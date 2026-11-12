import { BUSY_MARK, paneLife, WAKE_MARKS, inputLine } from "./aoe.ts";
import { turnRunning } from "./submit.ts";
import { isHerdrPane } from "./herdr.ts";
import type { FlowDeps } from "./done-flow.ts";
import { readScreen } from "./panes.ts";
import { lastLines } from "./pending-goal.ts";
import { startupPhrase } from "./startup-phrases.ts";

// A failure word is a failed start only where the agent itself put it (dori-superagent PR #51 review reproduced here (MIT):
// https://github.com/sisyphuslabs/dori-superagent/pull/51#discussion_r4445875794, a working lane quotes such words). On
// 2026-11-02 two healthy lanes got STARTUP_ERROR rate limit from the 40 lines launch reads: the cat of a log, the lane's
// own brief in a tool result, and the status lines under the input box (the session title and goal objective omo makes
// from the brief, the account usage bars). Measured on omo 5.1.51: its own errors are one line each, drawn above the
// input box at most one space in, as "Error: ..." (No API key found, 429, out of quota; the CLI's Model "x" not found),
// "The <provider> account usage limit has been reached" or "All <name> accounts for <provider> are currently blocked";
// tmux adds "Pane is dead" at the bottom; bun's own crash is "error: Cannot find module". So a failure word counts only on
// such a line (prose that merely starts with a failure word or "Error handling ..." is none), never while a turn runs (a
// running lane quotes what it reads; a 429 omo retries shows no running-turn mark and still counts). The lane's own
// session goes first: when its newest reply was written since the launch began (a resumed session's older replies say
// nothing about this start), that reply says how the start went: none when it ended without an error, else the phrase in
// its error text. That text is whole, while omo wraps its own error to the pane itself (pi-tui Text, one space each side)
// and prints the rows as lines hc keeps apart: at 32 columns " Error: The provider account is" / " out of quota. ..."
// (review 5 of #471). Only with no such reply is the screen read, where a narrow pane can still split a phrase.
const OWN_ERROR = /^ ?(?:error:|All \S+ accounts for \S+ are currently blocked|The \S+ account usage limit has been reached|Pane is dead)/i;

// Each line of the screen is a line the agent printed: hc's read joins the rows a long line wraps onto (its text is
// ghostty-vt's plain_text, "soft wraps joined", herdrdev/herdr-core since ca5699ab; hc 0.1.18 measured, review 3 of #471).
// dori-superagent PR #205 (SUL-1.0: NOTICE, https://github.com/sisyphuslabs/dori-superagent/pull/205) and #470 joined a
// full-width row to the next instead, which only glued two printed lines; that join is taken out again here.

// omo draws its running-turn mark ("── • Working (4s • esc to interrupt) ──") on the border right above the ❯ line;
// the status lines under the box may quote the words (a session title), so only the lines just above the ❯ are read.
export const startupFailure = (screen: string, reply?: { readonly error?: string }): string | undefined => {
  const lines = screen.split("\n");
  const box = lines.findLastIndex((l) => l.trimStart().startsWith("❯"));
  const running = box >= 0 && lines.slice(Math.max(0, box - 3), box).some((l) => l.toLowerCase().includes(BUSY_MARK));
  if (running) return undefined;
  if (reply) return reply.error === undefined ? undefined : (startupPhrase(reply.error) ?? undefined);
  for (const [i, line] of lines.entries()) {
    const above = box < 0 || i < box;
    const own = above ? OWN_ERROR.test(line) : line.startsWith("Pane is dead");
    // the failure phrase table of dori-superagent #207 and #210 (startup-phrases.ts): a topic word is none
    const bad = own ? startupPhrase(line) : null;
    if (bad) return bad;
  }
  return undefined;
};


// No failure word on screen is not a start (ported from dori-superagent 40034ad, #7, MIT,
// https://github.com/sisyphuslabs/dori-superagent/commit/40034ad1a557b92a34aa1450565adcafd3352c96, with tmux and the
// agent's own screen in place of herdr's agent_status): STARTUP_OK only when the session still runs and its agent shows a
// running turn, a wake mark or its ❯ input line 20 s after the lane prompt, or on a re-read while a slow host brings it up
// (recheck, pending-goal.ts startupRechecks, #202); a session that ended, or a failure line on a re-read (failure), is a
// STARTUP_ERROR at once, and an agent that shows none of them within the wait is STARTUP_UNCONFIRMED with its last lines,
// for the lead to look at (exit 3 like an error). prompted: the clock when the agent got its prompt.
export const aoeStartup = async (deps: FlowDeps, key: string, pane: string, screen: string, failure: (screen: string) => string | undefined, recheck: () => Promise<boolean>, prompted: number): Promise<string> => {
  for (let shown = screen; ; ) {
    const life = await paneLife(deps.run, pane);
    if (!life.live) return `STARTUP_ERROR ${key} ${pane}: ${life.how === "gone" ? (isHerdrPane(pane) ? "the herdr pane is gone" : "the tmux session is gone") : life.status < 0 ? "no agent runs in the pane any more" : `the agent exited (status ${life.status})`}`;
    const full = await readScreen(deps.run, "aoe", pane);
    if ([shown, full].some((s) => turnRunning(s) || WAKE_MARKS.some((m) => s.includes(m)) || inputLine(s) !== undefined)) return `STARTUP_OK ${key} ${pane}`;
    if (!(await recheck())) return `STARTUP_UNCONFIRMED ${key} ${pane}: no running turn and no ❯ prompt on screen after ${Math.round((deps.clock.now() - prompted) / 1_000)} s; last lines: ${lastLines(full || shown)}`;
    shown = await readScreen(deps.run, deps.config.backend, pane, 40);
    const bad = failure(shown);
    if (bad) return `STARTUP_ERROR ${key} ${pane}: ${bad}`;
  }
};
