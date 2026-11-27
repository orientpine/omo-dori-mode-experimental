import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CheckpointError, takeLock } from "./checkpoint-lock.ts";
import type { FlowDeps } from "./done-flow-state.ts";

// A revive and a close of one lane take turns on this lock (review 2 of #535): a revive checks the lane is still open in
// its gone pane and writes the new pane under it, and a close reads the lane again and writes it closed under it, closing a
// pane a revive wrote since the close began. So a new pane is either seen and closed by the close or never written. Both
// sections are short (a read, a write, one pane close), so a busy lock is waited for, up to 30 s.
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
// A record read before a revive and written back after it would name the pane the lane was revived away from (the watch's
// settle and not-done writes, a pause: review 8 of #535). Registry.write keeps the revived pane then: true when the lane's
// latest move ended on the pane on disk and some move left the pane being written (A to B to C, then an old read naming A;
// review 9 of #535). A move back (a refused start) is recorded too, so its own write passes.
export const revivedAway = (stateDir: string, key: string, writing: string, onDisk: string): boolean => {
  const mine = allMoves(stateDir).filter((m) => m.key === key);
  return mine.at(-1)?.to === onDisk && mine.some((m) => m.from === writing);
};

const WAIT_MS = 100;
const TRIES = 300;

export const withLaneLifecycle = async <T>(deps: Pick<FlowDeps, "config" | "clock">, key: string, section: () => Promise<T>): Promise<T> => {
  const dir = join(deps.config.stateDir, "revive");
  mkdirSync(dir, { recursive: true });
  for (let i = 0; ; i++) {
    let release: () => void;
    try {
      release = takeLock(join(dir, `${key}.lifecycle.lock`), deps.clock.now(), "lane lifecycle", key);
    } catch (error) {
      if (!(error instanceof CheckpointError) || i >= TRIES) throw error;
      await deps.clock.sleep(WAIT_MS);
      continue;
    }
    try {
      return await section();
    } finally {
      release();
    }
  }
};
