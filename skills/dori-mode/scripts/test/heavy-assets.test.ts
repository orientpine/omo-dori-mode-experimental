import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { HeavyQueue } from "../src/config.ts";
import { assetsWord, stageAssets, stager, unpackChecked } from "../src/heavy-assets.ts";
import type { HeavyCtx } from "../src/heavy-queue.ts";
import type { SlotDeps } from "../src/heavy-slot.ts";
import { heavySpread, spreadPlan, startExec, type SpreadJob } from "../src/heavy-spread.ts";
import { withState } from "./fakes.ts";

// A job's --sync paths go as one archive made once on the caller and checked by its sha256 on the helper (heavy-assets.ts,
// lead 2026-11-14 #477 H334): the caller and a helper, each with its own state; the helper is the real CLI
// (`dori heavy-worker`) behind an argv that stands in for ssh, as in heavy-spread.test.ts, and this host's one slot is
// held, so every job goes to it.
const CLI = join(import.meta.dir, "../src/cli.ts");
const HOLDER = 4243;
const who = { uid: process.getuid?.() ?? -1, home: homedir() };
let state: ReturnType<typeof withState>;
let logs: string[];
let work: string;
let stage: string;

const helperArgv = (): string[] => {
  const dir = join(state.dir, "helper");
  mkdirSync(dir, { recursive: true });
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ stateDir: join(dir, "state"), heavyHoldDir: join(dir, "hold"), heavyMaxLoad: 1e9, heavyQueue: { exec: true, execMaxMin: 5, jobDir: join(dir, "jobs") } }));
  const own = Object.entries(process.env).map(([k, v]) => `${k}=${v}`);
  return ["env", "-i", ...own, `DORI_CONFIG=${config}`, `DORI_ENV_FILE=${join(dir, "none.env")}`, process.execPath, CLI, "heavy-worker", "--caller", "tester"];
};
const helperLog = (): string => readFileSync(join(state.dir, "helper", "state", "heavy", "heavy.log"), "utf8");

const ctxWith = (ssh: string[]): HeavyCtx => {
  mkdirSync(join(state.dir, "heavy", "slot.1"), { recursive: true });
  writeFileSync(join(state.dir, "heavy", "slot.1", "owner"), `${HOLDER} other-job ${new Date().toISOString()}`);
  const usage = async () => ({ host: { gpu: null, gpuMem: null, cpu: 0, mem: 10 }, unified: false, jobs: [], memTotalKb: 1e8 });
  const deps: SlotDeps = { dir: join(state.dir, "heavy"), slots: 1, maxLoad: 80, clock: { now: () => Date.now(), sleep: () => new Promise((r) => setImmediate(r)) }, pid: process.pid, load: async () => 10, alive: (p) => p === HOLDER || p === process.pid, headroom: { maxSlots: 1, free: 10, settleSec: 0, usage }, log: (l) => logs.push(l) };
  return { q: { jobs: {}, helpers: [{ name: "helper", ssh }], queue: [], rl: true, jobDir: join(state.dir, "jobs"), exec: false, execMaxMin: 240 } satisfies HeavyQueue, deps };
};

const jobWith = (cmd: string[], assets: SpreadJob["assets"], out?: (s: string) => void): SpreadJob => ({ label: "t", kind: "cpu", cmd, cwd: work, sync: [work], env: {}, ...(assets ? { assets } : {}), ...(out ? { out: { write: out } } : {}) });

// one job on the helper as dori heavy runs it (its own archive, removed after): its exit code and what it printed
const runOnce = async (ctx: HeavyCtx, cmd = ["sh", "-c", "cat data.txt; wc -c < big.bin"]): Promise<{ code: unknown; out: string }> => {
  let out = "";
  const st = stager(stage, "t", (l) => logs.push(l));
  const job = jobWith(cmd, st, (s) => (out += s));
  const plan = spreadPlan(job, who);
  if (!plan.ok) throw new Error(plan.why);
  try {
    const r = await heavySpread(ctx, job, plan);
    return { code: "code" in r ? r.code : r, out };
  } finally {
    st.drop();
  }
};
// the sha256 and size the caller archived, from its HEAVY_ASSET line
const staged = (): [string, string] => {
  const m = /^HEAVY_ASSET t: --sync archived once, sha256 ([0-9a-f]{64}), (\d+) bytes/.exec(logs.findLast((l) => l.startsWith("HEAVY_ASSET t:")) ?? "");
  if (!m) throw new Error(`no HEAVY_ASSET line in ${logs.join("\n")}`);
  return [m[1]!, m[2]!];
};

beforeEach(() => {
  state = withState();
  logs = [];
  work = join(state.dir, "work");
  stage = join(state.dir, "stage");
  mkdirSync(work);
  writeFileSync(join(work, "data.txt"), "first\n");
  writeFileSync(join(work, "big.bin"), Buffer.alloc(2 * 1024 * 1024, 7));
});
afterEach(() => state.done());

test("the helper checks the archive's bytes against the sha256 they left with (ASSET_OK), and nothing is kept after the job", async () => {
  const ctx = ctxWith(helperArgv());
  expect(await runOnce(ctx)).toEqual({ code: 0, out: "first\n2097152\n" });
  const [sha, bytes] = staged();
  expect(Number(bytes)).toBeGreaterThan(2 * 1024 * 1024);
  expect(helperLog()).toContain(`ASSET_OK ${sha} ${bytes}\n`);
  expect(readdirSync(stage)).toEqual([]);
  expect(readdirSync(join(state.dir, "helper", "state", "heavy", "exec"))).toEqual([]);
  logs = [];
  writeFileSync(join(work, "data.txt"), "second!\n");
  expect(await runOnce(ctx)).toEqual({ code: 0, out: "second!\n2097152\n" });
  const [sha2] = staged();
  expect(sha2).not.toBe(sha);
  expect(helperLog()).toContain(`ASSET_OK ${sha2} `);
});

test("a tree whose group bits the helper's umask would drop still arrives with its modes (tar -p, review 3 of #477)", async () => {
  const was = process.umask(0o022);
  try {
    chmodSync(work, 0o775);
    chmodSync(join(work, "data.txt"), 0o664);
    expect(await runOnce(ctxWith(helperArgv()), ["stat", "-c", "%a", ".", "data.txt"])).toEqual({ code: 0, out: "775\n664\n" });
    expect(helperLog()).toContain(`ASSET_OK ${staged()[0]} `);
  } finally {
    process.umask(was);
  }
});

test("a job whose tree holds a read-only folder leaves no folder behind on the helper, and the next job runs (review 4 of #477)", async () => {
  mkdirSync(join(work, "ro"));
  writeFileSync(join(work, "ro", "x.txt"), "x\n");
  chmodSync(join(work, "ro"), 0o555);
  try {
    const ctx = ctxWith(helperArgv());
    expect(await runOnce(ctx)).toEqual({ code: 0, out: "first\n2097152\n" });
    expect(await runOnce(ctx)).toEqual({ code: 0, out: "first\n2097152\n" });
    expect(readdirSync(join(state.dir, "helper", "state", "heavy", "exec"))).toEqual([]);
  } finally {
    chmodSync(join(work, "ro"), 0o755);
  }
});

test("a helper whose dori does not know assets= is asked once more without it, and the job runs there", async () => {
  const f = join(state.dir, "old-helper.sh");
  writeFileSync(f, `#!/bin/sh\ncase "$*" in *assets=*) echo 'WORKER_REFUSED unknown option "assets=x"' >&2; exit 3;; esac\nexec "$@"\n`);
  chmodSync(f, 0o755);
  // the wrapper sees the exec words after the real helper argv, as the helper's forced command would
  expect(await runOnce(ctxWith([f, ...helperArgv()]))).toEqual({ code: 0, out: "first\n2097152\n" });
  expect(logs.some((l) => l.startsWith("HEAVY_HELPER_OLD"))).toBe(false);
  expect(logs.some((l) => l.startsWith("HEAVY_DONE t helper: exit 0"))).toBe(true);
  expect(helperLog()).not.toContain("ASSET_");
});

test("a byte changed on the way is ASSET_BAD: the job does not run and its folder on the helper goes", async () => {
  // an ssh stand-in that flips one bit 1 MiB into the upload (inside big.bin's bytes, so tar -x still takes it)
  const flip = join(state.dir, "flip.ts");
  writeFileSync(flip, `const p = Bun.spawn(process.argv.slice(2), { stdin: "pipe", stdout: "inherit", stderr: "inherit" });
let seen = 0;
for await (const c of Bun.stdin.stream()) {
  const b = new Uint8Array(c);
  const at = 1024 * 1024 - seen;
  if (at >= 0 && at < b.length) b[at] ^= 1;
  seen += b.length;
  p.stdin.write(b);
  await p.stdin.flush();
}
await p.stdin.end();
process.exit(await p.exited);
`);
  const ctx = ctxWith([process.execPath, flip, ...helperArgv()]);
  const st = stager(stage, "t", (l) => logs.push(l));
  const job = jobWith(["sh", "-c", "touch ran.txt"], st);
  const plan = spreadPlan(job, who);
  if (!plan.ok) throw new Error(plan.why);
  const t = await startExec(ctx, ctx.q.helpers[0]!, job, plan, 100);
  if (t.kind !== "started") throw new Error(t.why);
  expect(await t.run.done).toBeNull();
  st.drop();
  const [sha, bytes] = staged();
  expect(helperLog()).toMatch(new RegExp(`ASSET_BAD sent as ${sha} \\(${bytes} bytes\\), (?!${sha})[0-9a-f]{64} arrived \\(${bytes} bytes\\); the job does not run`));
  expect(helperLog()).not.toContain("ASSET_OK");
  expect(existsSync(join(work, "ran.txt"))).toBe(false);
  expect(readdirSync(join(state.dir, "helper", "state", "heavy", "exec"))).toEqual([]);
});

test("an archive that cannot be made (tar exit 2) offers the job to no helper", async () => {
  const contacted = join(state.dir, "contacted");
  const ctx = ctxWith(["sh", "-c", `touch ${contacted}; cat > /dev/null`]);
  const st = stager(stage, "t", (l) => logs.push(l), { argv: ["sh", "-c", `tar -cf - -C / ${work.slice(1)}; exit 2`] });
  const job = jobWith(["true"], st);
  const plan = spreadPlan(job, who);
  if (!plan.ok) throw new Error(plan.why);
  const t = await startExec(ctx, ctx.q.helpers[0]!, job, plan, 100);
  expect(t).toEqual({ kind: "refused", why: expect.stringContaining("archiving the --sync paths failed (exit 2") });
  expect(existsSync(contacted)).toBe(false);
  expect(logs.filter((l) => l.startsWith("HEAVY_ASSET_UNSENT t: archiving the --sync paths failed (exit 2"))).toHaveLength(1);
  st.drop();
  expect(readdirSync(stage)).toEqual([]);
});

test("an archive whose bytes stop coming is given up and leaves nothing", async () => {
  const t0 = Date.now();
  expect(await stageAssets([work], stage, { argv: ["sleep", "30"], stallMs: 50 })).toEqual({ why: "the --sync paths gave no bytes for 0.05 s while they were archived (a hung mount?)" });
  expect(Date.now() - t0).toBeLessThan(10_000);
  expect(readdirSync(stage)).toEqual([]);
});

test("an archive whose tar is gone while a child of it holds its output is given up, not waited on", async () => {
  const mark = `31.${process.pid}`;
  try {
    expect(await stageAssets([work], stage, { argv: ["sh", "-c", `sleep ${mark} & exit 0`], stallMs: 50 })).toEqual({ why: "the --sync paths gave no bytes for 0.05 s while they were archived (a hung mount?)" });
    expect(readdirSync(stage)).toEqual([]);
  } finally {
    Bun.spawnSync(["pkill", "-f", `^sleep ${mark}$`]);
  }
});

test("an archive cut short on the way is ASSET_BAD", async () => {
  const r = await stageAssets([work], stage);
  if (!r || "why" in r) throw new Error(`not staged: ${JSON.stringify(r)}`);
  const bytes = readFileSync(r.assets.path);
  const root = join(state.dir, "root");
  mkdirSync(root);
  const said: string[] = [];
  expect(await unpackChecked(root, [assetsWord(r.assets)], (l) => said.push(l), new Blob([bytes.subarray(0, bytes.length - 20_000)]).stream())).toBe(false);
  expect(said).toHaveLength(1);
  expect(said[0]).toStartWith(`ASSET_BAD `);
  expect(said[0]).toEndWith("; the job does not run");
});
