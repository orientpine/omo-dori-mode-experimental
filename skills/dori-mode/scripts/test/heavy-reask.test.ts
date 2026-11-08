import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { HeavyCtx } from "../src/heavy-queue.ts";
import type { SlotDeps } from "../src/heavy-slot.ts";
import { heavySpread, spreadPlan, type SpreadJob } from "../src/heavy-spread.ts";
import { withState } from "./fakes.ts";

// A helper that lacked a job's bundle, or whose dori was old, is asked again after a while: a bundle can be installed
// and a dori pulled while the job waits (2026-11-08: gongdori's still jobs, refused by cha, kimm-cha and both sparks
// before their rv bundles were installed, kept waiting for 4eae alone).
const HOLDER = 4243;
let state: ReturnType<typeof withState>;
let now: number;

beforeEach(() => {
  state = withState();
  now = Date.now();
  mkdirSync(join(state.dir, "heavy", "slot.1"), { recursive: true });
  writeFileSync(join(state.dir, "heavy", "slot.1", "owner"), `${HOLDER} other-job ${new Date().toISOString()}`);
});
afterEach(() => state.done());

const run = async (why: string): Promise<number> => {
  // Given: a helper that counts each time it is asked and refuses the job with this line
  const calls = join(state.dir, "calls");
  writeFileSync(join(state.dir, "why"), why);
  const helper = ["sh", "-c", `echo x >> ${calls}; printf 'WORKER_REFUSED %s\\n' "$(cat ${join(state.dir, "why")})" >&2; exit 3`, "helper"];
  let polls = 0;
  const usage = async () => ({ host: { gpu: null, gpuMem: null, cpu: 0, mem: 10 }, unified: false, jobs: [], memTotalKb: 1e8 });
  // each wait for this host's slot takes 15 minutes on the job's clock
  const deps: SlotDeps = { dir: join(state.dir, "heavy"), slots: 1, maxLoad: 80, clock: { now: () => now, sleep: async () => { now += 15 * 60_000; if (++polls > 3) throw new Error("stop"); } }, pid: process.pid, load: async () => 10, alive: (p) => p === HOLDER || p === process.pid, headroom: { maxSlots: 1, free: 10, settleSec: 0, usage } };
  const ctx: HeavyCtx = { q: { jobs: {}, helpers: [{ name: "second", ssh: helper }], queue: [], rl: true, jobDir: join(state.dir, "jobs"), exec: false, execMaxMin: 240 }, deps };
  const work = join(state.dir, "work");
  mkdirSync(work, { recursive: true });
  const job: SpreadJob = { label: "t", kind: "cpu", cmd: ["true"], cwd: work, sync: [work], env: {} };
  const plan = spreadPlan(job, { uid: process.getuid?.() ?? -1, home: homedir() });
  if (!plan.ok) throw new Error(plan.why);
  // When: the job waits through four of those
  await expect(heavySpread(ctx, job, plan)).rejects.toThrow("stop");
  return readFileSync(calls, "utf8").split("\n").filter(Boolean).length;
};

test("a helper that lacked the job's bundle is asked again while the job waits", async () => {
  expect(await run('no tool bundle "rv" on this host; install it there: setups/heavy-helper/tools.sh rv <tag>')).toBeGreaterThan(1);
});

test("a helper that refused for good (exec off) is still not asked again", async () => {
  expect(await run("exec is off on this host (heavyQueue.exec)")).toBe(1);
});
