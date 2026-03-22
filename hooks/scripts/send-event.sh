#!/usr/bin/env bash
# Forwards hook event JSON (from stdin) to the agent-visualizer server.
# Always exits 0 — visualization failures must never block Claude Code.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
node "$SCRIPT_DIR/send-event.js" 2>/dev/null
exit 0
