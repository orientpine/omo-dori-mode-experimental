import { BUSY_MARK, paneLife, WAKE_MARKS, inputLine } from "./aoe.ts";
import { turnRunning } from "./submit.ts";
import { isHerdrPane } from "./herdr.ts";
import type { FlowDeps } from "./done-flow.ts";
import { readScreen } from "./panes.ts";
import { lastLines } from "./pending-goal.ts";

const STARTUP_FAILURE = /Cannot find module|All fallback models failed|No API key|model_not_available|usage limit|rate limit|quota|Session crashed|unknown provider|Model "[^"\n]*" not found|Pane is dead/i;

// A failure word is a failed start only where the agent itself put it (dori-superagent PR #51 review reproduced here (MIT):
// https://github.com/sisyphuslabs/dori-superagent/pull/51#discussion_r4445875794, a working lane quotes such words). On
// 2026-11-02 two healthy lanes got STARTUP_ERROR rate limit from the 40 lines launch reads: the cat of a log, the lane's
// own brief in a tool result, and the status lines under the input box (the session title and goal objective omo makes
// from the brief, the account usage bars). Measured on omo 5.1.51: its own errors are one line each, drawn above the
// input box at most one space in, as "Error: ..." (No API key found, 429, out of quota; the CLI's Model "x" not found),
// "The <provider> account usage limit has been reached" or "All <name> accounts for <provider> are currently blocked";
// tmux adds "Pane is dead" at the bottom; bun's own crash is "error: Cannot find module". So a failure word counts only on
// such a line (prose that merely starts with a failure word or "Error handling ..." is none), never while a turn runs (a
// running lane quotes what it reads; a 429 omo retries shows no running-turn mark and still counts), and never once the
// model has answered this launch: the newest reply in the lane's own session, written since the launch began, ended
// without an error (a resumed session's older replies say nothing about this start).
const OWN_ERROR = /^ ?(?:error:|All \S+ accounts for \S+ are currently blocked|The \S+ account usage limit has been reached|Pane is dead)/i;

// omo draws its running-turn mark ("── • Working (4s • esc to interrupt) ──") on the border right above the ❯ line;
// the status lines under the box may quote the words (a session title), so only the lines just above the ❯ are read
export const startupFailure = (screen: string, answered = false): string | undefined => {
  const lines = screen.split("\n");
  const box = lines.findLastIndex((l) => l.trimStart().startsWith("❯"));
  const running = box >= 0 && lines.slice(Math.max(0, box - 3), box).some((l) => l.toLowerCase().includes(BUSY_MARK));
  if (answered || running) return undefined;
  for (const [i, line] of lines.entries()) {
    const own = box < 0 || i < box ? OWN_ERROR.test(line) : line.startsWith("Pane is dead");
    const bad = own ? STARTUP_FAILURE.exec(line) : null;
    if (bad) return bad[0];
  }
  return undefined;
};


// No failure word on screen is not a start (ported from dori-superagent 40034ad, #7, MIT,
// https://github.com/sisyphuslabs/dori-superagent/commit/40034ad1a557b92a34aa1450565adcafd3352c96, with tmux and the
// agent's own screen in place of herdr's agent_status): STARTUP_OK only when the session still runs and its agent shows a
// running turn, a wake mark or its ❯ input line 20 s after the lane prompt; a session that ended is a STARTUP_ERROR, and
// anything else is STARTUP_UNCONFIRMED with its last lines, for the lead to look at (exit 3 like an error).
export const aoeStartup = async (deps: FlowDeps, key: string, pane: string, screen: string): Promise<string> => {
  const life = await paneLife(deps.run, pane);
  if (!life.live) return `STARTUP_ERROR ${key} ${pane}: ${life.how === "gone" ? (isHerdrPane(pane) ? "the herdr pane is gone" : "the tmux session is gone") : life.status < 0 ? "no agent runs in the pane any more" : `the agent exited (status ${life.status})`}`;
  const full = await readScreen(deps.run, "aoe", pane);
  const shows = [screen, full].some((s) => turnRunning(s) || WAKE_MARKS.some((m) => s.includes(m)) || inputLine(s) !== undefined);
  return shows ? `STARTUP_OK ${key} ${pane}` : `STARTUP_UNCONFIRMED ${key} ${pane}: no running turn and no ❯ prompt on screen; last lines: ${lastLines(full || screen)}`;
};
