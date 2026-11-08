// Ported from https://github.com/sisyphuslabs/omo-dori-mode-experimental/blob/90f02c19fd86ce70cfd6a74f521c9acd24428cc3/skills/dori-mode/scripts/src/checkpoints.ts
// (upstream PR #61 (4ea8bd1)), with fork changes marked "Fork change" (reviews of orientpine#297): the writer lock is a
// kernel flock (no takeover by age), an identical replay is flushed before it is acknowledged, and a record is appended
// whole or not at all, and per-lane state lives in <stateDir>/lane-state/<key>/, apart from the registry.
import { closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, readSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { LANE_KEY } from "./registry.ts";
import { CheckpointError, takeLock } from "./checkpoint-lock.ts";

export { CheckpointError, takeLock } from "./checkpoint-lock.ts";

export type CheckpointInput = {
  readonly step: string;
  readonly result: string;
  readonly evidence: readonly string[];
  readonly remoteEffects: readonly string[];
};
export type Checkpoint = CheckpointInput & { readonly key: string; readonly at: string };

const validate = (input: CheckpointInput): void => {
  if (typeof input.step !== "string" || !input.step.trim() ||
      typeof input.result !== "string" || !input.result.trim() ||
      !Array.isArray(input.evidence) || !input.evidence.every((v) => typeof v === "string") ||
      !Array.isArray(input.remoteEffects) || !input.remoteEffects.every((v) => typeof v === "string")) {
    throw new CheckpointError("checkpoint requires step, result, evidence[], and completed remoteEffects[]");
  }
};
const payload = (value: CheckpointInput): string => JSON.stringify({
  step: value.step, result: value.result, evidence: value.evidence, remoteEffects: value.remoteEffects,
});


const flush = (path: string): void => {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

export class Checkpoints {
  constructor(readonly stateDir: string, readonly platform: string = process.platform) {}

  path(key: string): string {
    if (!LANE_KEY.test(key)) throw new CheckpointError(`invalid lane key: ${key}`);
    // Fork change (review 3 of orientpine#297): per-lane state lives apart from the registry's <stateDir>/lanes/<key>.json
    // files. Under lanes/<key>/, a lane keyed foo.json would make a directory the registry reads as a lane, and a lane
    // keyed foo.json could not checkpoint while a lane foo exists.
    return join(this.stateDir, "lane-state", key, "checkpoints.jsonl");
  }

  read(key: string): Checkpoint[] {
    const path = this.path(key);
    if (!existsSync(path)) return [];
    const steps = new Set<string>();
    return readFileSync(path, "utf8").split("\n").map((line, index) => ({ line, index })).filter(({ line }) => line.trim()).map(({ line, index }) => {
      try {
        const value = JSON.parse(line) as Checkpoint;
        validate(value);
        if (value.key !== key || typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at)) || steps.has(value.step)) {
          throw new CheckpointError("invalid key, timestamp, or duplicate step");
        }
        steps.add(value.step);
        return value;
      } catch (error) {
        throw new CheckpointError(`${path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  /** Take the journal's writer lock (takeLock on <journal>.lock) and return its release. */
  lock(key: string, now: number): () => void {
    const path = this.path(key);
    mkdirSync(dirname(path), { recursive: true });
    return takeLock(`${path}.lock`, now, "checkpoint writer", key);
  }

  write(key: string, input: CheckpointInput, now: number): { checkpoint: Checkpoint; unchanged: boolean } {
    // The journal's durability (fsync of the file and its directory) uses handles Windows cannot flush, so on native
    // Windows a checkpoint is refused before anything is written, not half-written.
    if (this.platform === "win32") {
      throw new CheckpointError("checkpoints are not supported on native Windows yet; nothing was written (record the step in the lane's report instead)");
    }
    validate(input);
    const path = this.path(key);
    const at = new Date(now).toISOString();
    // Never replay a remote effect just because the process restarted: the step check runs under the lock.
    const release = this.lock(key, now);
    try {
      const recorded = this.read(key);
      const previous = recorded.find((entry) => entry.step === input.step);
      if (previous) {
        if (payload(previous) !== payload(input)) throw new CheckpointError(`conflicting checkpoint step: ${input.step}`);
        // Fork change (review of orientpine#297): the record may be one a writer killed before its fsync appended, so it is
        // flushed (with the journal's directory entry) before it is acknowledged.
        flush(path);
        flush(dirname(path));
        return { checkpoint: previous, unchanged: true };
      }
      // A receipt names one completed remote effect; recording it under a second step would read as a second effect.
      for (const entry of recorded) {
        const repeated = input.remoteEffects.find((receipt) => entry.remoteEffects.includes(receipt));
        if (repeated !== undefined) throw new CheckpointError(`remote effect ${repeated} already recorded by step ${entry.step}`);
      }
      const checkpoint: Checkpoint = { key, at, ...JSON.parse(payload(input)) };
      const created = !existsSync(path);
      const fd = openSync(path, "a+", 0o600);
      try {
        // Fork change (review of orientpine#297): the whole record or nothing. A short write (a full disk) is written on
        // until done; one that fails is cut off again, so the journal keeps its valid lines and nothing is acknowledged.
        // A last record a writer left without its newline (interrupted after the closing brace) gets one first, in the
        // same write, so the new record starts its own line.
        const before = fstatSync(fd).size;
        const last = Buffer.alloc(1);
        const separator = before > 0 && readSync(fd, last, 0, 1, before - 1) === 1 && last[0] !== 0x0a ? "\n" : "";
        const bytes = Buffer.from(`${separator}${JSON.stringify(checkpoint)}\n`);
        try {
          for (let done = 0; done < bytes.length;) {
            const n = writeSync(fd, bytes, done, bytes.length - done);
            if (n <= 0) throw new CheckpointError(`checkpoint not written: ${path} took ${done} of ${bytes.length} bytes`);
            done += n;
          }
          fsyncSync(fd);
        } catch (error) {
          ftruncateSync(fd, before);
          fsyncSync(fd);
          throw error;
        }
      } finally {
        closeSync(fd);
      }
      // A new journal's directory entry must be durable too, or a crash could lose the first checkpoint after it was acknowledged.
      if (created) {
        const dir = openSync(dirname(path), "r");
        try {
          fsyncSync(dir);
        } finally {
          closeSync(dir);
        }
      }
      return { checkpoint, unchanged: false };
    } finally {
      release();
    }
  }
}
