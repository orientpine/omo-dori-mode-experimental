// Every phrase that means a lane failed to start, one row each (dori-superagent PRs #206, #207, #210 and #212 reproduced
// here (SUL-1.0: NOTICE): https://github.com/sisyphuslabs/dori-superagent/pull/206,
// https://github.com/sisyphuslabs/dori-superagent/pull/207, https://github.com/sisyphuslabs/dori-superagent/pull/210,
// https://github.com/sisyphuslabs/dori-superagent/pull/212, their src/startup-screen.ts). launch-screen.ts reads it only on the agent's own error line, one printed
// line; upstream reads the whole screen with omo's extension warning cut out, which the fork never needs (#205, #470), so
// upstream's Bun tail rule (#206) is not taken. Three kinds:
// - `anywhere`: text no healthy screen prints (omo's own failure lines, provider messages). It matches even glued onto other
//   text (`...okNo API key`).
// - `word`: a phrase that names a failure, not a topic (`rate limit reached`, never bare `rate limit`, `quota` or a
//   component such as `rate limiter`). It must stand alone; see `standsAlone`. Its gaps are single spaces as printed,
//   never `-`, so a kebab-case lane key such as `fix-rate-limit-error` is not one.
// - `value`: an error code (`insufficient_quota`, `QUOTA_EXCEEDED`), counted only where it is a value: after `error`,
//   `code`, `type` or `status` in any case and a `:` or `=` (`"type":"rate_limit_error"`, `code=quotaExceeded`). The same code in
//   source (`case 'rate_limit_error':`, `instanceof RateLimitError`, `X === 'RESOURCE_EXHAUSTED'`) is not.
// The last five rows are the fork's own, measured on omo 5.1.51 and tmux (launch-screen.ts, test/aoe.test.ts): omo's
// notices that are failures as a whole, which no upstream row names. test/startup-phrases.test.ts holds the corpus.
type Kind = "anywhere" | "word" | "value";
const PHRASES: readonly (readonly [Kind, string])[] = [
  ["anywhere", "Cannot find module"],
  ["anywhere", "All fallback models failed"],
  ["anywhere", "No API key"],
  ["anywhere", "model_not_available"],
  ["anywhere", "Session crashed"],
  ["anywhere", "unknown provider"],
  ["anywhere", "(?:429|Error:) Too Many Requests"],
  ["anywhere", "RESOURCE_EXHAUSTED: Resource exhausted"],
  ["anywhere", "429 status code \\(no body\\)"],
  ["anywhere", "RateLimitError: 4\\d\\d"],
  ["anywhere", "Resource has been exhausted"],
  ["anywhere", "would exceed your account's rate limit"],
  ["anywhere", "exceeded your current quota"],
  ["word", "rate limit(?:s)? (?:exceeded|reached|hit)"],
  ["word", "rate limited"],
  ["word", "rate-limit (?:exceeded|reached)"],
  ["word", "usage limit(?:s)? (?:exceeded|reached|hit)"],
  ["word", "(?:reached|hit) your usage limit"],
  ["word", "quota(?:s)? (?:exceeded|exhausted|reached|hit)"],
  ["value", "insufficient_quota|rate_limit_error|resource_exhausted|quota_?exceeded|rate_?limit_?exceeded"],
  ["word", "out of quota"],
  ["anywhere", "account usage limit has been reached"],
  ["anywhere", "accounts for \\S+ are currently blocked"],
  ["anywhere", 'Model "[^"\\n]*" not found'],
  ["anywhere", "Pane is dead"],
];
const PATTERNS = PHRASES.map(([kind, source]) => ({ kind, re: new RegExp(source, "gi") }));
// What touching a word match makes it part of something else: a word, a path, a kebab-case name, a file name.
const JOINS = /[a-z0-9_/\\.-]/i;
// A `word` match stands alone when nothing in JOINS touches its end (a `.` only when a word goes on: `reached.` ends a
// sentence, `limited.md` is a file), and nothing touches its start, except when it is glued onto the end of other text,
// whatever that text ended in (`ok`, `....`, `----`, a path). Then it must read as printed text: it starts with a capital
// and has a space (`...okRate limit reached`), which camelCase (`onRateLimitExceeded`) and lower-case names
// (`fix-rate-limit-error`) never are.
const standsAlone = (text: string, at: number, found: string): boolean => {
  const after = text[at + found.length] ?? "";
  if (JOINS.test(after) && !(after === "." && !/[a-z0-9_]/i.test(text[at + found.length + 1] ?? ""))) return false;
  const before = text[at - 1] ?? "";
  if (!JOINS.test(before)) return true;
  // Glued after an identifier character (`foo_Rate limit exceeded`) is a name, never printed text (#212).
  return before !== "_" && /^[A-Z]/.test(found) && found.includes(" ");
};
// A `value` match counts only as the value of an `error`, `code`, `type` or `status` field as logs, JSON and Python reprs
// print it (#212): `Error: VALUE` or `key=VALUE` (unquoted key, unquoted value), `"key": "VALUE"` (JSON) or
// `'key': 'VALUE'` (a Python dict repr): the value is quoted only when its key is, with the same quote. The key is a whole
// word in any case (`ERROR`, `Status`, omo's own `Error:`), never the end of a longer name (`errorType`). An unquoted key
// with a quoted value is source code (`throw { type: "rate_limit_error" }`, `const code = 'insufficient_quota'`), never a
// value. The trade-offs this leaves are DECIDED rows in test/startup-phrases.test.ts.
const VALUE_KEY =
  /(?:^|[^A-Za-z0-9_])(?:"(?:error|code|type|status)"\s*:\s*"|'(?:error|code|type|status)'\s*:\s*'|(?:error|code|type|status)(?::\s*|=))$/i;
const isValue = (text: string, at: number, found: string): boolean =>
  VALUE_KEY.test(text.slice(Math.max(0, at - 24), at)) && !/[a-z0-9_]/i.test(text[at + found.length] ?? "");
const counts = (kind: Kind, text: string, at: number, found: string): boolean =>
  kind === "anywhere" || (kind === "word" ? standsAlone(text, at, found) : isValue(text, at, found));
// the first failure phrase in the text, by position, as printed; null when none counts
export const startupPhrase = (text: string): string | null => {
  let first: { at: number; found: string } | undefined;
  for (const { kind, re } of PATTERNS) {
    for (const m of text.matchAll(re)) {
      if (!counts(kind, text, m.index, m[0])) continue;
      if (!first || m.index < first.at) first = { at: m.index, found: m[0] };
      break;
    }
  }
  return first?.found ?? null;
};
