import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { BatchJob } from "../src/heavy-batch.ts";
import { shipItems } from "../src/heavy-batch-check.ts";
import { shipMissing } from "../src/heavy-ship.ts";
import type { SpreadJob } from "../src/heavy-spread.ts";
import { withState } from "./fakes.ts";

// What a --kind job sends to a helper, weighed for every path that goes (reviews 5 and 6 of #479): the --sync paths and
// --tools trees against heavyNoShip, and relative argument paths as absolute ones; heavy-ship.test.ts holds the rest.
let state: ReturnType<typeof withState>;
let home: string;
let other: string;

beforeEach(() => {
  state = withState();
  home = join(state.dir, "home");
  other = join(home, "other");
  mkdirSync(other, { recursive: true });
});
afterEach(() => state.done());

const job = (cmd: string[]): SpreadJob => ({ label: "t", kind: "cpu", cmd, cwd: other, sync: [other], env: {} });
const who = { uid: process.getuid?.() ?? -1, home: homedir() };

// review 5 of #479: heavyNoShip holds for every path that goes, the declared --sync paths too, and a refusal never tells
// the user to --sync a path under it (gongdori's condition, #dori-pair 1571030089280266255: nothing under ~/data leaves)
test("a --sync path that is, holds or links into a heavyNoShip path never leaves, and the refusal never says add --sync", () => {
  const data = join(home, "data");
  const run = join(data, "run");
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, "raw.bin"), "raw\n");
  const linked = join(home, "linked");
  mkdirSync(linked);
  symlinkSync(join(run, "raw.bin"), join(linked, "raw.bin"));
  const jobs = [{ cwd: run, sync: [run] }, { cwd: other, sync: [other, data] }, { cwd: home, sync: [other, home] }, { cwd: linked, sync: [linked, run] }, { cwd: linked, sync: [linked] }];
  for (const j of jobs) {
    const s = shipMissing({ ...job(["true"]), ...j }, who, [data], 1024 ** 3);
    expect(s).toMatchObject({ refuse: true, why: expect.stringContaining("heavyNoShip") });
    expect(s).not.toMatchObject({ why: expect.stringContaining("add --sync") });
  }
});

test("the items of one batch share one inventory of the folder they send along, not one each", () => {
  const work = join(home, "work");
  mkdirSync(work);
  writeFileSync(join(work, "a.txt"), "a\n");
  const seen = new Map();
  const [a, b] = ["1", "2"].map((n) => shipMissing({ ...job(["echo", n]), cwd: work }, who, [], 1024 ** 3, seen));
  if (!a || !("files" in a) || !b || !("files" in b)) throw new Error("not shipped");
  expect(a.files.map((f) => f.path)).toEqual([join(work, "a.txt")]);
  expect(b.files).toBe(a.files);
});

// review 6 of #479: every path that is archived is weighed, a --tools tree too, and a relative path leaving the working
// folder stops the job as an absolute one does; one batch's items alike, before any item starts
const batchOf = (sync: string[], noShip: string[]): BatchJob => ({ sync, ship: { noShip, maxBytes: 1024 ** 3, heavyLog: join(state.dir, "heavy.log") } }) as unknown as BatchJob;

test("a --tools tree in a heavyNoShip path never leaves, for a job or a batch", () => {
  const data = join(home, "data");
  const install = join(data, "rv");
  mkdirSync(install, { recursive: true });
  writeFileSync(join(install, "rv"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(install, "rv"), 0o755);
  writeFileSync(join(install, "VERSION"), "0.2.1\n");
  writeFileSync(join(install, "raw.bin"), "raw\n");
  mkdirSync(join(home, "bin"));
  symlinkSync(join(install, "rv"), join(home, "bin", "rv"));
  const me = { ...who, path: `${join(home, "bin")}:/usr/bin:/bin` };
  const rv: SpreadJob = { ...job(["rv", "make", other]), tools: ["rv"] };
  expect(shipMissing(rv, me, [data], 1024 ** 3)).toMatchObject({ refuse: true, why: expect.stringContaining("heavyNoShip") });
  expect(shipItems(batchOf([other], [data]), [rv, rv], me).stops).toEqual([expect.stringContaining("#1: "), expect.stringContaining("#2: ")]);
});

test("a relative path that leaves the working folder stops the job and names its --sync, for a job or a batch", () => {
  const work = join(home, "work");
  mkdirSync(work);
  writeFileSync(join(home, "input.txt"), "in\n");
  for (const arg of ["../input.txt", "--in=../input.txt", "./../input.txt"]) {
    const j = { ...job(["cat", arg]), cwd: work, sync: [] };
    expect(shipMissing(j, who, [], 1024 ** 3)).toMatchObject({ refuse: true, why: expect.stringContaining(`(add --sync ${join(home, "input.txt")})`) });
    expect(shipItems(batchOf([], []), [j], who).stops).toEqual([expect.stringContaining(`(add --sync ${join(home, "input.txt")})`)]);
  }
  expect(shipMissing({ ...job(["cat", "sub/../in.txt"]), cwd: work, sync: [] }, who, [], 1024 ** 3)).toHaveProperty("plan");
});
