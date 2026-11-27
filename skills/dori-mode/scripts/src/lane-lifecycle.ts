import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { CheckpointError, takeLock } from "./checkpoint-lock.ts";
import type { FlowDeps } from "./done-flow-state.ts";

// A revive and a close of one lane take turns on this lock (review 2 of #535): a revive checks the lane is still open in
// its gone pane and writes the new pane under it, and a close reads the lane again and writes it closed under it, closing a
// pane a revive wrote since the close began. So a new pane is either seen and closed by the close or never written. Both
// sections are short (a read, a write, one pane close), so a busy lock is waited for, up to 30 s.
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
