require('dotenv').config();
const { App, Assistant } = require('@slack/bolt');
const Groq = require('groq-sdk');
const axios = require('axios');
const { notionSearch } = require('./notion');
const { getContext, updateContext } = require('./store');

// ── Fail fast on missing config ───────────────────────────
// Without this, a missing token surfaces later as an opaque auth error
// from deep inside Bolt or the Groq SDK on the first real event, instead
// of a clear message at boot. NOTION_TOKEN is intentionally excluded —
// it's read by the separate Notion MCP server process, not this one.
const REQUIRED_ENV_VARS = [
  'SLACK_BOT_TOKEN',
  'SLACK_USER_TOKEN',
  'SLACK_SIGNING_SECRET',
  'SLACK_APP_TOKEN',
  'GROQ_API_KEY',
];
const missingEnvVars = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
if (missingEnvVars.length) {
  console.error(`Missing required environment variable(s): ${missingEnvVars.join(', ')}`);
  console.error('Copy .env.example to .env and fill these in before starting the bot.');
  process.exit(1);
}

// ── Crash resilience ───────────────────────────────────────
// Node treats an unhandled promise rejection anywhere in the app as
// fatal by default — logging it instead keeps one missed .catch() from
// taking the whole bot down. uncaughtException logs and exits
// deliberately instead of trying to resume, since process state may be
// corrupt at that point; start.sh's restart loop brings it back up.
process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise rejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception, exiting:', err);
  process.exit(1);
});

// ── Clients ──────────────────────────────────────────────
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── Context store ──────────────────────────────────────────
// getContext/updateContext are now backed by a JSON file on disk (see
// store.js) instead of a plain in-memory object, so per-user state
// survives a process restart.

// ── Per-user serialization ────────────────────────────────
// Slack can deliver a fast follow-up before a slower prior request for
// the same user has finished — e.g. one that's still waiting out the
// Notion timeout — has finished reading and writing that user's context.
// Without this, the second request can read stale context mid-flight:
// topicsCovered can appear empty in its prompt even though the first
// request already pushed onto it, just hasn't persisted yet. Queuing
// every context-mutating handler per user makes each one wait for the
// previous to fully finish before it starts, instead of racing it.
const userQueues = new Map();

function serializedPerUser(userId, task) {
  const previous = userQueues.get(userId) || Promise.resolve();
  const next = previous.then(task, task).finally(() => {
    if (userQueues.get(userId) === next) userQueues.delete(userId);
  });
  userQueues.set(userId, next);
  return next;
}

// ── Role selection buttons ────────────────────────────────
const roleButtons = [
  { text: '⚙️ Engineer', value: 'engineer', action_id: 'role_engineer' },
  { text: '📋 Product Manager', value: 'pm', action_id: 'role_pm' },
  { text: '🎨 Designer', value: 'designer', action_id: 'role_designer' },
  { text: '📊 Other', value: 'other', action_id: 'role_other' },
];

function buildRoleBlock(headerText) {
  const blocks = [];
  if (headerText && headerText.trim()) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: headerText },
    });
  }
  blocks.push({
    type: 'actions',
    block_id: 'role_selection',
    elements: roleButtons.map((r) => ({
      type: 'button',
      text: { type: 'plain_text', text: r.text },
      value: r.value,
      action_id: r.action_id,
    })),
  });
  return { text: headerText && headerText.trim() ? headerText : 'Pick your role:', blocks };
}

// ── Role → search expansion ───────────────────────────────
// RTS supports the OR operator natively. Expanding a bare role into
// related terms gives the search far better recall than the literal
// role word alone, and is a real (not cosmetic) use of RTS query syntax.
const roleSearchTerms = {
  engineer: 'engineering OR backend OR infrastructure OR deployment OR architecture',
  pm: 'roadmap OR product OR launch OR prioritization OR planning',
  designer: 'design OR UX OR figma OR prototype OR user research',
  other: 'onboarding OR team OR projects OR goals',
};

// Notion's search tool takes a plain-text query, not RTS's OR-operator
// syntax — a separate, simpler term per role rather than reusing
// roleSearchTerms with the operators stripped out at runtime.
const notionSearchTerms = {
  engineer: 'engineering architecture deployment',
  pm: 'roadmap product launch',
  designer: 'design UX prototype',
  other: 'onboarding team',
};

// Turn a raw query into a natural-language question when it isn't
// already one. RTS triggers semantic search only when the query begins
// with a question word or ends in "?" — bare keyword queries always
// fall back to keyword search. This nudges /ask toward semantic retrieval
// when it's likely to help, without forcing it on queries that are
// already well-formed keyword/OR searches.
function asSemanticQuery(raw) {
  const trimmed = raw.trim();
  const looksLikeQuestion =
    /^(what|who|where|when|why|how|did|does|is|are|can|could|should)\b/i.test(trimmed) ||
    trimmed.endsWith('?');
  const hasOrOperator = /\bOR\b/.test(trimmed);

  if (looksLikeQuestion || hasOrOperator) return trimmed;
  return `What is the latest on ${trimmed}?`;
}

// ── Real-time Search API (assistant.search.context) ──────
// Uses the xoxp- user token. User-token calls do not require an
// action_token (bot-token calls do, and /ask as a slash command has
// no event-sourced action_token available, so user token is the
// correct choice here, not just the simpler one).
const RTS_URL = 'https://slack.com/api/assistant.search.context';

async function rtsSearch({ query, contentTypes = ['messages'], limit = 10, includeContext = false }) {
  try {
    const res = await axios.post(
      RTS_URL,
      {
        query,
        content_types: contentTypes,
        channel_types: ['public_channel', 'private_channel'],
        include_context_messages: includeContext,
        limit,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.SLACK_USER_TOKEN}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
      }
    );

    if (!res.data.ok) {
      console.error('RTS error:', res.data.error);
      return null;
    }
    return res.data.results;
  } catch (err) {
    console.error('RTS request failed:', err.response?.data || err.message);
    return null;
  }
}

// Formats message results into prompt-ready text AND keeps permalinks
// separately so we can cite sources back to the user — Slack's own
// guidelines call out sourcing/citations as expected behavior for
// RTS-backed apps. Field access is defensive (fallbacks for missing
// channel_name/author_name/content) the same way formatFileResults
// already is — a message with only Block Kit content and no plain text,
// or a deleted-user author, would otherwise inject literal "undefined"
// strings straight into the Groq prompt.
function formatMessageResults(messages = []) {
  if (!messages.length) return { promptText: 'No relevant messages found.', sources: [] };

  const sources = [];
  const blocks = messages.map((m, i) => {
    const channelName = m.channel_name || 'unknown-channel';
    const authorName = m.author_name || 'Unknown';
    const content = m.content || '(no text)';
    const label = String(i + 1);
    sources.push({ channel: channelName, permalink: m.permalink, label });

    let entry = `[${label}] #${channelName} — ${authorName}: ${content}`;

    if (m.context_messages?.before?.length) {
      const before = m.context_messages.before
        .map((c) => `    (before) ${c.author_name || 'Unknown'}: ${c.text || ''}`)
        .join('\n');
      entry += `\n${before}`;
    }
    if (m.context_messages?.after?.length) {
      const after = m.context_messages.after
        .map((c) => `    (after) ${c.author_name || 'Unknown'}: ${c.text || ''}`)
        .join('\n');
      entry += `\n${after}`;
    }
    return entry;
  });

  return { promptText: blocks.join('\n---\n'), sources };
}

// Formats file results from RTS (content_types: ['files']) into the same
// shape as formatMessageResults so they can merge into one prompt + one
// sources list. Field names are defensive (title/name, preview/snippet)
// since RTS's exact file-result schema wasn't confirmed against this
// workspace — empty fields degrade to 'Untitled' rather than throwing.
function formatFileResults(files = [], startIndex = 0) {
  if (!files.length) return { promptText: '', sources: [] };

  const sources = [];
  const blocks = files.map((f, i) => {
    const name = f.title || f.name || 'Untitled file';
    const label = String(startIndex + i + 1);
    sources.push({ channel: f.channel_name || 'file', permalink: f.permalink, label });

    let entry = `[${label}] 📄 File "${name}"${f.filetype ? ` (${f.filetype})` : ''}`;
    if (f.channel_name) entry += ` — shared in #${f.channel_name}`;
    const snippet = f.preview || f.snippet || f.plain_text;
    if (snippet) entry += `\n    ${snippet}`;
    return entry;
  });

  return { promptText: blocks.join('\n---\n'), sources };
}

// Merges message + file results into one prompt block and one combined
// sources list, with file citation numbers continuing on from messages
// instead of restarting at [1].
function formatCombinedResults(messages = [], files = []) {
  const msgResult = formatMessageResults(messages);
  const fileResult = formatFileResults(files, messages.length);

  const promptParts = [msgResult.promptText];
  if (fileResult.promptText) promptParts.push(fileResult.promptText);

  return {
    promptText: promptParts.join('\n---\n'),
    sources: [...msgResult.sources, ...fileResult.sources],
  };
}

function formatSourcesBlock(sources) {
  if (!sources.length) return null;

  // Naive slice(0, 5) on the merged array let Slack message sources
  // (often already 5+) crowd out Notion sources appended at the end —
  // Notion content would show up in the briefing text but never in the
  // Sources block. Reserve room for at least one Notion source if any
  // exist, instead of truncating purely by array order.
  const notionSources = sources.filter((s) => s.channel === 'notion');
  const otherSources = sources.filter((s) => s.channel !== 'notion');

  const notionSlots = notionSources.length ? Math.min(2, notionSources.length) : 0;
  const otherSlots = 5 - notionSlots;

  const selected = [...otherSources.slice(0, otherSlots), ...notionSources.slice(0, notionSlots)];

  // Render each source's own citation label (the same [1]/[N1] marker the
  // prompt told Groq to use inline), not a freshly computed position — a
  // recomputed 1-based index here would drift from the LLM's inline
  // citations the moment sources get filtered/reordered/truncated above.
  const lines = selected
    .map((s) => {
      const displayLabel = s.channel === 'notion' ? '📘 Notion' : s.channel === 'file' ? '📄 file' : `#${s.channel}`;
      const marker = s.label ? `[${s.label}]` : '•';
      if (!s.permalink) return `${marker} ${displayLabel}`;
      return `${marker} <${s.permalink}|${displayLabel}>`;
    })
    .join('\n');
  return {
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `📎 *Sources:*\n${lines}` }],
  };
}

// Real people/channel discovery — replaces the LLM-guessed "types of
// people to meet" with actual users and channels surfaced by RTS.
// NOTE: in sparse sandboxes (few members, little channel topic/activity
// history) this can legitimately return empty arrays even when message
// search works fine for the same query — this is expected RTS behavior,
// not a bug. The downstream prompt is built to handle that gracefully.
async function discoverPeopleAndChannels(role) {
  const results = await rtsSearch({
    query: roleSearchTerms[role] || roleSearchTerms.other,
    contentTypes: ['users', 'channels'],
    limit: 8,
  });

  if (!results) return { users: [], channels: [] };
  return {
    users: results.users || [],
    channels: results.channels || [],
  };
}

// ── Ask Groq ──────────────────────────────────────────────
async function askGroq(prompt, maxTokens = 1024) {
  const response = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  });
  return response.choices[0].message.content;
}

// ── Assistant container (top bar / split pane) ────────────
// Replaces the old /ask slash command and DM-posted role buttons.
// Everything the user types or clicks inside the container now flows
// through this one lifecycle instead of a slash command + action ids.
// IMPORTANT: app.assistant(assistant) is called here, BEFORE any other
// app.event/app.action/app.command registration below. Bolt's assistant()
// method internally calls assistant.getMiddleware() to convert the
// Assistant instance into a valid middleware function before pushing it —
// app.use(assistant) does NOT do this conversion and causes
// "middleware[toCallMiddlewareIndex] is not a function" on every event.
const ROLE_LABELS = {
  engineer: 'Engineer',
  pm: 'Product Manager',
  designer: 'Designer',
  other: 'New Member',
};

// Role keyword patterns shared by detectRoleFromText (the full-briefing
// trigger) and extractStatedRole (inline role capture in follow-ups
// below) — one shared list so a title like "Product Owner" is recognized
// consistently in both places instead of silently diverging.
const ROLE_KEYWORD_PATTERNS = {
  engineer: [/\bengineer(ing)?\b/, /\bdeveloper\b/, /\bswe\b/],
  pm: [/\bproduct manager\b/, /\bproduct owner\b/, /\bpm\b/, /\bpo\b/],
  designer: [/\bdesigner\b/, /\bdesign\b/],
};

function matchRoleKeyword(text) {
  for (const [role, patterns] of Object.entries(ROLE_KEYWORD_PATTERNS)) {
    if (patterns.some((p) => p.test(text))) return role;
  }
  return null;
}

function titleCase(phrase) {
  return phrase.replace(/\b\w/g, (c) => c.toUpperCase());
}

// userMessage gets plain text — if it matches a role-pick prompt
// ("I'm a new Engineer, brief me") we route to handleRoleSelection
// instead of treating it as a follow-up /ask-style question. This
// is what lets Suggested Prompts double as the role-selection entry
// point alongside the explicit buttons.
function detectRoleFromText(text) {
  const t = text.toLowerCase().trim();

  // Require an "I'm ... new" self-announcement before even checking role
  // keywords. A bare substring match on "engineer"/"design"/"pm" anywhere
  // in the message would hijack a genuine follow-up question — e.g.
  // "What's the engineering deploy process?" — into a full re-briefing
  // instead of answering it. All four suggested-prompt strings ("I'm a
  // new Engineer, brief me") satisfy this; ordinary questions don't.
  if (!/\bi'?m\b[^.?!]*\bnew\b|\bi am\b[^.?!]*\bnew\b/.test(t)) return null;

  return matchRoleKeyword(t);
}

// Picks up an inline role self-identification in a follow-up message
// that doesn't match detectRoleFromText's stricter "I'm ... new" gate —
// e.g. "I'm a product owner — what can I get started on". Groq reads the
// raw question text and reflects a role like this back in its answer
// regardless of what's in ctx, so without this, the context store (and
// every later prompt) kept saying role/roleLabel were null even though
// the bot's own reply had already committed to a role. Deliberately
// narrower than a bare keyword search — only fires on an explicit
// "I'm a/an <role>" self-identification — so it doesn't hijack unrelated
// questions the way a plain substring match would.
function extractStatedRole(text) {
  const t = text.toLowerCase();
  const match = t.match(/\bi'?m\s+(?:a|an)\s+([a-z][a-z\s-]{1,40}?)(?:[,.!?—-]|\bwho\b|\bwhat\b|$)/);
  if (!match) return null;

  const phrase = match[1].trim();
  const role = matchRoleKeyword(phrase);
  if (!role) return null;

  return { role, label: titleCase(phrase) };
}

// Lets someone explicitly ask for onboarding on demand — by typing this
// in the assistant pane, or via the /onboard slash command below —
// instead of only via a fresh channel-join event. Closes a real gap:
// someone who missed or dismissed their original welcome message had no
// way back into onboarding at all before this.
const ONBOARD_REQUEST_PATTERN = /\b(re)?-?onboard(ing)?\s*me\b|\b(start|restart)\s+(my\s+)?onboarding\b/i;

function isOnboardRequest(text) {
  return ONBOARD_REQUEST_PATTERN.test(text.trim());
}

// Deliberately NOT a blanket reset. TeamTrail is meant to keep working
// as an ongoing internal assistant once someone's been onboarded, not
// snap back to a blank slate every time this phrase comes up — an
// employee is onboarded once, not repeatedly. So this only shows the
// role-selection flow for someone who was never onboarded in the first
// place (briefingSent: false), and it doesn't touch topicsCovered even
// then — follow-up questions asked before ever completing onboarding
// shouldn't be discarded just because onboarding is happening now.
// For someone who's already onboarded, this is a no-op on their state:
// it just tells them so and keeps them in the conversation. The
// existing 🔄 Refresh my briefing button remains the one deliberate,
// explicit way to actually wipe state and start over — a labeled button
// click is a much clearer "I want a full reset" signal than this
// loosely-typed phrase, so its behavior is unchanged.
async function handleOnboardRequest(userId, say) {
  const ctx = getContext(userId);

  if (ctx.briefingSent) {
    await say(
      `You're already onboarded${ctx.roleLabel ? ` as a *${ctx.roleLabel}*` : ''} — just ask me anything and I'll keep helping. Click *🔄 Refresh my briefing* on your original briefing if you'd like a completely fresh one.`
    );
    return;
  }

  await say(buildRoleBlock(`👋 *Let's get you onboarded — what's your role?*`));
}

const assistant = new Assistant({
  threadStarted: async ({ say, setSuggestedPrompts, saveThreadContext }) => {
    await say(
      buildRoleBlock(
        `👋 *Welcome!* I'm TeamTrail — I build onboarding briefings from real workspace activity, not a static doc.\n\n*What's your role?*`
      )
    );

    await setSuggestedPrompts({
      title: 'Get started:',
      prompts: [
        { title: "I'm a new Engineer", message: "I'm a new Engineer, brief me" },
        { title: "I'm a new PM", message: "I'm a new Product Manager, brief me" },
        { title: "I'm a new Designer", message: "I'm a new Designer, brief me" },
        { title: 'What channels should I join?', message: 'What channels should I join?' },
      ],
    });

    await saveThreadContext();
  },

  threadContextChanged: async ({ saveThreadContext }) => {
    await saveThreadContext();
  },

  userMessage: async ({ message, say, setStatus }) => {
    const userId = message.user;
    const question = (message.text || '').trim();
    if (!question) return;

    // Wrapped in serializedPerUser so a fast second message can't read
    // this user's context before a slower first one (e.g. one still
    // waiting out the Notion timeout) has finished writing its updates —
    // see the comment on serializedPerUser above.
    await serializedPerUser(userId, async () => {
      const ctx = getContext(userId);

      // Route 0: explicit request for onboarding — not limited to a
      // fresh join event. Safe to check before briefingSent: for someone
      // already onboarded this is a no-op that just replies in place,
      // it doesn't reset anything (see handleOnboardRequest).
      if (isOnboardRequest(question)) {
        await handleOnboardRequest(userId, say);
        return;
      }

      // Route 1: role pick typed via suggested prompt instead of button click
      const detectedRole = detectRoleFromText(question);
      if (detectedRole && !ctx.briefingSent) {
        await handleRoleSelection(detectedRole, ROLE_LABELS[detectedRole], userId, say, setStatus);
        return;
      }

      // Route 2: follow-up question — same pipeline /ask used to run
      ctx.questionsAsked.push(question);

      // Pick up an inline role self-identification even when it doesn't
      // match the stricter Route 1 gate (e.g. "I'm a product owner —
      // what can I get started on"), so the context store reflects what
      // the bot's answer actually ends up reflecting back to the user.
      const stated = extractStatedRole(question);
      if (stated) {
        ctx.role = stated.role;
        ctx.roleLabel = stated.label;
      }

      updateContext(userId, {
        questionsAsked: ctx.questionsAsked,
        role: ctx.role,
        roleLabel: ctx.roleLabel,
      });

      await setStatus('Searching the workspace...');

      const semanticQuery = asSemanticQuery(question);
      const [results, notionResult] = await Promise.all([
        rtsSearch({
          query: semanticQuery,
          contentTypes: ['messages', 'files'],
          limit: 10,
          includeContext: true,
        }),
        notionSearch(question),
      ]);

      const slackCombined = formatCombinedResults(results?.messages, results?.files);
      const promptText = [slackCombined.promptText, notionResult.promptText]
        .filter(Boolean)
        .join('\n---\n');
      const sources = [...slackCombined.sources, ...notionResult.sources];

      // An explicit instruction, not just a data field, for whether
      // anything's been covered yet — a passive "Topics already covered: X"
      // line left it to the model to infer it shouldn't say this is a
      // fresh conversation, and it didn't always get that right.
      const topicsLine = ctx.topicsCovered.length
        ? `${ctx.topicsCovered.join(', ')}. This is a continuing conversation — do not say this is their first question or that nothing has been discussed yet; acknowledge what's already covered.`
        : 'None yet — this is genuinely their first question in this conversation.';

      const prompt = `You are an onboarding assistant for a new ${ctx.roleLabel || 'team member'} in a Slack workspace.

Their context:
- Role: ${ctx.roleLabel || 'Unknown'}
- Topics already covered: ${topicsLine}
- Previous questions: ${ctx.questionsAsked.slice(0, -1).join(', ') || 'None yet'}

Their question: "${question}"

Relevant workspace messages, files, and Notion content (numbered, with surrounding context where available):
${promptText}

Answer concisely. Reference result numbers like [1] or [N1] when you draw on a specific result. Only claim a specific document, page, or resource exists if it appears in the numbered results above — if you're not sure something exists, say so instead of naming or linking a resource that isn't actually there. Do NOT repeat topics already covered. Use Slack markdown. End with one follow-up suggestion.`;

      await setStatus('Writing your answer...');

      try {
        const answer = await askGroq(prompt, 512);

        ctx.topicsCovered.push(question.slice(0, 50));
        updateContext(userId, { topicsCovered: ctx.topicsCovered });

        const sourcesBlock = formatSourcesBlock(sources);
        const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: answer } }];
        if (sourcesBlock) blocks.push(sourcesBlock);

        await say({ text: answer, blocks });
      } catch (err) {
        console.error('userMessage error:', err.message);
        await say("Sorry, I ran into a problem answering that — please try again in a moment.");
      }
    });
  },
});

app.assistant(assistant);

// ── Manual onboarding trigger (/onboard slash command) ────
// A more discoverable alternative to typing "onboard me" in the
// assistant pane (Route 0 in userMessage above): this works from
// anywhere — a DM or a channel — and doesn't require already being
// inside, or even knowing about, the assistant container. That makes it
// the better answer for someone who missed their onboarding message
// entirely and has no idea the pane exists. Same non-destructive
// semantics as Route 0 — see handleOnboardRequest above.
//
// Inert until /onboard is registered under Slash Commands in the Slack
// app config (api.slack.com/apps) and the `commands` scope is added and
// the app reinstalled — see README. Until that's done, Slack has nothing
// to route to this handler, so shipping it now is safe either way.
app.command('/onboard', async ({ command, ack, respond }) => {
  await ack();
  const userId = command.user_id;
  if (!userId) return;

  try {
    await serializedPerUser(userId, () => handleOnboardRequest(userId, respond));
  } catch (err) {
    console.error(`/onboard command failed for user ${userId}:`, err);
    try {
      await respond('Sorry, something went wrong starting onboarding — please try again.');
    } catch (respondErr) {
      console.error(`Also failed to notify user ${userId} after an /onboard error:`, respondErr);
    }
  }
});

// ── Step 1: New member joined ─────────────────────────────
// With Agents & AI Apps enabled, the assistant container (top bar /
// split pane) is the primary entry point. We still DM on join, but
// now it's a nudge toward that container rather than buttons posted
// straight into the DM — role selection itself happens inside
// threadStarted below, once the user opens the container.
// A user can join several channels the bot is present in before ever
// opening the assistant pane — this event fires once per channel join,
// not once per user. Gating on `welcomed` (set right after the DM sends,
// separate from `briefingSent`) keeps this a one-time nudge instead of
// one DM per channel joined.
app.event('member_joined_channel', async ({ event, client }) => {
  const userId = event.user;
  const ctx = getContext(userId);
  if (ctx.briefingSent || ctx.welcomed) return;

  try {
    await client.chat.postMessage({
      channel: userId,
      text: `👋 *Welcome to the workspace!*\n\nI'm your onboarding assistant — open me from the *top bar* (or click here) to get a briefing built from real workspace activity, not a static doc.`,
    });
    updateContext(userId, { welcomed: true });
  } catch (err) {
    console.error('Welcome DM error:', err.message);
  }
});

// ── Step 2: Role selected → generate briefing ─────────────
// `say` posts into the active assistant thread (works for both the
// button-click path and a typed "I'm an Engineer" path via userMessage).
async function handleRoleSelection(role, roleLabel, userId, say, setStatus) {
  // The whole function body is now one try/catch, not just the askGroq
  // call — the initial ack `say()` below used to sit outside any guard,
  // so a failure there (or in anything else before the old try block)
  // propagated as an unhandled rejection with no log detail and no
  // message to the user: a button click that silently did nothing.
  const ctx = getContext(userId);

  try {
    updateContext(userId, { role, roleLabel });

    const article = /^[aeiou]/i.test(roleLabel) ? 'an' : 'a';
    await say(`Got it — you're ${article} *${roleLabel}*! Pulling together your briefing... ⏳`);
    if (setStatus) await setStatus('Searching the workspace...');

    const searchTerms = roleSearchTerms[role] || roleSearchTerms.other;
    const notionTerms = notionSearchTerms[role] || notionSearchTerms.other;

    const [messageResults, discovery, notionResult] = await Promise.all([
      rtsSearch({ query: searchTerms, contentTypes: ['messages', 'files'], limit: 10, includeContext: true }),
      discoverPeopleAndChannels(role),
      notionSearch(notionTerms),
    ]);

    const slackCombined = formatCombinedResults(messageResults?.messages, messageResults?.files);
    const promptText = [slackCombined.promptText, notionResult.promptText]
      .filter(Boolean)
      .join('\n---\n');
    const sources = [...slackCombined.sources, ...notionResult.sources];

    const peopleList = discovery.users
      .slice(0, 5)
      .map((u) => `${u.full_name}${u.title ? ` (${u.title})` : ''}`)
      .join(', ') || 'No specific matches found yet';

    const channelList = discovery.channels
      .slice(0, 5)
      .map((c) => `#${c.name}`)
      .join(', ') || 'No specific matches found yet';

    const prompt = `You are an intelligent onboarding assistant for a new ${roleLabel} joining a Slack workspace.

Based on the following recent Slack messages and files, plus any relevant Notion pages (marked with [N1], [N2], etc., with surrounding context where available), create a personalised onboarding briefing.

Recent workspace activity:
${promptText}

Real people relevant to this role, found via workspace search: ${peopleList}
Real channels relevant to this role, found via workspace search: ${channelList}

Write a briefing that includes:
1. A 2-3 sentence summary of what's currently happening relevant to a ${roleLabel}
2. 2-3 specific topics or projects they should know about, grounded in the messages/files/Notion content above
3. Name-check 2-3 of the real people listed above and why they're worth introducing yourself to (use the actual names given, do not invent people)
4. Recommend 2-3 of the real channels listed above (use the actual channel names given, do not invent channels)
5. One piece of advice for their first week

Keep it warm, concise, and actionable. Use Slack markdown (bold with *asterisks*, bullets with •). If no real people/channels were found, say so honestly instead of making something up. If no Notion content was found, don't mention Notion at all — just use what's available. Only mention a specific document, page, or resource (like a handbook or guide) if it appears in the numbered results above — don't invent a title for something that isn't actually there.`;

    if (setStatus) await setStatus('Writing your briefing...');

    const briefing = await askGroq(prompt);

    // Append, don't replace — this can run for a user who already asked
    // follow-up questions (and accumulated topicsCovered) before ever
    // selecting a role, since Route 2 in userMessage never required a
    // role/briefing to exist first. Overwriting here silently discarded
    // that history.
    updateContext(userId, {
      briefingSent: true,
      topicsCovered: [...ctx.topicsCovered, role, 'initial briefing'],
    });

    const sourcesBlock = formatSourcesBlock(sources);
    const blocks = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `🧠 *Your personalised briefing:*\n\n${briefing}` },
      },
    ];
    if (sourcesBlock) blocks.push(sourcesBlock);
    blocks.push(
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `💬 Just type a follow-up question anytime — I keep context across the session.`,
        },
      },
      {
        type: 'actions',
        block_id: 'followup_actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '🔄 Refresh my briefing' },
            value: 'refresh',
            action_id: 'refresh_briefing',
          },
        ],
      }
    );

    await say({ text: briefing, blocks });
  } catch (err) {
    console.error(`handleRoleSelection failed for role "${role}" (user ${userId}):`, err);
    try {
      await say("Sorry, I ran into a problem putting together your briefing — please try again in a moment.");
    } catch (sayErr) {
      console.error(`Also failed to notify user ${userId} about the briefing error:`, sayErr);
    }
  }
}

// ── Refresh briefing button ───────────────────────────────
// NOTE: say() inside app.action() does not reliably post into the
// active assistant thread — observed posting into App Home History
// instead of the live Chat pane. Posting explicitly via
// client.chat.postMessage with the action's own channel + thread_ts
// keeps the reply anchored to the thread the button was clicked in.
app.action('refresh_briefing', async ({ ack, body, client }) => {
  await ack();
  updateContext(body.user.id, { briefingSent: false, topicsCovered: [] });

  const block = buildRoleBlock(`🔄 *Let's refresh your briefing!*\n\nWhat's your role?`);
  await client.chat.postMessage({
    channel: body.channel?.id || body.user.id,
    thread_ts: body.container?.thread_ts,
    ...block,
  });
});

// ── Role button handlers ──────────────────────────────────
// Keys here must be the same canonical roles used by roleSearchTerms /
// notionSearchTerms / ROLE_LABELS ('engineer' / 'pm' / 'designer' /
// 'other'). This used to hardcode a separate, drifted set of strings
// ('product manager', 'design', 'general onboarding') that matched
// nothing else in the file — roleButtons above already carries the
// correct keys as each button's `value`, but that value was never read.
// The mismatch had two consequences: role/roleLabel written to the
// context store from a button click didn't match what extractStatedRole
// or detectRoleFromText would ever produce for the same role, and
// roleSearchTerms[role] / notionSearchTerms[role] silently missed for
// PM, Designer, and Other, falling back to the generic 'other' search
// terms for every role except Engineer. Deriving roleLabel from
// ROLE_LABELS instead of a second hardcoded string removes the
// possibility of this drifting again.
const roleMap = {
  role_engineer: 'engineer',
  role_pm: 'pm',
  role_designer: 'designer',
  role_other: 'other',
};

Object.entries(roleMap).forEach(([actionId, role]) => {
  app.action(actionId, async ({ body, client, ack }) => {
    await ack();
    const userId = body.user.id;
    const roleLabel = ROLE_LABELS[role];
    const channel = body.channel?.id || body.user.id;
    const threadTs = body.container?.thread_ts;
    const sayToThread = async (payload) => {
      const msg = typeof payload === 'string' ? { text: payload } : payload;
      return client.chat.postMessage({ channel, thread_ts: threadTs, ...msg });
    };

    // Outer safety net around the whole handler, on top of
    // handleRoleSelection's own internal try/catch — a role button click
    // was observed producing no visible response in Slack at all, with
    // nothing logged; this makes sure that can't happen silently again,
    // whatever the actual cause turns out to be.
    try {
      // Wrapped in the same serializedPerUser queue userMessage uses, so
      // a button click and a typed follow-up for the same user can't
      // race each other's context reads/writes either.
      await serializedPerUser(userId, async () => {
        // The role buttons posted in threadStarted stay clickable for the
        // life of the thread — Slack doesn't disable them after use.
        // Without this guard, clicking one again after onboarding re-runs
        // handleRoleSelection, which used to overwrite topicsCovered
        // (now fixed to append instead). Route repeat clicks through the
        // same intentional reset as the Refresh button instead.
        const ctx = getContext(userId);
        if (ctx.briefingSent) {
          await sayToThread(
            "You've already got a briefing! Click *🔄 Refresh my briefing* below if you'd like a new one."
          );
          return;
        }

        await handleRoleSelection(role, roleLabel, userId, sayToThread, null);
      });
    } catch (err) {
      console.error(`Role button handler (${actionId}) failed for user ${userId}:`, err);
      try {
        await client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: 'Sorry, something went wrong handling that — please try again.',
        });
      } catch (notifyErr) {
        console.error(`Also failed to notify user ${userId} after a role button error:`, notifyErr);
      }
    }
  });
});

// ── Start ─────────────────────────────────────────────────
(async () => {
  await app.start();
  console.log('⚡ TeamTrail is running!');
})();