import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { HeavyQueue } from "../src/config.ts";
import { heavyJobCommand, runQueued, type HeavyCtx } from "../src/heavy-queue.ts";
import { newJobDir, stageInputs } from "../src/heavy-job.ts";
import { heavyWorker } from "../src/heavy-worker.ts";
import type { SlotDeps } from "../src/heavy-slot.ts";
import { withState } from "./fakes.ts";

// A queue host and a helper, each with its own state; the helper is the real CLI (`dori heavy-worker`) behind an argv
// that stands in for ssh, so jobs cross as tar between two processes the way they do between two hosts.
const CLI = join(import.meta.dir, "../src/cli.ts");
const HOLDER = 4243;
let state: ReturnType<typeof withState>;
let holderAlive: boolean;
let logs: string[];
let input: string;

const upper = (where: string) => ({ argv: ["sh", "-c", `tr a-z A-Z < "$0"; echo ${where} > "$1/where"`, "{in0}", "{out}"] });
const train = { argv: ["sh", "-c", "echo trained"], rl: true };

const helperArgv = (): string[] => {
  const dir = join(state.dir, "helper");
  mkdirSync(dir, { recursive: true });
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ stateDir: join(dir, "state"), heavyMaxLoad: 1e9, heavyQueue: { jobs: { upper: upper("helper"), train }, jobDir: join(dir, "jobs") } }));
  return ["env", `DORI_CONFIG=${config}`, `DORI_ENV_FILE=${join(dir, "none.env")}`, process.execPath, CLI, "heavy-worker"];
};

const ctxWith = (q: Partial<HeavyQueue>, sleep: () => Promise<void> = () => new Promise((r) => setImmediate(r))): HeavyCtx => {
  const deps: SlotDeps = { dir: join(state.dir, "heavy"), slots: 1, maxLoad: 80, clock: { now: () => Date.now(), sleep }, pid: process.pid, load: async () => 10, alive: (p) => (p === HOLDER ? holderAlive : true), log: (l) => logs.push(l) };
  return { q: { jobs: { upper: upper("queue"), train }, helpers: [], queue: [], rl: true, jobDir: join(state.dir, "jobs"), ...q }, deps };
};

const holdSlot = () => {
  mkdirSync(join(state.dir, "heavy", "slot.1"), { recursive: true });
  writeFileSync(join(state.dir, "heavy", "slot.1", "owner"), `${HOLDER} other-job ${new Date().toISOString()}`);
};

const queued = async (ctx: HeavyCtx, kind = "upper", rl = false) => {
  const dir = newJobDir(ctx.q.jobDir);
  stageInputs(dir, [input]);
  const r = await runQueued(ctx, { label: "t", kind, rl, args: [] }, dir);
  return { ...r, where: readFileSync(join(dir, "out", "where"), "utf8").trim() };
};

const stopAfter = (n: number) => {
  let polls = 0;
  return async () => {
    if (++polls >= n) throw new Error("stop");
    await new Promise((r) => setImmediate(r));
  };
};

beforeEach(() => {
  state = withState();
  holderAlive = true;
  logs = [];
  input = join(state.dir, "voice.txt");
  writeFileSync(input, "hello\n");
});
afterEach(() => state.done());

test("a job the queue host cannot start now runs on the helper, comes back the same, and leaves no file there", async () => {
  // Given
  holdSlot();
  const ctx = ctxWith({ helpers: [{ name: "second", ssh: helperArgv() }] });
  // When
  const r = await queued(ctx);
  // Then
  expect(r).toEqual({ code: 0, stdout: "HELLO\n", where: "helper" });
  expect(logs.some((l) => l.startsWith("HEAVY_HELPER t second:"))).toBe(true);
  expect(readdirSync(join(state.dir, "helper", "jobs"))).toEqual([]);
  expect(readFileSync(join(state.dir, "helper", "state", "heavy", "heavy.log"), "utf8")).toContain("HEAVY_WORKER_ADMIT t upper");
});

test("a job the queue host can start runs here and never reaches the helper", async () => {
  const ctx = ctxWith({ helpers: [{ name: "second", ssh: helperArgv() }] });
  expect((await queued(ctx)).where).toBe("queue");
  expect(existsSync(join(state.dir, "helper", "state", "heavy", "heavy.log"))).toBe(false);
});

test("an rl job is never offered to a helper, it waits for the queue host", async () => {
  holdSlot();
  const ctx = ctxWith({ helpers: [{ name: "second", ssh: helperArgv() }] }, stopAfter(3));
  await expect(queued(ctx, "train")).rejects.toThrow("stop");
  expect(logs.filter((l) => l.startsWith("HEAVY_HELPER"))).toEqual([]);
  expect(existsSync(join(state.dir, "helper", "state", "heavy", "heavy.log"))).toBe(false);
});

test("a run that breaks off on the helper goes back to the front of the line and finishes on the queue host", async () => {
  // Given: a helper that admits the job, then drops the connection without a result
  holdSlot();
  const ctx = ctxWith({ helpers: [{ name: "second", ssh: ["sh", "-c", "echo WORKER_ADMIT slot.1 >&2; cat >/dev/null; exit 255"] }] }, async () => {
    if (logs.some((l) => l.startsWith("HEAVY_HELPER_CUT"))) holderAlive = false;
    await new Promise((r) => setImmediate(r));
  });
  // When
  const r = await queued(ctx);
  // Then
  expect(r).toEqual({ code: 0, stdout: "HELLO\n", where: "queue" });
  expect(logs.filter((l) => /^HEAVY_(HELPER_CUT|DONE)/.test(l)).map((l) => l.split(":")[0])).toEqual(["HEAVY_HELPER_CUT t second", "HEAVY_DONE t here"]);
});

test("a helper that cannot be reached is noted once and the job waits for the queue host", async () => {
  holdSlot();
  let pollsWhileDown = 0;
  const ctx = ctxWith({ helpers: [{ name: "second", ssh: ["false"] }] }, async () => {
    if (logs.some((l) => l.startsWith("HEAVY_HELPER_DOWN")) && ++pollsWhileDown >= 3) holderAlive = false;
    await new Promise((r) => setImmediate(r));
  });
  const r = await queued(ctx);
  expect(r.where).toBe("queue");
  expect(logs.filter((l) => l.startsWith("HEAVY_HELPER_DOWN t second"))).toHaveLength(1);
});

test("the worker refuses an rl job, an unknown job and an argument a shell would read, and takes no slot", async () => {
  const ctx = ctxWith({});
  for (const request of ["run t train", "run t upper --rl", "run t nojob", "run t upper $(id)", "exec sh"]) expect(await heavyWorker(ctx, request)).toBe(3);
  expect(existsSync(join(state.dir, "heavy", "slot.1"))).toBe(false);
});

test("a host cut off from the queue host runs the job itself, but holds an rl job when it runs none", async () => {
  const out = join(state.dir, "out");
  const ctx = ctxWith({ queue: ["false"] });
  expect(await heavyJobCommand(ctx, { req: { label: "t", kind: "upper", rl: false, args: [] }, files: [input], out })).toBe(0);
  expect(readFileSync(join(out, "where"), "utf8").trim()).toBe("queue");
  expect(logs.some((l) => l.startsWith("HEAVY_QUEUE_DOWN t:"))).toBe(true);
  const noRl = ctxWith({ queue: ["false"], rl: false }, stopAfter(2));
  await expect(heavyJobCommand(noRl, { req: { label: "r", kind: "train", rl: false, args: [] }, files: [input] })).rejects.toThrow("stop");
  expect(logs.filter((l) => l.startsWith("HEAVY_ADMIT r"))).toEqual([]);
});
