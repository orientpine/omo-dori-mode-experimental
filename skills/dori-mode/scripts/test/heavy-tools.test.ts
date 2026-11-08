import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { HeavyCtx } from "../src/heavy-queue.ts";
import type { SlotDeps } from "../src/heavy-slot.ts";
import { heavySpread, spreadPlan, type SpreadJob } from "../src/heavy-spread.ts";
import { withState } from "./fakes.ts";

// A job that needs a helper's tool bundle (dori heavy --tools rv): the caller's rv is a program in its home, which no
// helper box has, so without a bundle the job stays here; with one, the helper's real CLI runs it in its real box, and a
// helper whose bundle is missing or another version says so (2026-11-08: rv renders sent to 4eae found no rv there).
const CLI = join(import.meta.dir, "../src/cli.ts");
const HOLDER = 4243;
let state: ReturnType<typeof withState>;
let logs: string[];
let work: string;
let callerPath: string;

// a helper account whose tools folder holds the bundle "rv" at this version (none: no bundle)
const helperWith = (version?: string): string[] => {
  const dir = join(state.dir, "helper");
  const tools = join(dir, "home", ".local", "share", "dori-heavy", "tools");
  mkdirSync(join(tools, "bin"), { recursive: true });
  if (version) {
    mkdirSync(join(tools, "rv", "bin"), { recursive: true });
    writeFileSync(join(tools, "rv", "VERSION"), `${version}\n`);
    writeFileSync(join(tools, "rv", "bin", "rv"), '#!/bin/sh\necho "bundle rv $*"; mkdir -p out && echo frame > out/v.mp4\n');
    chmodSync(join(tools, "rv", "bin", "rv"), 0o755);
    symlinkSync("../rv/bin/rv", join(tools, "bin", "rv"));
  }
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

const rvJob = (extra: Partial<SpreadJob> = {}): SpreadJob => ({ label: "t", kind: "cpu", cmd: ["rv", "make", work], cwd: work, sync: [work], env: {}, tools: ["rv"], ...extra });
const planOf = (job: SpreadJob) => spreadPlan(job, { uid: process.getuid?.() ?? -1, home: homedir(), path: callerPath });

beforeEach(() => {
  state = withState();
  logs = [];
  work = join(state.dir, "work");
  mkdirSync(work);
  // the caller's own rv, installed as rv's install.sh does: a folder with VERSION, linked from a bin folder on PATH
  const install = join(state.dir, "caller", "rv-video-tool");
  mkdirSync(install, { recursive: true });
  writeFileSync(join(install, "rv"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(install, "rv"), 0o755);
  writeFileSync(join(install, "VERSION"), "0.2.1\n");
  mkdirSync(join(state.dir, "caller", "bin"));
  symlinkSync(join(install, "rv"), join(state.dir, "caller", "bin", "rv"));
  callerPath = `${join(state.dir, "caller", "bin")}:/usr/bin:/bin`;
  mkdirSync(join(state.dir, "heavy", "slot.1"), { recursive: true });
  writeFileSync(join(state.dir, "heavy", "slot.1", "owner"), `${HOLDER} other-job ${new Date().toISOString()}`);
});
afterEach(() => state.done());

test("a job naming a tool bundle sends the caller's version of it, and a program only the bundle has may be its command", () => {
  expect(planOf(rvJob({ tools: [] }))).toEqual({ ok: false, why: `the command rv is ${join(state.dir, "caller", "bin", "rv")}, which is in no --sync path and no system folder, so a helper has none` });
  const plan = planOf(rvJob());
  expect(plan.ok && [plan.which, plan.tools]).toEqual([["rv"], ["rv@0.2.1"]]);
  const shell = planOf(rvJob({ cmd: ["sh", "-c", "rv make ."] }));
  expect(shell.ok && [shell.which, shell.tools]).toEqual([["sh"], ["rv@0.2.1"]]);
  expect(planOf(rvJob({ tools: ["Rv/x"] }))).toEqual({ ok: false, why: '--tools "Rv/x" is not a tool bundle name (lower-case letters, digits, . _ -)' });
});

test("a helper with the bundle at the caller's version runs the job with the bundle's program, and its files come back", async () => {
  const job = rvJob();
  const plan = planOf(job);
  if (!plan.ok) throw new Error(plan.why);
  const r = await heavySpread(ctxWith(helperWith("0.2.1")), job, plan);
  expect(r).toEqual({ code: 0 });
  expect(readFileSync(join(work, "out", "v.mp4"), "utf8")).toBe("frame\n");
  expect(logs).toContain("HEAVY_DONE t second: exit 0");
}, 60_000);

test("a helper without the bundle, or with another version of it, is named as lacking it, and the job stays here", async () => {
  const job = rvJob();
  const plan = planOf(job);
  if (!plan.ok) throw new Error(plan.why);
  for (const [have, why] of [
    [undefined, 'no tool bundle "rv" on this host; install it there: setups/heavy-helper/tools.sh rv <tag>'],
    ["0.2.0", 'tool bundle "rv" here is version 0.2.0, the job\'s is 0.2.1; install that one there: setups/heavy-helper/tools.sh rv v0.2.1'],
  ] as const) {
    logs = [];
    state.done();
    state = withState();
    mkdirSync(join(state.dir, "heavy", "slot.1"), { recursive: true });
    writeFileSync(join(state.dir, "heavy", "slot.1", "owner"), `${HOLDER} other-job ${new Date().toISOString()}`);
    await expect(heavySpread(ctxWith(helperWith(have)), job, plan)).rejects.toThrow("stop");
    expect(logs).toContain(`HEAVY_HELPER_NOTOOLS t second: ${why}`);
    expect(logs).toContain(`HEAVY_LOCAL t: no helper can run it (second: ${why}); it waits for this host`);
    expect(logs.some((l) => l.startsWith("HEAVY_SPREAD"))).toBe(false);
  }
}, 60_000);

test("a helper whose dori predates tool bundles is named out of date, not as lacking the bundle", async () => {
  const old = 'for a; do case "$a" in tools=*) echo "WORKER_REFUSED unknown option \\"$a\\"" >&2; exit 3;; esac; done; echo "WORKER_BUSY x" >&2; exit 75';
  const job = rvJob();
  const plan = planOf(job);
  if (!plan.ok) throw new Error(plan.why);
  await expect(heavySpread(ctxWith(["sh", "-c", old, "old-helper"]), job, plan)).rejects.toThrow("stop");
  expect(logs).toContain('HEAVY_HELPER_OLD t second: its dori is older than this one and does not know "tools=rv@0.2.1"; update it there (dori update --pull, or its dori-update-pull timer)');
}, 60_000);
