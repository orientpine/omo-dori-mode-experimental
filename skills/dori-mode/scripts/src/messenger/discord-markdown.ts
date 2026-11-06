// Discord's markdown pairs underscores as italics (_x_) or underline (__x__) even inside a word, so a file name or path
// with two of them ("1_Project/2026_크레인", "a_b_c.txt") showed slanted with its underscores gone (the owner,
// 2026-11-05). Every underscore of a post goes out as \_ (drawn as a plain _) except in what Discord shows as written: a
// code span or block, a URL (bare, <...> or a masked link's address) and a Discord token (<:emoji_name:id>,
// </command_name:id>). Emphasis written on purpose stays: one underscore or two around a word that start after a space,
// the text start or an opening bracket or quote, end before a space, the text end or punctuation that ends a word, and
// hold no underscore themselves. An underscore already escaped (after an odd run of backslashes) is left as it is.

export const DISCORD_TEXT_MAX = 2000;

// What Discord shows as written, read left to right the way its parser (simple-markdown) does, so a span starts only
// where Discord's would (reviews 1-3 of #358): a backslash escapes the punctuation after it; a code span or block opens
// with a run of backticks and closes on the next run of exactly that length; a run with no such close is text one
// backtick at a time. Then a Discord token, a URL, and a masked link's address after its label's "]".
const ESCAPE = /\\[^0-9A-Za-z\s]/y;
const CODE = /(`+)[\s\S]*?[^`]\1(?!`)/y;
const TOKEN = /<(?:https?:\/\/[^\s<>]+|@[!&]?\d+|#\d+|a?:\w+:\d+|\/[^<>:\n]+:\d+|t:-?\d+(?::[tTdDfFR])?)>/y;
const BARE_URL = /https?:\/\/[^\s<>]+/y;
const LINK = /\[((?:\\[\s\S]|[^[\]\\])*)\]\((?:<[^<>\n]*>|[^()\s]*)\)/y;
const ADDRESS = /\((?:<[^<>\n]*>|[^()\s]*)\)/y;
const HELD = "\uE000";

const at = (re: RegExp, text: string, i: number): number => {
  re.lastIndex = i;
  return re.exec(text)?.[0].length ?? 0;
};

// the text with every character Discord shows as written held; an escaped character other than _ and ` keeps its
// place, so it still bounds emphasis around it ("\[_word_]" is italic); an escaped backslash is held like _ and `
const mask = (text: string): string => {
  let out = "";
  for (let i = 0; i < text.length; ) {
    const escaped = at(ESCAPE, text, i);
    if (escaped) {
      const c = text[i + 1] ?? "";
      out += HELD + (c === "_" || c === "`" || c === "\\" ? HELD : c);
      i += escaped;
      continue;
    }
    // a masked link's label is read on its own, so a backtick left open in it pairs with nothing after the link
    if (text[i] === "[") {
      LINK.lastIndex = i;
      const link = LINK.exec(text);
      if (link) {
        const label = link[1] ?? "";
        out += `[${mask(label)}]${HELD.repeat(link[0].length - label.length - 2)}`;
        i += link[0].length;
        continue;
      }
    }
    const held = at(CODE, text, i) || at(TOKEN, text, i) || at(BARE_URL, text, i) || (text[i - 1] === "]" ? at(ADDRESS, text, i) : 0);
    if (held) {
      out += HELD.repeat(held);
      i += held;
      continue;
    }
    out += text[i];
    i++;
  }
  return out;
};
const EMPHASIS = /(?<=^|\s|[([{"'“‘])(__?)(?![\s_])[^_\n]*?[^\s_\\]\1(?=$|\s|[)\]}"'”’!?,;:.](?![\p{L}\p{N}_]))/gu;

export const escapeUnderscores = (text: string): string => {
  if (!text.includes("_")) return text;
  const masked = mask(text);
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
