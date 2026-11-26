import { captureTmux, currentTmuxSession } from "./aoe.ts";
import { setQuiet } from "./rollover.ts";
import type { Clock, Runner } from "./run.ts";
import { turnRunning } from "./submit.ts";

// The old lead answers the owner until a lead handover commits (ZzangDori 2026-11-26: two checks of ~16 min each left him
// unanswered while both sessions were silent). At the commit its quiet mark refuses every new dori send, ask and thread,
// and it is frozen only once its running turn has ended: a dori ask, resolve or reopen inside a turn holds the question's
// claim (a flock, kept by a stopped process and dropped by a dead one), so a turn still running after TURN_END_MS is not
// stopped and the commit goes the freeze-failed way (closed, or open and quiet with --keep-old). No command is matched by
// its text, so no platform or subcommand slips past (reviews 1 and 2 of #533).
export const TURN_END_MS = 60_000;
const POLL_MS = 2_000;

type QuietDeps = { readonly run: Runner; readonly clock: Clock };

export const quietOldLead = async (deps: QuietDeps, stateDir: string, lead: string, until: number, why: string): Promise<string | undefined> => {
  setQuiet(stateDir, lead, until, why);
  // run inside the old lead itself, its own turn runs this command and the freeze refuses it anyway
  if ((await currentTmuxSession(deps.run)) === lead) return undefined;
  const end = deps.clock.now() + TURN_END_MS;
  while (turnRunning(await captureTmux(deps.run, lead).catch(() => ""))) {
    if (deps.clock.now() >= end) return `its turn still ran ${TURN_END_MS / 1000} s after the commit, and a stopped turn would keep any question claim it holds`;
    await deps.clock.sleep(POLL_MS);
  }
  return undefined;
};
