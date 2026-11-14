import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { BatchJob } from "../src/heavy-batch.ts";
import { shipItems } from "../src/heavy-batch-check.ts";
import { shipMissing } from "../src/heavy-ship.ts";
import type { SpreadJob } from "../src/heavy-spread.ts";
import { withState } from "./fakes.ts";

// The paths a --kind job's arguments name (reviews 10-16 of #479, heavy-route.ts argPaths): each weighed whole, never by
// a covered prefix; heavy-ship-roots.test.ts holds what is archived.
let state: ReturnType<typeof withState>;
let home: string;

beforeEach(() => {
  state = withState();
  home = join(state.dir, "home");
  mkdirSync(join(home, "other"), { recursive: true });
});
afterEach(() => state.done());

const job = (cmd: string[]): SpreadJob => ({ label: "t", kind: "cpu", cmd, cwd: join(home, "other"), sync: [join(home, "other")], env: {} });
const who = { uid: process.getuid?.() ?? -1, home: homedir() };
const batchOf = (sync: string[], noShip: string[]): BatchJob => ({ sync, ship: { noShip, maxBytes: 1024 ** 3, heavyLog: join(state.dir, "heavy.log") } }) as unknown as BatchJob;

// review 10 of #479: an absolute word that does not exist yet (a new output) is weighed whole, never by a covered prefix
test("a new absolute output named with a space or a colon beside the working folder stops a job and a batch", () => {
  const work = join(home, "work");
  mkdirSync(work);
  for (const out of [`${work} result.txt`, `${work}:out.txt`]) {
    const j = { ...job(["touch", out]), cwd: work, sync: [work] };
    expect(shipMissing(j, who, [], 1024 ** 3)).toMatchObject({ refuse: true, why: expect.stringContaining(`(add --sync ${dirname(out)})`) });
    expect(shipItems(batchOf([], []), [j], who).stops).toEqual([expect.stringContaining(`(add --sync ${dirname(out)})`)]);
  }
  expect(shipMissing({ ...job(["touch", join(work, "new.txt")]), cwd: work, sync: [work] }, who, [], 1024 ** 3)).toHaveProperty("plan");
  // review 11: an assigned or relative new output is weighed whole too; an absolute list of synced paths still runs
  for (const [arg, out] of [[`of=${work} result.bin`, `${work} result.bin`], ["../work:result.txt", `${work}:result.txt`]] as const) {
    const j = { ...job(["dd", arg]), cwd: work, sync: [work] };
    expect({ arg, s: shipMissing(j, who, [], 1024 ** 3) }).toMatchObject({ arg, s: { refuse: true, why: expect.stringContaining(`(add --sync ${dirname(out)})`) } });
    expect(shipItems(batchOf([], []), [j], who).stops).toEqual([expect.stringContaining(`(add --sync ${dirname(out)})`)]);
  }
  // the lead after review 12: the advice names the new output's folder, and doing what it says lets the job go
  const res = join(home, "results");
  const nj = { ...job(["dd", "if=/dev/zero", `of=${join(res, "result.bin")}`]), cwd: work, sync: [work] };
  expect(shipMissing(nj, who, [], 1024 ** 3)).toMatchObject({ refuse: true, why: expect.stringContaining(`(add --sync ${res})`) });
  expect(shipMissing({ ...nj, sync: [work, res] }, who, [], 1024 ** 3)).toHaveProperty("plan");
  // and . or .. in a list is a path item: a covered PYTHONPATH=<lib>:. runs
  mkdirSync(join(home, "lib"));
  expect(shipMissing({ ...job(["env", `PYTHONPATH=${join(home, "lib")}:.`, "true"]), cwd: work, sync: [work, join(home, "lib")] }, who, [], 1024 ** 3)).toHaveProperty("plan");
  // review 14: only path-shaped items make a list (being there cannot tell lib from a new output's name)
  mkdirSync(join(work, "lib"));
  writeFileSync(join(work, "out.txt"), "old\n");
  for (const arg of [`${work}:out.txt`, `of=${work}:out.txt`]) {
    const oj = { ...job(["touch", arg]), cwd: work, sync: [work] };
    expect({ arg, s: shipMissing(oj, who, [], 1024 ** 3) }).toMatchObject({ arg, s: { refuse: true, why: expect.stringContaining(`${work}:out.txt (in`) } });
    expect(shipItems(batchOf([], []), [oj], who).stops).toEqual([expect.stringContaining(`${work}:out.txt (in`)]);
  }
  const bare = { ...job(["env", `PYTHONPATH=${join(home, "lib")}:lib`, "true"]), cwd: work, sync: [work, join(home, "lib")] };
  expect(shipMissing(bare, who, [], 1024 ** 3)).toMatchObject({ refuse: true, why: expect.stringContaining("write each relative item with ./ (./lib)") });
  expect(shipMissing({ ...bare, cmd: ["env", `PYTHONPATH=${join(home, "lib")}:./lib`, "true"] }, who, [], 1024 ** 3)).toHaveProperty("plan");
  // review 15: a mixed list never drops its path-shaped items (lib:../shared weighs ../shared)
  mkdirSync(join(home, "shared"));
  const mixed = { ...job(["env", "PYTHONPATH=lib:../shared", "true"]), cwd: work, sync: [work] };
  expect(shipMissing(mixed, who, [], 1024 ** 3)).toMatchObject({ refuse: true, why: expect.stringContaining(`(add --sync ${join(home, "shared")})`) });
  expect(shipItems(batchOf([], []), [mixed], who).stops).toEqual([expect.stringContaining(`(add --sync ${join(home, "shared")})`)]);
  expect(shipMissing({ ...mixed, sync: [work, join(home, "shared")] }, who, [], 1024 ** 3)).toHaveProperty("plan");
  // review 16: a URL names no path here, whole or as a list
  const url = { ...job(["printf", "%s\\n", "https://example.org/a", "--url=https://example.org/b:8080"]), cwd: work, sync: [work] };
  expect(shipMissing(url, who, [], 1024 ** 3)).toHaveProperty("plan");
  expect(shipItems(batchOf([], []), [url], who).stops).toEqual([]);
  const data = join(home, "data");
  mkdirSync(join(data, "lib"), { recursive: true });
  const dj = { ...job(["env", `PYTHONPATH=${join(data, "lib")}:lib`, "true"]), cwd: work, sync: [work] };
  expect(shipMissing(dj, who, [data], 1024 ** 3)).toMatchObject({ refuse: true, why: expect.stringContaining("heavyNoShip") });
  expect(shipItems(batchOf([], []), [dj], who).stops).toEqual([expect.stringContaining(join(data, "lib"))]);
  writeFileSync(join(home, "a.jar"), "a");
  writeFileSync(join(home, "b.jar"), "b");
  const jars = [join(home, "a.jar"), join(home, "b.jar")];
  expect(shipMissing({ ...job(["true", "-cp", jars.join(":"), "Main"]), cwd: work, sync: [work, ...jars] }, who, [], 1024 ** 3)).toHaveProperty("plan");
});
