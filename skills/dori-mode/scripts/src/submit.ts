import { BUSY_MARK } from "./aoe.ts";
import type { Clock } from "./run.ts";

// Typing into an agent pane only counts once the agent took it: a long or multi-line text folds into
// "[paste #1 +13 lines]" and an Enter sent right after it can be lost, leaving the text unsent while the
// old "is the start of the text still on the ❯ line" check passed (okdori, 2026-10-11).
export type Submitted = { readonly status: "SUBMITTED" | "NOT_SUBMITTED"; readonly reason: string };

export type PaneKeys = {
  // types the text without Enter; a returned string is why it could not
  readonly type: (text: string) => Promise<string | undefined>;
  readonly enter: () => Promise<void>;
  readonly read: () => Promise<string>;
};

export type SubmitTiming = { readonly settleMs: number; readonly pollMs: number; readonly clearPolls: number; readonly busyPolls: number };
export const SUBMIT_TIMING: SubmitTiming = { settleMs: 1_500, pollMs: 500, clearPolls: 6, busyPolls: 30 };

const isBorder = (line: string): boolean => line.trimStart().startsWith("─");

// The agent's input box: the lines between the last two ─ borders (a tall box scrolls its ❯ line out of
// view, so "from ❯ down" misses text). A screen without two borders falls back to the last ❯ line.
const inputBox = (screen: string): { readonly top: number; readonly lines: readonly string[] } => {
  const lines = screen.split("\n");
  const borders = lines.flatMap((line, i) => (isBorder(line) ? [i] : []));
  const top = borders.at(-2);
  const bottom = borders.at(-1);
  if (top !== undefined && bottom !== undefined) return { top, lines: lines.slice(top + 1, bottom) };
  const prompt = lines.findLastIndex((line) => line.trimStart().startsWith("❯"));
  return prompt < 0 ? { top: lines.length, lines: [] } : { top: prompt, lines: [lines[prompt] ?? ""] };
};

// What is still unsent in the input box, the ❯ and whitespace folded away; "" when the box is empty
export const editorText = (screen: string): string =>
  inputBox(screen).lines.map((line) => line.replace(/^\s*❯/, "")).join(" ").replace(/\s+/g, " ").trim();

// The running-turn mark sits on or just above the input box; the transcript higher up may quote it
export const turnRunning = (screen: string): boolean => {
  const lines = screen.split("\n");
  return lines.slice(Math.max(0, inputBox(screen).top - 3)).some((line) => line.toLowerCase().includes(BUSY_MARK));
};

export const submitText = async (keys: PaneKeys, clock: Clock, text: string, timing: SubmitTiming = SUBMIT_TIMING): Promise<Submitted> => {
  const failed = (reason: string): Submitted => ({ status: "NOT_SUBMITTED", reason });
  const typed = await keys.type(text);
  if (typed) return failed(typed);
  await clock.sleep(timing.settleMs); // let the agent take the whole text (a long one arrives as a paste) before Enter
  let screen = "";
  let left = "";
  for (let enter = 1; enter <= 2; enter++) {
    await keys.enter();
    for (let poll = 0; poll < timing.clearPolls; poll++) {
      await clock.sleep(timing.pollMs);
      screen = await keys.read();
      left = editorText(screen);
      if (!left) break;
    }
    if (!left) break;
  }
  if (left) return failed(`text still in the input box after 2 Enters: ${left.slice(0, 60)}`);
  for (let poll = 0; poll < timing.busyPolls; poll++) {
    if (turnRunning(screen)) return { status: "SUBMITTED", reason: "input box empty and the turn runs" };
    await clock.sleep(timing.pollMs);
    screen = await keys.read();
  }
  return failed(`input box empty but no running turn ("${BUSY_MARK}") within ${(timing.busyPolls * timing.pollMs) / 1000}s`);
};
