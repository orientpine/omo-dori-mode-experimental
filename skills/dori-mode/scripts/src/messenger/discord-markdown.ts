// Discord's markdown pairs underscores as italics (_x_) or underline (__x__) even inside a word, so a file name or path
// with two of them ("1_Project/2026_크레인", "a_b_c.txt") showed slanted with its underscores gone (the owner,
// 2026-11-05). Every underscore of a post goes out as \_ (drawn as a plain _) except in what Discord shows as written: a
// code span or block, a URL (bare, <...> or a masked link's address) and a Discord token (<:emoji_name:id>,
// </command_name:id>). Emphasis written on purpose stays: one underscore or two around a word that start after a space,
// the text start or an opening bracket or quote, end before a space, the text end or punctuation that ends a word, and
// hold no underscore themselves. An underscore already escaped (after an odd run of backslashes) is left as it is.

import SimpleMarkdown, { type Capture, type Rule, type State } from "./vendor/simple-markdown.js";

export const DISCORD_TEXT_MAX = 2000;

// What Discord shows as written is found by Discord's own parser, simple-markdown (vendor/simple-markdown.js, MIT),
// with its inline rules in its order, so a span starts and ends where Discord's does and the text of a link label,
// bold, underline, italics, strikethrough or spoiler is read on its own (reviews 1-6 of #358). Each rule is wrapped to
// note where in the text its match lies: a code span or block, a URL (bare or <...>), a masked link's address and a
// Discord token are held; an escape (a backslash and the punctuation after it) is marked.
const HELD = "\uE000";
// the backslash of an escaped underscore outside what is held: held to every rule here, dropped by the fallback
const ESCAPED_UNDERSCORE = "\uE001";
// an emoji name may hold \_ here: escapeUnderscores reads the text with every underscore escaped, where it is the same token
const TOKEN = /^<(?:@[!&]?\d+|#\d+|a?:(?:\w|\\_)+:\d+|\/[^<>:\n]+:\d+|t:-?\d+(?::[tTdDfFR])?)>/;
const SPOILER = /^\|\|([\s\S]+?)\|\|/;

// where the parse is: the text it reads at each level of nesting starts at base and is len long; src is the rest of it
type Where = State & { frames: { base: number; len: number }[]; src: string; marks: string[] };
const here = (s: Where): number => {
  const f = s.frames[s.frames.length - 1] ?? { base: 0, len: 0 };
  return f.base + f.len - s.src.length;
};
const hold = (s: Where, from: number, to: number) => {
  for (let i = from; i < to; i++) s.marks[i] = HELD;
};
// a rule of simple-markdown whose match records the text it reads, whose nested parses know their place, and whose
// match is noted by mark (start, the capture)
const traced = (rule: Rule, mark?: (s: Where, start: number, c: Capture) => void): Rule => ({
  ...rule,
  match: (source, state, prev) => {
    (state as Where).src = source;
    return rule.match(source, state, prev);
  },
  parse: (capture, parse, state) => {
    const s = state as Where;
    const start = here(s);
    mark?.(s, start, capture);
    return rule.parse(capture, (inner, st) => {
      s.frames.push({ base: start + capture[0].indexOf(inner), len: inner.length });
      try {
        return parse(inner, st);
      } finally {
        s.frames.pop();
      }
    }, state);
  },
});
const whole = (s: Where, start: number, c: Capture) => hold(s, start, start + c[0].length);
const d = SimpleMarkdown.defaultRules;
const parse = SimpleMarkdown.parserFor({
  escape: traced(d.escape, (s, start, c) => {
    const ch = c[1] ?? "";
    s.marks[start] = ch === "_" ? ESCAPED_UNDERSCORE : HELD;
    // an escaped character other than _, ` and \ keeps its place, so it still bounds emphasis ("\[_word_]" is italic)
    if (ch === "_" || ch === "`" || ch === "\\") s.marks[start + 1] = HELD;
  }),
  token: traced({ order: d.autolink.order - 0.5, match: (source) => TOKEN.exec(source), parse: () => ({ type: "text", content: "" }) }, whole),
  autolink: traced(d.autolink, whole),
  mailto: traced(d.mailto, whole),
  url: traced(d.url, whole),
  // the address after the label's "]" is held; the label is parsed on its own
  link: traced(d.link, (s, start, c) => hold(s, start + (c[1] ?? "").length + 2, start + c[0].length)),
  em: traced(d.em),
  strong: traced(d.strong),
  u: traced(d.u),
  del: traced(d.del),
  spoiler: traced({ order: d.del.order, match: SimpleMarkdown.inlineRegex(SPOILER), parse: (c, p, st) => ({ content: p(c[1] ?? "", st) }) }),
  inlineCode: traced(d.inlineCode, whole),
  br: traced(d.br),
  text: traced(d.text),
});

// the text with every character Discord shows as written held and each escape marked. simple-markdown turns a tab into
// four spaces and drops a carriage return or form feed before it parses, so those are read as one space each, which
// keeps every place in the text where it is
const mask = (text: string): string => {
  const s: Where = { inline: true, frames: [{ base: 0, len: text.length }], src: text, marks: [...text.split("")] };
  parse(text.replace(/[\t\r\f]/g, " "), s);
  return s.marks.join("");
};
// a word edge for emphasis: a space, the text's ends, a bracket or quote, or the marks of bold, strikethrough and spoiler
// around it ("**__x__**", review 10 of #358)
const EMPHASIS = /(?<=^|\s|[([{"'“‘*~|])(__?)(?![\s_])[^_\n]*?[^\s_\\]\1(?=$|\s|[)\]}"'”’!?,;:.*~|](?![\p{L}\p{N}_]))/gu;

// the places (UTF-16 offsets, as everywhere here) of the underscores of emphasis written on purpose in a masked text
const emphasis = (masked: string): Set<number> => {
  const kept = new Set<number>();
  for (const m of masked.matchAll(EMPHASIS)) {
    const mark = (m[1] ?? "").length;
    const start = m.index ?? 0;
    for (let i = 0; i < mark; i++) {
      kept.add(start + i);
      kept.add(start + m[0].length - 1 - i);
    }
  }
  return kept;
};

// the text with a backslash before each place in at, and where each original character went
const withSlashes = (text: string, at: ReadonlySet<number>): { out: string; pos: number[]; slash: Map<number, number> } => {
  let out = "";
  const pos: number[] = [];
  const slash = new Map<number, number>();
  for (let i = 0; i < text.length; i++) {
    if (at.has(i)) {
      slash.set(i, out.length);
      out += "\\";
    }
    pos.push(out.length);
    out += text[i];
  }
  return { out, pos, slash };
};

// An escape changes what Discord parses: "_ then `name_" stops being italics, so its backtick opens code (review 7 of
// #358), and an underscore that was in code can come out of it (review 8). So what is code, a URL or emphasis is read
// on the text with every underscore escaped but those of emphasis written on purpose, where no other underscore pairs as
// italics and the rest of the markdown decides alone; that text is the same for a text and the same text already
// escaped, so escaping twice changes nothing. An
// underscore is escaped unless that reading holds it (in code or a URL) or keeps it as emphasis written on purpose.
// Last, the text that goes out is parsed once more and a backslash it does not read as escaping its underscore is left
// out, until every one added is (the set only shrinks).
export const escapeUnderscores = (text: string): string => {
  if (!text.includes("_")) return text;
  // emphasis written on purpose is read on the text as written, as Discord reads it (an underline around a URL or a lone
  // backtick, review 9 of #358); its underscores stay as they are in the reading below too
  const purpose = emphasis(mask(text));
  const open = new Set<number>();
  for (let i = 0, run = 0; i < text.length; i++) {
    if (text[i] === "_" && run % 2 === 0 && !purpose.has(i)) open.add(i);
    run = text[i] === "\\" ? run + 1 : 0;
  }
  const all = withSlashes(text, open);
  const allMask = mask(all.out);
  // the text read that way, at its own places: an underscore whose backslash is read as an escape there is free
  let read = "";
  for (let i = 0; i < text.length; i++) {
    const s = all.slash.get(i);
    read += s === undefined ? (allMask[all.pos[i] ?? -1] ?? HELD) : allMask[s] === ESCAPED_UNDERSCORE ? "_" : HELD;
  }
  const kept = emphasis(read);
  const added = new Set([...open].filter((i) => read[i] === "_" && !kept.has(i)));
  for (;;) {
    const { out, slash } = withSlashes(text, added);
    const outMask = mask(out);
    const wrong = [...slash].filter(([, s]) => outMask[s] !== ESCAPED_UNDERSCORE);
    if (!wrong.length) return out;
    for (const [i] of wrong) added.delete(i);
  }
};

// The text with no escaped underscore outside code, URLs and tokens: each \_ there loses its backslash, the writer's own
// too, so a text and the same text already escaped come out alike.
export const unescapeUnderscores = (text: string): string => {
  if (!text.includes("\\_")) return text;
  const masked = mask(text);
  let out = "";
  for (let i = 0; i < text.length; i++) if (masked[i] !== ESCAPED_UNDERSCORE) out += text[i];
  return out;
};

// The places a text links to, as Discord reads them in order: a URL's (bare or <...>), a mail link's and a masked link's
// address.
export const linkTargets = (text: string): string[] => {
  const s: Where = { inline: true, frames: [{ base: 0, len: text.length }], src: text, marks: [...text.split("")] };
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) for (const n of node) walk(n);
    else if (node && typeof node === "object") {
      const { target, content } = node as { target?: unknown; content?: unknown };
      if (typeof target === "string") out.push(target);
      walk(content);
    }
  };
  walk(parse(text.replace(/[\t\r\f]/g, " "), s));
  return out;
};

export const LINK_TARGET_WARN = "DISCORD_LINK_TARGET_WARN underscores left as written: escaping them would change where a link goes";

// A text that fits its limit only without the escapes goes out with none rather than refused (400) or cut. build makes
// the whole text from its parts, escaping those it passes through md, so the limit is checked before any slicing. The
// fallback is made from the escaped parts, so it is the same for every input that escapes alike: the repeat check keys
// the escaped text, and two texts it calls one message post one text (review 5 of #358).
// A part whose escaped (or unescaped) form links anywhere else than the part as written goes out as written: a \_ next
// to a URL can move where Discord ends it ("___http://x.y/_"), so a link would go elsewhere. That is
// said once in a warning line, with no part of the text.
export const fitEscaped = (build: (md: (part: string) => string) => string, max: number, warn: (line: string) => void = (line) => console.error(line)): string => {
  let kept = false;
  const keep = (part: string, out: string): string => {
    if (out === part || JSON.stringify(linkTargets(out)) === JSON.stringify(linkTargets(part))) return out;
    kept = true;
    return part;
  };
  const escape = (part: string) => keep(part, escapeUnderscores(part));
  const escaped = build(escape);
  const plain = escaped.length <= max ? escaped : build((part) => keep(part, unescapeUnderscores(escape(part))));
  if (kept) warn(LINK_TARGET_WARN);
  return plain.length <= max ? plain : escaped;
};

export const discordText = (text: string): string => fitEscaped((md) => md(text), DISCORD_TEXT_MAX);
