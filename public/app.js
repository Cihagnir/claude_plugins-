"use strict";

/* ============================================================
   STATE
   ============================================================ */
const state = {
  allEvents: [],
  events: [],
  agents: new Map(),
  agentIdMap: new Map(),
  sessions: [],
  conversationGroups: new Map(),
  selectedSessionId: null,
  ws: null,
  connected: false,
  parentChildLinks: [],
  projectName: null,

  // Gantt-specific
  activityPeriods: new Map(), // agentKey -> [ActivityPeriod]
  ganttConfig: {
    gapThresholdMs: 5000,
    pixelsPerSecond: 8,
    zoomLevels: [2, 4, 8, 16, 32, 64],
    zoomIndex: 2, // default = 8
    sessionStartTime: null,
    autoFollow: true,
  },
};

/* ============================================================
   DOM REFS
   ============================================================ */
const dom = {
  sessionSelector: document.getElementById("session-selector"),
  sessionCount: document.getElementById("session-count"),
  sessionStatus: document.getElementById("session-status"),
  eventCount: document.getElementById("event-count"),
  connectionStatus: document.getElementById("connection-status"),
  ganttView: document.getElementById("gantt-view"),
  ganttTimeAxis: document.getElementById("gantt-time-axis"),
  ganttLabels: document.getElementById("gantt-labels"),
  ganttChartScroll: document.getElementById("gantt-chart-scroll"),
  ganttSvg: document.getElementById("gantt-svg"),
  ganttNowLine: document.getElementById("gantt-now-line"),
  ganttTooltip: document.getElementById("gantt-tooltip"),
  jumpToNow: document.getElementById("jump-to-now"),
  consoleText: document.getElementById("console-text"),
  consoleMemory: document.getElementById("console-memory"),
  consoleUptime: document.getElementById("console-uptime"),
  clearBtn: document.getElementById("clear-btn"),
  zoomIn: document.getElementById("zoom-in"),
  zoomOut: document.getElementById("zoom-out"),
  zoomLevel: document.getElementById("zoom-level"),
  projectName: document.getElementById("project-name"),
};

/* ============================================================
   CONSTANTS & HELPERS
   ============================================================ */
const SVG_NS = "http://www.w3.org/2000/svg";

const AGENT_ICONS = {
  main: "stars",
  default: "smart_toy",
  explore: "explore",
  plan: "architecture",
  "general-purpose": "hub",
  code: "code",
  test: "science",
  review: "rate_review",
  skill: "auto_fix_high",
};

const TOOL_COLORS = {
  bash: "#3b82f6",
  write: "#10b981",
  edit: "#f59e0b",
  multiedit: "#f59e0b",
  read: "#8b5cf6",
  glob: "#14b8a6",
  grep: "#14b8a6",
  agent: "#ec4899",
  skill: "#a855f7",
  stop: "#ffb4ab",
  session: "#4b5e6e",
  notification: "#f97316",
  mcp: "#f97316",
  other: "#4b5563",
};

function getAgentIcon(t) {
  if (!t) return AGENT_ICONS.default;
  const k = t.toLowerCase();
  for (const [n, v] of Object.entries(AGENT_ICONS)) {
    if (k.includes(n)) return v;
  }
  return AGENT_ICONS.default;
}

function getToolColor(toolName, eventType) {
  if (!toolName) {
    if (eventType === "Stop" || eventType === "SubagentStop") return TOOL_COLORS.stop;
    if (eventType === "SessionStart" || eventType === "SessionEnd") return TOOL_COLORS.session;
    if (eventType === "Notification") return TOOL_COLORS.notification;
    return TOOL_COLORS.other;
  }
  const n = toolName.toLowerCase();
  if (n.startsWith("mcp_") || n.startsWith("mcp__")) return TOOL_COLORS.mcp;
  return TOOL_COLORS[n] || TOOL_COLORS.other;
}

function getToolLabel(ev) {
  if (ev.tool_name) return ev.tool_name;
  if (ev.event_type === "SubagentStop") return "SubagentStop";
  if (ev.event_type === "Stop") return "Stop";
  if (ev.event_type === "Notification") return "Notif";
  if (ev.event_type === "SessionStart") return "Start";
  if (ev.event_type === "SessionEnd") return "End";
  return ev.event_type;
}

function getEventDetails(ev) {
  if (ev.tool_name === "Bash" && ev.tool_input) {
    const c = ev.tool_input.command || ev.tool_input.cmd || "";
    return c.length > 60 ? c.slice(0, 60) + "..." : c;
  }
  if ((ev.tool_name === "Write" || ev.tool_name === "Edit" || ev.tool_name === "Read") && ev.tool_input)
    return ev.tool_input.file_path || ev.tool_input.path || "";
  if (ev.tool_name === "Agent" && ev.tool_input) {
    const d = ev.tool_input.description || "";
    const p = ev.tool_input.prompt || "";
    return d || (p.length > 120 ? p.slice(0, 120) + "..." : p);
  }
  if (ev.tool_name === "Skill" && ev.tool_input) {
    const skill = ev.tool_input.skill || "";
    const args = ev.tool_input.args || "";
    return skill + (args ? ` ${args.length > 80 ? args.slice(0, 80) + "..." : args}` : "");
  }
  if (ev.event_type === "SubagentStop") return ev.agent_type || "subagent finished";
  if (ev.event_type === "Notification" && ev.raw) return ev.raw.message?.slice(0, 60) || "";
  if (ev.reason) return ev.reason.slice(0, 60);
  return "";
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function formatDuration(ms) {
  if (ms < 1000) return ms + "ms";
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  return m + "m " + (s % 60) + "s";
}

function formatRelativeTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `+${m}:${String(s).padStart(2, "0")}`;
}

function escapeHtml(str) {
  if (!str) return "";
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

/* ============================================================
   AGENT TRACKING
   ============================================================ */
function getAgentKey(ev) {
  const rawId = ev.agent_id || "main";
  if (state.agentIdMap.has(rawId)) return state.agentIdMap.get(rawId);

  if (rawId !== "main" && ev.agent_type) {
    // Look for existing agents with the same type
    const activeMatches = [];
    const stoppedMatches = [];
    for (const [key, agent] of state.agents) {
      if (key === "main") continue;
      if (agent.rawType === ev.agent_type) {
        if (agent.status === "active") activeMatches.push(key);
        else stoppedMatches.push(key);
      }
    }

    // If no active agent of this type exists, reuse a stopped one
    // (same agent type getting a new task — keep it on the same row)
    if (activeMatches.length === 0 && stoppedMatches.length > 0) {
      const reuseKey = stoppedMatches[stoppedMatches.length - 1]; // most recent
      state.agentIdMap.set(rawId, reuseKey);
      return reuseKey;
    }

    // If exactly one active agent of this type, map to it
    if (activeMatches.length === 1) {
      state.agentIdMap.set(rawId, activeMatches[0]);
      return activeMatches[0];
    }
  }

  // No match — new canonical key
  state.agentIdMap.set(rawId, rawId);
  return rawId;
}

function updateAgent(ev) {
  const key = getAgentKey(ev);
  const existing = state.agents.get(key);
  if (existing) {
    existing.toolCount++;
    existing.lastSeen = ev.timestamp;
    existing.events.push(ev);
    if (existing.events.length > 50) existing.events.shift();
    if (ev.event_type === "SubagentStop" || ev.event_type === "Stop") existing.status = "stopped";
    else existing.status = "active";
    // Update delegation description — always take new one when agent is re-tasked
    if (ev.delegation_description) {
      existing.delegation_description = ev.delegation_description;
      existing.type = `${ev.agent_type || "Subagent"}: ${ev.delegation_description}`;
    }
  } else {
    const name = ev.delegation_description
      ? `${ev.agent_type || "Subagent"}: ${ev.delegation_description}`
      : ev.agent_type || (key === "main" ? "Main Agent" : "Subagent");
    state.agents.set(key, {
      type: name,
      rawType: ev.agent_type || null,
      status: ev.event_type === "SubagentStop" ? "stopped" : "active",
      toolCount: 1,
      firstSeen: ev.timestamp,
      lastSeen: ev.timestamp,
      isSubagent: key !== "main",
      events: [ev],
      delegation_description: ev.delegation_description || null,
      parentKey: ev.parent_agent_id || null,
      is_skill_subagent: ev.is_skill_subagent || false,
    });
    if (ev.parent_agent_id) {
      const link = { parentKey: ev.parent_agent_id, childKey: key, timestamp: ev.timestamp };
      if (!state.parentChildLinks.find((l) => l.parentKey === link.parentKey && l.childKey === link.childKey)) {
        state.parentChildLinks.push(link);
      }
    }
  }
}

/* ============================================================
   ACTIVITY PERIOD ALGORITHM
   ============================================================ */
let periodIdCounter = 0;

function createPeriod(ev, agentKey) {
  const t = new Date(ev.timestamp).getTime();
  return {
    id: "p" + (++periodIdCounter),
    agentKey,
    startTime: t,
    endTime: t,
    events: [ev],
    toolCounts: { [getToolLabel(ev)]: 1 },
    primaryTool: getToolLabel(ev),
    primaryToolColor: getToolColor(ev.tool_name, ev.event_type),
    status: "active",
  };
}

function updatePrimaryTool(period) {
  let maxCount = 0;
  let maxTool = null;
  for (const [tool, count] of Object.entries(period.toolCounts)) {
    if (count > maxCount) { maxCount = count; maxTool = tool; }
  }
  period.primaryTool = maxTool;
  // Find the original event to get color
  const ev = period.events.find((e) => getToolLabel(e) === maxTool) || period.events[0];
  period.primaryToolColor = getToolColor(ev.tool_name, ev.event_type);
}

function buildActivityPeriods() {
  state.activityPeriods.clear();
  periodIdCounter = 0;
  const gap = state.ganttConfig.gapThresholdMs;

  // Group events by agent
  const byAgent = new Map();
  state.events.forEach((ev) => {
    const key = getAgentKey(ev);
    if (!byAgent.has(key)) byAgent.set(key, []);
    byAgent.get(key).push(ev);
  });

  // Compute session start time
  if (state.events.length > 0) {
    state.ganttConfig.sessionStartTime = new Date(state.events[0].timestamp).getTime();
  }

  byAgent.forEach((events, agentKey) => {
    const periods = [];
    let current = null;
    events.forEach((ev) => {
      const t = new Date(ev.timestamp).getTime();
      if (!current || (t - current.endTime) > gap) {
        if (current) current.status = "completed";
        current = createPeriod(ev, agentKey);
        periods.push(current);
      } else {
        current.endTime = t;
        current.events.push(ev);
        const label = getToolLabel(ev);
        current.toolCounts[label] = (current.toolCounts[label] || 0) + 1;
        updatePrimaryTool(current);
      }
      if (ev.event_type === "SubagentStop" || ev.event_type === "Stop") {
        if (current) current.status = "completed";
      }
    });
    state.activityPeriods.set(agentKey, periods);
  });
}

function appendToActivityPeriods(ev) {
  const key = getAgentKey(ev);
  const gap = state.ganttConfig.gapThresholdMs;
  const t = new Date(ev.timestamp).getTime();

  if (!state.ganttConfig.sessionStartTime || t < state.ganttConfig.sessionStartTime) {
    state.ganttConfig.sessionStartTime = t;
  }

  let periods = state.activityPeriods.get(key);
  if (!periods) {
    periods = [];
    state.activityPeriods.set(key, periods);
  }

  const last = periods[periods.length - 1];
  if (last && last.status === "active" && (t - last.endTime) <= gap) {
    last.endTime = t;
    last.events.push(ev);
    const label = getToolLabel(ev);
    last.toolCounts[label] = (last.toolCounts[label] || 0) + 1;
    updatePrimaryTool(last);
  } else {
    if (last) last.status = "completed";
    const p = createPeriod(ev, key);
    periods.push(p);
  }

  if (ev.event_type === "SubagentStop" || ev.event_type === "Stop") {
    const current = periods[periods.length - 1];
    if (current) current.status = "completed";
  }
}

/* ============================================================
   GANTT RENDERING
   ============================================================ */
function getSortedAgentEntries() {
  const entries = Array.from(state.agents.entries());
  const main = entries.find(([k]) => k === "main");
  const subs = entries.filter(([k]) => k !== "main")
    .sort((a, b) => a[1].firstSeen.localeCompare(b[1].firstSeen));
  const result = [];
  if (main) result.push(main);
  result.push(...subs);
  return result;
}

function renderGantt() {
  const entries = getSortedAgentEntries();
  const pps = state.ganttConfig.pixelsPerSecond;
  const startTime = state.ganttConfig.sessionStartTime || Date.now();
  const now = Date.now();
  const duration = Math.max(30000, now - startTime); // min 30s visible
  const totalWidth = Math.max(dom.ganttChartScroll.clientWidth, (duration / 1000) * pps + 100);
  const totalHeight = Math.max(dom.ganttChartScroll.clientHeight, entries.length * getLaneHeight());

  // SVG setup
  const svg = dom.ganttSvg;
  svg.setAttribute("width", totalWidth);
  svg.setAttribute("height", totalHeight);
  svg.innerHTML = "";

  if (entries.length === 0 && state.events.length === 0) {
    dom.ganttLabels.innerHTML = "";
    dom.ganttTimeAxis.innerHTML = "";
    dom.ganttView.querySelector(".empty-state")?.remove();
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = `<div class="empty-title">Awaiting agent activity</div><div class="empty-desc">Start a Claude Code session with hooks to populate the timeline.</div>`;
    dom.ganttView.appendChild(empty);
    return;
  }

  // Remove empty state if present
  dom.ganttView.querySelector(".empty-state")?.remove();

  const laneH = getLaneHeight();

  // Draw swimlane backgrounds
  entries.forEach(([key, agent], idx) => {
    const y = idx * laneH;
    // Alternating lane background
    if (idx % 2 === 1) {
      const bg = document.createElementNS(SVG_NS, "rect");
      bg.setAttribute("x", 0);
      bg.setAttribute("y", y);
      bg.setAttribute("width", totalWidth);
      bg.setAttribute("height", laneH);
      bg.setAttribute("fill", "rgba(12, 25, 52, 0.3)");
      svg.appendChild(bg);
    }
    // Lane bottom border
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", 0);
    line.setAttribute("y1", y + laneH);
    line.setAttribute("x2", totalWidth);
    line.setAttribute("y2", y + laneH);
    line.setAttribute("stroke", "rgba(26, 40, 64, 0.5)");
    line.setAttribute("stroke-width", "1");
    svg.appendChild(line);
    // Purple accent bar
    const accent = document.createElementNS(SVG_NS, "rect");
    accent.setAttribute("x", 0);
    accent.setAttribute("y", y + 4);
    accent.setAttribute("width", 2);
    accent.setAttribute("height", laneH - 8);
    accent.setAttribute("fill", key === "main" ? "#72dcff" : "#ddb7ff");
    accent.setAttribute("rx", 1);
    accent.classList.add("gantt-accent");
    svg.appendChild(accent);
  });

  // Draw time gridlines
  const gridInterval = getGridInterval(duration);
  for (let t = 0; t <= duration; t += gridInterval.minor) {
    const x = (t / 1000) * pps;
    const isMajor = t % gridInterval.major === 0;
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", x);
    line.setAttribute("y1", 0);
    line.setAttribute("x2", x);
    line.setAttribute("y2", totalHeight);
    line.setAttribute("stroke", isMajor ? "rgba(42, 58, 80, 0.6)" : "rgba(26, 40, 64, 0.3)");
    line.setAttribute("stroke-width", isMajor ? "1" : "0.5");
    svg.appendChild(line);
  }

  // Draw activity period bars
  entries.forEach(([key], idx) => {
    const periods = state.activityPeriods.get(key) || [];
    const y = idx * laneH;
    const barY = y + 8;
    const barH = laneH - 16;

    periods.forEach((period) => {
      const x = ((period.startTime - startTime) / 1000) * pps;
      const w = Math.max(4, ((period.endTime - period.startTime) / 1000) * pps || 4);

      const rect = document.createElementNS(SVG_NS, "rect");
      rect.setAttribute("x", x);
      rect.setAttribute("y", barY);
      rect.setAttribute("width", w);
      rect.setAttribute("height", barH);
      rect.setAttribute("rx", 3);
      rect.setAttribute("fill", period.primaryToolColor);
      rect.classList.add("gantt-bar");
      rect.dataset.periodId = period.id;

      rect.addEventListener("mouseenter", (e) => showTooltip(period, e.clientX, e.clientY));
      rect.addEventListener("mousemove", (e) => moveTooltip(e.clientX, e.clientY));
      rect.addEventListener("mouseleave", hideTooltip);

      svg.appendChild(rect);
    });
  });

  // Render labels and time axis
  renderAgentLabels(entries);
  renderTimeAxis(startTime, duration);
  updateNowLine(startTime);
}

function getLaneHeight() {
  return parseInt(getComputedStyle(document.documentElement).getPropertyValue("--lane-height")) || 40;
}

function getGridInterval(durationMs) {
  const s = durationMs / 1000;
  if (s < 120) return { minor: 10000, major: 30000 };
  if (s < 600) return { minor: 30000, major: 60000 };
  if (s < 1800) return { minor: 60000, major: 300000 };
  if (s < 7200) return { minor: 300000, major: 900000 };
  return { minor: 900000, major: 3600000 };
}

function renderAgentLabels(entries) {
  dom.ganttLabels.innerHTML = "";
  entries.forEach(([key, agent]) => {
    const isMain = key === "main";
    const icon = agent.is_skill_subagent ? "auto_fix_high" : getAgentIcon(agent.rawType || (isMain ? "main" : agent.type));
    const shortName = (agent.rawType || agent.type).replace(/:.*/, "");
    const displayName = agent.delegation_description
      ? `${shortName}: ${agent.delegation_description}`
      : shortName;
    const truncated = displayName.length > 24 ? displayName.slice(0, 24) + "..." : displayName;

    const label = document.createElement("div");
    label.className = `gantt-label${agent.isSubagent ? " subagent" : ""}`;

    label.innerHTML = `
      <span class="gantt-label-dot ${agent.status === "active" ? "active" : "stopped"}"></span>
      <span class="gantt-label-icon"><span class="material-symbols-outlined">${icon}</span></span>
      <span class="gantt-label-text" title="${escapeHtml(displayName)}">${escapeHtml(truncated)}</span>
    `;
    dom.ganttLabels.appendChild(label);
  });
}

function renderTimeAxis(startTime, durationMs) {
  dom.ganttTimeAxis.innerHTML = "";
  const pps = state.ganttConfig.pixelsPerSecond;
  const grid = getGridInterval(durationMs);

  for (let t = 0; t <= durationMs; t += grid.minor) {
    const x = (t / 1000) * pps;
    const isMajor = t % grid.major === 0;
    const absoluteTime = formatTime(new Date(startTime + t).toISOString());
    const relTime = formatRelativeTime(t);
    const tick = document.createElement("div");
    tick.className = `time-tick${isMajor ? " time-tick-major" : ""}`;
    tick.style.left = x + "px";
    tick.innerHTML = `
      <div class="time-tick-line"></div>
      <span class="time-tick-label">${isMajor ? absoluteTime : relTime}</span>
    `;
    dom.ganttTimeAxis.appendChild(tick);
  }
}

/* ============================================================
   INCREMENTAL GANTT UPDATE
   ============================================================ */
let renderPending = false;

function renderGanttIncremental() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => {
    renderPending = false;
    renderGantt();
    handleAutoScroll();
  });
}

/* ============================================================
   NOW LINE & AUTO-SCROLL
   ============================================================ */
function updateNowLine(startTime) {
  const start = startTime || state.ganttConfig.sessionStartTime;
  if (!start) { dom.ganttNowLine.style.display = "none"; return; }
  const pps = state.ganttConfig.pixelsPerSecond;
  const x = ((Date.now() - start) / 1000) * pps;
  dom.ganttNowLine.style.display = "";
  dom.ganttNowLine.style.left = x + "px";
}

let programmaticScroll = false;

function handleAutoScroll() {
  if (!state.ganttConfig.autoFollow) return;
  const start = state.ganttConfig.sessionStartTime;
  if (!start) return;
  const pps = state.ganttConfig.pixelsPerSecond;
  const nowX = ((Date.now() - start) / 1000) * pps;
  const viewWidth = dom.ganttChartScroll.clientWidth;
  const targetScroll = Math.max(0, nowX - viewWidth * 0.8);

  programmaticScroll = true;
  dom.ganttChartScroll.scrollLeft = targetScroll;
  // Also sync time axis scroll
  dom.ganttTimeAxis.style.transform = `translateX(${-dom.ganttChartScroll.scrollLeft}px)`;
  requestAnimationFrame(() => { programmaticScroll = false; });
}

// Scroll sync between labels and chart
let syncingScroll = false;

dom.ganttChartScroll.addEventListener("scroll", () => {
  // Sync vertical scroll to labels
  if (!syncingScroll) {
    syncingScroll = true;
    dom.ganttLabels.scrollTop = dom.ganttChartScroll.scrollTop;
    // Sync time axis horizontal
    dom.ganttTimeAxis.style.transform = `translateX(${-dom.ganttChartScroll.scrollLeft}px)`;
    syncingScroll = false;
  }
  // Detect manual scroll → pause auto-follow
  if (!programmaticScroll) {
    state.ganttConfig.autoFollow = false;
    dom.jumpToNow.classList.remove("hidden");
  }
});

dom.ganttLabels.addEventListener("scroll", () => {
  if (!syncingScroll) {
    syncingScroll = true;
    dom.ganttChartScroll.scrollTop = dom.ganttLabels.scrollTop;
    syncingScroll = false;
  }
});

// Jump to now
dom.jumpToNow.addEventListener("click", () => {
  state.ganttConfig.autoFollow = true;
  dom.jumpToNow.classList.add("hidden");
  handleAutoScroll();
});

// Auto-update now line every second
setInterval(() => {
  updateNowLine();
  if (state.ganttConfig.autoFollow) handleAutoScroll();
}, 1000);

/* ============================================================
   TOOLTIP
   ============================================================ */
function showTooltip(period, x, y) {
  const duration = period.endTime - period.startTime;
  const eventCount = period.events.length;
  const lastEvent = period.events[period.events.length - 1];
  const detail = getEventDetails(lastEvent);

  dom.ganttTooltip.innerHTML = `
    <div class="tooltip-tool" style="color:${period.primaryToolColor}">${escapeHtml(period.primaryTool)}</div>
    <div class="tooltip-duration">${formatDuration(duration)} &middot; ${eventCount} event${eventCount !== 1 ? "s" : ""}</div>
    ${detail ? `<div class="tooltip-detail">${escapeHtml(detail)}</div>` : ""}
  `;
  dom.ganttTooltip.classList.remove("hidden");
  moveTooltip(x, y);
}

function moveTooltip(x, y) {
  const tt = dom.ganttTooltip;
  const pad = 12;
  tt.style.left = (x + pad) + "px";
  tt.style.top = (y + pad) + "px";
  // Keep on screen
  const rect = tt.getBoundingClientRect();
  if (rect.right > window.innerWidth) tt.style.left = (x - rect.width - pad) + "px";
  if (rect.bottom > window.innerHeight) tt.style.top = (y - rect.height - pad) + "px";
}

function hideTooltip() {
  dom.ganttTooltip.classList.add("hidden");
}

/* ============================================================
   ZOOM
   ============================================================ */
function setZoom(index) {
  const levels = state.ganttConfig.zoomLevels;
  index = Math.max(0, Math.min(levels.length - 1, index));
  state.ganttConfig.zoomIndex = index;
  state.ganttConfig.pixelsPerSecond = levels[index];
  dom.zoomLevel.textContent = levels[index] + "px/s";
  renderGantt();
  handleAutoScroll();
}

dom.zoomIn.addEventListener("click", () => setZoom(state.ganttConfig.zoomIndex + 1));
dom.zoomOut.addEventListener("click", () => setZoom(state.ganttConfig.zoomIndex - 1));

/* ============================================================
   FILTERING & SESSION
   ============================================================ */
function filterEventsBySession() {
  if (!state.selectedSessionId) {
    state.events = [...state.allEvents];
    return;
  }
  if (state.selectedSessionId.startsWith("conv:")) {
    const g = state.conversationGroups.get(state.selectedSessionId.slice(5));
    if (g) {
      const s = new Set(g.session_ids);
      state.events = state.allEvents.filter((e) => s.has(e.session_id));
    } else state.events = [...state.allEvents];
  } else {
    state.events = state.allEvents.filter((e) => e.session_id === state.selectedSessionId);
  }
}

function applyFilter() {
  filterEventsBySession();
  state.agents.clear();
  state.agentIdMap.clear();
  state.parentChildLinks = [];
  state.ganttConfig.sessionStartTime = null;
  state.events.forEach((e) => updateAgent(e));
  buildActivityPeriods();
  renderGantt();
  handleAutoScroll();
  updateConsole();
  updateCounters();
  updateSessionStatus();
  refreshProjectDisplay();
}

function renderSessionSelector() {
  const sel = dom.sessionSelector;
  const cv = sel.value;
  sel.innerHTML = "";
  const grouped = new Map(), ungrouped = [];
  state.sessions.forEach((s) => {
    if (s.conversation_id) {
      if (!grouped.has(s.conversation_id)) grouped.set(s.conversation_id, []);
      grouped.get(s.conversation_id).push(s);
    } else ungrouped.push(s);
  });
  grouped.forEach((sessions, cid) => {
    if (sessions.length > 1) {
      const og = document.createElement("optgroup");
      og.label = `CONV ${cid.slice(0, 8)}...`;
      const co = document.createElement("option");
      co.value = `conv:${cid}`;
      co.textContent = `\u25A0 ALL (${sessions.reduce((n, s) => n + s.event_count, 0)} events)`;
      og.appendChild(co);
      sessions.forEach((s) => {
        const o = document.createElement("option");
        o.value = s.session_id;
        o.textContent = `  ${s.status === "active" ? "\u25CF" : "\u25CB"} ${s.session_id.slice(0, 8)}... (${s.event_count})`;
        og.appendChild(o);
      });
      sel.appendChild(og);
    } else ungrouped.push(...sessions);
  });
  ungrouped.forEach((s) => {
    const o = document.createElement("option");
    o.value = s.session_id;
    o.textContent = `${s.status === "active" ? "\u25CF" : "\u25CB"} ${s.session_id.slice(0, 8)}... (${s.event_count})`;
    sel.appendChild(o);
  });
  sel.value = cv;
  if (!sel.value && sel.options.length > 0) {
    sel.value = sel.options[0].value;
    state.selectedSessionId = sel.value;
  }
  dom.sessionCount.textContent = `${state.sessions.length} session${state.sessions.length !== 1 ? "s" : ""}`;
}

function updateSessionStatus() {
  const el = dom.sessionStatus;
  const ac = state.sessions.filter((s) => s.status === "active").length;
  if (!state.selectedSessionId) {
    el.textContent = !state.sessions.length ? "\u2014" : `${ac} active`;
  } else {
    const s = state.sessions.find((s) => s.session_id === state.selectedSessionId);
    el.textContent = s ? (s.status === "active" ? "Active" : "Ended") : "\u2014";
  }
}

/* ============================================================
   CONSOLE FOOTER
   ============================================================ */
function updateConsole() {
  const last5 = state.events.slice(-5).reverse();
  if (last5.length === 0) {
    dom.consoleText.textContent = "Awaiting agent activity...";
    return;
  }
  const lines = last5.map((ev) => {
    const agent = (state.agents.get(getAgentKey(ev))?.type || getAgentKey(ev)).replace(/:.*/, "").toUpperCase();
    const tool = ev.tool_name || ev.event_type;
    const detail = getEventDetails(ev);
    return `[${formatTime(ev.timestamp)}] ${agent}: ${tool}${detail ? " " + detail : ""}`;
  });
  dom.consoleText.textContent = lines.join(" \u00b7 ");
  dom.consoleMemory.textContent = `AGENTS: ${state.agents.size}`;
  dom.consoleUptime.textContent = `EVENTS: ${state.events.length}`;
}

function updateCounters() {
  const t = state.allEvents.length, f = state.events.length;
  dom.eventCount.textContent = !state.selectedSessionId ? `${t} events` : `${f}/${t} events`;
}

/* ============================================================
   EVENT PROCESSING
   ============================================================ */
function extractFolderName(cwd) {
  if (!cwd) return null;
  const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

function updateProjectName(ev) {
  if (ev.cwd && ev.session_id) {
    const session = state.sessions.find((s) => s.session_id === ev.session_id);
    if (session && !session.cwd) session.cwd = ev.cwd;
  }
}

function refreshProjectDisplay() {
  let cwd = null;
  if (!state.selectedSessionId) {
    const active = [...state.sessions].reverse().find((s) => s.cwd);
    if (active) cwd = active.cwd;
  } else if (state.selectedSessionId.startsWith("conv:")) {
    const convId = state.selectedSessionId.slice(5);
    const group = state.conversationGroups.get(convId);
    if (group) {
      const session = state.sessions.find((s) => group.session_ids.includes(s.session_id) && s.cwd);
      if (session) cwd = session.cwd;
    }
  } else {
    const session = state.sessions.find((s) => s.session_id === state.selectedSessionId);
    if (session) cwd = session.cwd;
  }
  const name = extractFolderName(cwd);
  state.projectName = name;
  dom.projectName.textContent = name || "";
  dom.projectName.style.display = name ? "" : "none";
}

function processEvent(ev) {
  state.allEvents.push(ev);
  updateProjectName(ev);
  if (ev.session_id) {
    const ex = state.sessions.find((s) => s.session_id === ev.session_id);
    if (ex) {
      ex.event_count++;
      if (ev.event_type === "SessionEnd") { ex.end_time = ev.timestamp; ex.status = "ended"; }
      if (ev.conversation_id && !ex.conversation_id) ex.conversation_id = ev.conversation_id;
    } else {
      state.sessions.push({
        session_id: ev.session_id, event_count: 1, start_time: ev.timestamp,
        end_time: null, status: "active", conversation_id: ev.conversation_id || null,
        cwd: ev.cwd || null,
      });
    }
    if (ev.conversation_id) {
      const g = state.conversationGroups.get(ev.conversation_id);
      if (g) { if (!g.session_ids.includes(ev.session_id)) g.session_ids.push(ev.session_id); }
      else state.conversationGroups.set(ev.conversation_id, { session_ids: [ev.session_id], transcript_path: ev.transcript_path || null });
    }
    renderSessionSelector();
    updateSessionStatus();
    refreshProjectDisplay();
  }

  let match = !state.selectedSessionId;
  if (!match && state.selectedSessionId.startsWith("conv:")) {
    const g = state.conversationGroups.get(state.selectedSessionId.slice(5));
    match = g && g.session_ids.includes(ev.session_id);
  } else if (!match) match = ev.session_id === state.selectedSessionId;

  if (match) {
    state.events.push(ev);
    updateAgent(ev);
    appendToActivityPeriods(ev);
    renderGanttIncremental();
    updateConsole();
  }
  updateCounters();
}

function processHistory(data) {
  state.allEvents = data.events || [];
  state.sessions = data.sessions || [];
  state.conversationGroups.clear();
  (data.conversations || []).forEach((c) =>
    state.conversationGroups.set(c.conversation_id, {
      session_ids: c.session_ids || [], transcript_path: c.transcript_path || null,
    }),
  );
  renderSessionSelector();
  const active = state.sessions.filter((s) => s.status === "active");
  if (active.length === 1) {
    const s = active[0];
    if (s.conversation_id) {
      const g = state.conversationGroups.get(s.conversation_id);
      state.selectedSessionId = g && g.session_ids.length > 1 ? `conv:${s.conversation_id}` : s.session_id;
    } else state.selectedSessionId = s.session_id;
  } else if (state.sessions.length > 0 && !state.sessions.find((s) => s.session_id === state.selectedSessionId)) {
    state.selectedSessionId = state.sessions[0].session_id;
  }
  dom.sessionSelector.value = state.selectedSessionId;
  filterEventsBySession();
  state.agents.clear();
  state.agentIdMap.clear();
  state.parentChildLinks = [];
  state.ganttConfig.sessionStartTime = null;
  state.projectName = null;
  state.events.forEach((e) => { updateProjectName(e); updateAgent(e); });
  buildActivityPeriods();
  renderGantt();
  handleAutoScroll();
  updateConsole();
  updateCounters();
  updateSessionStatus();
  refreshProjectDisplay();
}

/* ============================================================
   WEBSOCKET
   ============================================================ */
function connect() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`);
  ws.addEventListener("open", () => {
    state.connected = true;
    state.ws = ws;
    dom.connectionStatus.textContent = "LIVE";
    dom.connectionStatus.className = "header-status connected";
  });
  ws.addEventListener("message", (msg) => {
    try {
      const d = JSON.parse(msg.data);
      if (d.type === "history") processHistory(d);
      else if (d.type === "sessions_updated") {
        state.sessions = d.sessions || [];
        if (d.conversations) {
          state.conversationGroups.clear();
          d.conversations.forEach((c) =>
            state.conversationGroups.set(c.conversation_id, {
              session_ids: c.session_ids || [], transcript_path: c.transcript_path || null,
            }),
          );
        }
        renderSessionSelector();
        updateSessionStatus();
        refreshProjectDisplay();
      } else processEvent(d);
    } catch (e) { console.error("Parse error:", e); }
  });
  ws.addEventListener("close", () => {
    state.connected = false;
    state.ws = null;
    dom.connectionStatus.textContent = "OFFLINE";
    dom.connectionStatus.className = "header-status disconnected";
    setTimeout(connect, 2000);
  });
  ws.addEventListener("error", () => ws.close());
}

/* ============================================================
   INIT
   ============================================================ */
dom.sessionSelector.addEventListener("change", () => {
  state.selectedSessionId = dom.sessionSelector.value;
  applyFilter();
});

dom.clearBtn.addEventListener("click", () => {
  if (!state.selectedSessionId) state.allEvents = [];
  else state.allEvents = state.allEvents.filter((e) => e.session_id !== state.selectedSessionId);
  applyFilter();
});

// Initial render
renderGantt();
connect();
