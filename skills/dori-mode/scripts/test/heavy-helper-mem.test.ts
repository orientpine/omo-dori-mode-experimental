import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { HeavyCtx } from "../src/heavy-queue.ts";
import { memRefusal } from "../src/heavy-route.ts";
import { admitOnce, type SlotDeps } from "../src/heavy-slot.ts";
import { heavySpread, spreadPlan, type SpreadJob } from "../src/heavy-spread.ts";
import { withState } from "./fakes.ts";

// review 2 of #413: a --helpers-only job's --mem is not checked on the caller (the job never runs there), so the helper
// that is asked must check it: one it can never fit refuses it and the caller asks the next, and admission keeps the
// memory it says it needs free beside the running jobs.
const CLI = join(import.meta.dir, "../src/cli.ts");
const PB = 999_999_999_999_999;
let state: ReturnType<typeof withState>;
let logs: string[];

beforeEach(() => {
  state = withState();
  logs = [];
});
afterEach(() => state.done());

const helperArgv = (name: string): string[] => {
  const dir = join(state.dir, name);
  mkdirSync(dir, { recursive: true });
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ stateDir: join(dir, "state"), heavyHoldDir: join(dir, "hold"), heavyMaxLoad: 1e9, heavyQueue: { exec: true, execMaxMin: 5, jobDir: join(dir, "jobs") } }));
  const own = Object.entries(process.env).map(([k, v]) => `${k}=${v}`);
  return ["env", "-i", ...own, `DORI_CONFIG=${config}`, `DORI_ENV_FILE=${join(dir, "none.env")}`, process.execPath, CLI, "heavy-worker", "--caller", "tester"];
};

test("a job's mem= that can never fit this host is a refusal, one that fits or none is not", () => {
  const m = { totalKb: 16 * 1024 ** 2, availKb: 12 * 1024 ** 2 };
  expect(memRefusal([`mem=${32 * 1024 ** 3}`], 10, m)).toContain("never fits here");
  expect(memRefusal([`mem=${8 * 1024 ** 3}`], 10, m)).toBeUndefined();
  expect(memRefusal(["playwright=1.2.3"], 10, m)).toBeUndefined();
});

test("a helper refuses an exec whose mem= it can never fit, before it admits anything", () => {
  const p = Bun.spawnSync([...helperArgv("small"), "exec", "big", "cpu", "100", `mem=${PB}`], { stdin: "ignore", stderr: "pipe" });
  const err = p.stderr.toString();
  expect([p.exitCode, err.includes("WORKER_REFUSED"), err.includes("never fits here"), err.includes("WORKER_ADMIT")]).toEqual([3, true, true, false]);
});

test("a --helpers-only job too big for the first helper goes on to the next, and ends with exit 2 when none fits", async () => {
  const refuse = ["sh", "-c", "printf 'WORKER_REFUSED exec is off on this host (heavyQueue.exec)\\n' >&2; exit 3", "helper"];
  const deps: SlotDeps = { dir: join(state.dir, "heavy"), slots: 1, maxLoad: 80, clock: { now: () => Date.now(), sleep: async () => { throw new Error("waited"); } }, pid: process.pid, load: async () => 0, alive: () => true, log: (l) => void logs.push(l) };
  const ctx: HeavyCtx = { q: { jobs: {}, helpers: [{ name: "small", ssh: helperArgv("small") }, { name: "second", ssh: refuse }], queue: [], rl: true, jobDir: join(state.dir, "jobs"), exec: false, execMaxMin: 240 }, deps };
  const work = join(state.dir, "work");
  mkdirSync(work, { recursive: true });
  const job: SpreadJob = { label: "big", kind: "cpu", cmd: ["true"], cwd: work, sync: [work], env: {}, helpersOnly: true, needBytes: PB };
  const plan = spreadPlan(job, { uid: process.getuid?.() ?? -1, home: homedir() });
  if (!plan.ok) throw new Error(plan.why);
  expect(await heavySpread(ctx, job, plan)).toEqual({ code: 2 });
  const last = logs.find((l) => l.startsWith("HEAVY_HELPERS_ONLY big: no helper can run it")) ?? "";
  expect([last.includes("small: --mem"), last.includes("never fits here"), last.includes("second: exec is off")]).toEqual([true, true, true]);
});

test("a helper's admission keeps the memory the job says it needs: with too little free now it waits", async () => {
  const deps: SlotDeps = {
    dir: join(state.dir, "heavy"), slots: 1, maxLoad: 80, clock: { now: () => Date.now(), sleep: async () => {} }, pid: process.pid, load: async () => 0, alive: () => true,
    headroom: { maxSlots: 2, free: 10, settleSec: 0, gpuFreeKb: 0, usage: async () => ({ host: { gpu: 0, gpuMem: 0, cpu: 0, mem: 80 }, unified: false, jobs: [], memTotalKb: 16 * 1024 ** 2 }) },
  };
  expect(await admitOnce(deps, "big", 0, 8 * 1024 ** 2)).toMatchObject({ wait: "memory" });
  expect(await admitOnce(deps, "small", 0, 1024 ** 2)).toHaveProperty("slot");
});
