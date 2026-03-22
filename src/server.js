#!/usr/bin/env node
"use strict";

const http = require("http");
const crypto = require("crypto");

const PORT = parseInt(process.env.AGENT_VIZ_PORT || "3399", 10);
const MAX_EVENTS_PER_SESSION = 10000;
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const SESSION_EXPIRY_MS = 60 * 60 * 1000; // 1 hour after session ends

// In-memory session-indexed event store
// sessionId -> { events: [], startTime, endTime, status }
const sessions = new Map();
let lastActivityTime = Date.now();

// Pending Agent tool delegations awaiting SubagentStart match
// session_id -> [{ subagent_type, description, prompt, timestamp }]
const pendingDelegations = new Map();

// Conversation grouping by transcript_path
// transcript_path -> { conversation_id, session_ids: Set<string> }
const conversationGroups = new Map();

// Subagent session mapping: maps a subagent's own session_id to its canonical
// agent identity so that events arriving on the subagent's session can be
// attributed back to the correct agent card.
// session_id -> { agent_id, agent_type }
const subagentSessionMap = new Map();

// Tracks known subagents awaiting their own session to appear.
// conversation_id -> [{ agent_id, agent_type, parent_session_id }]
const pendingSubagentSessions = new Map();

function getOrCreateSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      events: [],
      startTime: new Date().toISOString(),
      endTime: null,
      status: "active",
      cwd: null,
    });
  }
  return sessions.get(sessionId);
}

function getAllEvents() {
  const all = [];
  sessions.forEach((s) => all.push(...s.events));
  all.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return all;
}

// --- HTTP Server ---

const server = http.createServer((req, res) => {
  lastActivityTime = Date.now();

  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  // API routes
  if (req.method === "POST" && pathname === "/api/event") {
    return handlePostEvent(req, res);
  }
  if (req.method === "GET" && pathname === "/api/events") {
    return handleGetEvents(req, res, parsedUrl);
  }
  if (req.method === "GET" && pathname === "/api/health") {
    const totalEvents = Array.from(sessions.values()).reduce((n, s) => n + s.events.length, 0);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", sessions: sessions.size, events: totalEvents }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

function handlePostEvent(req, res) {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    try {
      const raw = JSON.parse(body);
      const event = {
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        event_type: raw.hook_event_name || "unknown",
        session_id: raw.session_id || null,
        agent_id: raw.agent_id || null,
        agent_type: raw.agent_type || raw.subagent_type || null,
        tool_name: raw.tool_name || null,
        tool_input: raw.tool_input || null,
        tool_result: raw.tool_result || null,
        reason: raw.reason || null,
        transcript_path: raw.transcript_path || null,
        cwd: raw.cwd || null,
        raw,
      };

      const sid = event.session_id || "unknown";

      // --- Delegation tracking ---
      // When parent agent invokes Agent tool, queue the delegation info
      if (event.event_type === "PreToolUse" && event.tool_name === "Agent" && event.tool_input) {
        const queue = pendingDelegations.get(sid) || [];
        queue.push({
          subagent_type: event.tool_input.subagent_type || null,
          description: event.tool_input.description || null,
          prompt: event.tool_input.prompt || null,
          parent_agent_id: event.agent_id || "main",
          timestamp: event.timestamp,
          is_skill: false,
        });
        pendingDelegations.set(sid, queue);
      }

      // When parent agent invokes Skill tool, also queue a delegation
      if (event.event_type === "PreToolUse" && event.tool_name === "Skill" && event.tool_input) {
        const queue = pendingDelegations.get(sid) || [];
        queue.push({
          subagent_type: null,
          description: event.tool_input.skill || null,
          prompt: event.tool_input.args || null,
          parent_agent_id: event.agent_id || "main",
          timestamp: event.timestamp,
          is_skill: true,
        });
        pendingDelegations.set(sid, queue);
      }

      // When subagent starts, match to pending delegation and enrich the event
      if (event.event_type === "SubagentStart" && event.agent_type) {
        const queue = pendingDelegations.get(sid) || [];
        // First: try exact match by subagent_type (for Agent tool delegations)
        let idx = queue.findIndex(d => d.subagent_type === event.agent_type);
        // Fallback: if no exact match, use the oldest unmatched skill delegation
        if (idx === -1) {
          idx = queue.findIndex(d => d.is_skill === true);
        }
        if (idx !== -1) {
          const delegation = queue.splice(idx, 1)[0];
          event.delegation_description = delegation.description;
          event.delegation_prompt = delegation.prompt;
          event.parent_agent_id = delegation.parent_agent_id;
          event.is_skill_subagent = delegation.is_skill || false;
        }
        pendingDelegations.set(sid, queue);

        // Register the subagent so that when its own session appears in the
        // same conversation group, we can attribute those events correctly.
        // The subagent's own session_id is NOT available on SubagentStart —
        // it arrives on the parent's session. So we queue by conversation group
        // and match when a new session joins with a compatible agent_type.
        if (event.agent_id && event.transcript_path) {
          const convKey = event.transcript_path;
          const pending = pendingSubagentSessions.get(convKey) || [];
          pending.push({
            agent_id: event.agent_id,
            agent_type: event.agent_type,
            parent_session_id: sid,
          });
          pendingSubagentSessions.set(convKey, pending);
        }
      }

      // --- Subagent session enrichment ---
      // When we see events from a session that we haven't mapped yet,
      // check if it belongs to a known subagent by matching agent_type
      // against pending subagent registrations in the same conversation group.
      if (event.event_type !== "SubagentStart") {
        const mapped = subagentSessionMap.get(sid);
        if (mapped) {
          // Session already mapped — stamp the event
          if (!event.agent_id) event.agent_id = mapped.agent_id;
          if (!event.agent_type) event.agent_type = mapped.agent_type;
        } else if (!event.agent_id && event.transcript_path) {
          // Try to match this session to a pending subagent
          const pending = pendingSubagentSessions.get(event.transcript_path) || [];
          // Match by agent_type if available, otherwise take the oldest pending
          let idx = event.agent_type
            ? pending.findIndex(p => p.agent_type === event.agent_type && p.parent_session_id !== sid)
            : pending.findIndex(p => p.parent_session_id !== sid);
          if (idx !== -1) {
            const match = pending.splice(idx, 1)[0];
            subagentSessionMap.set(sid, {
              agent_id: match.agent_id,
              agent_type: match.agent_type,
            });
            pendingSubagentSessions.set(event.transcript_path, pending);
            event.agent_id = match.agent_id;
            if (!event.agent_type) event.agent_type = match.agent_type;
          }
        }
      }

      // --- Conversation grouping by transcript_path ---
      if (event.transcript_path) {
        let group = conversationGroups.get(event.transcript_path);
        if (!group) {
          group = { conversation_id: sid, session_ids: new Set() };
          conversationGroups.set(event.transcript_path, group);
        }
        group.session_ids.add(sid);
        event.conversation_id = group.conversation_id;

        // --- Auto-detect subagents by conversation membership ---
        // If this session is NOT the first in the conversation and has no
        // agent_id yet, it's a subagent session. Assign a synthetic identity
        // so the client can show it as a separate agent row.
        if (!event.agent_id && group.conversation_id !== sid) {
          const mapped = subagentSessionMap.get(sid);
          if (mapped) {
            event.agent_id = mapped.agent_id;
            if (!event.agent_type) event.agent_type = mapped.agent_type;
          } else {
            // First time seeing this subagent session — create synthetic identity
            const syntheticId = `sub-${sid.slice(0, 8)}`;
            const syntheticType = event.agent_type || "Subagent";
            subagentSessionMap.set(sid, { agent_id: syntheticId, agent_type: syntheticType });
            event.agent_id = syntheticId;
            if (!event.agent_type) event.agent_type = syntheticType;
          }
        }

        // If this IS the first session (main agent), stamp it
        if (!event.agent_id && group.conversation_id === sid) {
          event.agent_id = "main";
        }
      }

      console.log(`[EVENT] type=${event.event_type} session=${sid} agent_type=${event.agent_type || '-'} transcript=${event.transcript_path || 'none'}`);

      const session = getOrCreateSession(sid);
      if (event.cwd && !session.cwd) session.cwd = event.cwd;
      session.events.push(event);
      if (session.events.length > MAX_EVENTS_PER_SESSION) session.events.shift();

      // Mark session ended if this is a SessionEnd event
      if (event.event_type === "SessionEnd") {
        session.endTime = event.timestamp;
        session.status = "ended";
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
    }
  });
}

function handleGetEvents(req, res, parsedUrl) {
  const sid = parsedUrl.searchParams.get("session_id");
  let result;
  if (sid && sessions.has(sid)) {
    result = sessions.get(sid).events;
  } else {
    result = getAllEvents();
  }
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(result));
}

// --- Lifecycle ---

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Agent Visualizer running at http://localhost:${PORT}`);
});

// Inactivity auto-shutdown + expired session cleanup
const inactivityTimer = setInterval(() => {
  if (Date.now() - lastActivityTime > INACTIVITY_TIMEOUT_MS) {
    console.log("Shutting down due to inactivity.");
    shutdown();
    return;
  }
  // Prune ended sessions older than SESSION_EXPIRY_MS
  const now = Date.now();
  sessions.forEach((session, sid) => {
    if (session.status === "ended" && session.endTime) {
      const endedAt = new Date(session.endTime).getTime();
      if (now - endedAt > SESSION_EXPIRY_MS) {
        sessions.delete(sid);
      }
    }
  });
}, 60000);

function shutdown() {
  clearInterval(inactivityTimer);
  server.close(() => process.exit(0));
  // Force exit after 5s
  setTimeout(() => process.exit(0), 5000);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
