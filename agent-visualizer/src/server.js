#!/usr/bin/env node
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const PORT = parseInt(process.env.AGENT_VIZ_PORT || "3399", 10);
const MAX_EVENTS_PER_SESSION = 10000;
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const SESSION_EXPIRY_MS = 60 * 60 * 1000; // 1 hour after session ends

const PUBLIC_DIR = path.join(__dirname, "..", "public");

const MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

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

function getOrCreateSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      events: [],
      startTime: new Date().toISOString(),
      endTime: null,
      status: "active",
      cwd: null,
    });
    broadcastSessionsUpdate();
  }
  return sessions.get(sessionId);
}

function getAllEvents() {
  const all = [];
  sessions.forEach((s) => all.push(...s.events));
  all.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return all;
}

function getSessionList() {
  const list = [];
  sessions.forEach((session, sid) => {
    // Find conversation_id for this session
    let conversation_id = null;
    let transcript_path = null;
    conversationGroups.forEach((group, tpath) => {
      if (group.session_ids.has(sid)) {
        conversation_id = group.conversation_id;
        transcript_path = tpath;
      }
    });
    list.push({
      session_id: sid,
      event_count: session.events.length,
      start_time: session.startTime,
      end_time: session.endTime,
      status: session.status,
      conversation_id,
      transcript_path,
      cwd: session.cwd || null,
    });
  });
  list.sort((a, b) => b.start_time.localeCompare(a.start_time));
  return list;
}

function getConversationList() {
  const list = [];
  conversationGroups.forEach((group, tpath) => {
    list.push({
      conversation_id: group.conversation_id,
      transcript_path: tpath,
      session_ids: Array.from(group.session_ids),
    });
  });
  return list;
}

function broadcastSessionsUpdate() {
  const msg = JSON.stringify({ type: "sessions_updated", sessions: getSessionList(), conversations: getConversationList() });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(msg);
  });
}

function broadcastConversationsUpdate() {
  const msg = JSON.stringify({ type: "sessions_updated", sessions: getSessionList(), conversations: getConversationList() });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(msg);
  });
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
  if (req.method === "GET" && pathname === "/api/sessions") {
    return handleGetSessions(req, res);
  }
  if (req.method === "GET" && pathname === "/api/health") {
    const totalEvents = Array.from(sessions.values()).reduce((n, s) => n + s.events.length, 0);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", sessions: sessions.size, events: totalEvents }));
    return;
  }

  // Static file serving
  serveStatic(req, res);
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
        agent_type: raw.agent_type || null,
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
      }

      // --- Conversation grouping by transcript_path ---
      if (event.transcript_path) {
        let group = conversationGroups.get(event.transcript_path);
        if (!group) {
          group = { conversation_id: sid, session_ids: new Set() };
          conversationGroups.set(event.transcript_path, group);
        }
        const isNewSession = !group.session_ids.has(sid);
        group.session_ids.add(sid);
        event.conversation_id = group.conversation_id;
        if (isNewSession && group.session_ids.size > 1) {
          // New session joined an existing conversation — broadcast update
          broadcastConversationsUpdate();
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
        broadcastSessionsUpdate();
      }

      // Broadcast event to all WebSocket clients
      const msg = JSON.stringify(event);
      wss.clients.forEach((client) => {
        if (client.readyState === 1) client.send(msg);
      });

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

function handleGetSessions(req, res) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(getSessionList()));
}

function serveStatic(req, res) {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  let filePath = parsedUrl.pathname === "/" ? "/index.html" : parsedUrl.pathname;
  filePath = path.join(PUBLIC_DIR, path.normalize(filePath));

  // Prevent directory traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/html" });
      res.end("<h1>404 Not Found</h1>");
      return;
    }
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  });
}

// --- WebSocket Server ---

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  lastActivityTime = Date.now();
  // Send history with session list on connect
  ws.send(JSON.stringify({
    type: "history",
    events: getAllEvents(),
    sessions: getSessionList(),
    conversations: getConversationList(),
  }));
});

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
  let pruned = false;
  sessions.forEach((session, sid) => {
    if (session.status === "ended" && session.endTime) {
      const endedAt = new Date(session.endTime).getTime();
      if (now - endedAt > SESSION_EXPIRY_MS) {
        sessions.delete(sid);
        pruned = true;
      }
    }
  });
  if (pruned) broadcastSessionsUpdate();
}, 60000);

function shutdown() {
  clearInterval(inactivityTimer);
  wss.clients.forEach((client) => client.close());
  wss.close();
  server.close(() => process.exit(0));
  // Force exit after 5s
  setTimeout(() => process.exit(0), 5000);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
