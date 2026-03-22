#!/usr/bin/env bash
# Forwards the SessionEnd event. Does NOT kill the server — other sessions may still be active.
# The server auto-shuts down after 30 minutes of inactivity.

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"

# Read stdin
INPUT=$(cat)

# Forward end event to the server
echo "$INPUT" | node "$PLUGIN_ROOT/hooks/scripts/send-event.js" 2>/dev/null

echo '{"suppressOutput": true}'
exit 0
