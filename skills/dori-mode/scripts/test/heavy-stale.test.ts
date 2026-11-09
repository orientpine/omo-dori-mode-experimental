import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { HeavyQueue } from "../src/config.ts";
import type { HeavyCtx } from "../src/heavy-queue.ts";
import { heavySpread, spreadPlan, type SpreadJob } from "../src/heavy-spread.ts";
import type { SlotDeps } from "../src/heavy-slot.ts";
import { withState } from "./fakes.ts";

// A helper run that gives no sign of life is ended (or sent again), not waited on forever (2026-11-08: zzangdori's
// rvq-c3-final2 sat 73 minutes on cha with no line on either side).
const CLI = join(import.meta.dir, "../src/cli.ts");
const HOLDER = 4243;
// every config here names its own heavyHoldDir: a hold another account put on this host (heavy hold-local) must not
// turn the real worker away (2026-11-08 22:58Z: a live hold-local QA on 0a83 failed 7 heavy tests with WORKER_BUSY).
// What a stale run leaves behind for the real CLI: heavy-stale-cli.test.ts
// heavyQueue.staleMin in these tests: 1.2 s (3 s where a run must not be cut)
const STALE_MIN = 0.02;
let state: ReturnType<typeof withState>;
let logs: string[];
let work: string;

beforeEach(() => {
  state = withState();
  logs = [];
  work = join(state.dir, "work");
  mkdirSync(work);
  writeFileSync(join(work, "in.txt"), "hello\n");
  mkdirSync(join(state.dir, "heavy", "slot.1"), { recursive: true });
  writeFileSync(join(state.dir, "heavy", "slot.1", "owner"), `${HOLDER} other-job ${new Date().toISOString()}`);
});
afterEach(() => state.done());

const ctxWith = (q: Partial<HeavyQueue>): HeavyCtx => {
  const usage = async () => ({ host: { gpu: null, gpuMem: null, cpu: 0, mem: 10 }, unified: false, jobs: [], memTotalKb: 1e8 });
  const deps: SlotDeps = { dir: join(state.dir, "heavy"), slots: 1, maxLoad: 80, clock: { now: () => Date.now(), sleep: () => new Promise((r) => setImmediate(r)) }, pid: process.pid, load: async () => 10, alive: (p) => p === HOLDER || p === process.pid, headroom: { maxSlots: 1, free: 10, settleSec: 0, usage }, log: (l) => logs.push(l) };
  return { q: { jobs: {}, helpers: [], queue: [], rl: true, jobDir: join(state.dir, "jobs"), exec: false, execMaxMin: 240, staleMin: STALE_MIN, ...q }, deps };
};

// a helper that admits the job and then says nothing more: script is what it does after WORKER_ADMIT; `stop` is answered
// and counted in the stops file
const silentHelper = (name: string, admit: string, script: string): string[] => {
  const stops = join(state.dir, `${name}.stops`);
  return ["sh", "-c", `if [ "$1" = stop ]; then echo "$2 $3" >> ${stops}; echo "WORKER_STOPPED 1" >&2; exit 0; fi; echo "${admit}" >&2; ${script}`, name];
};

const realHelper = (aliveSec: number): string[] => {
  const dir = join(state.dir, "helper");
  mkdirSync(dir, { recursive: true });
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ stateDir: join(dir, "state"), heavyHoldDir: join(dir, "hold"), heavyMaxLoad: 1e9, heavyQueue: { exec: true, execMaxMin: 5, jobDir: join(dir, "jobs"), aliveSec } }));
  const own = Object.entries(process.env).map(([k, v]) => `${k}=${v}`);
  return ["env", "-i", ...own, `DORI_CONFIG=${config}`, `DORI_ENV_FILE=${join(dir, "none.env")}`, process.execPath, CLI, "heavy-worker", "--caller", "tester"];
};

const spread = async (ctx: HeavyCtx, cmd: string[], extra: Partial<SpreadJob> = {}) => {
  const job: SpreadJob = { label: "t", kind: "cpu", cmd, cwd: work, sync: [work], env: {}, ...extra };
  const plan = spreadPlan(job, { uid: process.getuid?.() ?? -1, home: homedir() });
  if (!plan.ok) throw new Error(plan.why);
  return heavySpread(ctx, job, plan);
};

test("a helper that admits the job and then goes silent ends it as stale and is asked to stop it", async () => {
  // Given: a helper that takes the whole upload, announces a heartbeat and never sends a line again
  const ctx = ctxWith({ helpers: [{ name: "mute", ssh: silentHelper("mute", "WORKER_ADMIT slot.1 alive=0.1 run=1-abc", "cat > /dev/null; exec sleep 600") }] });
  // When
  const r = await spread(ctx, ["true"]);
  // Then
  expect(r).toEqual({ code: 124 });
  expect(logs.find((l) => l.startsWith("HEAVY_HELPER_STALE t mute"))).toContain("no word from it");
  expect(logs).toContain("HEAVY_HELPER_STOP t mute: WORKER_STOPPED 1");
  expect(readFileSync(join(state.dir, "mute.stops"), "utf8")).toBe("t 1-abc\n");
}, 30_000);

test("a stale run on a helper that named no run id is not stopped there by its label alone", async () => {
  // Given: an older helper, whose admission line has no run=, so a stop by label could end another run of that label
  const ctx = ctxWith({ helpers: [{ name: "mute", ssh: silentHelper("mute", "WORKER_ADMIT slot.1 alive=0.1", "cat > /dev/null; exec sleep 600") }] });
  // When
  const r = await spread(ctx, ["true"]);
  // Then
  expect(r).toEqual({ code: 124 });
  expect(existsSync(join(state.dir, "mute.stops"))).toBe(false);
  expect(logs.find((l) => l.startsWith("HEAVY_HELPER_STOP t mute"))).toContain("no run id");
}, 30_000);

test("a stop whose ssh ends but leaves a child holding its stderr does not hold the stale run", async () => {
  // Given: a helper that goes silent after admission, and whose stop answers nothing, exits and leaves a child holding
  // its stderr (an ssh wrapper or ProxyCommand that leaves a descendant)
  const ssh = ["sh", "-c", 'if [ "$1" = stop ]; then sleep 593 >&2 & exit 0; fi; echo "WORKER_ADMIT slot.1 alive=0.1 run=1-abc" >&2; cat > /dev/null; exec sleep 600', "deaf"];
  try {
    // When
    const r = await spread(ctxWith({ helpers: [{ name: "deaf", ssh }] }), ["true"]);
    // Then: the run ends stale, and the caller is told to exit without waiting on what the stop left
    expect(r).toEqual({ code: 124, abandoned: true });
    expect(logs.find((l) => l.startsWith("HEAVY_HELPER_STOP t deaf"))).toContain("no answer within");
  } finally {
    Bun.spawnSync(["pkill", "-f", "^sleep 593"]);
  }
}, 30_000);

test("a helper that connects and never answers the admission is down after staleMin, and the job goes on", async () => {
  // Given: a helper whose ssh connects and then says nothing (no WORKER_ADMIT, BUSY or REFUSED), and this host's slot
  // freed once that helper is given up on
  const ctx = ctxWith({ helpers: [{ name: "quiet", ssh: ["sh", "-c", "exec sleep 595", "quiet"] }] });
  const log = ctx.deps.log!;
  const freeing = { ...ctx, deps: { ...ctx.deps, log: (l: string) => { log(l); if (l.startsWith("HEAVY_HELPER_DOWN t quiet")) rmSync(join(state.dir, "heavy", "slot.1"), { recursive: true, force: true }); } } };
  try {
    // When
    const r = await spread(freeing, ["true"]);
    // Then: given up on after staleMin, its ssh ended, and the job takes this host's slot
    expect(r).toHaveProperty("slot");
    expect(logs.find((l) => l.startsWith("HEAVY_HELPER_DOWN t quiet"))).toContain("no answer to the admission within");
    expect(Bun.spawnSync(["pgrep", "-f", "^sleep 595"]).exitCode).toBe(1);
  } finally {
    Bun.spawnSync(["pkill", "-f", "^sleep 595"]);
  }
}, 30_000);

test("a helper that admits the job but takes no bytes of its upload is stale even without a heartbeat", async () => {
  // Given: 8 MB to send, more than the pipes hold, and a helper that never reads it
  writeFileSync(join(work, "big.bin"), Buffer.alloc(8e6, 1));
  const ctx = ctxWith({ helpers: [{ name: "stuck", ssh: silentHelper("stuck", "WORKER_ADMIT slot.1", "exec sleep 600") }] });
  // When
  const r = await spread(ctx, ["true"]);
  // Then
  expect(r).toEqual({ code: 124 });
  expect(logs.find((l) => l.startsWith("HEAVY_HELPER_STALE t stuck"))).toContain("took no bytes");
  expect(logs.some((l) => /^HEAVY_SYNC t \d+\/8 MB to stuck/.test(l))).toBe(true);
}, 30_000);

test("a slow upload that keeps moving is not cut, and its progress is logged", async () => {
  // Given: 4 MB taken 64 KB per 0.1 s (about 6.4 s, over twice staleMin of 3 s), then the run ends with exit 0 and nothing back
  writeFileSync(join(work, "big.bin"), Buffer.alloc(4e6, 1));
  const slow = 'while :; do n=$(dd bs=65536 count=1 2>/dev/null | wc -c); [ "$n" = 0 ] && break; sleep 0.1; done; tar -cf - -T /dev/null; echo "WORKER_EXIT 0" >&2';
  const ctx = ctxWith({ helpers: [{ name: "slow", ssh: silentHelper("slow", "WORKER_ADMIT slot.1", slow) }], staleMin: 0.05 });
  // When
  const r = await spread(ctx, ["true"]);
  // Then
  expect(r).toEqual({ code: 0 });
  expect(logs.some((l) => l.startsWith("HEAVY_HELPER_STALE"))).toBe(false);
  expect(logs.filter((l) => l.startsWith("HEAVY_SYNC t ")).at(-1)).toMatch(/^HEAVY_SYNC t 4\/4 MB to slow/);
}, 30_000);

test("with --stale-again a stale run goes back to the line and the next helper runs it", async () => {
  // Given: a silent helper first, then a real one
  const ctx = ctxWith({ helpers: [{ name: "mute", ssh: silentHelper("mute", "WORKER_ADMIT slot.1 alive=0.1", "cat > /dev/null; exec sleep 600") }, { name: "real", ssh: realHelper(0.2) }] });
  // When
  const r = await spread(ctx, ["sh", "-c", "exit 5"], { staleAgain: true });
  // Then
  expect(r).toEqual({ code: 5 });
  expect(logs.filter((l) => /^HEAVY_(SPREAD|HELPER_STALE|DONE) /.test(l)).map((l) => l.split(":")[0])).toEqual(["HEAVY_SPREAD t mute", "HEAVY_HELPER_STALE t mute", "HEAVY_SPREAD t real", "HEAVY_DONE t real"]);
}, 30_000);

test("a quiet job on a helper that beats is not cut, however long it says nothing", async () => {
  // Given: a job silent for 7 s, over twice staleMin of 3 s, on the real worker beating every 0.2 s
  const ctx = ctxWith({ helpers: [{ name: "real", ssh: realHelper(0.2) }], staleMin: 0.05 });
  // When
  const r = await spread(ctx, ["sh", "-c", "sleep 7; echo late > done.txt"]);
  // Then
  expect(r).toEqual({ code: 0 });
  expect(readFileSync(join(work, "done.txt"), "utf8")).toBe("late\n");
  expect(logs.some((l) => l.startsWith("HEAVY_HELPER_STALE"))).toBe(false);
}, 30_000);

test("a real worker that stops beating is stale; stop kills it, deletes its folder and frees its slot", async () => {
  // Given: the real worker, frozen (SIGSTOP) the moment it admits the job, as a wedged helper would be
  const ctx = ctxWith({ helpers: [{ name: "real", ssh: realHelper(0.2) }] });
  const log = ctx.deps.log!;
  const frozen = { ...ctx, deps: { ...ctx.deps, log: (l: string) => { log(l); if (l.startsWith("HEAVY_SPREAD t real")) Bun.spawnSync(["pkill", "-STOP", "-f", "heavy-worker --caller tester exec t "]); } } };
  // When
  const r = await spread(frozen, ["sh", "-c", "sleep 297"]);
  // Then: ended, and nothing of it is left on the helper
  expect(r).toEqual({ code: 124 });
  const heavy = join(state.dir, "helper", "state", "heavy");
  expect(logs).toContain("HEAVY_HELPER_STOP t real: WORKER_STOPPED 1");
  expect(readdirSync(join(heavy, "exec"))).toEqual([]);
  expect(readdirSync(heavy).filter((d) => d.startsWith("slot."))).toEqual([]);
  expect(Bun.spawnSync(["pgrep", "-f", `sh -c sleep 297`]).exitCode).toBe(1);
}, 30_000);
