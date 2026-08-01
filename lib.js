// ── Pure logic, no Slack/Groq/filesystem dependencies ───────
// Everything here is a plain function of its inputs — no network calls,
// no Bolt, no process.env beyond the two rate-limit tuning vars. Kept
// separate from index.js specifically so the unit test suite (see
// test_unit.js) can require it directly without also constructing a
// real @slack/bolt App, which schedules background Socket Mode
// reconnect attempts as a side effect of construction alone — even
// without ever calling .start() — and would otherwise hang any test
// process that merely required index.js.

// ── Per-user rate limiting ────────────────────────────────
// Every follow-up question and every role selection fires at least one
// paid Groq call (plus RTS/Notion searches) with no ceiling otherwise —
// a recruiter double-clicking, or enthusiastic rapid-fire testing, has
// no cost limit today. In-memory sliding window, not persisted:
// resetting on restart is fine, this is a cost guardrail against
// accidental bursts, not a security control against a determined
// attacker (who could just use a fresh process restart to reset it).
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 10;
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 5 * 60 * 1000;
const rateLimitLog = new Map();

function isRateLimited(userId) {
  const now = Date.now();
  const recent = (rateLimitLog.get(userId) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);

  if (recent.length >= RATE_LIMIT_MAX) {
    rateLimitLog.set(userId, recent);
    return true;
  }

  recent.push(now);
  rateLimitLog.set(userId, recent);
  return false;
}

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

// Role keyword patterns shared by detectRoleFromText (the full-briefing
// trigger) and extractStatedRole (inline role capture in follow-ups
// below) — one shared list so a title like "Product Owner" is recognized
// consistently in both places instead of silently diverging. Derived
// from roles.js (the single source of truth for role configuration,
// shared with index.js) instead of a second, independently-maintained
// copy — that exact kind of drift between two role lists is what caused
// a real bug earlier (roleMap using different keys than everything else).
const ROLES = require('./roles');
const ROLE_KEYWORD_PATTERNS = Object.fromEntries(ROLES.map((r) => [r.id, r.keywordPatterns]));

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
// in the assistant pane, or via the /onboard slash command — instead of
// only via a fresh channel-join event. Closes a real gap: someone who
// missed or dismissed their original welcome message had no way back
// into onboarding at all before this.
const ONBOARD_REQUEST_PATTERN = /\b(re)?-?onboard(ing)?\s*me\b|\b(start|restart)\s+(my\s+)?onboarding\b/i;

function isOnboardRequest(text) {
  return ONBOARD_REQUEST_PATTERN.test(text.trim());
}

// Aggregates the per-user context snapshot from store.js's
// getAllContexts() into the numbers the /teamtrail-status admin command
// reports. Pure — takes the snapshot object, returns a plain summary,
// touches nothing else.
function computeStats(contexts) {
  const users = Object.values(contexts);
  const onboarded = users.filter((u) => u.briefingSent);

  const roleBreakdown = {};
  for (const u of onboarded) {
    const label = u.roleLabel || 'Unknown';
    roleBreakdown[label] = (roleBreakdown[label] || 0) + 1;
  }

  const totalQuestions = users.reduce((sum, u) => sum + (u.questionsAsked?.length || 0), 0);
  const feedbackUp = users.reduce((sum, u) => sum + (u.feedback?.up || 0), 0);
  const feedbackDown = users.reduce((sum, u) => sum + (u.feedback?.down || 0), 0);

  return {
    totalUsers: users.length,
    totalOnboarded: onboarded.length,
    roleBreakdown,
    totalQuestions,
    feedbackUp,
    feedbackDown,
  };
}

// Simple allowlist check for admin-only commands (/teamtrail-status).
// Takes the parsed list as a parameter rather than reading process.env
// itself, so this stays pure and testable — index.js parses
// ADMIN_USER_IDS once and passes it in.
function isAdmin(userId, adminUserIds) {
  return adminUserIds.includes(userId);
}

module.exports = {
  isRateLimited,
  asSemanticQuery,
  formatMessageResults,
  formatFileResults,
  formatCombinedResults,
  formatSourcesBlock,
  matchRoleKeyword,
  titleCase,
  detectRoleFromText,
  extractStatedRole,
  isOnboardRequest,
  computeStats,
  isAdmin,
};
