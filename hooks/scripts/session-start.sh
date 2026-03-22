#!/usr/bin/env bash
# Starts the agent-visualizer server (if not already running).
# Called by the SessionStart hook. Visualization is shown in the Claude Code status line.

set -euo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
PORT="${AGENT_VIZ_PORT:-3399}"

# Read stdin (hook input JSON)
INPUT=$(cat)

# Use a single shared PID file so multiple sessions share one server
SHARED_PID_FILE="/tmp/agent-viz-server.pid"

# Check if server is already running
if [ -f "$SHARED_PID_FILE" ] && kill -0 "$(cat "$SHARED_PID_FILE")" 2>/dev/null; then
  # Server already running — just forward the session start event
  echo "$INPUT" | node "$PLUGIN_ROOT/hooks/scripts/send-event.js" 2>/dev/null &
  echo '{"suppressOutput": true}'
  exit 0
fi

# Start server in background
AGENT_VIZ_PORT="$PORT" node "$PLUGIN_ROOT/src/server.js" &>/dev/null &
SERVER_PID=$!
echo "$SERVER_PID" > "$SHARED_PID_FILE"

# Wait for server to be ready (up to 3 seconds)
for i in $(seq 1 15); do
  if curl -s "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

# Forward the session start event to the server
echo "$INPUT" | node "$PLUGIN_ROOT/hooks/scripts/send-event.js" 2>/dev/null &

echo '{"suppressOutput": true}'
exit 0
