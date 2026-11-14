import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { HeavyHelper, HeavyQueue } from "../src/config.ts";
import { heavyBatch, type BatchJob, type BatchReceipt } from "../src/heavy-batch.ts";
import type { HeavyCtx } from "../src/heavy-queue.ts";
import type { SlotDeps } from "../src/heavy-slot.ts";
import { withState } from "./fakes.ts";


// dori heavy <label> --items FILE: the items of one batch spread over this host and the helpers. Real helpers are the real
// CLI (`dori heavy-worker`) behind an argv that stands in for ssh, as in heavy-spread.test.ts; a helper that dies or
// whose item is killed for memory is a script speaking the worker's lines.
// The fixture of heavy-batch.test.ts and heavy-batch-rules.test.ts: each file runs start before and stop after each test.
const CLI = join(import.meta.dir, "../src/cli.ts");
const HOLDER = 4243;
export let state: ReturnType<typeof withState>;
export let logs: string[];
export let work: string;

export const realHelper = (name: string, slots = 3): HeavyHelper => {
  const dir = join(state.dir, name);
  mkdirSync(dir, { recursive: true });
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ stateDir: join(dir, "state"), heavyHoldDir: join(dir, "hold"), heavySlots: slots, heavyMaxLoad: 1e9, heavyQueue: { exec: true, execMaxMin: 5, jobDir: join(dir, "jobs") } }));
  const own = Object.entries(process.env).map(([k, v]) => `${k}=${v}`);
  return { name, ssh: ["env", "-i", ...own, `DORI_CONFIG=${config}`, `DORI_ENV_FILE=${join(dir, "none.env")}`, process.execPath, CLI, "heavy-worker", "--caller", "tester"] };
};

// a helper that speaks the worker's lines: script reads the upload (cat), then says what it says
export const fakeHelper = (name: string, script: string): HeavyHelper => {
  const f = join(state.dir, `${name}.sh`);
  writeFileSync(f, `#!/bin/sh\n${script}\n`);
  chmodSync(f, 0o755);
  return { name, ssh: [f] };
};

// here: this host's slots; full: slot.1 held by another job, so no item runs here
// skip: each sleep of the batch moves the clock on by all it asked for, so a 15 s wait for a busy host takes 50 ms
export const ctxWith = (helpers: HeavyHelper[], full = true, staleMin?: number, skip = false, slots = 1): HeavyCtx => {
  let ahead = 0;
  const usage = async () => ({ host: { gpu: null, gpuMem: null, cpu: 0, mem: 10 }, unified: false, jobs: [], memTotalKb: 1e8 });
  if (full) {
    mkdirSync(join(state.dir, "heavy", "slot.1"), { recursive: true });
    writeFileSync(join(state.dir, "heavy", "slot.1", "owner"), `${HOLDER} other-job ${new Date().toISOString()}`);
  }
  const deps: SlotDeps = { dir: join(state.dir, "heavy"), slots, maxLoad: 80, clock: { now: () => Date.now() + ahead, sleep: (ms) => {
        if (skip) ahead += ms;
        return Bun.sleep(Math.min(ms, 50));
      } }, pid: process.pid, load: async () => 10, alive: (p) => p === HOLDER || p === process.pid, headroom: { maxSlots: slots, free: 10, settleSec: 0, usage }, log: (l) => logs.push(l) };
  return { q: { jobs: {}, helpers, queue: [], rl: true, jobDir: join(state.dir, "jobs"), exec: false, execMaxMin: 240, ...(staleMin ? { staleMin } : {}) } satisfies HeavyQueue, deps };
};

// the batch's exit code (abandoned is the stale CLI tests' concern, heavy-stale-cli.test.ts)
export const batchCode = async (...a: Parameters<typeof heavyBatch>): Promise<number> => (await heavyBatch(...a)).code;
export const batchOf = (items: string[], cmd: string[], extra: Partial<BatchJob> = {}): BatchJob => ({ label: "b", kind: "cpu", cmd, cwd: work, sync: [work], env: {}, items, out: join(state.dir, "out"), ...extra });
export const receipts = (): BatchReceipt[] => readFileSync(join(state.dir, "out", "receipts.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as BatchReceipt);
export const outOf = (r: BatchReceipt): string => readFileSync(r.out, "utf8");

export const start = (): void => {
  state = withState();
  logs = [];
  work = join(state.dir, "work");
  mkdirSync(work);
};
export const stop = (): void => state.done();
// a second batch in one test, on a state of its own
export const fresh = (): void => {
  stop();
  start();
};
