# Agent Viewer

Real-time terminal Gantt chart that visualizes what your Claude Code agents are doing — tool calls, subagent spawns, and task delegation — all on a live timeline in your terminal.

## What It Does

When Claude Code runs agents and tools, this plugin captures every event and displays it as a horizontal timeline directly in your terminal:

- **Each agent gets a row** — main agent at top, subagents below
- **Activity bars** show what each agent is doing over time, color-coded by tool type
- **Real-time updates** — the chart refreshes after every assistant message
- **Runs in your terminal** — no browser needed, displayed directly below the Claude Code input

## Requirements

- **Node.js** 18+ (with npm)
- **Claude Code** CLI

## Installation

```bash
git clone https://github.com/cihangir/agent-viewer.git
cd agent-viewer
bash install.sh
```

That's it. The install script will:
1. Register event hooks in your Claude Code settings (`~/.claude/settings.json`)
2. Configure the terminal Gantt chart as your Claude Code status line

Start a new Claude Code session and the timeline will appear below your input.

## Uninstall

```bash
bash uninstall.sh
```

Removes all hooks and the status line from your Claude Code settings. Does not delete any files.

## How It Works

```
Claude Code ──(hooks)──> Server ──(HTTP API)──> Statusline Renderer
```

1. **Hooks** — The plugin registers lifecycle hooks with Claude Code (`hooks/hooks.json`). These fire on every tool call, subagent spawn/stop, and session start/end.

2. **Event forwarding** — Hook scripts (`hooks/scripts/`) read the event JSON from stdin and POST it to the local server.

3. **Server** (`src/server.js`) — A lightweight Node.js HTTP server that:
   - Receives events via `POST /api/event`
   - Enriches them (delegation matching, conversation grouping)
   - Serves event data via `GET /api/events` for the statusline renderer
   - Auto-starts on first session, auto-shuts down after 30 min inactivity

4. **Statusline** (`statusline/gantt-statusline.js`) — A terminal Gantt chart renderer that fetches events from the server and draws an ASCII timeline.

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `AGENT_VIZ_PORT` | `3399` | Port for the visualization server |

To use a custom port:

```bash
export AGENT_VIZ_PORT=8080
```

## Usage

Once installed, the timeline is fully automatic:

- **Start a Claude Code session** — the server starts and the Gantt chart appears in your terminal
- **Activity bars** grow in real-time as agents work — colored by tool type
- **Multiple agents** — main agent at top, subagents below with indentation
- **Stats** — agent count, event count, and session duration at the bottom

## What It Looks Like

```
 Main Agent   │ ▓▓▓▓████░░██▓▓▓▓▓▓████████░░▓▓██████
 Explore      │         ████████░░░░░░░░░░████
 Dev          │                   ░░██████████████████
─────────────┴──────────────────────────────────────
  ██ Bash  ██ Write  ██ Edit  ██ Read  ██ Glob  ██ Agent  ██ Skill  ██ Thinking  ██ MCP  ▓▓ Active
  Agents: 3  Events: 47  Duration: 2m 15s
```

Each row is an agent. Colored bars show tool activity over time. The chart updates live as agents work.

## Tool Color Legend

| Color | Tools |
|-------|-------|
| Blue | Bash |
| Green | Write |
| Yellow | Edit, MultiEdit |
| Purple | Read |
| Teal | Glob, Grep |
| Pink | Agent (subagent spawn) |
| Amber | Thinking |
| Violet | Skill |
| Orange | MCP tools, Notifications |

## Project Structure

```
agent-viewer/
├── install.sh                  # One-command setup
├── uninstall.sh                # Clean removal
├── hooks/
│   ├── hooks.json              # Hook event definitions
│   └── scripts/                # Event forwarding scripts
├── statusline/
│   └── gantt-statusline.js     # Terminal Gantt chart renderer
├── src/
│   └── server.js               # HTTP event server
├── package.json
└── version_notes.md
```

## Troubleshooting

**Status line not showing**
- Verify install ran successfully: check `~/.claude/settings.json` has a `statusLine` entry
- Re-run `bash install.sh` to fix

**No events / empty chart**
- Check if the server is running: `curl http://localhost:3399/api/health`
- If not, start it manually: `node src/server.js`
- Verify hooks are in `~/.claude/settings.json` — look for entries referencing your install path
- Make sure `node` is available in your PATH

**Port conflict**
- Set a different port: `export AGENT_VIZ_PORT=8080`
- Update the port before starting your Claude Code session

**Server won't start**
- Check if another process is using port 3399: `lsof -i :3399`
- Remove stale PID file if needed: `rm /tmp/agent-viz-server.pid`

**Re-install after moving the repo**
- Run `bash install.sh` again from the new location — it updates all paths automatically

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to report bugs, submit changes, and run locally.

## License

MIT — see [LICENSE](LICENSE) for details.
