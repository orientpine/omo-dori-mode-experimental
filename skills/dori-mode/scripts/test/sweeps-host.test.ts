import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseGpuQuery, parsePmon, treeOf, type Usage } from "../src/heavy-headroom.ts";
import { acquire, acquireSlot, pidAlive, releaseSlot, type SlotDeps } from "../src/heavy-slot.ts";
import { guardTick } from "../src/host-guard.ts";
import type { Clock } from "../src/run.ts";
import { fakeClock, withState } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;

let state: ReturnType<typeof withState>;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

test("the host guard alerts on low disk, clears when it recovers, and flips compute readiness on load", () => {
  const t = { loadAlert: 150, loadOk: 80, memFreeMinPct: 20, diskFreeMinGb: 50, panesMax: 20 };
  const st = { alerting: false } as { alerting: boolean; computeReady?: boolean };
  const healthy = { load1: 40, memFreePct: 50, diskFreeGb: 200, swapFreeGb: 4, panes: 5 };
  expect(guardTick(healthy, t, st)).toEqual(["HOST_GUARD COMPUTE_READY load 40 < 80"]);
  expect(guardTick({ ...healthy, diskFreeGb: 12 }, t, st)).toEqual(["HOST_GUARD ALERT disk free 12 GB < 50 GB"]);
  expect(guardTick({ ...healthy, diskFreeGb: 12 }, t, st)).toEqual([]);
  const recovered = guardTick({ ...healthy, load1: 120 }, t, st);
  expect(recovered[0]).toStartWith("HOST_GUARD CLEAR");
  expect(recovered.slice(1)).toEqual(["HOST_GUARD COMPUTE_BUSY load 120"]);
});

test("a heavy slot waits for load to drop, and a slot held by a dead process is taken over", async () => {
  const dir = join(state.dir, "heavy");
  const clock = fakeClock(T0);
  let loads = [120, 95, 40];
  const base = { dir, slots: 1, maxLoad: 80, clock, pid: 4242, load: async () => loads.shift() ?? 40 };
  const slot = await acquireSlot({ ...base, alive: () => true }, "build");
  expect(loads).toEqual([]);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(slot, "owner"), "999999 other 2026-01-01T00:00:00Z");
  loads = [10];
  let polls = 0;
  const stolen = await acquireSlot({ ...base, alive: (pid) => pid !== 999999, clock: { ...clock, sleep: async () => { polls++; } } }, "test");
  expect(stolen).toBe(slot);
  expect(polls).toBe(0);
  releaseSlot(stolen);
});

test("a slot whose owner is alive is not taken", async () => {
  const dir = join(state.dir, "heavy");
  mkdirSync(join(dir, "slot.1"), { recursive: true });
  writeFileSync(join(dir, "slot.1", "owner"), "1 busy now");
  utimesSync(join(dir, "slot.1"), new Date(), new Date());
  let polls = 0;
  const clock = { now: () => Date.now(), sleep: async () => { polls++; if (polls > 2) throw new Error("stop"); } };
  await expect(acquireSlot({ dir, slots: 1, maxLoad: 80, clock, pid: 7, load: async () => 10, alive: () => true }, "x", 1)).rejects.toThrow("stop");
});

const heldSlot = (dir: string, n: number, pid: number, since: number) => {
  mkdirSync(join(dir, `slot.${n}`), { recursive: true });
  writeFileSync(join(dir, `slot.${n}`, "owner"), `${pid} running eval ${new Date(since).toISOString()}`);
};
const eval25: Usage = { gpu: 25, gpuMem: null, cpu: 10, mem: 10 };
const headroomDeps = (dir: string, host: () => Usage, logs: string[], clock: Clock = fakeClock(T0)): SlotDeps & { calls: number } => {
  const d = {
    dir, slots: 1, maxLoad: 80, clock, pid: 4242, load: async () => 10, alive: (pid: number) => pid !== 999999, calls: 0,
    headroom: { maxSlots: 4, free: 30, settleSec: 120, usage: async (pids: readonly number[]) => { d.calls++; return { host: host(), unified: true, jobs: pids.map(() => eval25), memTotalKb: 100_000_000 }; } },
    log: (l: string) => logs.push(l),
  };
  return d;
};
const stopAfter = (n: number) => { let polls = 0; return { now: () => T0, sleep: async () => { if (++polls >= n) throw new Error("stop"); } }; };

test("a heavy job starts beside a running one when every resource keeps 30% free with it, and waits when one would not", async () => {
  const dir = join(state.dir, "heavy");
  heldSlot(dir, 1, 100, T0 - 10 * MIN);
  const logs: string[] = [];
  const slot = await acquireSlot(headroomDeps(dir, () => ({ gpu: 45, gpuMem: null, cpu: 20, mem: 25 }), logs), "eval-b");
  expect(slot).toBe(join(dir, "slot.2"));
  expect(logs).toEqual(["HEAVY_ADMIT eval-b slot.2: 1 running beside it; gpu 45%+25% -> 30% free, cpu 20%+10% -> 70% free, mem(unified) 25%+10% -> 65% free (needs 30% free each)"]);
  heldSlot(dir, 2, 101, T0 - 10 * MIN);
  const waits: string[] = [];
  const busy = headroomDeps(dir, () => ({ gpu: 46, gpuMem: null, cpu: 20, mem: 25 }), waits, stopAfter(3));
  await expect(acquireSlot(busy, "eval-c", 1)).rejects.toThrow("stop");
  expect(waits).toEqual(["HEAVY_WAIT eval-c: 2 running; gpu 46%+25% -> 29% free, cpu 20%+10% -> 70% free, mem(unified) 25%+10% -> 65% free (needs 30% free each)"]);
  expect(busy.calls).toBe(3);
});

test("with --mem even the first heavy job waits until its memory keeps headroom free, counting what a running job said it needs and does not use yet", async () => {
  const dir = join(state.dir, "heavy");
  // Given: nothing runs, half of 100,000,000 KB is in use
  const waits: string[] = [];
  await expect(acquire(headroomDeps(dir, () => ({ gpu: 0, gpuMem: null, cpu: 0, mem: 50 }), waits, stopAfter(2)), "big", { pollMs: 1, memKb: 30_000_000 })).rejects.toThrow("stop");
  expect(waits).toEqual(["HEAVY_WAIT big: memory: needs 28.6G, 47.7G available, 0M held for running jobs still loading -> 20% free (needs 30% free)"]);
  const logs: string[] = [];
  const got = await acquire(headroomDeps(dir, () => ({ gpu: 0, gpuMem: null, cpu: 0, mem: 50 }), logs), "fits", { pollMs: 1, memKb: 15_000_000 });
  expect(got).toEqual({ slot: join(dir, "slot.1") });
  expect(readFileSync(join(dir, "slot.1", "mem"), "utf8")).toBe("15000000");
  rmSync(join(dir, "slot.1"), { recursive: true });
  // Given: a job said 40,000,000 KB and uses 10% (10,000,000 KB) so far, the host is 25% used: 30,000,000 KB more is coming
  heldSlot(dir, 1, 100, T0 - 10 * MIN);
  writeFileSync(join(dir, "slot.1", "mem"), "40000000");
  const host = () => ({ gpu: 45, gpuMem: null, cpu: 20, mem: 25 });
  const held: string[] = [];
  await expect(acquire(headroomDeps(dir, host, held, stopAfter(2)), "second", { pollMs: 1, memKb: 20_000_000 })).rejects.toThrow("stop");
  expect(held).toEqual(["HEAVY_WAIT second: memory: needs 19.1G, 71.5G available, 28.6G held for running jobs still loading -> 25% free (needs 30% free)"]);
  const beside: string[] = [];
  expect(await acquire(headroomDeps(dir, host, beside), "small", { pollMs: 1, memKb: 10_000_000 })).toEqual({ slot: join(dir, "slot.2") });
  expect(beside).toEqual(["HEAVY_ADMIT small slot.2: 1 running beside it; gpu 45%+25% -> 30% free, cpu 20%+10% -> 70% free (needs 30% free each); memory: needs 9.5G, 71.5G available, 28.6G held for running jobs still loading -> 35% free (needs 30% free)"]);
});

test("a heavy job waits while the last one taken has not shown its load, and two waiters never take one headroom twice", async () => {
  const dir = join(state.dir, "heavy");
  heldSlot(dir, 1, 100, T0 - 30_000);
  const logs: string[] = [];
  const settling = headroomDeps(dir, () => ({ gpu: 0, gpuMem: null, cpu: 0, mem: 0 }), logs, stopAfter(2));
  await expect(acquireSlot(settling, "eval-b", 1)).rejects.toThrow("stop");
  expect(logs).toEqual(["HEAVY_WAIT eval-b: slot.1 was taken 30s ago; its load shows after 120s"]);
  expect(settling.calls).toBe(0);
  heldSlot(dir, 1, 100, T0 - 10 * MIN);
  const both: string[] = [];
  const a = acquireSlot(headroomDeps(dir, () => ({ gpu: 0, gpuMem: null, cpu: 0, mem: 0 }), both, stopAfter(3)), "eval-b", 1);
  // eval-c stands behind eval-b in the line first, then sees eval-b's slot settle
  const b = acquireSlot(headroomDeps(dir, () => ({ gpu: 0, gpuMem: null, cpu: 0, mem: 0 }), both, stopAfter(20)), "eval-c", 1);
  const got = await Promise.allSettled([a, b]);
  expect(got.filter((g) => g.status === "fulfilled").length).toBe(1);
  expect(both.filter((l) => l.startsWith("HEAVY_ADMIT")).length).toBe(1);
  expect(both.some((l) => /^HEAVY_WAIT eval-[bc]: slot\.2 was taken 0s ago/.test(l))).toBe(true);
});

test("a slot whose pid now belongs to a process started after the claim is taken at the next admission; a live holder keeps its slot", async () => {
  // Given: slot.1 held by a job that started before its claim, slot.2 by a pid the system gave to a newer process
  const dir = join(state.dir, "heavy");
  heldSlot(dir, 1, 100, T0 - 10 * MIN);
  heldSlot(dir, 2, 200, T0 - 60 * MIN);
  const started: Record<number, number> = { 100: T0 - 11 * MIN, 200: T0 - 5 * MIN };
  const logs: string[] = [];
  const deps = { ...headroomDeps(dir, () => ({ gpu: 45, gpuMem: null, cpu: 20, mem: 25 }), logs), alive: (pid: number, since?: number) => since === undefined || (started[pid] ?? Infinity) <= since };
  // When
  const slot = await acquireSlot(deps, "eval-b");
  // Then: slot.2 is reused, only slot.1 counts beside it, and the 30% verdict reads as before
  expect(slot).toBe(join(dir, "slot.2"));
  expect(logs).toEqual(["HEAVY_ADMIT eval-b slot.2: 1 running beside it; gpu 45%+25% -> 30% free, cpu 20%+10% -> 70% free, mem(unified) 25%+10% -> 65% free (needs 30% free each)"]);
  expect(readFileSync(join(dir, "slot.1", "owner"), "utf8")).toStartWith("100 running eval");
  // and the real check tells this process from one that took a slot before it started
  expect(pidAlive(process.pid, Date.now())).toBe(true);
  expect(pidAlive(process.pid, performance.timeOrigin - MIN)).toBe(false);
});

test("a holder that ends after its slot was taken over leaves the new job's slot alone", async () => {
  const dir = join(state.dir, "heavy");
  const slot = await acquireSlot({ dir, slots: 1, maxLoad: 80, clock: fakeClock(T0), pid: 4242, load: async () => 10, alive: () => true }, "old");
  writeFileSync(join(slot, "owner"), `5151 next-job ${new Date(T0 + MIN).toISOString()}`);
  releaseSlot(slot);
  expect(readFileSync(join(slot, "owner"), "utf8")).toStartWith("5151 next-job");
});

test("a waiter for full slots is told which jobs hold them and for how long", async () => {
  const dir = join(state.dir, "heavy");
  [1, 2, 3, 4].forEach((n) => {
    mkdirSync(join(dir, `slot.${n}`), { recursive: true });
    writeFileSync(join(dir, `slot.${n}`, "owner"), `${100 + n} e7-eval-${n} ${new Date(T0 - n * 70 * MIN).toISOString()}`);
  });
  const logs: string[] = [];
  await expect(acquireSlot(headroomDeps(dir, () => ({ gpu: 0, gpuMem: null, cpu: 0, mem: 0 }), logs, stopAfter(2)), "eval-e", 1)).rejects.toThrow("stop");
  expect(logs).toEqual(["HEAVY_WAIT eval-e: all 4 slots busy: slot.1 e7-eval-1 pid 101 1h10m, slot.2 e7-eval-2 pid 102 2h20m, slot.3 e7-eval-3 pid 103 3h30m, slot.4 e7-eval-4 pid 104 4h40m"]);
});

test("waiters take a freed slot in the order they came, not by process id", async () => {
  // Given: one slot held, three waiters arriving one ms apart with falling pids; the earliest polls slowest
  const dir = join(state.dir, "heavy");
  heldSlot(dir, 1, 100, T0 - 10 * MIN);
  let holderAlive = true;
  const order: string[] = [];
  const waiter = async (label: string, pid: number, at: number) => {
    const hops = 3 - (at - T0);
    const clock = { now: () => at, sleep: async () => { for (let i = 0; i < hops; i++) await new Promise<void>((r) => setImmediate(r)); } };
    const slot = await acquireSlot({ dir, slots: 1, maxLoad: 80, clock, pid, load: async () => 10, alive: (p) => (p === 100 ? holderAlive : true) }, label, 1);
    order.push(label);
    releaseSlot(slot);
  };
  const all = Promise.all([waiter("first", 900, T0), waiter("second", 800, T0 + 1), waiter("third", 700, T0 + 2)]);
  // When: the holder ends after every waiter found the slot taken
  await new Promise<void>((r) => setImmediate(r));
  holderAlive = false;
  await all;
  // Then
  expect(order).toEqual(["first", "second", "third"]);
});

test("GPU, per-process and process-tree readings parse as nvidia-smi and ps print them on a GB10", () => {
  expect(parseGpuQuery("77, [N/A], [N/A]")).toEqual({ util: 77, memUsedMib: null, memTotalMib: null });
  expect(parseGpuQuery("40, 8000, 16000\n60, 4000, 16000")).toEqual({ util: 50, memUsedMib: 12000, memTotalMib: 32000 });
  const pmon = [
    "# gpu         pid   type     sm    mem    enc    dec    jpg    ofa     fb   ccpm    command ",
    "# Idx           #    C/G      %      %      %      %      %      %     MB     MB    name ",
    "    0       3292     G      -      -      -      -      -      -     18      0    Xorg           ",
    "    0    1977792     C     34      0      -      -      -      -    289      0    python         ",
  ].join("\n");
  expect(parsePmon(pmon).get(1977792)).toEqual({ sm: 34, fbMib: 289 });
  expect(parsePmon(pmon).get(3292)).toEqual({ sm: 0, fbMib: 18 });
  const t = treeOf("   10     1  100  0.0\n   11    10 2000 100\n   12    11  500 50.5\n   13     1  900 99", 10);
  expect(t.pids.sort()).toEqual([10, 11, 12]);
  expect(t.rssKb).toBe(2600);
  expect(t.cpuPct).toBe(150.5);
});
