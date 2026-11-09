import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { homedir } from "node:os";

import type { HeavyCtx } from "../src/heavy-queue.ts";
import { linesOf } from "../src/heavy-queue.ts";
import type { SlotDeps } from "../src/heavy-slot.ts";
import { heavySpread, spreadPlan, type SpreadJob } from "../src/heavy-spread.ts";
import { withState } from "./fakes.ts";

// A helper run whose caller is gone ends there (2026-11-08: gongdori's rvp-make2 ran on cha for two hours after its
// caller had gone; cha's Tailscale SSH closes a lost session's I/O but leaves its processes running, so the worker's
// parent never changed and bwrap's --die-with-parent never fired; the worker's stdin did reach EOF).
const CLI = join(import.meta.dir, "../src/cli.ts");
const HOLDER = 4243;
// this run's mark on the job these tests start and then look for by name, so two suites on one host never read the
// other's job as their own leftover (as the heavy-stale tests did on 4eae, 2026-11-09)
const RUN = process.pid;
const sleeper = `sleep 293.${RUN}`;
const sleeping = '(^| )sleep 293\\.' + RUN + '$';
let state: ReturnType<typeof withState>;
let work: string;
let helper: string;

beforeEach(() => {
  state = withState();
  work = join(state.dir, "work");
  helper = join(state.dir, "helper");
  mkdirSync(work);
  mkdirSync(helper);
  writeFileSync(join(helper, "config.json"), JSON.stringify({ stateDir: join(helper, "state"), heavyHoldDir: join(helper, "hold"), heavyMaxLoad: 1e9, heavyQueue: { exec: true, execMaxMin: 5, jobDir: join(helper, "jobs"), aliveSec: 0.2 } }));
});
afterEach(() => state.done());

// the real worker, started as a caller's ssh starts it, with the job (job.json and the work folder) as tar on its stdin;
// stdin stays open, as a caller that holds it keeps it
const startRun = async (job: Record<string, unknown>) => {
  const own = Object.entries(process.env).map(([k, v]) => `${k}=${v}`);
  const p = Bun.spawn(["env", "-i", ...own, `DORI_CONFIG=${join(helper, "config.json")}`, `DORI_ENV_FILE=${join(helper, "none.env")}`, process.execPath, CLI, "heavy-worker", "--caller", "tester", "exec", "t", "cpu", "100"], { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
  const tmp = join(state.dir, "tar");
  mkdirSync(tmp, { recursive: true });
  writeFileSync(join(tmp, "job.json"), JSON.stringify({ argv: ["sh", "-c", sleeper], cwd: work, sync: [work], env: {}, ...job }));
  const tar = Bun.spawnSync(["tar", "-cf", "-", "-C", tmp, "job.json", "-C", "/", work.slice(1)]);
  p.stdin.write(tar.stdout);
  await p.stdin.flush();
  // the run has started once a heartbeat says so
  const lines = linesOf(p.stderr);
  for (let n = await lines.next(); !n.done; n = await lines.next()) if (n.value === "WORKER_ALIVE run") break;
  return p;
};

const within = <T>(ms: number, x: Promise<T>): Promise<T | "still running"> => Promise.race([x, new Promise<"still running">((r) => setTimeout(() => r("still running"), ms))]);

test("a run whose caller holds its stdin ends when that stdin closes, and leaves nothing behind", async () => {
  // Given: a run of a long job from a caller that holds the connection
  const p = await startRun({ hold: true });
  // When: the connection goes, as cha's Tailscale SSH closes a lost session's I/O
  p.stdin.end();
  // Then
  expect(await within(10_000, p.exited)).not.toBe("still running");
  const heavy = join(helper, "state", "heavy");
  expect(readFileSync(join(heavy, "heavy.log"), "utf8")).toContain("HEAVY_WORKER_ORPHAN t caller=tester");
  expect(readdirSync(join(heavy, "exec"))).toEqual([]);
  expect(readdirSync(heavy).filter((d) => d.startsWith("slot."))).toEqual([]);
  expect(Bun.spawnSync(["pgrep", "-f", sleeping]).exitCode).toBe(1);
}, 30_000);

test("a run from a caller that does not hold its stdin is not ended by its stdin closing", async () => {
  // Given: an older caller, which ends stdin after the upload
  const p = await startRun({});
  // When
  p.stdin.end();
  // Then: still running a while later; it is stopped by hand
  expect(await within(2_000, p.exited)).toBe("still running");
  p.kill("SIGTERM");
  await p.exited;
}, 30_000);

test("a run stopped on its helper (dori heavy-stop) ends its live caller too, instead of going back to the line", async () => {
  // Given: a caller waiting on a long run on the real worker, and this host's only slot held
  mkdirSync(join(state.dir, "heavy", "slot.1"), { recursive: true });
  writeFileSync(join(state.dir, "heavy", "slot.1", "owner"), `${HOLDER} other-job ${new Date().toISOString()}`);
  const own = Object.entries(process.env).map(([k, v]) => `${k}=${v}`);
  const ssh = ["env", "-i", ...own, `DORI_CONFIG=${join(helper, "config.json")}`, `DORI_ENV_FILE=${join(helper, "none.env")}`, process.execPath, CLI, "heavy-worker", "--caller", "tester"];
  const logs: string[] = [];
  let stopped: Promise<unknown> = Promise.resolve();
  const usage = async () => ({ host: { gpu: null, gpuMem: null, cpu: 0, mem: 10 }, unified: false, jobs: [], memTotalKb: 1e8 });
  const deps: SlotDeps = { dir: join(state.dir, "heavy"), slots: 1, maxLoad: 80, clock: { now: () => Date.now(), sleep: () => new Promise((r) => setImmediate(r)) }, pid: process.pid, load: async () => 10, alive: (p) => p === HOLDER || p === process.pid, headroom: { maxSlots: 1, free: 10, settleSec: 0, usage }, log: (l) => {
    logs.push(l);
    // When: the run is stopped there once its job has started
    if (l.startsWith("HEAVY_SYNC t ") || l.startsWith("HEAVY_SPREAD t real")) stopped = new Promise((r) => setTimeout(r, 1_500)).then(() => Bun.spawn([...ssh, "stop", "t"]).exited);
  } };
  const ctx: HeavyCtx = { q: { jobs: {}, helpers: [{ name: "real", ssh }], queue: [], rl: true, jobDir: join(state.dir, "jobs"), exec: false, execMaxMin: 240, staleMin: 5 }, deps };
  const job: SpreadJob = { label: "t", kind: "cpu", cmd: ["sh", "-c", sleeper], cwd: work, sync: [work], env: {} };
  const plan = spreadPlan(job, { uid: process.getuid?.() ?? -1, home: homedir() });
  if (!plan.ok) throw new Error(plan.why);
  const r = await heavySpread(ctx, job, plan);
  await stopped;
  // Then
  expect(r).toEqual({ code: 143 });
  expect(logs.filter((l) => /^HEAVY_(SPREAD|HELPER_CANCELLED|HELPER_CUT|DONE) /.test(l)).map((l) => l.split(":")[0])).toEqual(["HEAVY_SPREAD t real", "HEAVY_HELPER_CANCELLED t real"]);
  expect(Bun.spawnSync(["pgrep", "-f", sleeping]).exitCode).toBe(1);
}, 30_000);

test("sweep deletes the job folders of exec runs whose worker is gone", () => {
  // Given: a left folder of a dead worker and one of this live process
  const exec = join(helper, "state", "heavy", "exec");
  mkdirSync(join(exec, "999999999-dead"), { recursive: true });
  mkdirSync(join(exec, `${process.pid}-live`), { recursive: true });
  const own = Object.entries(process.env).map(([k, v]) => `${k}=${v}`);
  // When
  const p = Bun.spawnSync(["env", "-i", ...own, `DORI_CONFIG=${join(helper, "config.json")}`, `DORI_ENV_FILE=${join(helper, "none.env")}`, process.execPath, CLI, "heavy-worker", "--caller", "tester", "sweep"]);
  // Then
  expect(p.stderr.toString()).toContain("WORKER_SWEPT 1");
  expect(readdirSync(exec)).toEqual([`${process.pid}-live`]);
  expect(existsSync(join(exec, "999999999-dead"))).toBe(false);
});
