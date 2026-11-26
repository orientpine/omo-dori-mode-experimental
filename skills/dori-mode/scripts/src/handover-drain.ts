import { existsSync, readdirSync } from "node:fs";

import { captureTmux, currentTmuxSession, tmuxPanePid } from "./aoe.ts";
import { QuestionStore } from "./messenger/discord-cards.ts";
import { descendants } from "./process-tree.ts";
import { setQuiet } from "./rollover.ts";
import type { Clock, Runner } from "./run.ts";
import type { Proc } from "./session-id.ts";
import { turnRunning } from "./submit.ts";

// The old lead answers the owner until a lead handover commits (ZzangDori 2026-11-26: two checks of ~16 min each left him
// unanswered while both sessions were silent), so at the commit it may be in the middle of a reply. Once the checks passed
// it gets its quiet mark (new dori send, ask and thread refused) and is frozen only at rest: no turn on its screen and no
// question claim held. A claim is a flock that a stopped process keeps (a dori ask, resolve or reopen holds one across its
// HTTP call, in a turn or a background job), so it is asked of the lock itself, and kept until the freeze is done. An old lead not at rest within SETTLE_MS
// fails the checks: the move rolls back and nothing is frozen or closed, and freshness tries again (reviews 1-3 of #533).
// Whatever is in doubt rolls back the same way (lead, review 5 of #533): every card is claimed, an answered one too (a
// dori reopen takes its claim later); a dori send, thread, ask, reopen or resolve still running under the old lead (a
// background job holds no claim) is not at rest; and after the wait the new session's monitors and todos are checked
// again, since one can end while the old lead settles.
export const SETTLE_MS = 60_000;
const POLL_MS = 2_000;

type SettleDeps = { readonly run: Runner; readonly clock: Clock; readonly cardDir: string; readonly procs: () => Promise<readonly Proc[]> };
const DORI = /(?:^|[\s/\\])(?:dori|cli\.ts)\s+(send|thread|ask|reopen|resolve)(?=\s|$)/;

// the first owner-facing dori command running under the pane's shell, but not this command or what runs it
const doriUnder = async (deps: SettleDeps, lead: string): Promise<string | undefined> => {
  const shell = await tmuxPanePid(deps.run, lead).catch(() => 0);
  const table = shell ? await deps.procs().catch(() => undefined) : undefined;
  if (!table) return "its processes could not be listed";
  const parent = new Map(table.map((p) => [p.pid, p.ppid]));
  const mine = new Set<number>();
  for (let p: number | undefined = process.pid; p && !mine.has(p); p = parent.get(p)) mine.add(p);
  const hit = descendants(table, shell).find((p) => !mine.has(p.pid) && DORI.test(p.cmd));
  return hit ? `a dori ${DORI.exec(hit.cmd)?.[1]} of it was still running, pid ${hit.pid}` : undefined;
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
    const running = await doriUnder(deps, lead);
    if (running) return running;
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
  // the claims stay taken until the caller froze the old lead: a dori ask, resolve or reopen it starts meanwhile waits for
  // them and holds none when it is stopped
  const held = taken;
  taken = [];
  return { ...checked, release: () => { for (const r of held) r(); } };
};
