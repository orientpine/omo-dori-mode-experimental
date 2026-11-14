import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import type { HeavyHelper } from "../src/config.ts";
import { notAway, ownerBusy, ownerCpuCap, ownerNever, ownerTakes, ownerWords } from "../src/heavy-owner-pc.ts";
import { helperVerdict } from "../src/heavy-queue.ts";
import { helperProblem } from "../src/heavy-route.ts";
import { admitOnce, type SlotDeps } from "../src/heavy-slot.ts";
import { batchCode, batchOf, ctxWith, logs, realHelper, receipts, start, state, stop } from "./heavy-batch-fixture.ts";

// The owner's own PC as a batch helper (owner's card Q46): cha takes a batch's items only while its owner is away by
// ~/.dori/idle.json, under its caps, and an unreadable or stale file means it takes none.
beforeEach(start);
afterEach(stop);

const NOW = Date.parse("2026-11-14T06:00:00Z");
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
const idleFile = (dir: string, s: unknown): string => {
  mkdirSync(join(dir, ".dori"), { recursive: true });
  const f = join(dir, ".dori", "idle.json");
  writeFileSync(f, typeof s === "string" ? s : JSON.stringify(s));
  return f;
};

test("away is the screen locked or no input for idleMin, from a fresh file; anything else is not away", () => {
  const dir = state.dir;
  const at = iso(NOW - 30_000);
  expect(notAway(20, NOW, idleFile(dir, { at, locked: true, lastInputAt: iso(NOW - 60_000) }))).toBeUndefined();
  expect(notAway(20, NOW, idleFile(dir, { at, locked: false, lastInputAt: iso(NOW - 25 * 60_000) }))).toBeUndefined();
  expect(notAway(20, NOW, idleFile(dir, { at, locked: false, lastInputAt: iso(NOW - 2 * 60_000) }))).toContain("the owner is on this PC (screen not locked, input 2 min ago, under 20)");
  expect(notAway(20, NOW, idleFile(dir, { at: iso(NOW - 4 * 60_000), locked: true, lastInputAt: iso(NOW - 3600_000) }))).toContain("is 240 s old, so this PC takes no batch item");
  expect(notAway(20, NOW, idleFile(dir, "{not json"))).toContain("cannot be read");
  expect(notAway(20, NOW, idleFile(dir, { at, locked: "yes", lastInputAt: at }))).toContain("cannot be read");
  expect(notAway(20, NOW, join(dir, "none", "idle.json"))).toContain("cannot be read");
});

test("the caps keep an item off while CPU or memory with it would pass them; kinds keep a batch of another kind off", () => {
  const free = join(state.dir, "away");
  const file = idleFile(free, { at: iso(NOW), locked: true, lastInputAt: iso(NOW) });
  const words = ownerWords({ idleMin: 20, cpuPct: 50, memPct: 40 });
  expect(words).toEqual(["idle=20", "cap=50:40"]);
  const use = (cpuPct: number, usedGb: number) => () => ({ cpuPct, memTotal: 100 * 1024 ** 3, memAvail: (100 - usedGb) * 1024 ** 3 });
  expect(ownerBusy(words, 1024 ** 3, NOW, file, use(20, 10))).toBeUndefined();
  expect(ownerBusy(words, 1024 ** 3, NOW, file, use(55, 10))).toBe("this PC is 55% busy (cpu), its batch cap is 50%");
  expect(ownerBusy(words, 35 * 1024 ** 3, NOW, file, use(20, 10))).toBe("this PC's memory would be 45% used with it, its batch cap is 40%");
  expect(ownerTakes({ idleMin: 20, cpuPct: 50, memPct: 40, kinds: ["cpu", "browser"] }, "gpu")).toBe(false);
  expect(ownerTakes({ idleMin: 20, cpuPct: 50, memPct: 40, kinds: ["cpu", "browser"] }, "browser")).toBe(true);
  // a helper whose dori does not know idle= is out of date, so the batch leaves it out instead of sending it items unguarded
  expect(helperVerdict("REFUSED", 'unknown option "idle=20"').kind).toBe("old");
});

// a real worker whose home holds the idle file given
const ownerHelper = (idle: unknown): HeavyHelper => {
  const h = realHelper("cha");
  const home = join(state.dir, "cha-home");
  idleFile(home, idle);
  // HOME goes among the env words, before the worker's own five (bun, cli.ts, heavy-worker, --caller, tester)
  return { name: "cha", ssh: [...h.ssh.slice(0, -5), `HOME=${home}`, ...h.ssh.slice(-5)], owner: { idleMin: 20, cpuPct: 100, memPct: 100 } };
};

test("a batch item goes to the owner's PC only while he is away; while he is on it the item runs elsewhere", async () => {
  const on = ownerHelper({ at: iso(Date.now()), locked: false, lastInputAt: iso(Date.now()) });
  // this host frees after a second, so the item that cha keeps waiting runs here
  const ctx = ctxWith([on], true, undefined, true);
  setTimeout(() => rmSync(join(state.dir, "heavy", "slot.1"), { recursive: true, force: true }), 1000);
  expect(await batchCode(ctx, batchOf(["x"], ["true"], { memPerWorker: 64 * 1024 ** 2 }))).toBe(0);
  expect(receipts()).toMatchObject([{ host: hostname(), exit: 0 }]);
  expect(logs.some((l) => l.startsWith("HEAVY_BATCH_WAIT b cha: busy: the owner is on this PC (screen not locked"))).toBe(true);
}, 60_000);

test("a batch item goes to the owner's PC while its screen is locked", async () => {
  const away = ownerHelper({ at: iso(Date.now()), locked: true, lastInputAt: iso(Date.now()) });
  // an owner PC holds an item to its memory cap, so the batch gives it an estimate (review 1 of #480)
  expect(await batchCode(ctxWith([away]), batchOf(["x"], ["true"], { memPerWorker: 64 * 1024 ** 2 }))).toBe(0);
  expect(receipts()).toMatchObject([{ host: "cha", exit: 0 }]);
}, 60_000);

// review 1 of #480: a time that cannot be (2026-13-99...) or is ahead of now never counts as a fresh file
test("an idle file whose time cannot be or is in the future is unreadable, so the PC takes no item", () => {
  const dir = state.dir;
  expect(notAway(20, NOW, idleFile(dir, { at: "2026-13-99T99:99:99Z", locked: true, lastInputAt: iso(NOW) }))).toContain("cannot be read");
  expect(notAway(20, NOW, idleFile(dir, { at: iso(NOW + 10 * 60_000), locked: true, lastInputAt: iso(NOW) }))).toContain("cannot be read");
});

// reviews 1-2 of #480: an item with no memory estimate, or one over the owner's whole memory cap, can never start there,
// so the owner's PC refuses it (the batch sends it elsewhere or ends it), never only busy
test("an item without a memory estimate or over the whole memory cap is refused on the owner's PC, not kept waiting", async () => {
  const use = () => ({ cpuPct: 0, memTotal: 100 * 1024 ** 3, memAvail: 90 * 1024 ** 3 });
  const words = ownerWords({ idleMin: 20, cpuPct: 50, memPct: 40 });
  expect(ownerNever(words, 0, use)).toContain("needs a memory estimate");
  expect(ownerNever(words, 50 * 1024 ** 3, use)).toContain("over the owner's memory cap of 40%");
  expect(ownerNever(words, 1024 ** 3, use)).toBeUndefined();
  const away = ownerHelper({ at: iso(Date.now()), locked: true, lastInputAt: iso(Date.now()) });
  expect(await batchCode(ctxWith([away]), batchOf(["x"], ["true"], { onHosts: ["cha"] }))).not.toBe(0);
  expect(receipts()).toMatchObject([{ n: 1, refused: [{ host: "cha", why: expect.stringContaining("needs a memory estimate") }] }]);
}, 60_000);

// review 1 of #480: the owner's memory cap counts what running items reserved and do not use yet, under the slot lock
test("the owner's memory cap counts running items' reservations at admission", async () => {
  const dir = join(state.dir, "slots");
  mkdirSync(join(dir, "slot.1"), { recursive: true });
  writeFileSync(join(dir, "slot.1", "owner"), `4242 running ${new Date().toISOString()}`);
  writeFileSync(join(dir, "slot.1", "mem"), String(20 * 1024 ** 2));
  const gb = 1024 ** 2;
  const usage = async () => ({ host: { gpu: null, gpuMem: null, cpu: 0, mem: 10 }, unified: false, jobs: [{ mem: 0 }], memTotalKb: 100 * gb });
  const deps = { dir, slots: 4, maxLoad: 1e9, clock: { now: () => Date.now(), sleep: async () => {} }, pid: process.pid, load: async () => 0, alive: (p: number) => p === 4242, headroom: { maxSlots: 4, free: 5, settleSec: 0, usage } } as unknown as SlotDeps;
  const capped = await admitOnce(deps, "item", 0, 20 * gb, 40);
  expect(capped && "wait" in capped ? capped.why : capped).toContain("owner's memory cap");
  const free = await admitOnce(deps, "item", 0, 20 * gb);
  expect(free && "slot" in free).toBe(true);
  // review 3: the owner's CPU cap is the quota of the one item it runs, so a second item waits even with memory free
  writeFileSync(join(dir, "slot.1", "mem"), String(gb));
  const one = await admitOnce(deps, "item3", 0, gb, 40);
  expect(one && "wait" in one ? one.why : one).toContain("one batch item at a time");
  expect(ownerCpuCap(ownerWords({ idleMin: 20, cpuPct: 50, memPct: 40 }))).toBe(50);
  expect(ownerCpuCap(["idle=20"])).toBeUndefined();
  // review 2: with the owner's cap, a memory sample that read nothing waits instead of admitting unweighed
  const blind = { ...deps, headroom: { ...deps.headroom, usage: async () => ({ ...(await usage()), memTotalKb: 0 }) } } as unknown as SlotDeps;
  const unweighed = await admitOnce(blind, "item2", 0, 20 * gb, 40);
  expect(unweighed && "wait" in unweighed ? unweighed.why : unweighed).toContain("owner's memory cap cannot be weighed");
});

// review 4 of #480: a malformed owner entry (idleMin null would become idle=0) is a config error, never a silent default
test("an owner entry with a missing or out-of-range number or an unknown kind is refused when the config loads", () => {
  const h = (owner: unknown) => ({ name: "cha", ssh: ["true"], owner }) as unknown as HeavyHelper;
  expect(helperProblem(h({ idleMin: null, cpuPct: 50, memPct: 40 }))).toContain("heavyQueue.helpers.cha.owner");
  expect(helperProblem(h({ idleMin: 20, cpuPct: 150, memPct: 40 }))).toContain("heavyQueue.helpers.cha.owner");
  expect(helperProblem(h({ idleMin: 20, cpuPct: 50, memPct: 40, kinds: ["cpu", "nope"] }))).toContain("heavyQueue.helpers.cha.owner");
  expect(helperProblem(h({ idleMin: 20, cpuPct: 50, memPct: 40, kinds: ["cpu", "browser"] }))).toBeUndefined();
});
