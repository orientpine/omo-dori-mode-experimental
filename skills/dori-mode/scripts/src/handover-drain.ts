import { tmuxPanePid } from "./aoe.ts";
import { agentTree } from "./frozen.ts";
import { setQuiet } from "./rollover.ts";
import type { Clock, Runner } from "./run.ts";
import type { Proc } from "./session-id.ts";

// The old lead answers the owner until a lead handover commits (ZzangDori 2026-11-26: two checks of ~16 min each left him
// unanswered while both sessions were silent). At the commit its quiet mark refuses every new dori send, ask and thread;
// one already running may be inside its HTTP call while it holds a question claim, so it gets REPLY_DRAIN_MS to end, and
// one still running then is left out of the freeze with its children, like the work of a monitor (review 1 of #533).
const REPLY = /(?:^|[\s/])(?:dori|cli\.ts)\s+(?:send|ask|thread)(?:\s|$)/;
export const REPLY_DRAIN_MS = 30_000;

type DrainDeps = { readonly run: Runner; readonly procs: () => Promise<Proc[]>; readonly clock: Clock };

export const quietOldLead = async (deps: DrainDeps, stateDir: string, lead: string, until: number, why: string, emit: (line: string) => void): Promise<number[]> => {
  setQuiet(stateDir, lead, until, why);
  const shell = await tmuxPanePid(deps.run, lead);
  const replying = async (): Promise<number[]> => {
    if (!shell) return [];
    const table = await deps.procs();
    const tree = new Set(agentTree(table, shell, process.pid).pids);
    return table.filter((p) => tree.has(p.pid) && REPLY.test(p.cmd)).map((p) => p.pid);
  };
  const end = deps.clock.now() + REPLY_DRAIN_MS;
  let left = await replying();
  while (left.length && deps.clock.now() < end) {
    await deps.clock.sleep(1_000);
    left = await replying();
  }
  if (left.length) emit(`HANDOVER_REPLY_KEPT ${lead}: a dori send, ask or thread of the old lead still ran after ${REPLY_DRAIN_MS / 1000} s (${left.join(",")}); it is left out of the freeze so it can end`);
  return left;
};
