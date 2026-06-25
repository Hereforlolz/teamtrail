#!/bin/bash
# Standalone RTS API test — run this BEFORE wiring app.js back up.
# Usage: SLACK_USER_TOKEN=xoxp-... ./test_rts.sh
# (or just have a .env file with SLACK_USER_TOKEN=xoxp-... in this directory)

# Auto-load .env from the same directory as this script, if present,
# without clobbering a value already exported into this shell.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  source "$SCRIPT_DIR/.env"
  set +a
fi

if [ -z "$SLACK_USER_TOKEN" ]; then
  echo "SLACK_USER_TOKEN is not set."
  echo "Either export it: export SLACK_USER_TOKEN=xoxp-..."
  echo "Or add a line to .env in this folder: SLACK_USER_TOKEN=xoxp-..."
  exit 1
fi

echo "── Test 1: basic message search ──"
curl -s -X POST https://slack.com/api/assistant.search.context \
  -H "Authorization: Bearer $SLACK_USER_TOKEN" \
  -H "Content-Type: application/json; charset=utf-8" \
  -d '{
    "query": "engineering OR project",
    "content_types": ["messages"],
    "channel_types": ["public_channel", "private_channel"],
    "limit": 5
  }' | python3 -m json.tool

echo ""
echo "── Test 2: user/channel discovery ──"
curl -s -X POST https://slack.com/api/assistant.search.context \
  -H "Authorization: Bearer $SLACK_USER_TOKEN" \
  -H "Content-Type: application/json; charset=utf-8" \
  -d '{
    "query": "engineering OR backend",
    "content_types": ["users", "channels"],
    "limit": 5
  }' | python3 -m json.tool

echo ""
echo "── Test 3: semantic query with context messages ──"
curl -s -X POST https://slack.com/api/assistant.search.context \
  -H "Authorization: Bearer $SLACK_USER_TOKEN" \
  -H "Content-Type: application/json; charset=utf-8" \
  -d '{
    "query": "What is the team currently working on?",
    "content_types": ["messages"],
    "include_context_messages": true,
    "limit": 5
  }' | python3 -m json.tool

echo ""
echo "── Test 4: file search (new — confirms file-result schema before trusting it in the bot) ──"
curl -s -X POST https://slack.com/api/assistant.search.context \
  -H "Authorization: Bearer $SLACK_USER_TOKEN" \
  -H "Content-Type: application/json; charset=utf-8" \
  -d '{
    "query": "architecture OR PRD OR roadmap OR doc",
    "content_types": ["files"],
    "limit": 5
  }' | python3 -m json.tool