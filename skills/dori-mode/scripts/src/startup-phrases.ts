// Every phrase that means a lane failed to start, one row each (dori-superagent PRs #206, #207 and #210 reproduced here
// (SUL-1.0: NOTICE): https://github.com/sisyphuslabs/dori-superagent/pull/206,
// https://github.com/sisyphuslabs/dori-superagent/pull/207, https://github.com/sisyphuslabs/dori-superagent/pull/210,
// their src/startup-screen.ts). launch-screen.ts reads it only on the agent's own error line, rebuilt across hc's wrapped
// rows; upstream reads the whole screen with omo's extension warning cut out, which the fork never needs (#205, #470), so
// upstream's Bun tail rule (#206) is not taken. Three kinds:
// - `anywhere`: text no healthy screen prints (omo's own failure lines, provider messages). It matches even glued onto the
//   end of a pane-wide row by hc's wrap join (`...okNo API key`).
// - `word`: a phrase that names a failure, not a topic (`rate limit reached`, never bare `rate limit`, `quota` or a
//   component such as `rate limiter`). It must stand alone; see `standsAlone`. Its gaps are single spaces as printed (the
//   join puts back a space hc cut at a wrap), never `-`, so a kebab-case lane key such as `fix-rate-limit-error` is not one.
// - `value`: an error code (`insufficient_quota`, `QUOTA_EXCEEDED`), counted only where it is a value: after `error`,
//   `code`, `type` or `status` and a `:` or `=` (`"type":"rate_limit_error"`, `code=quotaExceeded`). The same code in
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
  ["anywhere", "(?:429|Error:|HTTP \\d\\.?\\d?) Too Many Requests"],
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
// sentence, `limited.md` is a file), and nothing touches its start, except when a join glued it onto a pane-wide row,
// whatever that row ended in (`ok`, `....`, `----`, a path). Then it must read as printed text: it starts with a capital
// and has a space (`...okRate limit reached`), which camelCase (`onRateLimitExceeded`) and lower-case names
// (`fix-rate-limit-error`) never are.
// rows: the fork's row joins (launch-screen.ts ownLine), positions where a full-width row met the next; either side of a
// match that sits on one is a boundary as good as a space (review 2 of #471).
const standsAlone = (text: string, at: number, found: string, rows: ReadonlySet<number>): boolean => {
  const end = at + found.length;
  const after = text[end] ?? "";
  if (!rows.has(end) && JOINS.test(after) && !(after === "." && !/[a-z0-9_]/i.test(text[end + 1] ?? ""))) return false;
  const before = text[at - 1] ?? "";
  if (rows.has(at) || !JOINS.test(before)) return true;
  return /^[A-Z]/.test(found) && found.includes(" ");
};
// A `value` match counts only as the value of an `error`, `code`, `type` or `status` field as logs and JSON print it:
// `key: VALUE`, `"key":"VALUE"` or `key=VALUE` with no spaces. The key is a whole lower-case word (`errorType` is not
// one), and a `= '`, `: '` or `===` is source code (`const code = 'insufficient_quota'`), never a value. The fork also
// takes omo's own capitalised `Error:` (`Error: QUOTA_EXCEEDED`, review 1 of #471), the way it prints its error lines.
const VALUE_KEY = /(?:^|[^A-Za-z0-9_])"?(?:[Ee]rror|code|type|status)"?(?::\s*"?|=)$/;
const isValue = (text: string, at: number, found: string, rows: ReadonlySet<number>): boolean =>
  VALUE_KEY.test(text.slice(Math.max(0, at - 24), at)) && (rows.has(at + found.length) || !/[a-z0-9_]/i.test(text[at + found.length] ?? ""));
const counts = (kind: Kind, text: string, at: number, found: string, rows: ReadonlySet<number>): boolean =>
  kind === "anywhere" || (kind === "word" ? standsAlone(text, at, found, rows) : isValue(text, at, found, rows));
// the first failure phrase in the text, by position, as printed; null when none counts
export const startupPhrase = (text: string, rows: ReadonlySet<number> = new Set()): string | null => {
  let first: { at: number; found: string } | undefined;
  for (const { kind, re } of PATTERNS) {
    for (const m of text.matchAll(re)) {
      if (!counts(kind, text, m.index, m[0], rows)) continue;
      if (!first || m.index < first.at) first = { at: m.index, found: m[0] };
      break;
    }
  }
  return first?.found ?? null;
};
