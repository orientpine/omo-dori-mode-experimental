import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { backPick } from "../src/heavy-back.ts";
import type { HeavyCtx } from "../src/heavy-queue.ts";
import type { SlotDeps } from "../src/heavy-slot.ts";
import { heavySpread, spreadPlan, type SpreadJob } from "../src/heavy-spread.ts";
import { withState } from "./fakes.ts";

// What a helper run sends back: what the job chose (dori heavy --back), and over the cap the folders holding the most
// bytes stay there, biggest first, so the rest still comes back (2026-11-08: a 1-minute rv make on 4eae made 5.1 GB,
// 1839 frames in build/frames, and nothing came back, not its mp4, srt or CHECKS.md, so the FAIL could not be read).
const CLI = join(import.meta.dir, "../src/cli.ts");
const HOLDER = 4243;
let state: ReturnType<typeof withState>;
let logs: string[];
let work: string;

const helper = (): string[] => {
  const dir = join(state.dir, "helper");
  mkdirSync(join(dir, "home"), { recursive: true });
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ stateDir: join(dir, "state"), heavyMaxLoad: 1e9, heavyQueue: { exec: true, execMaxMin: 5, jobDir: join(dir, "jobs") } }));
  const own = Object.entries(process.env).map(([k, v]) => `${k}=${v}`);
  return ["env", "-i", ...own, `HOME=${join(dir, "home")}`, `DORI_CONFIG=${config}`, `DORI_ENV_FILE=${join(dir, "none.env")}`, process.execPath, CLI, "heavy-worker", "--caller", "tester"];
};

const ctxWith = (ssh: string[]): HeavyCtx => {
  let polls = 0;
  const usage = async () => ({ host: { gpu: null, gpuMem: null, cpu: 0, mem: 10 }, unified: false, jobs: [], memTotalKb: 1e8 });
  const deps: SlotDeps = { dir: join(state.dir, "heavy"), slots: 1, maxLoad: 80, clock: { now: () => Date.now(), sleep: async () => { if (++polls > 3) throw new Error("stop"); } }, pid: process.pid, load: async () => 10, alive: (p) => p === HOLDER || p === process.pid, headroom: { maxSlots: 1, free: 10, settleSec: 0, usage }, log: (l) => logs.push(l) };
  return { q: { jobs: {}, helpers: [{ name: "second", ssh }], queue: [], rl: true, jobDir: join(state.dir, "jobs"), exec: false, execMaxMin: 240 }, deps };
};

beforeEach(() => {
  state = withState();
  logs = [];
  work = join(state.dir, "work");
  mkdirSync(work);
  mkdirSync(join(state.dir, "heavy", "slot.1"), { recursive: true });
  writeFileSync(join(state.dir, "heavy", "slot.1", "owner"), `${HOLDER} other-job ${new Date().toISOString()}`);
});
afterEach(() => state.done());

const made = (cwd: string) => [
  ...[1, 2, 3].map((i) => ({ path: `${cwd}/build/frames/${i}.png`, bytes: 40 })),
  { path: `${cwd}/out/v.mp4`, bytes: 30 },
  { path: `${cwd}/out/CHECKS.md`, bytes: 2 },
  { path: `${cwd}/run.log`, bytes: 5 },
];

test("over the cap the folders holding the most bytes stay on the helper, biggest first, and the rest comes back", () => {
  const p = backPick(made("/home/a/p"), { cwd: "/home/a/p", max: 100 });
  expect(p.keep).toEqual(["/home/a/p/out/v.mp4", "/home/a/p/out/CHECKS.md", "/home/a/p/run.log"]);
  expect(p.left).toEqual([{ dir: "/home/a/p/build/frames", files: 3, bytes: 120 }]);
  // under the cap everything comes back
  expect(backPick(made("/home/a/p"), { cwd: "/home/a/p", max: 157 })).toEqual({ keep: made("/home/a/p").map((f) => f.path), left: [], bytes: 157 });
});

test("a job's --back globs pick what comes back, relative to its working folder or absolute", () => {
  const p = backPick(made("/home/a/p"), { cwd: "/home/a/p", max: 100, globs: ["out/**", "*.log"] });
  expect(p).toEqual({ keep: ["/home/a/p/out/v.mp4", "/home/a/p/out/CHECKS.md", "/home/a/p/run.log"], left: [], bytes: 37 });
  expect(backPick(made("/home/a/p"), { cwd: "/home/a/p/out", max: 100, globs: ["/home/a/p/build/frames/1.png"] }).keep).toEqual(["/home/a/p/build/frames/1.png"]);
});

test("a helper run sends back only what the job's --back picks", async () => {
  // Given: a job that makes a big intermediate folder beside its result and log
  const job: SpreadJob = { label: "t", kind: "cpu", cmd: ["sh", "-c", "mkdir -p build/frames out && head -c 4096 /dev/zero > build/frames/1.png && echo mp4 > out/v.mp4 && echo log > run.log"], cwd: work, sync: [work], env: {}, back: ["out/**", "*.log"] };
  const plan = spreadPlan(job, { uid: process.getuid?.() ?? -1, home: homedir() });
  if (!plan.ok) throw new Error(plan.why);
  // When
  expect(await heavySpread(ctxWith(helper()), job, plan)).toEqual({ code: 0 });
  // Then
  expect([readFileSync(join(work, "out", "v.mp4"), "utf8"), readFileSync(join(work, "run.log"), "utf8")]).toEqual(["mp4\n", "log\n"]);
  expect(existsSync(join(work, "build", "frames", "1.png"))).toBe(false);
  expect(logs.filter((l) => /^HEAVY_BACK t second: sent \d+ bytes, 2 file\(s\) 8 bytes back$/.test(l))).toHaveLength(1);
}, 60_000);

test("--back takes globs a helper can read, and a bad one keeps the job here", () => {
  const job = (back: string[]): SpreadJob => ({ label: "t", kind: "cpu", cmd: ["true"], cwd: work, sync: [work], env: {}, back });
  const who = { uid: process.getuid?.() ?? -1, home: homedir() };
  expect(spreadPlan(job(["out/**"]), who).ok).toBe(true);
  expect(spreadPlan(job([""]), who)).toEqual({ ok: false, why: '--back "" is not a glob a helper can read (1 to 256 characters, no newline)' });
});
