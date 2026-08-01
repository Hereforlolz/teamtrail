// ── Role configuration ──────────────────────────────────────
// Single source of truth for the roles TeamTrail supports. Add a new
// role by adding an entry here — roleButtons, roleSearchTerms,
// notionSearchTerms, ROLE_LABELS, and the role-selection button/action
// wiring in index.js, plus the keyword matching in lib.js, are all
// derived from this array. Nothing else needs to change.
//
// Pure data, no dependencies — safe to require from lib.js (which must
// stay dependency-free for testing, see the comment at the top of
// lib.js) as well as from index.js.
//
// label vs. buttonLabel: usually the same, but "Other" is a case where
// they legitimately differ — the button says the short "Other", while
// prose reads better as "you're a New Member!" than "you're an Other!".
module.exports = [
  {
    id: 'engineer',
    label: 'Engineer',
    buttonLabel: 'Engineer',
    emoji: '⚙️',
    // RTS supports the OR operator natively. Expanding a bare role into
    // related terms gives the search far better recall than the literal
    // role word alone.
    searchTerms: 'engineering OR backend OR infrastructure OR deployment OR architecture',
    // Notion's search tool takes a plain-text query, not RTS's OR syntax.
    notionSearchTerms: 'engineering architecture deployment',
    // Used by matchRoleKeyword (lib.js) to recognize this role from free
    // text, e.g. "I'm a new Engineer" or "I'm a developer".
    keywordPatterns: [/\bengineer(ing)?\b/, /\bdeveloper\b/, /\bswe\b/],
  },
  {
    id: 'pm',
    label: 'Product Manager',
    buttonLabel: 'Product Manager',
    emoji: '📋',
    searchTerms: 'roadmap OR product OR launch OR prioritization OR planning',
    notionSearchTerms: 'roadmap product launch',
    keywordPatterns: [/\bproduct manager\b/, /\bproduct owner\b/, /\bpm\b/, /\bpo\b/],
  },
  {
    id: 'designer',
    label: 'Designer',
    buttonLabel: 'Designer',
    emoji: '🎨',
    searchTerms: 'design OR UX OR figma OR prototype OR user research',
    notionSearchTerms: 'design UX prototype',
    keywordPatterns: [/\bdesigner\b/, /\bdesign\b/],
  },
  {
    id: 'other',
    label: 'New Member',
    buttonLabel: 'Other',
    emoji: '📊',
    searchTerms: 'onboarding OR team OR projects OR goals',
    notionSearchTerms: 'onboarding team',
    // No keyword patterns — 'other' is the fallback role, never matched
    // from free text on purpose (there's no natural phrase that means
    // "I'm a new... other").
    keywordPatterns: [],
  },
];
