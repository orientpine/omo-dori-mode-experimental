import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { HeavyCtx } from "../src/heavy-queue.ts";
import type { SlotDeps } from "../src/heavy-slot.ts";
import { heavySpread, spreadPlan, type SpreadJob } from "../src/heavy-spread.ts";
import { withState } from "./fakes.ts";

// The 2026-11-08 4eae helper: still on dori before #372, it refuses the options it does not know, as its code did
// (heavyExec: WORKER_REFUSED unknown option "<option>", exit 3), and is busy for anything else.
const OLD_HELPER = 'for a; do case "$a" in need=*|which=*|path=*) echo "WORKER_REFUSED unknown option \\"$a\\"" >&2; exit 3;; esac; done; echo "WORKER_BUSY x" >&2; exit 75';
const HOLDER = 4243;
let state: ReturnType<typeof withState>;
let logs: string[];

beforeEach(() => {
  state = withState();
  logs = [];
});
afterEach(() => state.done());

test("a helper whose dori predates need=/which=/path= is named out of date, with how to update it, before the job runs here", async () => {
  // Given: this host's one slot is taken, and the only helper is the old one
  const work = join(state.dir, "work");
  mkdirSync(work);
  mkdirSync(join(state.dir, "heavy", "slot.1"), { recursive: true });
  writeFileSync(join(state.dir, "heavy", "slot.1", "owner"), `${HOLDER} other-job ${new Date().toISOString()}`);
  let polls = 0;
  const usage = async () => ({ host: { gpu: null, gpuMem: null, cpu: 0, mem: 10 }, unified: false, jobs: [], memTotalKb: 1e8 });
  const deps: SlotDeps = { dir: join(state.dir, "heavy"), slots: 1, maxLoad: 80, clock: { now: () => Date.now(), sleep: async () => { if (++polls > 2) throw new Error("stop"); } }, pid: process.pid, load: async () => 10, alive: (p) => p === HOLDER || p === process.pid, headroom: { maxSlots: 1, free: 10, settleSec: 0, usage }, log: (l) => logs.push(l) };
  const ctx: HeavyCtx = { q: { jobs: {}, helpers: [{ name: "second", ssh: ["sh", "-c", OLD_HELPER, "old-helper"] }], queue: [], rl: true, jobDir: join(state.dir, "jobs"), exec: false, execMaxMin: 240 }, deps };
  const job: SpreadJob = { label: "t", kind: "cpu", cmd: ["sh", "-c", "true"], cwd: work, sync: [work], env: {} };
  const plan = spreadPlan(job, { uid: process.getuid?.() ?? -1, home: homedir() });
  if (!plan.ok) throw new Error(plan.why);
  // When
  await expect(heavySpread(ctx, job, plan)).rejects.toThrow("stop");
  // Then: the caller's log says the helper is out of date and how to fix it, not that a program is missing
  const why = 'its dori is older than this one and does not know "which=sh"; update it there (dori update --pull, or its dori-update-pull timer)';
  expect(logs).toContain(`HEAVY_HELPER_OLD t second: ${why}`);
  expect(logs).toContain(`HEAVY_LOCAL t: no helper can run it (second: ${why}); it waits for this host`);
  expect(logs.some((l) => l.startsWith("HEAVY_HELPER_REFUSED"))).toBe(false);
}, 60_000);
