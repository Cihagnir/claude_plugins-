#!/usr/bin/env node
"use strict";

const http = require("http");

const PORT = process.env.AGENT_VIZ_PORT || 3399;
const GAP_THRESHOLD_MS = 5000;
const MAX_AGENTS = 8;

// ── ANSI helpers ──
const ESC = "\x1b";
const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;

const fg = (code) => `${ESC}[38;5;${code}m`;
const bg = (code) => `${ESC}[48;5;${code}m`;

const COLORS = {
  bash:         fg(33),   // blue
  write:        fg(35),   // green
  edit:         fg(214),  // yellow/orange
  multiedit:    fg(214),
  read:         fg(99),   // purple
  glob:         fg(37),   // teal
  grep:         fg(37),
  agent:        fg(205),  // pink
  skill:        fg(135),  // violet
  stop:         fg(210),  // salmon
  session:      fg(242),  // gray
  notification: fg(208),  // orange
  mcp:          fg(208),
  thinking:     fg(220),  // yellow/amber
  other:        fg(245),
  idle:         fg(238),  // dark gray
  active:       fg(83),   // bright green
  header:       fg(74),   // cyan
  dim:          fg(242),
  label:        fg(252),
  accent:       fg(183),  // purple accent
  time:         fg(74),
  separator:    fg(240),
  stat:         fg(74),
};

// ── Tool color resolution ──
function getToolColor(toolName, eventType) {
  if (!toolName) {
    if (eventType === "Stop" || eventType === "SubagentStop") return COLORS.stop;
    if (eventType === "SessionStart" || eventType === "SessionEnd") return COLORS.session;
    if (eventType === "Notification") return COLORS.notification;
    return COLORS.other;
  }
  const n = toolName.toLowerCase();
  if (n.startsWith("mcp_") || n.startsWith("mcp__")) return COLORS.mcp;
  return COLORS[n] || COLORS.other;
}

function getToolLabel(ev) {
  if (ev.tool_name) return ev.tool_name;
  return ev.event_type || "unknown";
}

// ── Agent tracking (simplified from app.js) ──
function buildAgentsAndPeriods(events) {
  const agents = new Map();
  const agentIdMap = new Map();
  const periods = new Map(); // agentKey -> [period]

  function getAgentKey(ev) {
    const rawId = ev.agent_id || "main";
    if (agentIdMap.has(rawId)) return agentIdMap.get(rawId);

    if (rawId !== "main" && ev.agent_type) {
      const active = [], stopped = [];
      for (const [key, agent] of agents) {
        if (key === "main") continue;
        if (agent.rawType === ev.agent_type) {
          if (agent.status === "active") active.push(key);
          else stopped.push(key);
        }
      }
      if (active.length === 0 && stopped.length > 0) {
        const reuseKey = stopped[stopped.length - 1];
        agentIdMap.set(rawId, reuseKey);
        return reuseKey;
      }
      if (active.length === 1) {
        agentIdMap.set(rawId, active[0]);
        return active[0];
      }
    }
    agentIdMap.set(rawId, rawId);
    return rawId;
  }

  events.forEach((ev) => {
    const key = getAgentKey(ev);
    const t = new Date(ev.timestamp).getTime();

    // Update agent
    let agent = agents.get(key);
    if (!agent) {
      const name = ev.delegation_description
        ? `${(ev.agent_type || "Sub").replace(/:.*/, "")}: ${ev.delegation_description}`
        : ev.agent_type || (key === "main" ? "Main Agent" : "Subagent");
      agent = {
        type: name, rawType: ev.agent_type || null,
        status: "active", toolCount: 0, firstSeen: t, lastSeen: t,
        isSubagent: key !== "main",
      };
      agents.set(key, agent);
    }
    agent.toolCount++;
    agent.lastSeen = t;
    if (ev.event_type === "SubagentStop" || ev.event_type === "Stop") agent.status = "stopped";
    else agent.status = "active";
    if (ev.delegation_description) {
      agent.type = `${(ev.agent_type || "Sub").replace(/:.*/, "")}: ${ev.delegation_description}`;
    }

    // Build activity periods
    let agentPeriods = periods.get(key);
    if (!agentPeriods) { agentPeriods = []; periods.set(key, agentPeriods); }
    const last = agentPeriods[agentPeriods.length - 1];
    const toolLabel = getToolLabel(ev);
    const toolColor = getToolColor(ev.tool_name, ev.event_type);

    if (last && last.status === "active" && (t - last.endTime) <= GAP_THRESHOLD_MS) {
      last.endTime = t;
      last.toolCounts[toolLabel] = (last.toolCounts[toolLabel] || 0) + 1;
      // Update primary tool
      let maxC = 0, maxT = null, maxColor = null;
      for (const [tl, c] of Object.entries(last.toolCounts)) {
        if (c > maxC) { maxC = c; maxT = tl; }
      }
      if (maxT) { last.primaryTool = maxT; last.color = last.toolColorMap[maxT] || toolColor; }
    } else {
      if (last) last.status = "completed";
      agentPeriods.push({
        startTime: t, endTime: t, primaryTool: toolLabel, color: toolColor,
        toolCounts: { [toolLabel]: 1 }, toolColorMap: { [toolLabel]: toolColor },
        status: "active",
      });
    }

    if (ev.event_type === "SubagentStop" || ev.event_type === "Stop") {
      const cur = agentPeriods[agentPeriods.length - 1];
      if (cur) cur.status = "completed";
    }

    // Track tool color for this label
    const curPeriod = agentPeriods[agentPeriods.length - 1];
    if (curPeriod) curPeriod.toolColorMap[toolLabel] = toolColor;
  });

  return { agents, periods };
}

// ── Rendering ──
function renderChart(events, sessionInfo) {
  const cols = process.stdout.columns || 80;
  const labelWidth = 10;
  const chartWidth = Math.max(20, cols - labelWidth - 3); // 3 for " │ "
  const lines = [];

  const { agents, periods } = buildAgentsAndPeriods(events);

  if (events.length === 0 || agents.size === 0) {
    const folderName = extractFolder(sessionInfo.cwd);
    const now = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });
    lines.push(`${COLORS.header}${BOLD}─── Agent Timeline ─── ${COLORS.accent}${folderName}${COLORS.header} ${"─".repeat(Math.max(0, cols - 28 - folderName.length - now.length))} ${COLORS.time}${now} ${COLORS.header}───${RESET}`);
    lines.push(`${COLORS.dim}  Awaiting agent activity...${RESET}`);
    return lines.join("\n");
  }

  // Time range
  let startTime = Infinity, endTime = 0;
  events.forEach((ev) => {
    const t = new Date(ev.timestamp).getTime();
    if (t < startTime) startTime = t;
    if (t > endTime) endTime = t;
  });
  const now = Date.now();
  const hasActive = Array.from(agents.values()).some((a) => a.status === "active");
  if (hasActive) endTime = now;
  const duration = Math.max(1000, endTime - startTime);

  // Sort agents: main first, then subagents by firstSeen
  const sorted = Array.from(agents.entries());
  const mainEntry = sorted.find(([k]) => k === "main");
  const subs = sorted.filter(([k]) => k !== "main").sort((a, b) => a[1].firstSeen - b[1].firstSeen);
  const agentList = [];
  if (mainEntry) agentList.push(mainEntry);
  agentList.push(...subs);
  const displayAgents = agentList.slice(0, MAX_AGENTS);
  const hiddenCount = agentList.length - displayAgents.length;

  // ── Header line ──
  const folderName = extractFolder(sessionInfo.cwd);
  const nowStr = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });
  const headerText = `─── Agent Timeline ─── ${folderName} `;
  const headerRight = ` ${nowStr} ───`;
  const headerFill = Math.max(0, cols - headerText.length - headerRight.length);
  lines.push(`${COLORS.header}${BOLD}${headerText}${COLORS.accent}${"─".repeat(headerFill)}${COLORS.header}${headerRight}${RESET}`);

  // ── Time axis ──
  const timeAxisLine = renderTimeAxis(startTime, duration, chartWidth, labelWidth);
  lines.push(timeAxisLine);

  // ── Separator ──
  lines.push(`${COLORS.separator}${"─".repeat(labelWidth)}┼${"─".repeat(chartWidth + 2)}${RESET}`);

  // ── Agent rows ──
  displayAgents.forEach(([key, agent]) => {
    const agentPeriods = periods.get(key) || [];
    const shortName = truncate(agent.type.replace(/:.*/, ""), labelWidth - 2);
    const statusDot = agent.status === "active" ? `${COLORS.active}●${RESET}` : `${COLORS.dim}○${RESET}`;
    const paddedName = (shortName).padEnd(labelWidth - 2);
    const labelStr = `${statusDot} ${agent.isSubagent ? COLORS.accent : COLORS.label}${paddedName}${RESET}`;

    // Build bar — right-to-left: rightmost position = now (+0), left = past
    const bar = new Array(chartWidth).fill(null);
    agentPeriods.forEach((period) => {
      // Map time to position: endTime (now) = rightmost, startTime = left
      const pStart = Math.max(0, ((endTime - period.endTime) / duration) * chartWidth);
      const pEnd = Math.min(chartWidth, ((endTime - period.startTime) / duration) * chartWidth);
      const startIdx = Math.floor(pStart);
      const endIdx = Math.max(startIdx + 1, Math.ceil(pEnd));
      for (let i = startIdx; i < endIdx && i < chartWidth; i++) {
        bar[chartWidth - 1 - i] = { color: period.color, active: period.status === "active" };
      }
    });

    let barStr = "";
    bar.forEach((cell) => {
      if (cell) {
        barStr += `${cell.color}${cell.active ? "▓" : "█"}${RESET}`;
      } else {
        barStr += `${COLORS.idle}░${RESET}`;
      }
    });

    lines.push(`${labelStr}${COLORS.separator}│${RESET} ${barStr}`);
  });

  if (hiddenCount > 0) {
    lines.push(`${COLORS.dim}${" ".repeat(labelWidth)}│ +${hiddenCount} more agent${hiddenCount > 1 ? "s" : ""}...${RESET}`);
  }

  // ── Bottom separator ──
  lines.push(`${COLORS.separator}${"─".repeat(labelWidth)}┴${"─".repeat(chartWidth + 2)}${RESET}`);

  // ── Legend ──
  const legend = [
    `${COLORS.bash}██${RESET} Bash`,
    `${COLORS.write}██${RESET} Write`,
    `${COLORS.edit}██${RESET} Edit`,
    `${COLORS.read}██${RESET} Read`,
    `${COLORS.glob}██${RESET} Glob`,
    `${COLORS.agent}██${RESET} Agent`,
    `${COLORS.skill}██${RESET} Skill`,
    `${COLORS.thinking}██${RESET} Thinking`,
    `${COLORS.mcp}██${RESET} MCP`,
    `${COLORS.active}▓▓${RESET} Active`,
  ];
  lines.push(`  ${legend.join("  ")}`);

  // ── Stats ──
  const activeCount = Array.from(agents.values()).filter((a) => a.status === "active").length;
  const totalEvents = events.length;
  const durationStr = formatDuration(duration);
  lines.push(`  ${COLORS.stat}Agents: ${agents.size} (${activeCount} active)${COLORS.separator} │ ${COLORS.stat}Events: ${totalEvents}${COLORS.separator} │ ${COLORS.stat}Duration: ${durationStr}${RESET}`);

  return lines.join("\n");
}

function renderTimeAxis(startTime, duration, chartWidth, labelWidth) {
  // Decide tick interval
  const durationSec = duration / 1000;
  let tickInterval; // in ms
  if (durationSec < 120) tickInterval = 15000;
  else if (durationSec < 600) tickInterval = 60000;
  else if (durationSec < 1800) tickInterval = 300000;
  else tickInterval = 900000;

  const labelPad = " ".repeat(labelWidth - 6);
  let axis = `${COLORS.dim}${labelPad}TIME  ${COLORS.separator}│${RESET} `;
  const marks = new Array(chartWidth).fill(" ");

  // Right-to-left: +0:00 on the right (now), past extends left
  // Place "-Xm:Xs" labels showing how far back in time
  for (let t = 0; t <= duration; t += tickInterval) {
    if (t === 0) continue; // skip 0, we place +0:00 explicitly
    const pos = chartWidth - 1 - Math.floor((t / duration) * chartWidth);
    const label = "-" + formatRelativeTime(t).slice(1); // -M:SS
    const labelStart = Math.max(0, pos - label.length + 1);
    for (let i = 0; i < label.length && labelStart + i < chartWidth; i++) {
      marks[labelStart + i] = label[i];
    }
  }

  // Place +0:00 at the right edge
  const nowLabel = "+0:00";
  const nowStart = chartWidth - nowLabel.length;
  if (nowStart >= 0) {
    for (let i = 0; i < nowLabel.length; i++) {
      marks[nowStart + i] = nowLabel[i];
    }
  }

  axis += `${COLORS.time}${marks.join("")}${RESET}`;
  return axis;
}

// ── Utilities ──
function truncate(str, max) {
  if (!str) return "";
  str = str.trim();
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + "…";
}

function extractFolder(cwd) {
  if (!cwd) return "—";
  const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  return m + "m " + String(s % 60).padStart(2, "0") + "s";
}

function formatRelativeTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `+${m}:${String(s).padStart(2, "0")}`;
}

// ── Fetch events from server ──
function fetchEvents(sessionId) {
  return new Promise((resolve) => {
    const url = sessionId
      ? `/api/events?session_id=${encodeURIComponent(sessionId)}`
      : `/api/events`;
    const req = http.get({ hostname: "127.0.0.1", port: PORT, path: url, timeout: 500 }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve([]); }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

// ── Main ──
async function main() {
  let input = "";
  process.stdin.setEncoding("utf8");

  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let sessionInfo = {};
  try { sessionInfo = JSON.parse(input); } catch {}

  const sessionId = sessionInfo.session_id || null;
  const events = await fetchEvents(sessionId);

  if (events === null) {
    // Server not reachable — fallback
    const cwd = sessionInfo.cwd || process.cwd();
    const folderName = extractFolder(cwd);
    process.stdout.write(
      `${COLORS.header}${BOLD}─── Agent Timeline ───${RESET} ${COLORS.accent}${folderName}${RESET} ${COLORS.dim}(server offline)${RESET}`
    );
    return;
  }

  const chart = renderChart(events, sessionInfo);
  process.stdout.write(chart);
}

main().catch(() => {
  process.stdout.write(`${COLORS.dim}Agent Timeline: error${RESET}`);
});
