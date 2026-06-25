# TeamTrail

An AI-powered, stateful onboarding agent for Slack, built on Slack's **Agents & AI Apps** platform. New members open TeamTrail from the top-bar entry point, pick their role, and get a personalised briefing generated from real workspace history via Slack's Real-time Search API and LLaMA 3.3 70B via Groq — grounded in actual messages, real people, and real channels. They can keep asking questions in the same pane afterward, with full context awareness across the session.

Built for the **Slack Agent Builder Challenge 2026**.

---

## How it works

```
User opens TeamTrail from the top bar / split pane
       │
       ▼
Assistant thread starts → role buttons + suggested prompts shown
       │
       ▼
User picks a role (button click or typed prompt)
       │
       ├──→  RTS searches workspace messages, files, users, channels
       └──→  Notion MCP searches connected pages, fetches top page content
       │
       ▼
Groq (LLaMA 3.3 70B) generates personalised briefing, grounded in combined results
       │
       ▼
Briefing posted in-thread with cited source permalinks (Slack + Notion) + Refresh button
       │
       ▼
Follow-up question typed in the pane  →  same combined search  →  Groq answer with citations  →  context updated
```

---

## Features

- **Native Slack AI app surface** — lives in the top bar with a dedicated split-pane container (Slack's Agents & AI Apps feature), not a slash command
- **Role-aware onboarding** — Engineer, PM, Designer, or Other, each mapped to different RTS search terms for better recall
- **Two ways to pick a role** — explicit buttons in the thread, or fixed suggested prompts ("I'm a new Engineer, brief me") that route through the same handler
- **Real-time workspace search** via `assistant.search.context` (Slack's RTS API) — searches actual messages, users, and channels, not a static knowledge base
- **Semantic query rewriting** — bare keyword queries like `rate limiting` are rewritten to `What is the latest on rate limiting?` to trigger RTS semantic mode; OR-operator queries are left as-is for keyword recall
- **Context message inclusion** — RTS returns surrounding messages before and after each result, giving the LLM conversation-level understanding, not just isolated snippets
- **Cited sources** — every briefing and follow-up response includes permalink-backed source citations so users can jump directly to the original messages
- **Stateful per-user context** — tracks role, topics covered, and questions asked across the session; the LLM is explicitly told not to repeat topics already covered
- **Follow-up questions in-thread** — just type in the assistant pane; same RTS + Groq pipeline that used to live behind `/ask`, with session context carried over
- **Refresh briefing** button — clears state and restarts the onboarding flow
- **Graceful sparse-workspace handling** — if RTS returns no users or channels (expected in sandboxes with limited history), the LLM is prompted to say so honestly rather than hallucinate people or channel names
- **File search** — RTS also searches `files`, not just `messages`, surfacing PRDs and architecture docs shared in Slack
- **Notion MCP integration** — optionally pulls relevant Notion pages into the same briefing/answer pipeline via a locally-run Notion MCP server, merged into one prompt alongside Slack messages and files

---

## Tech stack

| Layer | Technology |
|---|---|
| Slack framework | Slack Bolt for JavaScript (Socket Mode) |
| Slack AI surface | Agents & AI Apps — `Assistant` class (top bar + split pane) |
| AI model | Groq API — LLaMA 3.3 70B Versatile |
| Workspace search | Slack `assistant.search.context` (RTS API) |
| Transport | Socket Mode — no public URL or ngrok needed |
| State | In-memory per-user context store |
| Auth | Bot token (`xoxb-`) for Bolt; User token (`xoxp-`) for RTS |

---

## Architecture

```mermaid
---
config:
  theme: neo
---
flowchart TD
    subgraph Slack["Slack Workspace"]
        TB[Top bar entry point]
        PANE[Assistant split pane]
        BTN[Role selection buttons\nEngineer / PM / Designer / Other]
        PROMPTS[Suggested prompts\nI'm a new Engineer / PM / Designer\nWhat channels should I join?]
        REFRESH[Refresh briefing button]
        OUT1[Briefing message\nwith permalink citations\nSlack + Notion]
        OUT2[Follow-up answer\nwith permalink citations\nSlack + Notion]
    end

    subgraph Bot["index.js — Slack Bolt App (Socket Mode)"]
        ASST[Assistant class\nthreadStarted / threadContextChanged / userMessage]
        DETECT[detectRoleFromText\nrouter: role pick vs follow-up question]
        ACT[Role action handler\nrole_engineer / role_pm\nrole_designer / role_other]
        SQ[asSemanticQuery\nquery rewriter]
        FMT[formatCombinedResults\nmerge Slack messages + files\ninto prompt text + sources]
        FMTN[notionSearch\nmerge Notion page content\ninto same prompt + sources]
        FMTS[formatSourcesBlock\nbuild permalink blocks\nreserves slots for Notion]
        CTX[(In-memory\ncontext store\nrole · topicsCovered\nquestionsAsked · briefingSent)]
    end

    subgraph RTS["Slack RTS API\nassistant.search.context\nxoxp- user token"]
        RTS1[Message + file search\ncontent_types: messages, files\ninclude_context_messages: true]
        RTS2[User + channel discovery\ncontent_types: users, channels]
        RTS3[Follow-up semantic search\ncontent_types: messages, files\ninclude_context_messages: true]
    end

    subgraph Notion["Notion MCP server (local, notion.js)\nnpx @notionhq/notion-mcp-server"]
        NSEARCH[API-post-search\nplain-text query → matching pages]
        NPAGE[API-retrieve-page-markdown\nfetch content for top result]
    end

    subgraph Groq["Groq API\nLLaMA 3.3 70B Versatile"]
        G1[Briefing prompt\nrole + Slack + Notion content\n+ real people + real channels]
        G2[Follow-up prompt\nquestion + Slack + Notion content\n+ session context]
    end

    subgraph RoleExpansion["Role → Search Term Expansion"]
        RE[engineer → engineering OR backend\nOR infrastructure OR deployment\npm → roadmap OR product OR launch\ndesigner → design OR UX OR figma\nother → onboarding OR team OR goals]
    end

    TB --> PANE
    PANE --> ASST
    ASST -->|threadStarted| BTN
    ASST -->|threadStarted| PROMPTS
    BTN -->|action event| ACT
    PROMPTS -->|userMessage text| DETECT
    DETECT -->|role detected| ACT
    ACT --> RE
    RE -->|expanded OR query| RTS1
    RE -->|expanded OR query| RTS2
    RE -->|plain-text query| NSEARCH
    RTS1 -->|messages + files + context| FMT
    RTS2 -->|real users + channels| G1
    NSEARCH -->|matching page IDs| NPAGE
    NPAGE -->|page content| FMTN
    FMT -->|promptText + sources| FMTN
    FMTN -->|merged promptText| G1
    FMTN -->|merged sources| FMTS
    G1 -->|briefing text| OUT1
    FMTS -->|permalink blocks| OUT1
    ACT -->|update context| CTX

    DETECT -->|no role match: follow-up| SQ
    SQ -->|semantic question| RTS3
    SQ -->|raw question text| NSEARCH
    RTS3 -->|messages + files + context| FMT
    FMT -->|promptText + sources| G2
    FMTN -->|merged promptText| G2
    CTX -->|role · topicsCovered\nquestionsAsked| G2
    G2 -->|answer with N citations| OUT2
    FMTS -->|permalink blocks| OUT2
    DETECT -->|append question| CTX

    REFRESH -->|reset briefingSent\nclear topicsCovered| CTX
    CTX -->|rebuilt context| ACT
```

---

## RTS API — what's actually happening

The bot makes three distinct uses of `assistant.search.context`:

**1. Role-aware message and file search**
On role selection, the bot expands the role into an OR-query (e.g. `engineering OR backend OR infrastructure OR deployment OR architecture` for Engineer) and searches `messages` and `files` with `include_context_messages: true`. This gives the LLM conversation threads and shared documents, not just isolated messages.

**2. User and channel discovery**
A second parallel call searches `users` and `channels` with the same role-expanded query, surfacing real people and channels to name-check in the briefing. Note: in sparse sandboxes (few members, little channel history), this legitimately returns empty — the prompt handles this gracefully.

**3. Semantic follow-up search**
Typed follow-up questions are rewritten into natural-language questions before being passed to RTS, nudging the API toward semantic retrieval. Question-phrased and OR-style queries are passed through unchanged. This search also includes `files`.

**User token rationale:** RTS calls use the `xoxp-` user token. Bot-token RTS calls require an `action_token`, which is only available from button/shortcut events — a typed follow-up question in the assistant pane has no such token. The user token is the correct approach, not a workaround.

### Verified test output (sandbox workspace)

```
Test 1 (message search):   ✅  5 messages returned across #all-ai-playground, #design, #engineering
Test 2 (user/channel):     ⚠️  Empty — expected in sparse sandbox (RTS known behaviour)
Test 3 (semantic + ctx):   ✅  5 messages with full before/after context threads
Test 4 (file search):      ✅  files content type returns results — see test_rts.sh
```

---

## Notion MCP — what's actually happening

`notion.js` connects to a locally-run Notion MCP server as an MCP client, and makes two calls per search:

**1. Search** — `API-post-search` with a plain-text query (role-based terms for briefings, the user's raw question for follow-ups). The response is Notion's raw API search JSON, returned inside the MCP `content[0].text` field as a **string** — `notion.js` parses it rather than treating it as prose. Each result is page metadata only: title and URL, no body content.

**2. Page content** — for the top search result, `notion.js` calls `API-retrieve-page-markdown` with that page's ID to actually pull content, since search alone returns nothing for the LLM to summarize. This is truncated to ~1500 characters per page to keep prompts manageable.

Both tool names and the JSON-string response shape were confirmed against a real server run via `test_notion_mcp.js` — they are not guessed. If a future server version changes either, re-run that script to check before assuming `notion.js` still matches.

Notion sources are merged into the same `sources` array as Slack messages/files, and `formatSourcesBlock` reserves at least one slot for Notion citations specifically — a naive `slice(0, 5)` on the combined array let Slack's typically-5+ message results crowd out Notion entries even when Notion content made it into the briefing text.

---

## Project structure

```
├── index.js            # Main bot — Assistant lifecycle, RTS calls, Groq prompts
├── notion.js           # Notion MCP client — connects to a locally-run Notion MCP server
├── test_rts.sh         # Standalone RTS smoke tester (run before deploying)
├── test_notion_mcp.js  # Standalone Notion MCP smoke tester — confirms real tool names/shapes
├── .env                # Secrets (not committed)
├── package.json
└── README.md
```

---

## Setup

### 1. Create a Slack app

Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app **from scratch**.

**OAuth scopes (Bot Token):**
```
channels:history
channels:read
chat:write
groups:history
groups:read
im:write
users:read
```
`assistant:write` is added automatically when you enable Agents & AI Apps in step 2 below — you don't add it manually.

**OAuth scopes (User Token):**
```
search:read
```

### 2. Enable Agents & AI Apps

In the left sidebar, go to **Agents & AI Apps**:
- Toggle **Agent or Assistant** on
- Fill in the **Agent or Assistant Overview** (shown in the split pane before any message is sent)
- Under **Suggested Prompts**, choose **Fixed** and add:

| Title | Message |
|---|---|
| I'm a new Engineer | I'm a new Engineer, brief me |
| I'm a new PM | I'm a new Product Manager, brief me |
| I'm a new Designer | I'm a new Designer, brief me |
| What channels should I join? | What channels should I join? |

Save.

### 3. Event subscriptions

Enable Socket Mode first, then under **Event Subscriptions → Subscribe to bot events**, add:
```
assistant_thread_started
assistant_thread_context_changed
message.im
member_joined_channel
```

**App-level token:** Create one with `connections:write` scope — this is your `SLACK_APP_TOKEN`.

### 4. Install (or reinstall) the app

If you'd already installed the app before enabling Agents & AI Apps, you must **reinstall** for the new `assistant:write` scope to take effect. Confirm it appears in the scope list before clicking Allow.

### 5. Clone and install

```bash
git clone <repo-url>
cd teamtrail
npm install
```

### 6. Configure environment

Create a `.env` file:

```env
SLACK_BOT_TOKEN=xoxb-...
SLACK_USER_TOKEN=xoxp-...
SLACK_SIGNING_SECRET=...
SLACK_APP_TOKEN=xapp-...
GROQ_API_KEY=...
```

### 7. Smoke-test RTS before starting the bot

```bash
chmod +x test_rts.sh
./test_rts.sh
```

This runs three RTS calls directly against your workspace and pretty-prints the JSON. Confirm Test 1 and Test 3 return messages before proceeding. Test 2 returning empty in a new workspace is normal.

### 8. Notion MCP (optional but recommended)

TeamTrail can pull context from Notion alongside Slack, via a **locally-run** Notion MCP server — not Notion's hosted/remote MCP, which requires interactive OAuth and doesn't fit a headless bot process.

1. Go to [notion.so/profile/integrations](https://www.notion.so/profile/integrations) → create a new internal integration → copy the token (`ntn_...`)
2. In Notion, open each page/database you want searchable → **•••** menu → **Connections** → add your integration. Pages not explicitly connected are not searchable, even with a valid token.
3. In a separate terminal, run the server with that token. By default the server generates its own random bearer token to protect the local HTTP endpoint (separate from `NOTION_TOKEN`, which is what the server uses to talk to Notion's API) — since this runs on loopback only for local development, disable that extra auth layer rather than juggling a second token:
   ```bash
   NOTION_TOKEN=ntn_your_token_here npx @notionhq/notion-mcp-server --transport http --port 3331 --unsafe-disable-auth
   ```
4. Verify the connection and discover the real tool names before trusting it in the bot:
   ```bash
   node test_notion_mcp.js
   ```
   This prints the server's real `tools/list` response. Confirmed against a live server: the search tool is named **`API-post-search`**, and its result is Notion's raw API response as a JSON **string** inside `content[0].text` (not plain prose) — `notion.js` already parses it this way. If a server update changes either, re-run this script before trusting `notion.js` again.

If the Notion MCP server isn't running, the bot still works — `notionSearch()` fails closed and briefings/answers just use Slack data, same as before this feature existed.

### 9. Start the bot

```bash
node index.js
```

You should see:
```
⚡ TeamTrail is running!
```

---

## Usage

1. Open TeamTrail from the **top bar** in Slack (next to search)
2. Pick a role — click a button, or use one of the suggested prompts
3. A personalised briefing posts in the same pane within a few seconds, with cited sources
4. Type any follow-up question directly in the pane — the bot remembers what's already been covered and won't repeat itself
5. Click **🔄 Refresh my briefing** at any time to restart

---

## Environment variables reference

| Variable | Description |
|---|---|
| `SLACK_BOT_TOKEN` | `xoxb-` token — Bolt framework auth |
| `SLACK_USER_TOKEN` | `xoxp-` token — RTS API calls |
| `SLACK_SIGNING_SECRET` | Request verification |
| `SLACK_APP_TOKEN` | `xapp-` token — Socket Mode connection |
| `GROQ_API_KEY` | Groq API key for LLaMA 3.3 inference |
| `NOTION_TOKEN` | Internal integration token (`ntn_...`) — set in the terminal running the Notion MCP server, not the bot's own `.env`, since the server reads it directly |
| `NOTION_MCP_URL` | Optional — defaults to `http://127.0.0.1:3331/mcp`. Override if running the Notion MCP server on a different port |

---

## Known limitations

- **State is in-memory** — context resets on process restart. A Redis or SQLite layer would make it persistent across deployments. Per Slack's guidance for Agents & AI Apps, only metadata (role, topics, question text) is stored — never raw Slack message content.
- **User/channel discovery** returns empty in sparse workspaces — this is an RTS API behaviour, not a bug. The LLM prompt handles it honestly.
- **Single workspace** — the user token is workspace-scoped. Multi-workspace support would require per-installation token storage.
- **Notion MCP uses the local server, not the hosted one** — Notion's remote MCP requires interactive OAuth per session, which doesn't work for a headless bot. The local server with a static integration token is the only option that fits this architecture.
- **Notion MCP requires `--unsafe-disable-auth` for this setup** — the server's own auto-generated bearer token (separate from `NOTION_TOKEN`) rotates every restart and isn't read by `notion.js`. Disabling it is safe here since the server only listens on `127.0.0.1`, but would need real handling before any deployment beyond local development.
- **Notion page content is fetched for only the top search result** per query (`fetchContentForTop = 1` in `notion.js`), to keep prompt size and latency reasonable. Other matching pages are cited by title/URL only, without their content summarized.
- **Slack's own MCP Server toggle is unused** — Agents & AI Apps settings expose an optional Slack MCP Server (search/post/read via MCP tools instead of direct RTS calls). This build keeps the existing direct RTS calls instead of re-platforming onto it, since it would replace already-working code with an equivalent capability rather than add a new one.

## Known gotchas (Bolt for JS, `@slack/bolt@4.7.3`)

- **`app.use(assistant)` is wrong** — it pushes the raw `Assistant` instance into Bolt's middleware array without converting it, which crashes every incoming event with `middleware[toCallMiddlewareIndex] is not a function`. The correct call is **`app.assistant(assistant)`**, which internally calls `assistant.getMiddleware()` first.
- **`say()` inside `app.action()` doesn't reliably target the active assistant thread** for block actions fired from inside the split pane — messages can end up posted to the App Home History tab instead of the live Chat pane. Posting explicitly via `client.chat.postMessage` with `body.channel.id` and `body.container.thread_ts` keeps the reply anchored to the right thread.
- **Naive `sources.slice(0, 5)` silently dropped Notion citations** — Slack's message search alone often returns 5+ results, so Notion sources appended at the end of the merged array never survived the cutoff, even when Notion content was clearly used in the briefing text. `formatSourcesBlock` now reserves dedicated slots for Notion sources instead of truncating by array order.