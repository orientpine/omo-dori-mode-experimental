// Discord's markdown pairs underscores as italics (_x_) or underline (__x__) even inside a word, so a file name or path
// with two of them ("1_Project/2026_크레인", "a_b_c.txt") showed slanted with its underscores gone (the owner,
// 2026-11-05). Every underscore of a post goes out as \_ (drawn as a plain _) except in what Discord shows as written: a
// code span or block, a URL (bare, <...> or a masked link's address) and a Discord token (<:emoji_name:id>,
// </command_name:id>). Emphasis written on purpose stays: one underscore or two around a word that start after a space,
// the text start or an opening bracket or quote, end before a space, the text end or punctuation that ends a word, and
// hold no underscore themselves. An underscore already escaped (after an odd run of backslashes) is left as it is.

export const DISCORD_TEXT_MAX = 2000;

const SHOWN_AS_WRITTEN = new RegExp(
  [
    // a backslash escapes the next character, so an escaped backtick opens no code and an escaped _ stays as it is
    "\\\\[\\s\\S]",
    "```[\\s\\S]*?```",
    // a code span opens with one backtick or two and closes with the same run, over lines too
    "``[\\s\\S]+?``",
    "`[^`]+`",
    // a masked link's address ends at its own parenthesis, so the next link's label is still text; the label's "]"
    // stays text, so emphasis written in the label keeps its closing edge
    "(?<=\\])\\((?:<[^<>\\n]*>|[^()\\s]*)\\)",
    "<(?:https?:\\/\\/[^\\s<>]+|@[!&]?\\d+|#\\d+|a?:\\w+:\\d+|\\/[^<>:\\n]+:\\d+|t:-?\\d+(?::[tTdDfFR])?)>",
    "https?:\\/\\/[^\\s<>]+",
  ].join("|"),
  "g",
);
const HELD = "\uE000";
const EMPHASIS = /(?<=^|\s|[([{"'“‘])(__?)(?![\s_])[^_\n]*?[^\s_\\]\1(?=$|\s|[)\]}"'”’!?,;:.](?![\p{L}\p{N}_]))/gu;

export const escapeUnderscores = (text: string): string => {
  if (!text.includes("_")) return text;
  const masked = text.replace(SHOWN_AS_WRITTEN, (m) => HELD.repeat(m.length));
  const kept = new Set<number>();
  for (const m of masked.matchAll(EMPHASIS)) {
    const mark = (m[1] ?? "").length;
    const start = m.index ?? 0;
    for (let i = 0; i < mark; i++) {
      kept.add(start + i);
      kept.add(start + m[0].length - 1 - i);
    }
  }
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (masked[i] === "_" && !kept.has(i)) out += "\\";
    out += text[i];
  }
  return out;
};

// A text that fits its limit only without the escapes goes out as written rather than refused (400) or cut. build makes
// the whole text from its parts, escaping those it passes through md, so the limit is checked before any slicing.
export const fitEscaped = (build: (md: (part: string) => string) => string, max: number): string => {
  const escaped = build(escapeUnderscores);
  if (escaped.length <= max) return escaped;
  const plain = build((part) => part);
  return plain.length <= max ? plain : escaped;
};

export const discordText = (text: string): string => fitEscaped((md) => md(text), DISCORD_TEXT_MAX);
