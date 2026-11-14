import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { HeavyQueue } from "../src/config.ts";
import { assetHash, checkAssets } from "../src/heavy-assets.ts";
import type { HeavyCtx } from "../src/heavy-queue.ts";
import type { SlotDeps } from "../src/heavy-slot.ts";
import { heavySpread, spreadPlan, type SpreadJob } from "../src/heavy-spread.ts";
import { withState } from "./fakes.ts";

// The --sync trees a job sends with their hashes (heavy-assets.ts): the caller and a helper, each with its own state; the
// helper is the real CLI (`dori heavy-worker`) behind an argv that stands in for ssh, as in heavy-spread.test.ts, and this
// host's one slot is held, so every job goes to it. Every job sends its trees and the helper checks them (no store kept
// between jobs: review 4 of #477, lead 2026-11-14 "작업마다 그 작업 폴더로 새로 올리고 해시(ASSET_OK) 확인").
const CLI = join(import.meta.dir, "../src/cli.ts");
const HOLDER = 4243;
const who = { uid: process.getuid?.() ?? -1, home: homedir() };
let state: ReturnType<typeof withState>;
let logs: string[];
let work: string;

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

// one job on the helper: its exit code and what it printed
const runOnce = async (ctx: HeavyCtx): Promise<{ code: unknown; out: string }> => {
  let out = "";
  const job: SpreadJob = { label: "t", kind: "cpu", cmd: ["sh", "-c", "cat data.txt; wc -c < big.bin"], cwd: work, sync: [work], env: {}, out: { write: (s: string) => (out += s) } };
  const plan = spreadPlan(job, who);
  if (!plan.ok) throw new Error(plan.why);
  const r = await heavySpread(ctx, job, plan);
  return { code: "code" in r ? r.code : r, out };
};
const sentBytes = (): number => Number(/HEAVY_BACK t helper: sent (\d+) bytes/.exec(logs.findLast((l) => l.startsWith("HEAVY_BACK")) ?? "")?.[1]);

beforeEach(() => {
  state = withState();
  logs = [];
  work = join(state.dir, "work");
  mkdirSync(work);
  writeFileSync(join(work, "data.txt"), "first\n");
  writeFileSync(join(work, "big.bin"), Buffer.alloc(2 * 1024 * 1024, 7));
});
afterEach(() => state.done());

test("every job sends its trees and the helper checks each by hash, keeping nothing for the next job", async () => {
  const ctx = ctxWith(helperArgv());
  const h = (await assetHash(work))!;
  expect(await runOnce(ctx)).toEqual({ code: 0, out: "first\n2097152\n" });
  expect(sentBytes()).toBeGreaterThan(2 * 1024 * 1024);
  expect(helperLog()).toContain(`ASSET_OK ${h} ${work}\n`);
  logs = [];
  expect(await runOnce(ctx)).toEqual({ code: 0, out: "first\n2097152\n" });
  expect(sentBytes()).toBeGreaterThan(2 * 1024 * 1024);
  expect(helperLog().match(new RegExp(`ASSET_OK ${h} `, "g"))?.length).toBe(2);
  expect(existsSync(join(state.dir, "helper", "state", "heavy", "assets"))).toBe(false);
  logs = [];
  writeFileSync(join(work, "data.txt"), "second!\n");
  const h2 = (await assetHash(work))!;
  expect(h2).not.toBe(h);
  expect(await runOnce(ctx)).toEqual({ code: 0, out: "second!\n2097152\n" });
  expect(helperLog()).toContain(`ASSET_OK ${h2} ${work}\n`);
});

test("a tree whose group bits the helper's umask would drop still arrives as sent (tar -p, review 3 of #477)", async () => {
  const was = process.umask(0o022);
  try {
    chmodSync(work, 0o775);
    chmodSync(join(work, "data.txt"), 0o664);
    const ctx = ctxWith(helperArgv());
    const h = (await assetHash(work))!;
    expect(await runOnce(ctx)).toEqual({ code: 0, out: "first\n2097152\n" });
    expect(helperLog()).toContain(`ASSET_OK ${h} ${work}\n`);
    expect(helperLog()).not.toContain("ASSET_BAD");
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
  const ctx = ctxWith([f, ...helperArgv()]);
  expect(await runOnce(ctx)).toEqual({ code: 0, out: "first\n2097152\n" });
  expect(logs.some((l) => l.startsWith("HEAVY_HELPER_OLD"))).toBe(false);
  expect(logs.some((l) => l.startsWith("HEAVY_DONE t helper: exit 0"))).toBe(true);
});

test("a tree that arrives other than its hash says is named and used as it came", async () => {
  const root = join(state.dir, "root");
  mkdirSync(join(root, work), { recursive: true });
  writeFileSync(join(root, work, "data.txt"), "arrived\n");
  const said: string[] = [];
  await checkAssets(root, [work], [`assets=${"0".repeat(32)}`], (l) => said.push(l));
  expect(said).toEqual([`ASSET_BAD ${work}: sent as ${"0".repeat(32)}, ${await assetHash(join(root, work))} arrived; the job runs on what arrived`]);
  expect(readFileSync(join(root, work, "data.txt"), "utf8")).toBe("arrived\n");
});
