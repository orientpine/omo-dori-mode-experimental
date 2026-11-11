// What an owner message's inbox row carries (dori inbound discord) and dori directives hint prints: the directives its
// words call, from textDirectives.
import { type Directive, directiveLine, type Ledger, textDirectives } from "./directives.ts";

// How many directives an owner message carries in the inbox row (dori inbound discord): the lead reads them in every
// monitor event, so only the ones his message is about. Every entry one of his words calls by keyword comes in, however
// many; the kind-of-work matches fill the row up to this many (2026-11-11: YooDori's sixth 회신 entry pushed
// mail-check-sent out of "회신 초안 써줘").
export const HINT_LIMIT = 5;

// The directives an owner message's row carries: every entry whose own keywords are in the text (even when a kind gave
// its why), then the other matches up to HINT_LIMIT in all, in textDirectives' order.
export const hintDirectives = (text: string, ledger: Ledger): { readonly e: Directive; readonly why: string }[] => {
  const found = textDirectives(text, ledger);
  let room = Math.max(0, HINT_LIMIT - found.filter((x) => x.keyword).length);
  return found.filter((x) => x.keyword || room-- > 0);
};

// What an owner message's inbox row carries: the lines of hintDirectives, and when the tolerant load left local lines out
// (or the whole local layer), one last line saying so, so the lead knows the host's own directives may be missing (dori
// thread open refuses on it instead).
export const messageLines = (text: string, ledger: Ledger): string[] => {
  const lines = hintDirectives(text, ledger).map(({ e }) => directiveLine(e));
  const skipped = ledger.skipped ?? [];
  return skipped.length ? [...lines, `[장부 경고] 이 도리 로컬 장부에서 ${skipped.length}줄을 못 읽어 뺐다: ${skipped[0]?.slice(0, 200)}. dori directives check로 고친다.`] : lines;
};
