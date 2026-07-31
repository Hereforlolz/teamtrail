#!/bin/bash
# Starts the bot and, if NOTION_TOKEN is configured, the local Notion MCP
# server alongside it — one entry point that keeps both processes running
# together unattended, instead of requiring someone to open a second
# terminal by hand every time the bot restarts. Also restarts the bot on
# an unexpected crash, with a short backoff, so a transient failure
# doesn't take an unattended deployment offline until someone notices.
#
# If you're running this behind a process supervisor that already
# restarts on crash (systemd Restart=always, Docker --restart, pm2), that
# supervisor should point at this script, not at `node index.js` directly
# — this is what keeps the Notion server paired with the bot.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

NOTION_PID=""

cleanup() {
  if [ -n "$NOTION_PID" ]; then
    echo "Stopping Notion MCP server (pid $NOTION_PID)..."
    kill "$NOTION_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

if [ -n "${NOTION_TOKEN:-}" ]; then
  echo "Starting local Notion MCP server..."
  npx @notionhq/notion-mcp-server --transport http --port 3331 --unsafe-disable-auth &
  NOTION_PID=$!
  sleep 2
else
  echo "NOTION_TOKEN not set — skipping Notion MCP server (bot runs Slack-only)."
fi

echo "Starting TeamTrail bot..."
while true; do
  node index.js
  EXIT_CODE=$?
  echo "Bot process exited (code $EXIT_CODE) — restarting in 5s..."
  sleep 5
done
