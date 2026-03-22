# Contributing to Agent Viewer

Thanks for your interest in contributing! Here's how to get started.

## Reporting Bugs

Open a GitHub Issue with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Your Node.js version (`node --version`) and OS

## Submitting Changes

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Test locally: run `bash install.sh` and verify the statusline works in a Claude Code session
4. Open a Pull Request with a clear description of what changed and why

## Running Locally

```bash
git clone <your-fork-url> agent-viewer
cd agent-viewer
bash install.sh
```

To test the server standalone:

```bash
node src/server.js
curl http://localhost:3399/api/health
```

## Project Structure

- `src/server.js` — HTTP event server
- `statusline/gantt-statusline.js` — Terminal Gantt chart renderer
- `hooks/` — Claude Code lifecycle hooks and event forwarding scripts
- `install.sh` / `uninstall.sh` — Setup and teardown

## Code Style

- Keep it simple — this is a lightweight plugin
- No build step, no transpilation — plain Node.js
- Test your changes with a real Claude Code session before submitting
