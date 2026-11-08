import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

import { holdOn, liveHolds } from "../src/heavy-hold.ts";
import { withState } from "./fakes.ts";

// Any account on the host writes in the hold directory (dori heavy hold-local), so every read of it fails closed and
// bounded, and an entry its owner swaps between a look and an open is never waited on, followed or read (#408 reviews).
const ME = userInfo().username;
let state: ReturnType<typeof withState>;
let hold: string;

beforeEach(() => {
  state = withState();
  hold = join(state.dir, "hold");
});
afterEach(() => state.done());

test("a hold file that cannot be read still holds, and none holds longer than a day from when it was written", () => {
  const now = Date.now();
  holdOn(hold, ME, now + 60_000, "x", now);
  writeFileSync(join(hold, `${ME}.json`), "not json");
  expect(liveHolds(hold, now)).toEqual([{ by: ME, reason: "(its file cannot be read)", until: statSync(join(hold, `${ME}.json`)).mtimeMs + 24 * 3_600_000 }]);
  writeFileSync(join(hold, `${ME}.json`), JSON.stringify({ reason: "forever", until: new Date(now + 7 * 24 * 3_600_000).toISOString() }));
  const old = (now - 25 * 3_600_000) / 1000;
  utimesSync(join(hold, `${ME}.json`), old, old);
  expect(liveHolds(hold, now)).toEqual([]);
});

test("a hold file that is not an object holds as unreadable, and an old one ends", () => {
  const now = Date.now();
  holdOn(hold, ME, now + 60_000, "x", now);
  const file = join(hold, `${ME}.json`);
  for (const body of ["null", "[1]", "7"]) {
    writeFileSync(file, body);
    expect(liveHolds(hold, now).map((h) => h.reason)).toEqual(["(its file cannot be read)"]);
  }
  const old = (now - 25 * 3_600_000) / 1000;
  utimesSync(file, old, old);
  expect(liveHolds(hold, now)).toEqual([]);
});

test("a hold whose owner dates its file into the future still ends a day after it was written", () => {
  const now = Date.now();
  holdOn(hold, ME, now + 60_000, "x", now);
  const file = join(hold, `${ME}.json`);
  writeFileSync(file, JSON.stringify({ reason: "forever", until: new Date(now + 365 * 24 * 3_600_000).toISOString() }));
  const future = (now + 365 * 24 * 3_600_000) / 1000;
  utimesSync(file, future, future);
  expect(liveHolds(hold, now).map((h) => h.until)).toEqual([statSync(file).ctimeMs + 24 * 3_600_000]);
});

test("a hold directory this account cannot read holds, and a hold is not set in one other accounts cannot use", () => {
  const now = Date.now();
  mkdirSync(hold, { mode: 0o700 });
  chmodSync(hold, 0o1700);
  expect(holdOn(hold, ME, now + 60_000, "x", now)).toContain("1777");
  chmodSync(hold, 0o000);
  try {
    expect(liveHolds(hold, now)).toMatchObject([{ by: "?", reason: expect.stringContaining("1777") }]);
  } finally {
    chmodSync(hold, 0o700);
  }
});

test("a hold file whose metadata this account cannot read holds", () => {
  const now = Date.now();
  holdOn(hold, ME, now + 60_000, "x", now);
  // listable but not searchable: readdir works, lstat of each entry fails
  chmodSync(hold, 0o644);
  try {
    expect(liveHolds(hold, now)).toMatchObject([{ by: "?", reason: expect.stringContaining("1777") }]);
  } finally {
    chmodSync(hold, 0o1777);
  }
});

test("a hold file too big to be one is not read whole: it holds as unreadable", () => {
  const now = Date.now();
  holdOn(hold, ME, now + 60_000, "x", now);
  writeFileSync(join(hold, `${ME}.json`), JSON.stringify({ reason: "y".repeat(1 << 20), until: new Date(now + 60_000).toISOString() }));
  expect(liveHolds(hold, now).map((h) => h.reason)).toEqual(["(its file cannot be read)"]);
});

test("a hold file swapped for a FIFO or a link is not waited on or followed", () => {
  const now = Date.now();
  holdOn(hold, ME, now + 60_000, "x", now);
  const file = join(hold, `${ME}.json`);
  rmSync(file);
  expect(Bun.spawnSync(["mkfifo", file]).exitCode).toBe(0);
  // opening a FIFO for reading waits for a writer unless it is opened non-blocking
  expect(liveHolds(hold, now)).toEqual([]);
  rmSync(file);
  const far = join(state.dir, "far.json");
  writeFileSync(far, JSON.stringify({ reason: "through a link", until: new Date(now + 60_000).toISOString() }));
  symlinkSync(far, file);
  expect(liveHolds(hold, now)).toEqual([]);
});

test("a hold file this account cannot open holds as unreadable until its day ends, and not after (dori challenge)", () => {
  const now = Date.now();
  holdOn(hold, ME, now + 60_000, "x", now);
  const file = join(hold, `${ME}.json`);
  chmodSync(file, 0o000);
  const st = statSync(file);
  expect(liveHolds(hold, now)).toEqual([{ by: ME, reason: "(its file cannot be read)", until: Math.min(st.mtimeMs, st.ctimeMs) + 24 * 3_600_000 }]);
  const old = (now - 25 * 3_600_000) / 1000;
  utimesSync(file, old, old);
  expect(liveHolds(hold, now)).toEqual([]);
});

test("an entry its owner swaps between the look and the open is not waited on, followed or read", () => {
  const now = Date.now();
  holdOn(hold, ME, now + 60_000, "x", now);
  const swap = (to: (file: string) => void) => liveHolds(hold, now, { afterLook: to });
  // a FIFO opened for reading waits for a writer unless opened non-blocking
  expect(swap((file) => { rmSync(file); Bun.spawnSync(["mkfifo", file]); })).toEqual([]);
  holdOn(hold, ME, now + 60_000, "x", now);
  const far = JSON.stringify({ reason: "swapped in", until: new Date(now + 60_000).toISOString() });
  // made before the old one goes, so it is another inode
  expect(swap((file) => { writeFileSync(`${file}.new`, far); renameSync(`${file}.new`, file); })).toEqual([]);
  holdOn(hold, ME, now + 60_000, "x", now);
  const decoy = join(state.dir, "decoy");
  mkdirSync(decoy);
  writeFileSync(join(decoy, `${ME}.json`), far);
  const seen = liveHolds(hold, now, { afterDirLook: () => { renameSync(hold, join(state.dir, "moved")); symlinkSync(decoy, hold); } });
  expect(seen.map((x) => x.reason)).toEqual(["x"]);
});

test("a hold directory that is a link or not mode 1777 holds, and nothing in it is opened", () => {
  const now = Date.now();
  const real = join(state.dir, "real");
  mkdirSync(real);
  writeFileSync(join(real, `${ME}.json`), JSON.stringify({ reason: "inside the link", until: new Date(now + 60_000).toISOString() }));
  symlinkSync(real, hold);
  expect(liveHolds(hold, now)).toMatchObject([{ by: "?", reason: expect.stringContaining("not a plain directory of mode 1777") }]);
});
