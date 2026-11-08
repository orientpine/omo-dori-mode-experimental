import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { HeavyHelper, HeavyQueue } from "../src/config.ts";
import type { HeavyCtx } from "../src/heavy-queue.ts";
import { hostMachine, syncedMachine } from "../src/heavy-route.ts";
import type { SlotDeps } from "../src/heavy-slot.ts";
import { heavySpread, spreadPlan, type SpreadJob } from "../src/heavy-spread.ts";
import { withState } from "./fakes.ts";

// The caller and a helper as in heavy-spread.test.ts: the helper is the real CLI (`dori heavy-worker`) behind an argv that
// stands in for ssh, and the command runs in the real bwrap box.
const CLI = join(import.meta.dir, "../src/cli.ts");
const who = { uid: process.getuid?.() ?? -1, home: homedir() };
let state: ReturnType<typeof withState>;
let logs: string[];
let work: string;

const helperArgv = (pathFirst?: string): string[] => {
  const dir = join(state.dir, "helper");
  mkdirSync(dir, { recursive: true });
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ stateDir: join(dir, "state"), heavyMaxLoad: 1e9, heavyQueue: { exec: true, execMaxMin: 5, jobDir: join(dir, "jobs") } }));
  const own = Object.entries(process.env).map(([k, v]) => (k === "PATH" && pathFirst ? `PATH=${pathFirst}:${v}` : `${k}=${v}`));
  return ["env", "-i", ...own, `DORI_CONFIG=${config}`, `DORI_ENV_FILE=${join(dir, "none.env")}`, process.execPath, CLI, "heavy-worker", "--caller", "tester"];
};

// this host is idle (0% busy) and its one heavy slot is free, so before prefer every job ran here
const ctxWith = (helpers: HeavyHelper[]): HeavyCtx => {
  const usage = async () => ({ host: { gpu: 0, gpuMem: null, cpu: 0, mem: 10 }, unified: false, jobs: [], memTotalKb: 1e8 });
  const deps: SlotDeps = { dir: join(state.dir, "heavy"), slots: 1, maxLoad: 80, clock: { now: () => Date.now(), sleep: () => new Promise((r) => setImmediate(r)) }, pid: process.pid, load: async () => 10, alive: (p) => p === process.pid, headroom: { maxSlots: 1, free: 10, settleSec: 0, usage }, log: (l) => logs.push(l) };
  const q: HeavyQueue = { jobs: {}, helpers, queue: [], rl: true, jobDir: join(state.dir, "jobs"), exec: false, execMaxMin: 240 };
  return { q, deps };
};

const spread = async (ctx: HeavyCtx, job: Partial<SpreadJob> & { cmd: string[] }) => {
  const full: SpreadJob = { label: "t", kind: "cpu", cwd: work, sync: [work], env: {}, ...job };
  const plan = spreadPlan(full, who);
  if (!plan.ok) throw new Error(plan.why);
  return heavySpread(ctx, full, plan);
};

// a 20-byte ELF header of another machine than this host's (x86_64 on aarch64, aarch64 elsewhere), executable
const foreignElf = (path: string): string => {
  const machine = hostMachine() === "x86_64" ? 183 : 62;
  const head = Buffer.alloc(20);
  head.writeUInt32BE(0x7f454c46, 0);
  head[4] = 2;
  head[5] = 1;
  head.writeUInt16LE(machine, 18);
  writeFileSync(path, head);
  chmodSync(path, 0o755);
  return machine === 62 ? "x86_64" : "aarch64";
};

beforeEach(() => {
  state = withState();
  logs = [];
  work = join(state.dir, "work");
  mkdirSync(work);
});
afterEach(() => state.done());

test("a gpu job goes to the helper that prefers gpu though this host is idle; a cpu job stays here", async () => {
  // Given: an idle host with a free slot and one helper that takes gpu work first (a training spark)
  const ctx = ctxWith([{ name: "spark", ssh: helperArgv(), prefer: ["gpu"] }]);
  // When
  const gpu = await spread(ctx, { kind: "gpu", cmd: ["sh", "-c", "echo ran > where.txt"] });
  const cpu = await spread(ctx, { kind: "cpu", cmd: ["true"] });
  // Then
  expect(gpu).toEqual({ code: 0 });
  expect(logs).toContain("HEAVY_SPREAD t spark: gpu jobs go to this helper first (heavyQueue.helpers prefer)");
  expect(cpu).toHaveProperty("slot");
  expect(logs.filter((l) => l.startsWith("HEAVY_SPREAD"))).toHaveLength(1);
}, 60_000);

test("the machine of the programs in the --sync paths goes with the job, and a helper of another machine refuses it", async () => {
  // Given: this host's own true in one folder, a program of another machine in another
  const same = join(work, "same");
  const other = join(work, "other");
  mkdirSync(same);
  mkdirSync(other);
  copyFileSync(Bun.which("true") ?? "/bin/true", join(same, "tool"));
  chmodSync(join(same, "tool"), 0o755);
  writeFileSync(join(same, "run.sh"), "#!/bin/sh\n");
  const foreign = foreignElf(join(other, "tool"));
  expect(syncedMachine([same])).toBe(hostMachine());
  expect(syncedMachine([join(work, "none")])).toBeUndefined();
  // a bundle with programs of both machines is "mixed" whichever folder comes first, and stays here
  expect(syncedMachine([same, other])).toBe("mixed");
  expect(syncedMachine([other, same])).toBe("mixed");
  // a library it cannot read is skipped, not thrown out of the plan
  const locked = join(work, "locked");
  mkdirSync(locked);
  writeFileSync(join(locked, "lib.so"), "x");
  chmodSync(join(locked, "lib.so"), 0);
  expect(syncedMachine([locked, same])).toBe(hostMachine());
  const ctx = ctxWith([{ name: "second", ssh: helperArgv(), prefer: ["cpu"] }]);
  // When
  const r = await spread(ctx, { cwd: other, sync: [other], cmd: ["true"] });
  // Then: the helper (this host's machine) refuses it and the job waits for this host's slot instead
  expect(logs).toContain(`HEAVY_HELPER_REFUSED t second: this host is ${hostMachine()} and the job's --sync paths hold ${foreign} programs or libraries, which do not run here`);
  expect(r).toHaveProperty("slot");
}, 60_000);

test("a label or option with shell characters never reaches a helper's shell: the job stays here", async () => {
  // Given: a helper reached like plain ssh, whose shell reads the words it is sent (no forced command, as cha)
  const marker = join(state.dir, "injected");
  const ctx = ctxWith([{ name: "plain", ssh: ["sh", "-c", 'eval "$*"', "sh"], prefer: ["cpu"] }]);
  // When
  const r = await spread(ctx, { label: `t;touch ${marker};#`, cmd: ["true"] });
  // Then
  expect(await Bun.file(marker).exists()).toBe(false);
  expect(logs.find((l) => l.startsWith("HEAVY_HELPER_REFUSED"))).toContain("would reach the helper's shell");
  expect(r).toHaveProperty("slot");
}, 60_000);

test("a helper whose bwrap cannot make its box refuses the job before it takes it, instead of failing it", async () => {
  // Given: a helper whose bwrap fails as it did on the training sparks under AppArmor (2026-11-08), and a job that asks
  // the helper to look for no program (its command is a script in its own --sync path)
  const bin = join(state.dir, "fakebin");
  mkdirSync(bin);
  writeFileSync(join(bin, "bwrap"), "#!/bin/sh\necho 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted' >&2\nexit 1\n");
  chmodSync(join(bin, "bwrap"), 0o755);
  writeFileSync(join(work, "run.sh"), "#!/bin/sh\necho ran\n");
  chmodSync(join(work, "run.sh"), 0o755);
  const ctx = ctxWith([{ name: "spark", ssh: helperArgv(bin), prefer: ["gpu"] }]);
  // When
  const r = await spread(ctx, { kind: "gpu", cmd: [join(work, "run.sh")] });
  // Then
  expect(logs.find((l) => l.startsWith("HEAVY_HELPER_REFUSED t spark"))).toContain("its box does not start on this host: exit 1: bwrap: loopback: Failed RTM_NEWADDR");
  expect(logs.some((l) => l.startsWith("HEAVY_SPREAD"))).toBe(false);
  expect(r).toHaveProperty("slot");
}, 60_000);
