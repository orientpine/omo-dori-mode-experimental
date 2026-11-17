import { realClock } from "./run.ts";
import { watchLog } from "./watch-log.ts";

// Only the author's prose counts: code, quotations, links, identifiers and shell commands are not language evidence.
export const ownerProse = (text: string): string => text
  .replace(/```[\s\S]*?(?:```|$)/g, " ")
  .replace(/`[^`\n]*`/g, " ")
  .replace(/"[^"\n]*"|“[^”\n]*”|'[^'\n]*'/g, " ")
  .split("\n").filter((line) => !/^\s*(?:>|[$#]\s|(?:bun|npm|npx|git|gh|dori|curl|ssh|env|python3?)\s)/.test(line)).join("\n")
  .replace(/https?:\/\/\S+|<[@#][!&]?\d+>|(?:\b[\da-f]{7,40}\b)|\b[A-Z][A-Z0-9_]*_[A-Z0-9_]+\b|\b\d+\b/g, " ");

// Warn only for Korean owners, and only when some prose remains but none of it contains Hangul.
export const koreanOwnerProblem = (text: string, locale: string): string | undefined => {
  if (!locale.toLowerCase().startsWith("ko")) return undefined;
  const prose = ownerProse(text);
  return /\p{L}/u.test(prose) && !/[\u1100-\u11ff\u3130-\u318f\uac00-\ud7a3]/.test(prose) ? "prose has no Hangul" : undefined;
};

// Warning-only rollout: preserve the send and its exit status, and record the same line under the command's tag.
export const textWarning = (path: string, where: string, token: string, id: string, problem: string): void => {
  const line = `${token} ${where}: ${problem} (directive ${id}; a warning until 2026-12-01, then it refuses)`;
  console.error(line);
  watchLog(path, realClock, { source: where.split(" ")[0] ?? where, line });
};
