# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Agent Viewer is a Claude Code plugin that displays a real-time terminal Gantt chart visualizing agent activity (tool calls, subagent spawns, task delegation) directly in the Claude Code status line. No browser needed — pure terminal ASCII rendering.

## Architecture

The system follows an event-sourcing pipeline:

```
Claude Code hooks → Shell scripts → HTTP POST → Node.js server (in-memory store) → Statusline renderer (GET + ASCII draw)
```

**Three core components:**

1. **Hook scripts** (`hooks/scripts/`) — Shell+Node scripts triggered by Claude Code lifecycle events. They read JSON from stdin and POST it to the local server. `session-start.sh` also starts the server if not running. All scripts exit 0 to never block Claude Code.
   - `session-start.sh` — Starts the server process if not running (checks PID file), waits up to 3s for health check, then forwards the event.
   - `send-event.sh` → `send-event.js` — Thin shell wrapper calls Node script that POSTs raw hook JSON to `POST /api/event`. Injects `cwd` if missing.
   - `session-end.sh` — Forwards session end event.

2. **Event server** (`src/server.js`) — HTTP server on port 3399 (configurable via `AGENT_VIZ_PORT`). Stores events in-memory indexed by session ID. Has a three-stage enrichment pipeline on each incoming event:
   - **Delegation tracking** — Queues PreToolUse events for Agent/Skill tools, then matches them to subsequent SubagentStart events to attach `delegation_description` and parent identity.
   - **Subagent session mapping** — Maps subagent session IDs back to their canonical agent identity using `transcript_path`-based conversation groups. Creates synthetic IDs (`sub-{sid8}`) for unmatched subagent sessions.
   - **Conversation grouping** — Groups sessions sharing the same `transcript_path`. First session = main agent, subsequent sessions = subagents.

3. **Statusline renderer** (`statusline/gantt-statusline.js`) — Reads session info JSON from stdin (provided by Claude Code), fetches events via `GET /api/events?session_id=X`, and outputs ANSI-colored ASCII Gantt chart to stdout.

**Supporting files:**
- `install.sh` / `uninstall.sh` — Register/remove hooks and statusline config in `~/.claude/settings.json`. Hooks are identified by an `agent-viewer-plugin` marker string for clean re-installs.
- `hooks/hooks.json` — Declarative hook definitions (reference only; `install.sh` generates the actual settings with absolute paths).
- `.claude-plugin/` — Plugin marketplace metadata (`plugin.json`, `marketplace.json`).

## Server API

- `POST /api/event` — Receives hook event JSON body. Returns `{ ok: true }`.
- `GET /api/events?session_id=X` — Returns event array for a session (or all events if no session_id).
- `GET /api/health` — Returns `{ status: "ok", sessions: N, events: N }`.

## Key Constants

| Constant | Location | Value | Purpose |
|----------|----------|-------|---------|
| `AGENT_VIZ_PORT` | env var | `3399` | Server port |
| `GAP_THRESHOLD_MS` | gantt-statusline.js | `5000` | Max gap between events before splitting into separate activity periods |
| `MAX_AGENTS` | gantt-statusline.js | `8` | Max agent rows displayed in the chart |
| `MAX_EVENTS_PER_SESSION` | server.js | `10000` | Ring buffer size per session |
| `INACTIVITY_TIMEOUT_MS` | server.js | `30 min` | Server auto-shutdown timer |
| `SESSION_EXPIRY_MS` | server.js | `1 hour` | Prune ended sessions after this |

## Development Commands

```bash
# Start the server standalone
node src/server.js

# Health check
curl http://localhost:3399/api/health

# Send a test event
echo '{"hook_event_name":"PreToolUse","session_id":"test","tool_name":"Bash"}' | curl -X POST -H 'Content-Type: application/json' -d @- http://localhost:3399/api/event

# Install hooks + statusline into Claude Code
bash install.sh

# Remove hooks + statusline
bash uninstall.sh

# Test the renderer manually (pipe session info JSON to stdin)
echo '{"session_id":"test","cwd":"/tmp"}' | node statusline/gantt-statusline.js
```

There is no build step, no transpilation, no test suite. All code is plain Node.js (CommonJS, no dependencies). Testing is done by running `install.sh` and verifying the statusline works in a live Claude Code session.

## Key Design Decisions

- **All hook scripts exit 0 unconditionally** — visualization failures must never block Claude Code operations. Errors are silently swallowed.
- **Single shared server** — Multiple Claude Code sessions share one server process via a PID file at `/tmp/agent-viz-server.pid`.
- **Subagent identity resolution** — The server correlates parent PreToolUse(Agent) events with subsequent SubagentStart events to enrich subagent identity. It also uses `transcript_path` to group sessions from the same conversation and auto-detect subagent sessions.
- **Right-to-left timeline** — The Gantt chart renders with "now" on the right edge and past extending leftward, using the full terminal width.
- **No external dependencies** — Only Node.js built-ins (`http`, `crypto`). The `node_modules/` directory exists but `package.json` has empty dependencies.
- **Activity period merging** — The renderer groups rapid events (within `GAP_THRESHOLD_MS`) into continuous activity bars. The "primary tool" for each period is the most frequent tool in that period.

## Skill Usage Rules

- **superpowers** — Use only during planning sessions (architecture discussions, design decisions, task breakdown). Do NOT use superpowers during active coding/implementation work.
