import { realClock } from "./run.ts";
import { watchLog } from "./watch-log.ts";

const ownText = (text: string): string => text
  .replace(/```[\s\S]*?(?:```|$)/g, " ")
  .replace(/`[^`\n]*`/g, " ")
  .replace(/"[^"\n]*"|“[^”\n]*”|'[^'\n]*'/g, " ")
  .split("\n").filter((line) => !/^\s*(?:>|[$#]\s|(?:bun|npm|npx|git|gh|dori|curl|ssh|env|python3?)\s)/.test(line)).join("\n")
  .replace(/https?:\/\/\S+/g, " ");

// Only the author's prose counts: code, quotations, links, identifiers and shell commands are not language evidence.
export const ownerProse = (text: string): string => ownText(text).replace(/<[@#][!&]?\d+>|(?:\b[\da-f]{7,40}\b)|\b[A-Z][A-Z0-9_]*_[A-Z0-9_]+\b|\b\d+\b/g, " ");

// Warn only for Korean owners, and only when some prose remains but none of it contains Hangul.
export const koreanOwnerProblem = (text: string, locale: string): string | undefined => {
  if (!locale.toLowerCase().startsWith("ko")) return undefined;
  const prose = ownerProse(text);
  return /\p{L}/u.test(prose) && !/[\u1100-\u11ff\u3130-\u318f\uac00-\ud7a3]/.test(prose) ? "prose has no Hangul" : undefined;
};

// A UTC clock time needs its Korean-time counterpart; a bare mention of KST is not a converted time.
export const kstOwnerProblem = (text: string, locale: string): string | undefined => {
  if (!locale.toLowerCase().startsWith("ko")) return undefined;
  const own = ownText(text);
  const utc = /\bUTC\b|\b(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?Z\b|\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?Z\b/i.test(own);
  const clockRe = /(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?|(?:오전|오후)?\s*\d{1,2}시(?!간)(?:\s*\d{1,2}분)?/g;
  const zoneRe = /\bKST\b|한국\s*(?:시간|시각)|한국표준시/gi;
  const plus9 = /\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?\+09:00/.test(own);
  const clocks = [...own.matchAll(clockRe)].map((m) => ({ at: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
  // a conversion promise (KST로, KST 변환 예정, KST로 바꿀게) is not a KST time; every other KST annotation with a
  // clock right next to it is, whatever the UTC clock looks like elsewhere in the message
  const near = (gap: string): boolean => gap.length <= 6 && !/[A-Za-z.]/.test(gap);
  const conversion = (end: number): boolean => {
    const s = own.slice(end, end + 20);
    // future promises only: KST 변환 예정, KST 변환할게, KST로 바꿀게; not KST 변환 완료 (completed)
    return /^\s*[()]*\s*(?:예정|변환\s*(?:예정|할))/.test(s) || (/(?:으로|로|기준)/.test(s) && /(?:변환할|바꿀)/.test(s));
  };
  const utcClock = (c: { at: number; end: number }): boolean => {
    const after = own.slice(c.end);
    if (/^\s*(?:\.\d+)?Z/.test(after) || /^[ \t]*UTC\b/i.test(after) || /^[ \t]*\([ \t]*UTC[ \t]*\)/i.test(after)) return true;
    const before = own.slice(Math.max(0, c.at - 12), c.at);
    return /\bUTC\s*(?:기준|으로|로|시간|시각|:|：|\s)*$/i.test(before) && !/(?:KST|한국)/i.test(before);
  };
  const kst = plus9 || [...own.matchAll(zoneRe)].some((m) => {
    const at = m.index ?? 0, end = at + m[0].length;
    const afterC = clocks.find((c) => c.at >= end && near(own.slice(end, c.at)));
    const beforeC = clocks.some((c) => c.end <= at && near(own.slice(c.end, at)) && !utcClock(c) && !/→|->|=>/.test(own.slice(c.end, at)));
    // a UTC-labelled clock right after a KST zone is a conversion target, never the KST time itself
    return (afterC && !utcClock(afterC)) || (beforeC && !conversion(end));
  });
  return utc && !kst ? "UTC time without a KST time" : undefined;
};

// Warning-only rollout: preserve the send and its exit status, and record the same line under the command's tag.
export const textWarning = (path: string, where: string, token: string, id: string, problem: string): void => {
  const line = `${token} ${where}: ${problem} (directive ${id}; a warning for now, refusal to be reviewed on 2026-12-01)`;
  console.error(line);
  // a watch log that cannot be written must not stop the send this warning rides on: say so on stderr and go on
  try {
    watchLog(path, realClock, { source: where.split(" ")[0] ?? where, line });
  } catch (e) {
    console.error(`${token} not written to the watch log ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
};
