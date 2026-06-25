require('dotenv').config();
const { App, Assistant } = require('@slack/bolt');
const Groq = require('groq-sdk');
const axios = require('axios');

// ── Clients ──────────────────────────────────────────────
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── In-memory context store ───────────────────────────────
const contextStore = {};

function getContext(userId) {
  if (!contextStore[userId]) {
    contextStore[userId] = {
      userId,
      role: null,
      roleLabel: null,
      joinedAt: new Date().toISOString(),
      topicsCovered: [],
      questionsAsked: [],
      briefingSent: false,
    };
  }
  return contextStore[userId];
}

function updateContext(userId, updates) {
  contextStore[userId] = { ...getContext(userId), ...updates };
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
// RTS-backed apps.
function formatMessageResults(messages = []) {
  if (!messages.length) return { promptText: 'No relevant messages found.', sources: [] };

  const sources = [];
  const blocks = messages.map((m, i) => {
    sources.push({ channel: m.channel_name, permalink: m.permalink });

    let entry = `[${i + 1}] #${m.channel_name} — ${m.author_name}: ${m.content}`;

    if (m.context_messages?.before?.length) {
      const before = m.context_messages.before
        .map((c) => `    (before) ${c.author_name}: ${c.text}`)
        .join('\n');
      entry += `\n${before}`;
    }
    if (m.context_messages?.after?.length) {
      const after = m.context_messages.after
        .map((c) => `    (after) ${c.author_name}: ${c.text}`)
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
    sources.push({ channel: f.channel_name || 'file', permalink: f.permalink });

    let entry = `[${startIndex + i + 1}] 📄 File "${name}"${f.filetype ? ` (${f.filetype})` : ''}`;
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
  const lines = sources
    .slice(0, 5)
    .map((s, i) => `${i + 1}. <${s.permalink}|#${s.channel}>`)
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

// userMessage gets plain text — if it matches a role-pick prompt
// ("I'm a new Engineer, brief me") we route to handleRoleSelection
// instead of treating it as a follow-up /ask-style question. This
// is what lets Suggested Prompts double as the role-selection entry
// point alongside the explicit buttons.
function detectRoleFromText(text) {
  const t = text.toLowerCase();
  if (/\bengineer/.test(t)) return 'engineer';
  if (/\b(pm|product manager)/.test(t)) return 'pm';
  if (/\bdesign/.test(t)) return 'designer';
  return null;
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
    const ctx = getContext(userId);

    if (!question) return;

    // Route 1: role pick typed via suggested prompt instead of button click
    const detectedRole = detectRoleFromText(question);
    if (detectedRole && !ctx.briefingSent) {
      await handleRoleSelection(detectedRole, ROLE_LABELS[detectedRole], userId, say, setStatus);
      return;
    }

    // Route 2: follow-up question — same pipeline /ask used to run
    ctx.questionsAsked.push(question);
    updateContext(userId, { questionsAsked: ctx.questionsAsked });

    await setStatus('Searching the workspace...');

    const semanticQuery = asSemanticQuery(question);
    const results = await rtsSearch({
      query: semanticQuery,
      contentTypes: ['messages'],
      limit: 10,
      includeContext: true,
    });

    const { promptText, sources } = formatMessageResults(results?.messages);

    const prompt = `You are an onboarding assistant for a new ${ctx.roleLabel || 'team member'} in a Slack workspace.

Their context:
- Role: ${ctx.roleLabel || 'Unknown'}
- Topics already covered: ${ctx.topicsCovered.join(', ') || 'None yet'}
- Previous questions: ${ctx.questionsAsked.slice(0, -1).join(', ') || 'None yet'}

Their question: "${question}"

Relevant workspace messages (numbered, with surrounding context where available):
${promptText}

Answer concisely. Reference message numbers like [1] when you draw on a specific result. Do NOT repeat topics already covered. Use Slack markdown. End with one follow-up suggestion.`;

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
    }
  },
});

app.assistant(assistant);

// ── Step 1: New member joined ─────────────────────────────
// With Agents & AI Apps enabled, the assistant container (top bar /
// split pane) is the primary entry point. We still DM on join, but
// now it's a nudge toward that container rather than buttons posted
// straight into the DM — role selection itself happens inside
// threadStarted below, once the user opens the container.
app.event('member_joined_channel', async ({ event, client }) => {
  const userId = event.user;
  const ctx = getContext(userId);
  if (ctx.briefingSent) return;

  try {
    await client.chat.postMessage({
      channel: userId,
      text: `👋 *Welcome to the workspace!*\n\nI'm your onboarding assistant — open me from the *top bar* (or click here) to get a briefing built from real workspace activity, not a static doc.`,
    });
  } catch (err) {
    console.error('Welcome DM error:', err.message);
  }
});

// ── Step 2: Role selected → generate briefing ─────────────
// `say` posts into the active assistant thread (works for both the
// button-click path and a typed "I'm an Engineer" path via userMessage).
async function handleRoleSelection(role, roleLabel, userId, say, setStatus) {
  updateContext(userId, { role, roleLabel });

  await say(`Got it — you're a *${roleLabel}*! Pulling together your briefing... ⏳`);
  if (setStatus) await setStatus('Searching the workspace...');

  const searchTerms = roleSearchTerms[role] || roleSearchTerms.other;

  const [messageResults, discovery] = await Promise.all([
    rtsSearch({ query: searchTerms, contentTypes: ['messages'], limit: 10, includeContext: true }),
    discoverPeopleAndChannels(role),
  ]);

  const { promptText, sources } = formatMessageResults(messageResults?.messages);

  const peopleList = discovery.users
    .slice(0, 5)
    .map((u) => `${u.full_name}${u.title ? ` (${u.title})` : ''}`)
    .join(', ') || 'No specific matches found yet';

  const channelList = discovery.channels
    .slice(0, 5)
    .map((c) => `#${c.name}`)
    .join(', ') || 'No specific matches found yet';

  const prompt = `You are an intelligent onboarding assistant for a new ${roleLabel} joining a Slack workspace.

Based on the following recent Slack messages (with surrounding context where available), create a personalised onboarding briefing.

Recent workspace activity:
${promptText}

Real people relevant to this role, found via workspace search: ${peopleList}
Real channels relevant to this role, found via workspace search: ${channelList}

Write a briefing that includes:
1. A 2-3 sentence summary of what's currently happening relevant to a ${roleLabel}
2. 2-3 specific topics or projects they should know about, grounded in the messages above
3. Name-check 2-3 of the real people listed above and why they're worth introducing yourself to (use the actual names given, do not invent people)
4. Recommend 2-3 of the real channels listed above (use the actual channel names given, do not invent channels)
5. One piece of advice for their first week

Keep it warm, concise, and actionable. Use Slack markdown (bold with *asterisks*, bullets with •). If no real people/channels were found, say so honestly instead of making something up.`;

  if (setStatus) await setStatus('Writing your briefing...');

  try {
    const briefing = await askGroq(prompt);

    updateContext(userId, {
      briefingSent: true,
      topicsCovered: [role, 'initial briefing'],
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
    console.error('Briefing error:', err.message);
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
const roleMap = {
  role_engineer: ['engineer', 'Engineer'],
  role_pm: ['product manager', 'Product Manager'],
  role_designer: ['design', 'Designer'],
  role_other: ['general onboarding', 'New Member'],
};

Object.entries(roleMap).forEach(([actionId, [role, roleLabel]]) => {
  app.action(actionId, async ({ body, client, ack }) => {
    await ack();
    const sayToThread = async (payload) => {
      const msg = typeof payload === 'string' ? { text: payload } : payload;
      return client.chat.postMessage({
        channel: body.channel?.id || body.user.id,
        thread_ts: body.container?.thread_ts,
        ...msg,
      });
    };
    await handleRoleSelection(role, roleLabel, body.user.id, sayToThread, null);
  });
});

// ── Start ─────────────────────────────────────────────────
(async () => {
  await app.start();
  console.log('⚡ TeamTrail is running!');
})();