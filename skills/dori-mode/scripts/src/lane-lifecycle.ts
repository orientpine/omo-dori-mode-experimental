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
export const movesFrom = (stateDir: string, pane: string): PaneMove[] => allMoves(stateDir).filter((m) => m.from === pane);
// A record read before a revive and written back after it would name the pane the lane was revived away from (the watch's
// settle and not-done writes, a pause: review 8 of #535). Registry.write keeps the revived pane then: true when the lane's
// latest move went from the pane being written to the pane on disk.
export const revivedAway = (stateDir: string, key: string, writing: string, onDisk: string): boolean => {
  const last = allMoves(stateDir).filter((m) => m.key === key).at(-1);
  return last?.from === writing && last.to === onDisk;
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
