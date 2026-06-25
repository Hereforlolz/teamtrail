// Standalone Notion MCP smoke tester — run this BEFORE wiring notion.js
// into index.js, the same way test_rts.sh was used to verify Slack RTS
// before trusting it in the bot.
//
// Usage:
//   1. In one terminal: npx @notionhq/notion-mcp-server --transport http --port 3331 --unsafe-disable-auth
//      (make sure NOTION_TOKEN is set in that terminal's environment, or
//       pass --auth-token ntn_your_token_here)
//      --unsafe-disable-auth skips the server's own auto-generated bearer
//      token requirement for its local HTTP endpoint — fine here since it
//      only listens on 127.0.0.1. Without this flag you'd need to read the
//      rotating token Notion writes to a temp file and send it as a
//      Authorization header, which this test script does not currently do.
//   2. In another terminal: node test_notion_mcp.js
//
// This prints the actual tool list first. Confirmed against a real
// server: the search tool is named 'API-post-search', not a generic
// 'search' — this script auto-detects it by regex match below, but
// verify the match still finds the right tool if the server updates.

require('dotenv').config();
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const NOTION_MCP_URL = process.env.NOTION_MCP_URL || 'http://127.0.0.1:3331/mcp';

async function main() {
  console.log(`── Connecting to Notion MCP server at ${NOTION_MCP_URL} ──`);

  const transport = new StreamableHTTPClientTransport(new URL(NOTION_MCP_URL));
  const client = new Client({ name: 'teamtrail-notion-test', version: '1.0.0' });

  try {
    await client.connect(transport);
    console.log('✅ Connected.\n');
  } catch (err) {
    console.error('❌ Connection failed:', err.message);
    console.error('Is the server running? npx @notionhq/notion-mcp-server --transport http --port 3331');
    process.exit(1);
  }

  console.log('── Test 1: list available tools ──');
  const tools = await client.listTools();
  console.log(JSON.stringify(tools, null, 2));

  const searchToolName = tools.tools?.find((t) => /search/i.test(t.name))?.name;
  console.log(`\nDetected search-like tool name: ${searchToolName || 'NONE FOUND — check tool list above manually'}\n`);

  if (searchToolName) {
    console.log(`── Test 2: call '${searchToolName}' with a sample query ──`);
    try {
      const result = await client.callTool({
        name: searchToolName,
        arguments: { query: 'onboarding' },
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error('Tool call failed:', err.message);
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});