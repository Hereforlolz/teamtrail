// ── Persistent context store ────────────────────────────────
// A flat JSON file, not SQLite or Redis. This app has a handful of small
// per-user records, one writer (a single Node process), and no relational
// queries — a real database would add an operational dependency (native
// bindings to compile, or a hosted service to pay for) without buying
// anything a plain file doesn't already give here: it survives process
// restarts, needs zero setup on any host, and costs nothing.
//
// Every update writes the whole file synchronously. Write volume is a
// handful of calls per user interaction, not a hot path, so there's no
// need for batching or debouncing.
//
// Same getContext/updateContext interface as before, so nothing that
// calls them needs to change.

const fs = require('fs');
const path = require('path');

const STORE_PATH = process.env.CONTEXT_STORE_PATH || path.join(__dirname, 'data', 'context-store.json');

// Entries older than this are dropped on load, so the file can't grow
// forever across a long-running deployment. joinedAt is set once, the
// first time a user's context is created, and never updated again, so
// it's a stable "first seen" timestamp to prune against.
const MAX_AGE_DAYS = Number(process.env.CONTEXT_STORE_MAX_AGE_DAYS) || 90;

let contextStore = loadStore();

function loadStore() {
  let raw;
  try {
    raw = fs.readFileSync(STORE_PATH, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('Failed to read context store, starting fresh:', err.message);
    }
    return {};
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error('Context store file is corrupt, starting fresh:', err.message);
    return {};
  }

  const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const pruned = {};
  for (const [userId, ctx] of Object.entries(parsed)) {
    const joinedAt = ctx?.joinedAt ? Date.parse(ctx.joinedAt) : NaN;
    if (Number.isNaN(joinedAt) || joinedAt >= cutoff) {
      pruned[userId] = ctx;
    }
  }
  return pruned;
}

function persistStore() {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(contextStore, null, 2));
  } catch (err) {
    // Persistence failing (e.g. a read-only filesystem) shouldn't take the
    // bot down — worst case, state doesn't survive a restart, which is
    // exactly the behavior this module is upgrading from, not a new
    // failure mode.
    console.error('Failed to persist context store:', err.message);
  }
}

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
      welcomed: false,
    };
  }
  return contextStore[userId];
}

function updateContext(userId, updates) {
  contextStore[userId] = { ...getContext(userId), ...updates };
  persistStore();
}

module.exports = { getContext, updateContext };
