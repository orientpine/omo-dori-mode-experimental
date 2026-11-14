import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import type { HeavyHelper } from "../src/config.ts";
import { notAway, ownerBusy, ownerTakes, ownerWords } from "../src/heavy-owner-pc.ts";
import { helperVerdict } from "../src/heavy-queue.ts";
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
  expect(ownerBusy(words, 0, NOW, file, use(20, 10))).toBeUndefined();
  expect(ownerBusy(words, 0, NOW, file, use(55, 10))).toBe("this PC is 55% busy (cpu), its batch cap is 50%");
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
  expect(await batchCode(ctx, batchOf(["x"], ["true"]))).toBe(0);
  expect(receipts()).toMatchObject([{ host: hostname(), exit: 0 }]);
  expect(logs.some((l) => l.startsWith("HEAVY_BATCH_WAIT b cha: busy: the owner is on this PC (screen not locked"))).toBe(true);
}, 60_000);

test("a batch item goes to the owner's PC while its screen is locked", async () => {
  const away = ownerHelper({ at: iso(Date.now()), locked: true, lastInputAt: iso(Date.now()) });
  expect(await batchCode(ctxWith([away]), batchOf(["x"], ["true"]))).toBe(0);
  expect(receipts()).toMatchObject([{ host: "cha", exit: 0 }]);
}, 60_000);
