// Unit tests for lib.js — the pure, dependency-free logic pulled out of
// index.js specifically so it could be tested without constructing a
// real @slack/bolt App (see the comment at the top of lib.js for why
// that matters). Run with: node --test test_unit.js
//
// Most of these cases exist because they're regressions of real bugs
// found during manual testing of this app, not generic filler coverage —
// see the comments on each describe block for which bug it maps to.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
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
} = require('./lib');

test('matchRoleKeyword recognizes role synonyms, including "product owner"', () => {
  assert.equal(matchRoleKeyword('engineer'), 'engineer');
  assert.equal(matchRoleKeyword('developer'), 'engineer');
  assert.equal(matchRoleKeyword('product manager'), 'pm');
  // "product owner" was not recognized at all before a real bug report —
  // it was silently treated as no role match anywhere in the app.
  assert.equal(matchRoleKeyword('product owner'), 'pm');
  assert.equal(matchRoleKeyword('designer'), 'designer');
  assert.equal(matchRoleKeyword('something unrelated'), null);
});

test('titleCase capitalizes each word', () => {
  assert.equal(titleCase('product owner'), 'Product Owner');
  assert.equal(titleCase('engineer'), 'Engineer');
});

test('detectRoleFromText requires an "I\'m ... new" self-announcement (Route 1 gate)', () => {
  // The four real suggested-prompt strings must still match.
  assert.equal(detectRoleFromText("I'm a new Engineer, brief me"), 'engineer');
  assert.equal(detectRoleFromText("I'm a new Product Manager, brief me"), 'pm');
  assert.equal(detectRoleFromText("I'm a new Designer, brief me"), 'designer');

  // Regression: a bare substring match on a role word used to hijack
  // genuine follow-up questions into a full re-briefing.
  assert.equal(detectRoleFromText("What's the engineering deploy process?"), null);
  assert.equal(detectRoleFromText('Can you point me to the design system docs?'), null);
  assert.equal(detectRoleFromText('What channels should I join?'), null);

  // "product owner" phrasing should also trigger Route 1 when paired
  // with "new", for consistency with extractStatedRole below.
  assert.equal(detectRoleFromText("I'm a new Product Owner, brief me"), 'pm');
});

test('extractStatedRole picks up an inline "I\'m a/an <role>" self-identification (Route 2)', () => {
  // The exact reported repro: "product owner" stated in an ordinary
  // follow-up, not matching detectRoleFromText's stricter gate.
  assert.deepEqual(extractStatedRole("I'm a product owner — what can I get started on"), {
    role: 'pm',
    label: 'Product Owner',
  });
  assert.deepEqual(extractStatedRole("I'm a designer"), { role: 'designer', label: 'Designer' });

  // Must NOT hijack ordinary questions containing a role word.
  assert.equal(extractStatedRole("What's the engineering deploy process?"), null);
  assert.equal(extractStatedRole('Can you point me to the design system docs?'), null);
  assert.equal(extractStatedRole("I'm a bit confused about the deploy process"), null);
  assert.equal(extractStatedRole("I'm reporting a bug in the login flow"), null);
});

test('isOnboardRequest matches restart phrasing but not ordinary onboarding-related questions', () => {
  for (const text of [
    'onboard me',
    'Onboard me please',
    're-onboard me',
    'reonboard me',
    'can you onboard me again?',
    'start onboarding',
    'restart my onboarding',
  ]) {
    assert.equal(isOnboardRequest(text), true, `expected match: ${text}`);
  }

  for (const text of [
    "What's the onboarding process like?",
    'Is there an onboarding doc somewhere?',
    "I'm a new Engineer, brief me",
    'What channels should I join?',
  ]) {
    assert.equal(isOnboardRequest(text), false, `expected no match: ${text}`);
  }
});

test('asSemanticQuery rewrites bare keywords into questions but leaves questions/OR-queries alone', () => {
  assert.equal(asSemanticQuery('rate limiting'), 'What is the latest on rate limiting?');
  assert.equal(asSemanticQuery('What is the latest on deploys?'), 'What is the latest on deploys?');
  assert.equal(asSemanticQuery('engineering OR backend'), 'engineering OR backend');
  assert.equal(asSemanticQuery('Can you help with onboarding?'), 'Can you help with onboarding?');
});

test('formatMessageResults degrades missing fields instead of injecting "undefined"', () => {
  const { promptText, sources } = formatMessageResults([
    { channel_name: 'eng', author_name: 'Alice', content: 'hello', permalink: 'https://x/1' },
    { permalink: 'https://x/2' }, // missing channel_name/author_name/content entirely
  ]);
  assert.match(promptText, /\[1\] #eng — Alice: hello/);
  assert.match(promptText, /\[2\] #unknown-channel — Unknown: \(no text\)/);
  assert.equal(sources.length, 2);
  assert.equal(sources[0].label, '1');
  assert.equal(sources[1].label, '2');
});

test('formatMessageResults with no results returns a safe placeholder', () => {
  const { promptText, sources } = formatMessageResults([]);
  assert.equal(promptText, 'No relevant messages found.');
  assert.deepEqual(sources, []);
});

test('formatCombinedResults continues file citation numbers on from messages, not restarting at [1]', () => {
  const messages = [{ channel_name: 'eng', author_name: 'A', content: 'msg1', permalink: 'https://x/1' }];
  const files = [{ title: 'doc.pdf', permalink: 'https://x/2' }];
  const { sources } = formatCombinedResults(messages, files);
  assert.equal(sources[0].label, '1');
  assert.equal(sources[1].label, '2'); // continues, doesn't restart at 1
});

test('formatSourcesBlock renders each source\'s own citation label, not a recomputed position', () => {
  // Regression: the block used to re-derive [1]/[2]/... from array
  // position after filtering/reserving Notion slots, which could drift
  // from the [N]/[N1] markers the LLM was actually told to cite inline.
  const sources = [
    { channel: 'eng', permalink: 'https://x/1', label: '1' },
    { channel: 'eng', permalink: 'https://x/2', label: '2' },
    { channel: 'notion', permalink: 'https://notion/1', label: 'N1' },
  ];
  const block = formatSourcesBlock(sources);
  const text = block.elements[0].text;
  assert.match(text, /\[1\]/);
  assert.match(text, /\[2\]/);
  assert.match(text, /\[N1\]/);
});

test('formatSourcesBlock returns null for no sources', () => {
  assert.equal(formatSourcesBlock([]), null);
});

test('isRateLimited allows up to the max within a window, then blocks', () => {
  // Uses real env-var-configurable constants, so pin a fresh userId per
  // test run to avoid cross-test interference within the same process.
  const userId = `rate-test-${Date.now()}-${Math.random()}`;
  const max = Number(process.env.RATE_LIMIT_MAX) || 10;

  for (let i = 0; i < max; i++) {
    assert.equal(isRateLimited(userId), false, `request ${i + 1} should be allowed`);
  }
  assert.equal(isRateLimited(userId), true, 'request beyond the max should be blocked');
});

test('isRateLimited tracks distinct users independently', () => {
  const userA = `rate-test-a-${Date.now()}`;
  const userB = `rate-test-b-${Date.now()}`;
  const max = Number(process.env.RATE_LIMIT_MAX) || 10;

  for (let i = 0; i < max; i++) isRateLimited(userA);
  assert.equal(isRateLimited(userA), true, 'userA should now be rate limited');
  assert.equal(isRateLimited(userB), false, 'userB should be unaffected by userA\'s usage');
});
