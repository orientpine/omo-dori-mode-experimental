import { afterEach, beforeEach, expect, test } from "bun:test";
import { Glob } from "bun";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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

const toolsDir = (): string => join(state.dir, "helper", "home", ".local", "share", "dori-heavy", "tools");

// a bundle as tools.sh leaves it: an install is a generation folder never moved or changed, rv@<version> links to the
// newest generation of that version, rv to the current version; a generation other than "a" says its name in its output
const bundle = (version: string, gen = "a", link = true): void => {
  const at = join(toolsDir(), "rv-gens", `${version}-${gen}`);
  mkdirSync(join(at, "bin"), { recursive: true });
  writeFileSync(join(at, "VERSION"), `${version}\n`);
  writeFileSync(join(at, "bin", "rv"), `#!/bin/sh\necho "bundle rv $*"; mkdir -p out && echo frame > out/v.mp4 && echo ${gen === "a" ? version : `${version}/${gen}`} >> out/versions\n`);
  chmodSync(join(at, "bin", "rv"), 0o755);
  if (link) symlinkSync(`rv-gens/${version}-${gen}`, join(toolsDir(), `rv@${version}`));
};
const makeCurrent = (version: string): void => {
  rmSync(join(toolsDir(), "rv"), { force: true });
  symlinkSync(`rv@${version}`, join(toolsDir(), "rv"));
};

// a helper account whose tools folder holds the bundle "rv" at these versions, the first current (none: no bundle)
const helperWith = (...versions: string[]): string[] => {
  const dir = join(state.dir, "helper");
  mkdirSync(join(toolsDir(), "bin"), { recursive: true });
  for (const v of versions) bundle(v);
  if (versions[0]) {
    makeCurrent(versions[0]);
    symlinkSync("../rv/bin/rv", join(toolsDir(), "bin", "rv"));
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

test("a job naming a bundle that stays here runs the caller's own install of it, which rv's install.sh does not put on PATH", async () => {
  // Given: rv as install.sh leaves it, a folder with VERSION under ~/.local/share and nothing on PATH, beside the copy it
  // keeps (<folder>.bak-<time>) and an old-* folder; and no helpers (2026-11-08: gongdori renders left here ended 127)
  const home = join(state.dir, "home");
  const install = (dir: string, v: string): void => {
    mkdirSync(join(home, ".local", "share", dir), { recursive: true });
    writeFileSync(join(home, ".local", "share", dir, "rv"), `#!/bin/sh\necho "caller rv ${v} $*"\n`);
    chmodSync(join(home, ".local", "share", dir, "rv"), 0o755);
    writeFileSync(join(home, ".local", "share", dir, "VERSION"), `${v}\n`);
  };
  install("rv/zz-video-tool", "0.2.1");
  install("rv/zz-video-tool.bak-20261108T081648Z", "0.2.0");
  install("rv/old-20261104", "0.1.0");
  const config = join(state.dir, "config.json");
  writeFileSync(config, JSON.stringify({ stateDir: join(state.dir, "state"), heavyMaxLoad: 1e9 }));
  const own = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("DORI_")));
  const env = { ...own, HOME: home, PATH: "/usr/bin:/bin", DORI_CONFIG: config, DORI_ENV_FILE: join(state.dir, "none.env"), DORI_STATE_DIR: join(state.dir, "state") };
  // When
  const p = Bun.spawn([process.execPath, CLI, "heavy", "t", "--kind", "cpu", "--tools", "rv", "--sync", work, "--", "rv", "make", work], { cwd: work, env, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  // Then: that install ran, and a helper would be asked for its version
  expect([code, out]).toEqual([0, `caller rv 0.2.1 make ${work}\n`]);
  expect(err).toContain(`HEAVY_TOOLS_HERE t: rv is ${join(home, ".local", "share", "rv", "zz-video-tool", "rv")} (0.2.1), first on the job's PATH here`);
  const plan = spreadPlan(rvJob(), { uid: process.getuid?.() ?? -1, home, path: "/usr/bin:/bin" });
  expect(plan.ok && plan.tools).toEqual(["rv@0.2.1"]);
  // and two installs of it are not guessed between
  install("rv-video-tool", "0.2.2");
  const two = spreadPlan(rvJob(), { uid: process.getuid?.() ?? -1, home, path: "/usr/bin:/bin" });
  expect(two.ok && two.tools).toEqual(["rv"]);
}, 60_000);

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
    ["", 'no tool bundle "rv" on this host; install it there: setups/heavy-helper/tools.sh rv <tag>'],
    ["0.2.0", 'tool bundle "rv" here is version 0.2.0, the job\'s is 0.2.1; install that one there: setups/heavy-helper/tools.sh rv v0.2.1'],
  ] as const) {
    logs = [];
    state.done();
    state = withState();
    mkdirSync(join(state.dir, "heavy", "slot.1"), { recursive: true });
    writeFileSync(join(state.dir, "heavy", "slot.1", "owner"), `${HOLDER} other-job ${new Date().toISOString()}`);
    await expect(heavySpread(ctxWith(have ? helperWith(have) : helperWith()), job, plan)).rejects.toThrow("stop");
    expect(logs).toContain(`HEAVY_HELPER_NOTOOLS t second: ${why}`);
    expect(logs).toContain(`HEAVY_LOCAL t: no helper can run it (second: ${why}); it waits for this host`);
    expect(logs.some((l) => l.startsWith("HEAVY_SPREAD"))).toBe(false);
  }
}, 60_000);

test("a helper that keeps the caller's version beside a newer current one runs the job on the caller's version", async () => {
  const job = rvJob();
  const plan = planOf(job);
  if (!plan.ok) throw new Error(plan.why);
  expect(await heavySpread(ctxWith(helperWith("0.2.2", "0.2.1")), job, plan)).toEqual({ code: 0 });
  expect(readFileSync(join(work, "out", "versions"), "utf8")).toBe("0.2.1\n");
}, 60_000);

test("a bundle installed again while a job runs does not change the version that job runs", async () => {
  // Given: a job that runs rv, then waits for a go file in its own folder on the helper before running rv again
  const job = rvJob({ cmd: ["sh", "-c", "rv && touch first-done && while [ ! -e go ]; do sleep 0.05; done && rv"] });
  const plan = planOf(job);
  if (!plan.ok) throw new Error(plan.why);
  const ssh = helperWith("0.2.1");
  bundle("0.2.2");
  // When: after its first rv, 0.2.2 becomes the helper's current rv
  const run = heavySpread(ctxWith(ssh), job, plan);
  const glob = new Glob(`exec/*/in${work}/first-done`);
  const jobs = join(state.dir, "helper", "state", "heavy");
  let first: string | undefined;
  for (const until = Date.now() + 30_000; !first && Date.now() < until; await new Promise((r) => setTimeout(r, 20))) first = existsSync(jobs) ? [...glob.scanSync({ cwd: jobs, onlyFiles: true })][0] : undefined;
  if (!first) throw new Error("the job did not run its first rv");
  makeCurrent("0.2.2");
  writeFileSync(join(jobs, dirname(first), "go"), "");
  // Then: both runs used the version the job was admitted with
  expect(await run).toEqual({ code: 0 });
  expect(readFileSync(join(work, "out", "versions"), "utf8")).toBe("0.2.1\n0.2.1\n");
}, 60_000);

test("the same version installed again between the helper's admission and its box start does not change what the job runs", async () => {
  // Given: generation b of 0.2.1 is ready, and the job's bytes reach the helper only after it admitted the job and
  // rv@0.2.1 was turned to generation b, as tools.sh rv v0.2.1 run again does
  const job = rvJob();
  const plan = planOf(job);
  if (!plan.ok) throw new Error(plan.why);
  const helper = helperWith("0.2.1");
  bundle("0.2.1", "b", false);
  const log = join(state.dir, "helper", "state", "heavy", "heavy.log");
  const t = toolsDir();
  const gate = `(until grep -q HEAVY_WORKER_ADMIT ${log} 2>/dev/null; do sleep 0.02; done; ln -sfn rv-gens/0.2.1-b ${t}/rv@0.2.1.new && mv -Tf ${t}/rv@0.2.1.new ${t}/rv@0.2.1; cat) | "$@"`;
  // When
  const r = await heavySpread(ctxWith(["bash", "-c", gate, "gate", ...helper]), job, plan);
  // Then: the job ran the generation the helper picked when it admitted it
  expect(r).toEqual({ code: 0 });
  expect(readFileSync(join(work, "out", "versions"), "utf8")).toBe("0.2.1\n");
}, 60_000);

test("a helper whose dori predates tool bundles is named out of date, not as lacking the bundle", async () => {
  const old = 'for a; do case "$a" in tools=*) echo "WORKER_REFUSED unknown option \\"$a\\"" >&2; exit 3;; esac; done; echo "WORKER_BUSY x" >&2; exit 75';
  const job = rvJob();
  const plan = planOf(job);
  if (!plan.ok) throw new Error(plan.why);
  await expect(heavySpread(ctxWith(["sh", "-c", old, "old-helper"]), job, plan)).rejects.toThrow("stop");
  expect(logs).toContain('HEAVY_HELPER_OLD t second: its dori is older than this one and does not know "tools=rv@0.2.1"; update it there (dori update --pull, or its dori-update-pull timer)');
}, 60_000);
