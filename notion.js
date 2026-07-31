// ── Notion MCP client ──────────────────────────────────────
// Connects to a LOCALLY RUNNING Notion MCP server (@notionhq/notion-mcp-server),
// not Notion's hosted/remote MCP. The remote server requires interactive
// OAuth, which doesn't fit a headless bot process — the local server uses
// a static integration token instead, set once via NOTION_TOKEN.
//
// Run the server in its own terminal before starting the bot:
//   npx @notionhq/notion-mcp-server --transport http --port 3331 --unsafe-disable-auth
// (the server reads NOTION_TOKEN from the environment automatically if
// it's set in your shell, or pass --auth-token explicitly)
//
// NOTE on --unsafe-disable-auth: by default this server generates its own
// random bearer token to protect the local HTTP endpoint itself — this is
// SEPARATE from NOTION_TOKEN, which is only used by the server to talk to
// Notion's API. Without --unsafe-disable-auth, every client request
// (including this module's) needs that auto-generated token in an
// Authorization header, and it rotates on every server restart. Since
// this server only listens on 127.0.0.1 for local development, disabling
// that extra layer is the simpler and correct choice here — nothing
// outside this machine can reach it either way.
//
// This module is a thin client: connect once, call the search tool,
// return plain text. It mirrors rtsSearch's shape on purpose so it can
// be merged into the same prompt-building pipeline as Slack results.

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const NOTION_MCP_URL = process.env.NOTION_MCP_URL || 'http://127.0.0.1:3331/mcp';

// How long to wait on the local Notion MCP server before giving up and
// falling back to Slack-only content. A server that's down fails fast
// (connection refused) and is already handled below — this guards against
// a server that's up but hung, which would otherwise block the
// Promise.all() this is always called inside of in index.js, stalling
// Slack results too even though the whole point of notionSearch is to
// fail closed without affecting the rest of the pipeline.
const NOTION_TIMEOUT_MS = Number(process.env.NOTION_TIMEOUT_MS) || 8000;

let clientPromise = null;

// Lazily connect once, reuse the connection across calls. If the Notion
// MCP server isn't running, this throws — callers must catch and degrade
// gracefully (no Notion context is better than a crashed briefing).
async function getClient() {
  if (clientPromise) return clientPromise;

  clientPromise = (async () => {
    const transport = new StreamableHTTPClientTransport(new URL(NOTION_MCP_URL));
    const client = new Client({ name: 'teamtrail-notion-client', version: '1.0.0' });
    await client.connect(transport);
    return client;
  })();

  // If connection fails, don't cache the rejected promise — next call
  // should retry instead of failing forever for the rest of the process.
  clientPromise.catch(() => {
    clientPromise = null;
  });

  return clientPromise;
}

// Searches the connected Notion workspace. Returns plain prompt-ready
// text plus a sources array shaped like RTS sources ({ channel, permalink })
// so it merges cleanly with formatCombinedResults in index.js.
//
// Confirmed against a real server via test_notion_mcp.js:
// - tool name is 'API-post-search', not a generic 'search'
// - content[0].text is a JSON STRING (Notion's raw API response), not
//   plain prose — must be JSON.parse'd
// - search results are page metadata only (title + url) — NO body text.
//   To get actual content for the briefing, this fetches markdown for
//   the top result via API-retrieve-page-markdown, rather than just
//   citing a title with nothing for Groq to actually brief from.
async function notionSearch(query, limit = 5, fetchContentForTop = 1) {
  return Promise.race([
    notionSearchInner(query, limit, fetchContentForTop),
    new Promise((resolve) =>
      setTimeout(() => {
        console.error('Notion MCP search timed out after', NOTION_TIMEOUT_MS, 'ms');
        resolve({ promptText: '', sources: [] });
      }, NOTION_TIMEOUT_MS)
    ),
  ]);
}

async function notionSearchInner(query, limit, fetchContentForTop) {
  try {
    const client = await getClient();

    const result = await client.callTool({
      name: 'API-post-search',
      arguments: { query },
    });

    const rawText = result?.content?.find((c) => c.type === 'text')?.text;
    if (!rawText) return { promptText: '', sources: [] };

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      return { promptText: `[N1] Notion: ${rawText.slice(0, 800)}`, sources: [] };
    }

    const pages = (parsed.results || []).slice(0, limit);
    if (!pages.length) return { promptText: '', sources: [] };

    const sources = [];
    const blocks = await Promise.all(
      pages.map(async (page, i) => {
        const title = extractPageTitle(page);
        const url = page.url || '';
        const label = `N${i + 1}`;
        sources.push({ channel: 'notion', permalink: url, label });

        let body = '';
        if (i < fetchContentForTop && page.id) {
          body = await fetchPageMarkdown(client, page.id);
        }

        let entry = `[${label}] Notion page: "${title}"${url ? ` (${url})` : ''}`;
        if (body) entry += `\n${body}`;
        return entry;
      })
    );

    return { promptText: blocks.join('\n---\n'), sources };
  } catch (err) {
    console.error('Notion MCP search failed:', err.message);
    return { promptText: '', sources: [] };
  }
}

// Notion requires exactly one title-type property per page/database, but
// its key name is workspace-defined — commonly "title" or "Name", but not
// guaranteed to be either. Scanning for type === 'title' finds it
// regardless of what it's actually called, instead of guessing two
// hardcoded key names and silently mislabeling anything else as
// "Untitled page".
function extractPageTitle(page) {
  const properties = page.properties || {};
  const titleProp = Object.values(properties).find((p) => p?.type === 'title');
  return titleProp?.title?.[0]?.plain_text || 'Untitled page';
}

// Fetches a page's content as markdown. Truncated to keep prompts from
// ballooning — onboarding docs can be long, and we only need enough for
// Groq to summarize, not the full page verbatim.
async function fetchPageMarkdown(client, pageId) {
  try {
    const result = await client.callTool({
      name: 'API-retrieve-page-markdown',
      arguments: { page_id: pageId },
    });
    const text = result?.content?.find((c) => c.type === 'text')?.text || '';
    return text.slice(0, 1500);
  } catch (err) {
    console.error('Notion page markdown fetch failed:', err.message);
    return '';
  }
}

module.exports = { notionSearch };