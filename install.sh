#!/usr/bin/env bash
# Agent Viewer — One-command installer
# Registers hooks and statusline in Claude Code settings.

set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETTINGS_DIR="$HOME/.claude"
SETTINGS_FILE="$SETTINGS_DIR/settings.json"

# 0. Check prerequisites
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js is not installed."
  echo "Agent Viewer requires Node.js 18 or later."
  echo "Install it from https://nodejs.org/ or via your package manager."
  exit 1
fi

NODE_VERSION=$(node -e "process.stdout.write(process.versions.node)")
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "ERROR: Node.js $NODE_VERSION is too old."
  echo "Agent Viewer requires Node.js 18 or later (found v$NODE_VERSION)."
  echo "Please upgrade: https://nodejs.org/"
  exit 1
fi

if ! command -v claude &>/dev/null; then
  echo "WARNING: 'claude' CLI not found in PATH."
  echo "Agent Viewer requires Claude Code to function."
  echo "Continuing installation, but hooks won't work without it."
  echo ""
fi

echo "╔══════════════════════════════════════╗"
echo "║   Agent Viewer — Installing...       ║"
echo "╚══════════════════════════════════════╝"
echo ""
echo "  Node.js v$NODE_VERSION detected"
echo ""

# 1. Make hook scripts executable
chmod +x "$PLUGIN_DIR/hooks/scripts/"*.sh || true
echo "  ✓ Hook scripts ready"

# 2. Ensure ~/.claude directory exists
mkdir -p "$SETTINGS_DIR"

# 3. Merge hooks + statusline into settings.json using Node.js
echo "→ Configuring Claude Code settings..."

node -e "
const fs = require('fs');
const path = process.argv[1];
const settingsFile = process.argv[2];

let settings = {};
try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch {}

// Marker to identify our hooks
const MARKER = 'agent-viewer-plugin';

// Remove any existing agent-viewer hooks first (clean re-install)
if (settings.hooks) {
  for (const [event, hookGroups] of Object.entries(settings.hooks)) {
    if (Array.isArray(hookGroups)) {
      settings.hooks[event] = hookGroups.filter(g => {
        const cmds = (g.hooks || []).map(h => h.command || '');
        return !cmds.some(c => c.includes(MARKER) || c.includes(path + '/'));
      });
      if (settings.hooks[event].length === 0) delete settings.hooks[event];
    }
  }
}

if (!settings.hooks) settings.hooks = {};

// Define hook entries
const sessionStartHook = {
  hooks: [{
    type: 'command',
    command: 'CLAUDE_PLUGIN_ROOT=\"' + path + '\" bash \"' + path + '/hooks/scripts/session-start.sh\" # ' + MARKER,
    timeout: 15
  }]
};

const sendEventHook = {
  hooks: [{
    type: 'command',
    command: 'bash \"' + path + '/hooks/scripts/send-event.sh\" # ' + MARKER,
    timeout: 5
  }]
};

const sessionEndHook = {
  hooks: [{
    type: 'command',
    command: 'CLAUDE_PLUGIN_ROOT=\"' + path + '\" bash \"' + path + '/hooks/scripts/session-end.sh\" # ' + MARKER,
    timeout: 10
  }]
};

// Add hooks for each event type
function addHook(event, hook) {
  if (!settings.hooks[event]) settings.hooks[event] = [];
  settings.hooks[event].push(hook);
}

addHook('SessionStart', sessionStartHook);
addHook('SessionEnd', sessionEndHook);
addHook('PreToolUse', sendEventHook);
addHook('PostToolUse', sendEventHook);
addHook('SubagentStart', sendEventHook);
addHook('SubagentStop', sendEventHook);
addHook('Stop', sendEventHook);
addHook('Notification', sendEventHook);

// Set statusline
settings.statusLine = {
  type: 'command',
  command: 'node \"' + path + '/statusline/gantt-statusline.js\"'
};

fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
" "$PLUGIN_DIR" "$SETTINGS_FILE"

echo "  ✓ Hooks registered (8 event types)"
echo "  ✓ Status line configured"
echo ""
echo "╔══════════════════════════════════════╗"
echo "║   ✓ Installation complete!           ║"
echo "╚══════════════════════════════════════╝"
echo ""
echo "Start a new Claude Code session to see the"
echo "Gantt chart timeline in your terminal."
echo ""
echo "To uninstall: bash $PLUGIN_DIR/uninstall.sh"
