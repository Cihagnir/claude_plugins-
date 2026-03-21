"use strict";

const state = {
  allEvents: [], events: [], agents: new Map(), sessions: [],
  conversationGroups: new Map(), selectedSessionId: "all",
  currentView: "cards", ws: null, connected: false,
};

const dom = {
  sessionSelector: document.getElementById("session-selector"),
  sessionCount: document.getElementById("session-count"),
  sessionStatus: document.getElementById("session-status"),
  eventCount: document.getElementById("event-count"),
  connectionStatus: document.getElementById("connection-status"),
  tacticalView: document.getElementById("tactical-view"),
  timelineView: document.getElementById("timeline-view"),
  timeline: document.getElementById("timeline"),
  slotTop: document.getElementById("slot-top"),
  slotLeft: document.getElementById("slot-left"),
  slotRight: document.getElementById("slot-right"),
  slotBottom: document.getElementById("slot-bottom"),
  slotOverflow: document.getElementById("slot-overflow"),
  consoleText: document.getElementById("console-text"),
  consoleMemory: document.getElementById("console-memory"),
  consoleUptime: document.getElementById("console-uptime"),
  clearBtn: document.getElementById("clear-btn"),
  modalOverlay: document.getElementById("modal-overlay"),
  modalBody: document.getElementById("modal-body"),
  modalClose: document.getElementById("modal-close"),
  statSynergy: document.getElementById("stat-synergy"),
  statLatency: document.getElementById("stat-latency"),
};

const AGENT_ICONS = {
  main: "stars", default: "smart_toy", explore: "explore",
  plan: "architecture", "general-purpose": "hub", code: "code",
  test: "science", review: "rate_review",
};
const SUB_ACCENTS = ["accent-green", "accent-cyan", "accent-error", "accent-white"];

function getAgentIcon(t) {
  if (!t) return AGENT_ICONS.default;
  const k = t.toLowerCase();
  for (const [n, v] of Object.entries(AGENT_ICONS)) { if (k.includes(n)) return v; }
  return AGENT_ICONS.default;
}

function getToolClass(toolName, eventType) {
  if (!toolName) {
    if (eventType === "Stop" || eventType === "SubagentStop") return "tool-stop";
    if (eventType === "SessionStart" || eventType === "SessionEnd") return "tool-session";
    if (eventType === "Notification") return "tool-notification";
    return "tool-other";
  }
  const n = toolName.toLowerCase();
  if (n === "bash") return "tool-bash"; if (n === "write") return "tool-write";
  if (n === "edit" || n === "multiedit") return "tool-edit";
  if (n === "read") return "tool-read"; if (n === "glob" || n === "grep") return "tool-glob";
  if (n === "agent") return "tool-agent"; if (n.startsWith("mcp_")) return "tool-mcp";
  return "tool-other";
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
  if (ev.event_type === "SubagentStop") return ev.agent_type || "subagent finished";
  if (ev.event_type === "Notification" && ev.raw) return ev.raw.message?.slice(0, 60) || "";
  if (ev.reason) return ev.reason.slice(0, 60);
  return "";
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function timeAgo(iso) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return s + "s ago"; const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago"; return Math.floor(m / 60) + "h ago";
}
function escapeHtml(str) {
  if (!str) return ""; const d = document.createElement("div"); d.textContent = str; return d.innerHTML;
}

// --- Agent tracking ---
function getAgentKey(ev) { return ev.agent_id || "main"; }

function updateAgent(ev) {
  const key = getAgentKey(ev);
  const existing = state.agents.get(key);
  if (existing) {
    existing.toolCount++; existing.lastSeen = ev.timestamp;
    existing.events.push(ev);
    if (existing.events.length > 50) existing.events.shift();
    if (ev.event_type === "SubagentStop" || ev.event_type === "Stop") existing.status = "stopped";
    else existing.status = "active";
    if (!existing.delegation_description && ev.delegation_description) {
      existing.delegation_description = ev.delegation_description;
      existing.delegation_prompt = ev.delegation_prompt;
      existing.type = `${ev.agent_type || "Subagent"}: ${ev.delegation_description}`;
    }
  } else {
    let name = ev.delegation_description
      ? `${ev.agent_type || "Subagent"}: ${ev.delegation_description}`
      : (ev.agent_type || (key === "main" ? "Main Agent" : "Subagent"));
    state.agents.set(key, {
      type: name, rawType: ev.agent_type || null,
      status: ev.event_type === "SubagentStop" ? "stopped" : "active",
      toolCount: 1, firstSeen: ev.timestamp, lastSeen: ev.timestamp,
      isSubagent: key !== "main", events: [ev],
      delegation_description: ev.delegation_description || null,
      delegation_prompt: ev.delegation_prompt || null,
    });
  }
}

// --- Filtering ---
function filterEventsBySession() {
  if (state.selectedSessionId === "all") { state.events = [...state.allEvents]; return; }
  if (state.selectedSessionId.startsWith("conv:")) {
    const g = state.conversationGroups.get(state.selectedSessionId.slice(5));
    if (g) { const s = new Set(g.session_ids); state.events = state.allEvents.filter(e => s.has(e.session_id)); }
    else state.events = [...state.allEvents];
  } else {
    state.events = state.allEvents.filter(e => e.session_id === state.selectedSessionId);
  }
}

function applyFilter() {
  filterEventsBySession(); state.agents.clear();
  state.events.forEach(e => updateAgent(e));
  renderCurrentView(); updateConsole(); updateCounters(); updateSessionStatus();
}

// --- View switching ---
function switchView(view) {
  state.currentView = view;
  document.querySelectorAll(".header-nav-link").forEach(l => l.classList.toggle("active", l.dataset.view === view));
  if (view === "cards") {
    dom.tacticalView.style.display = ""; dom.timelineView.style.display = "none";
    renderTacticalTable();
  } else {
    dom.tacticalView.style.display = "none"; dom.timelineView.style.display = "";
    renderTimeline();
  }
}

function renderCurrentView() {
  if (state.currentView === "cards") renderTacticalTable(); else renderTimeline();
}

// --- Session selector ---
function renderSessionSelector() {
  const sel = dom.sessionSelector; const cv = sel.value;
  sel.innerHTML = '<option value="all">ALL_SESSIONS</option>';
  const grouped = new Map(), ungrouped = [];
  state.sessions.forEach(s => {
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
      co.value = `conv:${cid}`; co.textContent = `\u25A0 ALL (${sessions.reduce((n, s) => n + s.event_count, 0)} events)`;
      og.appendChild(co);
      sessions.forEach(s => { const o = document.createElement("option"); o.value = s.session_id;
        o.textContent = `  ${s.status === "active" ? "\u25CF" : "\u25CB"} ${s.session_id.slice(0, 8)}... (${s.event_count})`; og.appendChild(o); });
      sel.appendChild(og);
    } else ungrouped.push(...sessions);
  });
  ungrouped.forEach(s => { const o = document.createElement("option"); o.value = s.session_id;
    o.textContent = `${s.status === "active" ? "\u25CF" : "\u25CB"} ${s.session_id.slice(0, 8)}... (${s.event_count})`; sel.appendChild(o); });
  sel.value = cv; if (!sel.value) sel.value = "all";
  dom.sessionCount.textContent = `${state.sessions.length} session${state.sessions.length !== 1 ? "s" : ""}`;
}

function updateSessionStatus() {
  const el = dom.sessionStatus;
  const ac = state.sessions.filter(s => s.status === "active").length;
  if (state.selectedSessionId === "all") {
    if (!state.sessions.length) el.textContent = "—";
    else el.textContent = `${ac} active`;
  } else {
    const s = state.sessions.find(s => s.session_id === state.selectedSessionId);
    el.textContent = s ? (s.status === "active" ? "Active" : "Ended") : "—";
  }
}

// --- Rendering: Tactical Table ---
function buildAgentCard(key, agent, idx) {
  const isMain = key === "main";
  const icon = getAgentIcon(agent.rawType || (isMain ? "main" : agent.type));
  const accent = isMain ? "" : SUB_ACCENTS[idx % SUB_ACCENTS.length];
  const shortName = (agent.rawType || agent.type).replace(/:.*/, "").toUpperCase();
  const unitLabel = isMain ? "ALPHA-01" : `UNIT-${String(idx + 1).padStart(2, "0")}`;
  const statusLine = `STATUS: ${agent.status === "active" ? "ACTIVE" : "IDLE"}`;
  const lastTool = agent.events.length ? (agent.events[agent.events.length - 1].tool_name || agent.events[agent.events.length - 1].event_type) : "—";
  const focusText = agent.delegation_description || lastTool;
  const focusDisplay = focusText.length > 35 ? focusText.slice(0, 35) + "..." : focusText;
  const pct = Math.min(100, Math.round((agent.toolCount / Math.max(1, state.events.length)) * 100));

  const card = document.createElement("div");
  card.className = `agent-card ${isMain ? "primary-agent" : "sub-agent"} ${accent}`;

  let footerHtml = "";
  if (isMain) {
    footerHtml = `<div class="card-footer-row">
      <span class="card-load">Cognitive Load: ${pct}%</span>
      <span class="card-footer-icon"><span class="material-symbols-outlined">settings_input_component</span></span>
    </div>`;
  } else {
    footerHtml = `<div class="card-progress"><div class="card-progress-fill" style="width:${pct}%;background:${accent === 'accent-green' ? '#79ff5b' : accent === 'accent-error' ? '#ffb4ab' : '#00fbfb'};"></div></div>`;
  }

  card.innerHTML = `
    ${isMain ? '<div class="master-badge">MASTER</div>' : ''}
    <div class="card-top-row">
      <div class="card-avatar"><span class="material-symbols-outlined">${icon}</span></div>
      <div>
        <div class="card-agent-name">${escapeHtml(shortName)}</div>
        <div class="card-unit">${unitLabel}</div>
        <div class="card-status-line">${statusLine}</div>
      </div>
    </div>
    <div>
      <span class="card-focus-label">Main Focus</span>
      <div class="card-focus-value">${escapeHtml(focusDisplay)}</div>
    </div>
    ${footerHtml}
  `;
  return card;
}

function renderTacticalTable() {
  // Clear slots
  [dom.slotTop, dom.slotLeft, dom.slotRight, dom.slotBottom, dom.slotOverflow].forEach(s => s.innerHTML = "");

  if (state.agents.size === 0 && state.events.length === 0) {
    dom.slotTop.innerHTML = `<div class="empty-state"><div class="empty-title">AWAITING_NEURAL_LINK</div><div class="empty-desc">Initialize a Claude Code session with hooks to populate the agent hive.</div></div>`;
    updateTableStats();
    return;
  }

  // Ensure main agent
  if (!state.agents.has("main") && state.events.length > 0) {
    state.agents.set("main", {
      type: "Main Agent", rawType: null, status: "active", toolCount: 0,
      firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(),
      isSubagent: false, events: [], delegation_description: null, delegation_prompt: null,
    });
  }

  const entries = Array.from(state.agents.entries());
  const mainEntry = entries.find(([k]) => k === "main");
  const subs = entries.filter(([k]) => k !== "main");

  // Position: main at top, subs around the table
  const slots = [dom.slotLeft, dom.slotRight, dom.slotBottom];

  if (mainEntry) {
    dom.slotTop.appendChild(buildAgentCard(mainEntry[0], mainEntry[1], 0));
  }

  subs.forEach(([key, agent], idx) => {
    const card = buildAgentCard(key, agent, idx);
    if (idx < 3) {
      slots[idx].appendChild(card);
    } else {
      dom.slotOverflow.appendChild(card);
    }
  });

  updateTableStats();
}

function updateTableStats() {
  const activeAgents = Array.from(state.agents.values()).filter(a => a.status === "active").length;
  const total = state.agents.size;
  dom.statSynergy.textContent = total > 0 ? Math.round((activeAgents / total) * 100) + "%" : "—";
  dom.statLatency.textContent = state.events.length > 0 ? Math.round(Math.random() * 8 + 2) + "ms" : "—";
}

// --- Rendering: Timeline ---
function renderTimeline() {
  dom.timeline.innerHTML = "";
  const byAgent = new Map();
  state.events.forEach(ev => {
    const k = getAgentKey(ev);
    if (!byAgent.has(k)) byAgent.set(k, []);
    byAgent.get(k).push(ev);
  });
  byAgent.forEach((evts, ak) => {
    const row = document.createElement("div"); row.className = "timeline-row";
    const label = document.createElement("div"); label.className = "timeline-row-label";
    const ai = state.agents.get(ak); label.textContent = ai ? ai.type : ak;
    row.appendChild(label);
    const blocks = document.createElement("div"); blocks.className = "timeline-row-blocks";
    evts.forEach(ev => {
      const b = document.createElement("div");
      b.className = `timeline-block ${getToolClass(ev.tool_name, ev.event_type)} ${ev.event_type === "PreToolUse" ? "pre" : "post"}`;
      b.textContent = getToolLabel(ev);
      b.title = `${formatTime(ev.timestamp)} - ${ev.event_type} ${ev.tool_name || ""}`;
      b.addEventListener("click", () => showModal(ev));
      blocks.appendChild(b);
    });
    row.appendChild(blocks); dom.timeline.appendChild(row);
  });
  const tc = document.getElementById("timeline-container");
  if (tc) tc.scrollTop = tc.scrollHeight;
}

// --- Console footer ---
function updateConsole() {
  const last5 = state.events.slice(-5).reverse();
  if (last5.length === 0) { dom.consoleText.textContent = "Awaiting agent activity..."; return; }
  const lines = last5.map(ev => {
    const agent = (state.agents.get(getAgentKey(ev))?.type || getAgentKey(ev)).replace(/:.*/, "").toUpperCase();
    const tool = ev.tool_name || ev.event_type;
    const detail = getEventDetails(ev);
    return `[${formatTime(ev.timestamp)}] ${agent}: ${tool}${detail ? " " + detail : ""}`;
  });
  dom.consoleText.textContent = lines.join(" ... ");
  dom.consoleMemory.textContent = `AGENTS: ${state.agents.size}`;
  dom.consoleUptime.textContent = `EVENTS: ${state.events.length}`;
}

function updateCounters() {
  const t = state.allEvents.length, f = state.events.length;
  dom.eventCount.textContent = state.selectedSessionId === "all" ? `${t} events` : `${f}/${t} events`;
}

// --- Modal ---
function showModal(ev) {
  dom.modalBody.textContent = JSON.stringify(ev.raw || ev, null, 2);
  dom.modalOverlay.classList.remove("hidden");
}
function hideModal() { dom.modalOverlay.classList.add("hidden"); }

// --- Event processing ---
function processEvent(ev) {
  state.allEvents.push(ev);
  if (ev.session_id) {
    const ex = state.sessions.find(s => s.session_id === ev.session_id);
    if (ex) { ex.event_count++; if (ev.event_type === "SessionEnd") { ex.end_time = ev.timestamp; ex.status = "ended"; }
      if (ev.conversation_id && !ex.conversation_id) ex.conversation_id = ev.conversation_id;
    } else {
      state.sessions.push({ session_id: ev.session_id, event_count: 1, start_time: ev.timestamp,
        end_time: null, status: "active", conversation_id: ev.conversation_id || null });
    }
    if (ev.conversation_id) {
      const g = state.conversationGroups.get(ev.conversation_id);
      if (g) { if (!g.session_ids.includes(ev.session_id)) g.session_ids.push(ev.session_id); }
      else state.conversationGroups.set(ev.conversation_id, { session_ids: [ev.session_id], transcript_path: ev.transcript_path || null });
    }
    renderSessionSelector(); updateSessionStatus();
  }
  let match = state.selectedSessionId === "all";
  if (!match && state.selectedSessionId.startsWith("conv:")) {
    const g = state.conversationGroups.get(state.selectedSessionId.slice(5));
    match = g && g.session_ids.includes(ev.session_id);
  } else if (!match) match = ev.session_id === state.selectedSessionId;
  if (match) { state.events.push(ev); updateAgent(ev); renderCurrentView(); updateConsole(); }
  updateCounters();
}

function processHistory(data) {
  state.allEvents = data.events || []; state.sessions = data.sessions || [];
  state.conversationGroups.clear();
  (data.conversations || []).forEach(c => state.conversationGroups.set(c.conversation_id, { session_ids: c.session_ids || [], transcript_path: c.transcript_path || null }));
  renderSessionSelector();
  const active = state.sessions.filter(s => s.status === "active");
  if (active.length === 1 && state.selectedSessionId === "all") {
    const s = active[0];
    if (s.conversation_id) { const g = state.conversationGroups.get(s.conversation_id);
      state.selectedSessionId = (g && g.session_ids.length > 1) ? `conv:${s.conversation_id}` : s.session_id;
    } else state.selectedSessionId = s.session_id;
    dom.sessionSelector.value = state.selectedSessionId;
  }
  filterEventsBySession(); state.agents.clear();
  state.events.forEach(e => updateAgent(e));
  renderCurrentView(); updateConsole(); updateCounters(); updateSessionStatus();
}

// --- WebSocket ---
function connect() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`);
  ws.addEventListener("open", () => {
    state.connected = true; state.ws = ws;
    dom.connectionStatus.textContent = "LIVE"; dom.connectionStatus.className = "header-status connected";
  });
  ws.addEventListener("message", msg => {
    try {
      const d = JSON.parse(msg.data);
      if (d.type === "history") processHistory(d);
      else if (d.type === "sessions_updated") {
        state.sessions = d.sessions || [];
        if (d.conversations) { state.conversationGroups.clear();
          d.conversations.forEach(c => state.conversationGroups.set(c.conversation_id, { session_ids: c.session_ids || [], transcript_path: c.transcript_path || null })); }
        renderSessionSelector(); updateSessionStatus();
      } else processEvent(d);
    } catch (e) { console.error("Parse error:", e); }
  });
  ws.addEventListener("close", () => {
    state.connected = false; state.ws = null;
    dom.connectionStatus.textContent = "OFFLINE"; dom.connectionStatus.className = "header-status disconnected";
    setTimeout(connect, 2000);
  });
  ws.addEventListener("error", () => ws.close());
}

// --- Init ---
dom.sessionSelector.addEventListener("change", () => { state.selectedSessionId = dom.sessionSelector.value; applyFilter(); });
dom.clearBtn.addEventListener("click", () => {
  if (state.selectedSessionId === "all") state.allEvents = [];
  else state.allEvents = state.allEvents.filter(e => e.session_id !== state.selectedSessionId);
  applyFilter();
});
document.querySelectorAll(".header-nav-link").forEach(l => l.addEventListener("click", e => { e.preventDefault(); switchView(l.dataset.view); }));
dom.modalClose.addEventListener("click", hideModal);
dom.modalOverlay.addEventListener("click", e => { if (e.target === dom.modalOverlay) hideModal(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") hideModal(); });
dom.consoleText.addEventListener("click", () => {
  const last = state.events[state.events.length - 1];
  if (last) showModal(last);
});

renderTacticalTable();
connect();
