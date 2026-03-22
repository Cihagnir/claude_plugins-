# Agent Viewer — Version Notes

## V 0.0.3 — Gantt Chart Dashboard

**Date:** 2026-03-22

### Overview

Complete dashboard redesign from card-based "tactical table" to a real-time Gantt chart timeline. The system visualizes Claude Code agent activity as horizontal bars on a time-based chart, showing what each agent is doing and when.

### System Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Claude Code (hooks)                                     │
│  SessionStart / PreToolUse / PostToolUse / SubagentStart │
│  SubagentStop / Stop / SessionEnd / Notification         │
└────────────────────┬─────────────────────────────────────┘
                     │ HTTP POST (JSON)
                     ▼
┌──────────────────────────────────────────────────────────┐
│  Server (src/server.js)                    Port 3399     │
│  ┌────────────────────────────────────────────────────┐  │
│  │ Event Enrichment Pipeline                          │  │
│  │ • UUID + timestamp generation                      │  │
│  │ • Delegation matching (Agent/Skill → SubagentStart)│  │
│  │ • Subagent session mapping                         │  │
│  │ • Conversation grouping (by transcript_path)       │  │
│  └────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────┐  │
│  │ In-Memory Store                                    │  │
│  │ • sessions Map (session_id → events[])             │  │
│  │ • conversationGroups Map                           │  │
│  │ • subagentSessionMap                               │  │
│  │ • pendingDelegations queue                         │  │
│  └────────────────────────────────────────────────────┘  │
│  WebSocket broadcast to all connected clients            │
└────────────────────┬─────────────────────────────────────┘
                     │ WebSocket (JSON)
                     ▼
┌──────────────────────────────────────────────────────────┐
│  Client (public/app.js)                   Browser UI     │
│  ┌────────────────────────────────────────────────────┐  │
│  │ Agent Tracking                                     │  │
│  │ • Canonical key resolution (merges agent IDs)      │  │
│  │ • Reuses stopped agents of same type               │  │
│  │ • Tracks parent-child relationships                │  │
│  └────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────┐  │
│  │ Activity Period Algorithm                          │  │
│  │ • Groups consecutive events within 5s gap          │  │
│  │ • Each period = one bar on the Gantt chart         │  │
│  │ • Color-coded by primary tool type                 │  │
│  │ • Incremental updates on new events                │  │
│  └────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────┐  │
│  │ SVG Gantt Renderer                                 │  │
│  │ • Agent swimlanes (rows) with labels sidebar       │  │
│  │ • Time axis with absolute + relative timestamps    │  │
│  │ • Auto-follow "now" line with scroll pause detect  │  │
│  │ • Tooltip on hover (tool, duration, detail)        │  │
│  │ • Zoom controls (2–64 px/s)                        │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

### File Structure

```
agent_viewer/
├── .claude-plugin/
│   ├── plugin.json             # Plugin metadata
│   └── marketplace.json        # Marketplace registration
├── hooks/
│   ├── hooks.json              # Hook definitions for Claude Code
│   └── scripts/
│       ├── session-start.sh    # Starts server, opens browser, forwards event
│       ├── session-end.sh      # Forwards SessionEnd event
│       ├── send-event.sh       # Shell wrapper for send-event.js
│       └── send-event.js       # HTTP POST client → /api/event
├── public/
│   ├── index.html              # Dashboard layout: header, gantt view, footer
│   ├── app.js                  # Client logic: agent tracking, gantt rendering, WebSocket
│   └── style.css               # Stitch design system: navy palette, glassmorphic surfaces
├── src/
│   └── server.js               # HTTP + WebSocket server, event enrichment, session store
├── team-agents/                # Agent role definitions for team orchestration
├── stitch_project/             # Design references and screenshots
├── package.json
└── version_notes.md
```

### Key Components

**Event Flow:**
1. Claude Code hooks fire on agent lifecycle events (tool use, subagent spawn/stop, session start/end)
2. Hook scripts POST event JSON to `http://localhost:3399/api/event`
3. Server enriches events (delegation matching, session mapping, conversation grouping)
4. Server broadcasts via WebSocket to all connected browser clients
5. Client processes events, builds activity periods, renders Gantt chart

**Agent Identity Resolution:**
- Each agent gets a canonical key on first appearance
- When the same agent type is re-tasked (stopped → new SubagentStart), the system reuses the existing row instead of creating a new one
- Only creates a new row when agents of the same type run concurrently

**Activity Period Grouping:**
- Consecutive events from the same agent within a 5-second gap are grouped into one "activity period"
- Each period becomes one colored bar on the Gantt chart
- Color is determined by the most frequently used tool in that period
- Gaps between periods represent idle time

**Tool Color Coding:**
| Tool      | Color   |
|-----------|---------|
| Bash      | Blue    |
| Write     | Green   |
| Edit      | Orange  |
| Read      | Purple  |
| Glob/Grep | Teal    |
| Agent     | Pink    |
| Skill     | Purple  |
| MCP       | Orange  |

**Real-Time Features:**
- Auto-scrolling timeline follows current activity ("now" line)
- Manual scroll pauses auto-follow; "Jump to Now" button resumes
- Incremental SVG updates via requestAnimationFrame batching
- WebSocket auto-reconnect on disconnect (2s retry)

**Design System (Stitch "Neural Conduit"):**
- Dark navy palette: `#060e20` → `#162550`
- Primary cyan: `#72dcff` / `#00d2ff`
- Accent purple: `#ddb7ff`
- Glassmorphic surfaces with `backdrop-filter: blur(16px)`
- Inter font family

### Server Details

- Port: 3399 (configurable via `AGENT_VIZ_PORT` env var)
- Max 10,000 events per session (rolling window)
- Auto-shutdown after 30 minutes of inactivity
- Ended sessions pruned after 1 hour
- Single dependency: `ws` (WebSocket library)

---

## V 0.0.2 — Tactical Table Dashboard

Card-based "war room" view with agent cards positioned around a central tactical table. SVG connection lines between parent and child agents. Dual view mode (cards + basic timeline).

## V 0.0.0 — Initial Release

Basic event forwarding infrastructure with hook scripts and server setup.
