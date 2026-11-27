import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { captureTmux, currentTmuxSession } from "./aoe.ts";
import { holdAdmission } from "./checkpoint-lock.ts";
import { QuestionStore } from "./messenger/discord-cards.ts";
import { setQuiet } from "./rollover.ts";
import type { Clock, Runner } from "./run.ts";
import { turnRunning } from "./submit.ts";

// The old lead answers the owner until a lead handover commits (ZzangDori 2026-11-26: two checks of ~16 min each left him
// unanswered while both sessions were silent), so at the commit it may be in the middle of a reply. Once the checks passed
// it gets its quiet mark (new dori send, ask and thread refused) and is frozen only at rest: no turn on its screen and no
// question claim held. A claim is a flock that a stopped process keeps (a dori ask, resolve or reopen holds one across its
// HTTP call, in a turn or a background job), so it is asked of the lock itself, and kept until the freeze is done. An old lead not at rest within SETTLE_MS
// fails the checks: the move rolls back and nothing is frozen or closed, and freshness tries again (reviews 1-3 of #533).
// Whatever is in doubt rolls back the same way (lead, review 5 of #533): every card is claimed, an answered one too (a
// dori reopen takes its claim later), and after the wait the new session's monitors and todos are checked again, since
// one can end while the old lead settles. A dori send, thread, ask, reopen or resolve in flight (in a turn or a background
// job) is not read from outside (reviews 5-7 found blind spots in each process scan): each holds its pane's admission
// lock shared for its whole run, and the move takes it exclusive before the freeze (H414, lead 2026-11-27).
export const SETTLE_MS = 60_000;
const POLL_MS = 2_000;
const ADMIT_MS = 3_000;
const ADMIT_POLL_MS = 100;

// one per lead pane, named like its quiet mark; permanent (holdAdmission)
export const admissionFile = (stateDir: string, pane: string): string => join(stateDir, "handover", "admission", `${pane.replace(/[^\w.-]/g, "_")}.lock`);

type SettleDeps = { readonly run: Runner; readonly clock: Clock; readonly cardDir: string };

// A dori command that talks to the owner takes its pane's admission lock shared and keeps it until it exits (the kernel
// lets go then). It never stands still for a handover: while one holds the lock exclusive it waits ADMIT_MS at most, then
// goes on without the lock as before, and the line says so for the watch log. No pane (a service): nothing to hold.
export const admitOwnerCommand = async (stateDir: string, pane: string, clock: Clock): Promise<{ readonly release?: () => void; readonly line?: string }> => {
  if (!pane) return {};
  const end = clock.now() + ADMIT_MS;
  for (;;) {
    let release: (() => void) | undefined;
    try {
      release = holdAdmission(admissionFile(stateDir, pane), "shared");
    } catch (e) {
      return { line: `ADMISSION_WAIT_PASSED ${pane}: its admission lock could not be taken (${e instanceof Error ? e.message : String(e)}); this command goes on without it` };
    }
    if (release) return { release };
    if (clock.now() >= end) return { line: `ADMISSION_WAIT_PASSED ${pane}: a lead handover held its admission lock past ${ADMIT_MS / 1000} s; this command goes on without it` };
    await clock.sleep(ADMIT_POLL_MS);
  }
};

export const settleOldLead = async <C extends { readonly reasons: readonly string[]; readonly session: string }>(deps: SettleDeps, checked: C, stateDir: string, lead: string, until: number, why: string, recheck: (session: string) => readonly string[]): Promise<C & { readonly release?: () => void }> => {
  if (checked.reasons.length) return checked;
  setQuiet(stateDir, lead, until, why);
  // run inside the old lead itself, its own turn runs this command: only the claims are asked
  const inside = (await currentTmuxSession(deps.run)) === lead;
  const store = new QuestionStore(deps.cardDir);
  let taken: (() => void)[] = [];
  const letGo = (): void => {
    for (const r of taken.splice(0)) r();
  };
  const unrest = async (): Promise<string | undefined> => {
    if (!inside) {
      const screen = await captureTmux(deps.run, lead).catch(() => "");
      if (!screen.trim()) return "its screen could not be read";
      if (turnRunning(screen)) return "its turn was still running";
    }
    // every card, and every claim file (a card being made): an answered one is claimed for its repaint or a reopen
    const files = existsSync(deps.cardDir) ? readdirSync(deps.cardDir).flatMap((n) => /^claim-(.+)\.lock$/.exec(n)?.[1] ?? []) : [];
    for (const id of new Set([...store.all().map((x) => x.id), ...files])) {
      const release = store.claim(id, deps.clock.now());
      if (!release) {
        letGo();
        return `the claim of card ${id} was still held`;
      }
      taken.push(release);
    }
    let admission: (() => void) | undefined;
    try {
      admission = holdAdmission(admissionFile(stateDir, lead), "exclusive");
    } catch (e) {
      letGo();
      return `the admission lock could not be taken: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (!admission) {
      letGo();
      return "a dori send, thread, ask, reopen or resolve of it was still running: its admission lock was held";
    }
    taken.push(admission);
    return undefined;
  };
  const end = deps.clock.now() + SETTLE_MS;
  for (let busy = await unrest(); busy; busy = await unrest()) {
    if (deps.clock.now() >= end) return { ...checked, reasons: [`the old lead ${lead} did not come to rest within ${SETTLE_MS / 1000} s after the checks passed (${busy}); nothing was frozen or closed`] };
    await deps.clock.sleep(POLL_MS);
  }
  const gone = recheck(checked.session);
  if (gone.length) {
    letGo();
    return { ...checked, reasons: [...gone] };
  }
  // the claims and the admission lock stay taken until the caller froze the old lead: a dori command it starts meanwhile
  // waits for them and holds none when it is stopped
  const held = taken;
  taken = [];
  return { ...checked, release: () => { for (const r of held) r(); } };
};
