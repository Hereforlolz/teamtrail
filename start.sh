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

NODE_ENV="${NODE_ENV:-development}"
NOTION_MCP_PORT="${NOTION_MCP_PORT:-3331}"
NOTION_HEALTH_URL="http://127.0.0.1:${NOTION_MCP_PORT}/health"
NOTION_READY_TIMEOUT_SECS="${NOTION_READY_TIMEOUT_SECS:-30}"

NOTION_PID=""

cleanup() {
  if [ -n "$NOTION_PID" ]; then
    echo "Stopping Notion MCP server (pid $NOTION_PID)..."
    kill "$NOTION_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# Bash built-in TCP probe — no dependency on lsof/nc being installed.
# Returns success (0) if something is already listening on the port.
port_in_use() {
  local port="$1"
  (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null
  local result=$?
  exec 3>&- 2>/dev/null || true
  return $result
}

if [ -n "${NOTION_TOKEN:-}" ]; then
  # --unsafe-disable-auth turns off the Notion MCP server's own bearer-
  # token protection on its local HTTP endpoint. Safe on 127.0.0.1 for
  # local development (nothing outside this machine can reach it either
  # way), but not something that should silently run in an environment
  # anyone's calling "production" — refuse by default, require an
  # explicit opt-in to proceed anyway.
  if [ "$NODE_ENV" = "production" ] && [ "${NOTION_ALLOW_UNSAFE_AUTH:-}" != "true" ]; then
    echo "ERROR: refusing to start the local Notion MCP server with --unsafe-disable-auth under NODE_ENV=production." >&2
    echo "This disables the server's bearer-token auth on its local HTTP endpoint and is only intended for local development. Set NOTION_ALLOW_UNSAFE_AUTH=true to override if you've deliberately decided this is safe for your deployment (e.g. it only ever listens on loopback)." >&2
    exit 1
  fi

  if port_in_use "$NOTION_MCP_PORT"; then
    echo "ERROR: port $NOTION_MCP_PORT is already in use — is another instance of the Notion MCP server (or this script) already running?" >&2
    echo "Check for and stop any leftover process before retrying, e.g.: lsof -i :$NOTION_MCP_PORT" >&2
    exit 1
  fi

  echo "Starting local Notion MCP server on port $NOTION_MCP_PORT..."
  npx @notionhq/notion-mcp-server --transport http --port "$NOTION_MCP_PORT" --unsafe-disable-auth &
  NOTION_PID=$!

  echo "Waiting for Notion MCP server to become healthy at $NOTION_HEALTH_URL..."
  waited=0
  until curl -sf "$NOTION_HEALTH_URL" >/dev/null 2>&1; do
    if ! kill -0 "$NOTION_PID" 2>/dev/null; then
      echo "ERROR: Notion MCP server process exited before becoming healthy." >&2
      exit 1
    fi
    if [ "$waited" -ge "$NOTION_READY_TIMEOUT_SECS" ]; then
      echo "ERROR: Notion MCP server did not become healthy within ${NOTION_READY_TIMEOUT_SECS}s — giving up." >&2
      exit 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  echo "Notion MCP server is healthy."
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
