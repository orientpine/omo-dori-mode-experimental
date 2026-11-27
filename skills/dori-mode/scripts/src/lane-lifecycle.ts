import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";

import { CheckpointError, takeLock } from "./checkpoint-lock.ts";
import type { FlowDeps } from "./done-flow-state.ts";
import type { HistoryEntry, Lane } from "./registry.ts";

// A revive, a close and every registry write of one lane take turns on this lock (reviews 2 and 11 of #535): a revive checks the lane is still open in
// its gone pane and writes the new pane under it, and a close reads the lane again and writes it closed under it, closing a
// pane a revive wrote since the close began. So a new pane is either seen and closed by the close or never written. Both
// sections are short (a read, a write, one pane close; a revive's start, seconds), so a busy lock is waited for in real time,
// up to 240 s: longer than a revive holds it (its agent's start is waited for up to 3 minutes).
// Each revive writes where a lane's session moved (review 6 of #535): a card answered while the old pane was gone keeps
// that pane in answers.jsonl, often with no session (dori ask without --session), so the owner-waiting check finds the
// revived lane through this record, never through a card's metadata.
export type PaneMove = { readonly key: string; readonly session: string; readonly from: string; readonly to: string; readonly at: string };
const movesFile = (stateDir: string): string => join(stateDir, "revive", "moved.jsonl");
export const recordMove = (stateDir: string, move: PaneMove): void => {
  mkdirSync(join(stateDir, "revive"), { recursive: true });
  appendFileSync(movesFile(stateDir), `${JSON.stringify(move)}\n`);
};
const allMoves = (stateDir: string): PaneMove[] => {
  const file = movesFile(stateDir);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").flatMap((line) => {
    try {
      const m = JSON.parse(line) as Partial<PaneMove>;
      return typeof m.key === "string" && typeof m.session === "string" && typeof m.from === "string" && typeof m.to === "string" ? [m as PaneMove] : [];
    } catch {
      return [];
    }
  });
};
// The lead's rule for a revived lane's cards (2026-11-27): an answer asked from pane `from` goes on to the lane's pane by
// itself only when the lane's moves, walked in order from the first one leaving `from`, all stay on the lane's session,
// none branches off the walk, and the walk ends on the lane's pane now. Anything else is doubt: the answer stays.
export const provenRoute = (stateDir: string, lane: { readonly key: string; readonly pane?: string | undefined; readonly session?: string | undefined }, from: string): boolean => {
  const mine = allMoves(stateDir).filter((m) => m.key === lane.key);
  const start = mine.findIndex((m) => m.from === from);
  if (start < 0 || !lane.session || !lane.pane) return false;
  let at = from;
  for (const m of mine.slice(start)) {
    if (m.from !== at || m.session !== lane.session) return false;
    at = m.to;
  }
  return at === lane.pane;
};

const WAIT_MS = 100;
const TRIES = 2_400;

// Held again inside its own section (the same async chain: a revive's section writing the lane, a registry write inside a
// close) the lock is not taken twice; another chain or process waits for it (review 11 of #535).
const held = new AsyncLocalStorage<ReadonlySet<string>>();
// one "wait" event (detail: the lane key) when a caller first finds the lane locked: tests watch a caller wait, no clock
export const lockWaits = new EventTarget();
export const withLaneLock = async <T>(stateDir: string, key: string, wait: (ms: number) => Promise<void>, now: () => number, section: () => Promise<T>): Promise<T> => {
  if (held.getStore()?.has(key)) return section();
  const dir = join(stateDir, "revive");
  mkdirSync(dir, { recursive: true });
  for (let i = 0; ; i++) {
    let release: () => void;
    try {
      release = takeLock(join(dir, `${key}.lifecycle.lock`), now(), "lane lifecycle", key);
    } catch (error) {
      if (!(error instanceof CheckpointError) || i >= TRIES) throw error;
      if (i === 0) lockWaits.dispatchEvent(new CustomEvent("wait", { detail: key }));
      await wait(WAIT_MS);
      continue;
    }
    try {
      return await held.run(new Set([...(held.getStore() ?? []), key]), section);
    } finally {
      release();
    }
  }
};
// A lane record changed whole under the lane's lock, from the record as it is then: a history note (the lead handover's)
// and a launch's final record merged onto what sweeps wrote while its agent started; a pane a handover moved the lane to
// meanwhile wins, with its session (review 17 of #535).
export const noteLaneHistory = (deps: Pick<FlowDeps, "config" | "clock" | "registry">, fallback: Lane, entry: (fresh: Lane) => HistoryEntry): Promise<void> => withLaneLifecycle(deps, fallback.key, async () => { const fresh = (await deps.registry.read(fallback.key)) ?? fallback; await deps.registry.write({ ...fresh, history: [...(fresh.history ?? []), entry(fresh)] }); });
export const writeOnFresh = (deps: Pick<FlowDeps, "config" | "clock" | "registry">, lane: Lane): Promise<void> => withLaneLifecycle(deps, lane.key, async () => {
  const fresh = await deps.registry.read(lane.key);
  const moved = fresh && fresh.pane !== lane.pane ? { pane: fresh.pane, tab: fresh.tab, paneRev: fresh.paneRev, session: fresh.session, sessionVia: fresh.sessionVia } : {};
  await deps.registry.write({ ...(fresh ?? {}), ...lane, ...moved } as Lane);
});
export const withLaneLifecycle = <T>(deps: Pick<FlowDeps, "config" | "clock">, key: string, section: () => Promise<T>): Promise<T> => withLaneLock(deps.config.stateDir, key, (ms) => Bun.sleep(ms), () => deps.clock.now(), section);
