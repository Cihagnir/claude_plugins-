#!/usr/bin/env bash
# Agent Viewer — Uninstaller
# Removes hooks and statusline from Claude Code settings.

set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETTINGS_FILE="$HOME/.claude/settings.json"

# Check prerequisites
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js is not installed."
  echo "The uninstaller needs Node.js to update settings.json."
  echo "To manually uninstall, remove agent-viewer entries from ~/.claude/settings.json"
  exit 1
fi

echo "→ Removing Agent Viewer from Claude Code settings..."

if [ ! -f "$SETTINGS_FILE" ]; then
  echo "  No settings file found. Nothing to remove."
  exit 0
fi

node -e "
const fs = require('fs');
const path = process.argv[1];
const settingsFile = process.argv[2];

let settings = {};
try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { process.exit(0); }

const MARKER = 'agent-viewer-plugin';

// Remove hooks that reference this plugin
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
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
}

// Remove statusline if it points to our script
if (settings.statusLine && settings.statusLine.command && settings.statusLine.command.includes(path)) {
  delete settings.statusLine;
}

fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
" "$PLUGIN_DIR" "$SETTINGS_FILE"

echo "  ✓ Hooks removed"
echo "  ✓ Status line reset"
echo ""
echo "Agent Viewer has been uninstalled from Claude Code."
