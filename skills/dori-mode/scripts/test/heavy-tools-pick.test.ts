import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import type { HeavyCtx } from "../src/heavy-queue.ts";
import type { SlotDeps } from "../src/heavy-slot.ts";
import { heavySpread, spreadPlan, type SpreadJob } from "../src/heavy-spread.ts";
import { withState } from "./fakes.ts";

setDefaultTimeout(30_000); // each test runs the helper's real CLI and box

// A bundle gives a job the heavy runtime (uv, its wheels, chromium, python); the tool's code is always the caller's own
// tree, sent with the job, so a caller whose rv says 0.2.1 but holds other code no longer runs the tag's code there, and
// a bundle is matched by the runtime packages that tree asks for. A program that comes in a bundle (uv in rv) is named
// with that bundle (2026-11-08: zzangdori's --tools uv render was refused on 4eae with "install it there: tools.sh uv <tag>").
const CLI = join(import.meta.dir, "../src/cli.ts");
const HOLDER = 4243;
let state: ReturnType<typeof withState>;
let logs: string[];
let work: string;
let home: string;

const toolsDir = (): string => join(state.dir, "helper", "home", ".local", "share", "dori-heavy", "tools");
const script = (path: string, body: string): void => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
};

// a helper whose tools folder holds the bundle rv at this version, as tools.sh makes it: its bin/rv runs the job's rv
// tree when the job sent one, else its own copy; PACKAGES lists its wheels (none: a bundle made before caller trees)
const helperWith = (version: string, packages?: string, beside: readonly (readonly [string, string])[] = []): string[] => {
  const dir = join(state.dir, "helper");
  for (const [v, pk] of beside) {
    const gen = join(toolsDir(), "rv-gens", `${v}-a`);
    mkdirSync(join(gen, "bin"), { recursive: true });
    writeFileSync(join(gen, "VERSION"), `${v}\n`);
    writeFileSync(join(gen, "PACKAGES"), `${pk}\n`);
    script(join(gen, "bin", "rv"), `mkdir -p out && echo runtime ${v} >> out/ran\nexec "\${DORI_TOOL_TREE_RV}/rv" "$@"`);
    symlinkSync(`rv-gens/${v}-a`, join(toolsDir(), `rv@${v}`));
  }
  const at = join(toolsDir(), "rv-gens", `${version}-a`);
  mkdirSync(join(at, "bin"), { recursive: true });
  mkdirSync(join(at, "rv-video-tool"));
  writeFileSync(join(at, "VERSION"), `${version}\n`);
  if (packages !== undefined) writeFileSync(join(at, "PACKAGES"), `${packages}\n`);
  mkdirSync(join(at, "py"));
  mkdirSync(join(at, "ms-playwright"));
  script(join(at, "bin", "rv"), 'b=$(dirname "$(dirname "$(readlink -f "$0")")")\nexec "${DORI_TOOL_TREE_RV:-$b/rv-video-tool}/rv" "$@"');
  script(join(at, "bin", "uv"), "mkdir -p out && echo uv >> out/ran");
  script(join(at, "rv-video-tool", "rv"), "mkdir -p out && echo bundle rv >> out/ran");
  symlinkSync(`rv-gens/${version}-a`, join(toolsDir(), `rv@${version}`));
  symlinkSync(`rv@${version}`, join(toolsDir(), "rv"));
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ stateDir: join(dir, "state"), heavyHoldDir: join(dir, "hold"), heavyMaxLoad: 1e9, heavyQueue: { exec: true, execMaxMin: 5, jobDir: join(dir, "jobs") } }));
  const own = Object.entries(process.env).map(([k, v]) => `${k}=${v}`);
  return ["env", "-i", ...own, `HOME=${join(dir, "home")}`, `DORI_CONFIG=${config}`, `DORI_ENV_FILE=${join(dir, "none.env")}`, process.execPath, CLI, "heavy-worker", "--caller", "tester"];
};

const ctxWith = (ssh: string[]): HeavyCtx => {
  let polls = 0;
  const usage = async () => ({ host: { gpu: null, gpuMem: null, cpu: 0, mem: 10 }, unified: false, jobs: [], memTotalKb: 1e8 });
  const deps: SlotDeps = { dir: join(state.dir, "heavy"), slots: 1, maxLoad: 80, clock: { now: () => Date.now(), sleep: async () => { if (++polls > 3) throw new Error("stop"); } }, pid: process.pid, load: async () => 10, alive: (p) => p === HOLDER || p === process.pid, headroom: { maxSlots: 1, free: 10, settleSec: 0, usage }, log: (l) => logs.push(l) };
  return { q: { jobs: {}, helpers: [{ name: "second", ssh }], queue: [], rl: true, jobDir: join(state.dir, "jobs"), exec: false, execMaxMin: 240 }, deps };
};

const job = (tools: string[], cmd = ["rv", "make", "."]): SpreadJob => ({ label: "t", kind: "cpu", cmd, cwd: work, sync: [work], env: {}, tools });
const planOf = (j: SpreadJob) => {
  const p = spreadPlan(j, { uid: process.getuid?.() ?? -1, home, path: "/usr/bin:/bin" });
  if (!p.ok) throw new Error(p.why);
  return p;
};

beforeEach(() => {
  state = withState();
  logs = [];
  work = join(state.dir, "work");
  mkdirSync(work);
  mkdirSync(join(state.dir, "heavy", "slot.1"), { recursive: true });
  writeFileSync(join(state.dir, "heavy", "slot.1", "owner"), `${HOLDER} other-job ${new Date().toISOString()}`);
  callerTree();
});

// the caller's rv: VERSION 0.2.1 like the tag, other code, as rv's install.sh leaves it (nothing on PATH)
const callerTree = (): void => {
  home = join(state.dir, "home");
  const tree = join(home, ".local", "share", "rv", "own-video-tool");
  mkdirSync(join(tree, "lib"), { recursive: true });
  writeFileSync(join(tree, "VERSION"), "0.2.1\n");
  script(join(tree, "rv"), "mkdir -p out && echo caller rv >> out/ran");
  writeFileSync(join(tree, "lib", "still.sh"), "uv run -q --no-project --with playwright --with pillow python still.py\n");
};
afterEach(() => state.done());

test("a caller whose rv has the tag's VERSION but other code runs its own code on the helper, on the bundle's runtime", async () => {
  const j = job(["rv"]);
  expect(await heavySpread(ctxWith(helperWith("0.2.1", "edge-tts numpy pillow playwright")), j, planOf(j))).toEqual({ code: 0 });
  expect(readFileSync(join(work, "out", "ran"), "utf8")).toBe("caller rv\n");
});

test("a bundle without a runtime package the caller's rv asks for, or made before caller trees, says how to install one", async () => {
  for (const [packages, why] of [
    ["edge-tts numpy", 'tool bundle "rv" here (0.2.1) lacks pillow playwright, which the job\'s rv asks for; install one with them there: setups/heavy-helper/tools.sh rv <tag or commit>'],
    [undefined, 'tool bundle "rv" here (0.2.1) was made before jobs sent their own rv; install it again there: setups/heavy-helper/tools.sh rv v0.2.1'],
  ] as const) {
    logs = [];
    state.done();
    state = withState();
    mkdirSync(join(state.dir, "heavy", "slot.1"), { recursive: true });
    writeFileSync(join(state.dir, "heavy", "slot.1", "owner"), `${HOLDER} other-job ${new Date().toISOString()}`);
    work = join(state.dir, "work");
    mkdirSync(work);
    callerTree();
    const j = job(["rv"]);
    const plan = planOf(j);
    await expect(heavySpread(ctxWith(helperWith("0.2.1", packages)), j, plan)).rejects.toThrow("stop");
    expect(logs).toContain(`HEAVY_HELPER_NOTOOLS t second: ${why}`);
  }
});

test("a caller's tree that the current bundle cannot serve takes another installed one that can, such as a commit's", async () => {
  // Given: the tag's 0.2.1 current without torch, and a bundle built from a commit beside it with torch
  writeFileSync(join(home, ".local", "share", "rv", "own-video-tool", "lib", "ml.sh"), "uv run --with torch python ml.py\n");
  const j = job(["rv"]);
  // When
  expect(await heavySpread(ctxWith(helperWith("0.2.1", "edge-tts numpy pillow playwright", [["0.2.1+gabc1234", "edge-tts numpy pillow playwright torch"]])), j, planOf(j))).toEqual({ code: 0 });
  // Then
  expect(readFileSync(join(work, "out", "ran"), "utf8")).toBe("runtime 0.2.1+gabc1234\ncaller rv\n");
});

test("a quoted or listed uv --with still asks for its package", async () => {
  // Given: the caller's tree asks for torch as uv lets one write it, which the bundle here lacks
  writeFileSync(join(home, ".local", "share", "rv", "own-video-tool", "lib", "ml.sh"), "uv run --with 'torch' --with=scipy,sympy python ml.py\n");
  const j = job(["rv"]);
  // When
  await expect(heavySpread(ctxWith(helperWith("0.2.1", "edge-tts numpy pillow playwright")), j, planOf(j))).rejects.toThrow("stop");
  // Then
  expect(logs).toContain('HEAVY_HELPER_NOTOOLS t second: tool bundle "rv" here (0.2.1) lacks scipy sympy torch, which the job\'s rv asks for; install one with them there: setups/heavy-helper/tools.sh rv <tag or commit>');
});

test("a caller's tree that pins a package version keeps the job here, since a bundle's wheels are not matched by version", () => {
  writeFileSync(join(home, ".local", "share", "rv", "own-video-tool", "lib", "pin.sh"), "uv run --with 'numpy>=1,<2' --with playwright==1.50.0 python x.py\n");
  expect(spreadPlan(job(["rv"]), { uid: process.getuid?.() ?? -1, home, path: "/usr/bin:/bin" })).toEqual({ ok: false, why: `your rv tree (${join(home, ".local", "share", "rv", "own-video-tool")}) asks for numpy>=1,<2, playwright==1.50.0 by version, which no bundle is matched by; it runs here` });
  // a space before the comparator, inside quotes, is a version too
  writeFileSync(join(home, ".local", "share", "rv", "own-video-tool", "lib", "pin.sh"), "uv run --with \"playwright ==1.50.0\" python x.py\n");
  expect(spreadPlan(job(["rv"]), { uid: process.getuid?.() ?? -1, home, path: "/usr/bin:/bin" })).toEqual({ ok: false, why: `your rv tree (${join(home, ".local", "share", "rv", "own-video-tool")}) asks for playwright ==1.50.0 by version, which no bundle is matched by; it runs here` });
});

test("tools.sh reads a tree's packages as uv takes them, without the versions", () => {
  const tree = join(state.dir, "pk");
  mkdirSync(tree);
  writeFileSync(join(tree, "a.sh"), "uv run -q --with playwright --with pillow python a.py\nuv run --with 'numpy>=1,<2' --with=scipy,sympy x\n");
  const p = Bun.spawnSync(["bash", join(import.meta.dir, "../../setups/heavy-helper/tools.sh"), "packages", tree], { stdout: "pipe", stderr: "pipe" });
  expect([p.exitCode, p.stdout.toString()]).toEqual([0, "numpy pillow playwright scipy sympy\n"]);
});

test("a caller's tree with a link out of what travels keeps the job here, as a --sync folder would", () => {
  const outside = join(home, "shared-lib");
  mkdirSync(outside);
  symlinkSync(outside, join(home, ".local", "share", "rv", "own-video-tool", "vendor"));
  const p = spreadPlan(job(["rv"]), { uid: process.getuid?.() ?? -1, home, path: "/usr/bin:/bin" });
  expect(p).toEqual({ ok: false, why: `the link ${join(home, ".local", "share", "rv", "own-video-tool", "vendor")} points to ${outside}, which is not in a --sync path (add it with --sync)` });
});

test("however a job starts the caller's tree, by path, relative or first on its own --env PATH, it gets the bundle's runtime", async () => {
  // Given: the caller's rv writes the runtime it sees
  const tree = join(home, ".local", "share", "rv", "own-video-tool");
  script(join(tree, "rv"), 'mkdir -p out && echo "$PYTHONPATH|$PLAYWRIGHT_BROWSERS_PATH|${PATH%%:*}" > out/env');
  const want = "/run/dori-tools/bundles/rv/py|/run/dori-tools/bundles/rv/ms-playwright|/run/dori-tools/bundles/rv/bin\n";
  for (const j of [job(["rv"], [join(tree, "rv")]), job(["rv"], [relative(work, join(tree, "rv"))]), { ...job(["rv"], ["rv"]), env: { PATH: `${tree}:/usr/bin:/bin` } }]) {
    rmSync(join(state.dir, "helper"), { recursive: true, force: true });
    rmSync(join(work, "out"), { recursive: true, force: true });
    // When
    expect(await heavySpread(ctxWith(helperWith("0.2.1", "edge-tts numpy pillow playwright")), j, planOf(j))).toEqual({ code: 0 });
    // Then
    expect(readFileSync(join(work, "out", "env"), "utf8")).toBe(want);
  }
});

test("a program that comes in a bundle is named with that bundle, not as a bundle to install", async () => {
  const j = job(["uv"], ["uv", "run", "x"]);
  await expect(heavySpread(ctxWith(helperWith("0.2.1", "pillow playwright")), j, planOf(j))).rejects.toThrow("stop");
  expect(logs).toContain('HEAVY_HELPER_NOTOOLS t second: no tool bundle "uv" on this host; uv comes in the bundle "rv" here: use --tools rv');
});

test("a name that no bundle here is or has lists the bundles here and what tools.sh makes", async () => {
  const j = job(["nosuch"], ["true"]);
  await expect(heavySpread(ctxWith(helperWith("0.2.1", "pillow playwright")), j, planOf(j))).rejects.toThrow("stop");
  expect(logs).toContain('HEAVY_HELPER_NOTOOLS t second: no tool bundle "nosuch" on this host (bundles here: rv); setups/heavy-helper/tools.sh makes the bundle rv: tools.sh rv <tag or commit>');
});
