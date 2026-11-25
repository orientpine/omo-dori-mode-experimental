import { join } from "node:path";
import { CheckpointError, takeLock } from "./checkpoint-lock.ts";
import type { SlotDeps } from "./heavy-slot-types.ts";

export class HeavyAdmissionError extends Error {
  override readonly name = "HeavyAdmissionError";
}

// https://github.com/sisyphuslabs/dori-superagent/pull/264
// Stop and admission use the same kernel lock, reusing the fork's lazy flock and inode-safe handoff.
export const withHeavyFlock = async <T>(deps: SlotDeps, section: () => Promise<T>): Promise<T | null> => {
  if (process.platform !== "linux" && process.platform !== "darwin")
    throw new HeavyAdmissionError(`dynamic heavy admission needs flock(2) on Linux or macOS, not ${process.platform}`);
  let release: () => void;
  try {
    release = takeLock(join(deps.dir, "admit.flock"), deps.clock.now(), "heavy admission", deps.dir);
  } catch (e) {
    if (e instanceof CheckpointError) return null;
    throw new HeavyAdmissionError(`cannot lock dynamic heavy admission in ${deps.dir}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
  try {
    return await section();
  } finally {
    release();
  }
};
