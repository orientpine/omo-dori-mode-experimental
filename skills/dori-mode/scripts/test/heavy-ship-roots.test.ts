import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { BatchJob } from "../src/heavy-batch.ts";
import { shipItems } from "../src/heavy-batch-check.ts";
import { stageAssets } from "../src/heavy-assets.ts";
import { sendTar } from "../src/heavy-send.ts";
import { shipMissing } from "../src/heavy-ship.ts";
import type { SpreadJob } from "../src/heavy-spread.ts";
import { TAR_LIST } from "../src/heavy-upload.ts";
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

// the lead after review 6 of #479: one archive builder makes every list tar gets, so no input kind can go around the
// heavyNoShip check. Every kind is given as a link into ~/data and refused; the two tar makers refuse such a root too.
test("no path into an upload's tar goes around the archive builder: every input kind linked into ~/data is refused", async () => {
  const data = join(home, "data");
  const run = join(data, "run");
  mkdirSync(join(data, "rv"), { recursive: true });
  mkdirSync(run);
  writeFileSync(join(run, "raw.bin"), "raw\n");
  writeFileSync(join(data, "rv", "rv"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(data, "rv", "rv"), 0o755);
  writeFileSync(join(data, "rv", "VERSION"), "0.2.1\n");
  mkdirSync(join(home, "bin"));
  symlinkSync(join(data, "rv", "rv"), join(home, "bin", "rv"));
  const me = { ...who, path: `${join(home, "bin")}:/usr/bin:/bin` };
  const linked = (name: string): string => {
    mkdirSync(join(home, name));
    symlinkSync(join(run, "raw.bin"), join(home, name, "raw.bin"));
    return join(home, name);
  };
  symlinkSync(run, join(home, "toData"));
  const inSync = linked("insync");
  const work = linked("work");
  mkdirSync(join(home, "plain"));
  symlinkSync(join(run, "raw.bin"), join(home, "up.bin"));
  const kinds: Record<string, SpreadJob> = {
    "--sync root": { ...job(["true"]), sync: [other, join(home, "toData")] },
    "link in --sync": { ...job(["true"]), cwd: inSync, sync: [inSync] },
    "working folder sent along": { ...job(["true"]), cwd: work, sync: [] },
    "--tools tree": { ...job(["rv", "make", other]), tools: ["rv"] },
    "relative ../ argument": { ...job(["cat", "../up.bin"]), cwd: join(home, "plain"), sync: [] },
  };
  for (const [kind, j] of Object.entries(kinds)) {
    const s = shipMissing(j, me, [data], 1024 ** 3);
    expect({ kind, s }).toMatchObject({ kind, s: { refuse: true, why: expect.stringContaining("heavyNoShip") } });
    expect({ kind, s }).not.toMatchObject({ s: { why: expect.stringContaining("add --sync") } });
  }
  const staged = await stageAssets([inSync], join(state.dir, "assets"), [data]);
  expect(staged).toMatchObject({ why: expect.stringContaining("heavyNoShip") });
  // the other tar maker sends job.json alone: no file of a --sync path is tarred outside the builder
  const sent: Uint8Array[] = [];
  const sink = { write: (b: Uint8Array) => sent.push(b.slice()), flush: () => 0, end: () => 0 };
  await sendTar(sink, kinds["link in --sync"]!, [inSync], () => {}, new Promise(() => {}), []);
  const listed = Bun.spawn(["tar", "-tf", "-"], { stdin: new Blob(sent), stdout: "pipe" });
  expect((await new Response(listed.stdout).text()).trim().split("\n")).toEqual(["job.json"]);
});

// the challenge of the r7 plan: tar opens each listed name again, so a folder swapped for a link into a heavyNoShip path
// between the check and tar would send what is behind it; the same list read again after tar throws that archive away
test("a folder swapped for a link into a heavyNoShip path while it is archived sends nothing", async () => {
  const work = join(home, "work");
  const deny = join(home, "deny");
  mkdirSync(join(work, "sub"), { recursive: true });
  mkdirSync(deny);
  writeFileSync(join(work, "sub", "input"), "PUBLIC\n");
  writeFileSync(join(deny, "input"), "SECRET_SENTINEL\n");
  const sub = join(work, "sub");
  const stage = join(state.dir, "stage");
  const swap = `mv ${sub} ${sub}.was && ln -s ${deny} ${sub} && exec tar "$@"`;
  const r = await stageAssets([work], stage, [deny], { argv: ["sh", "-c", swap, "sh", ...TAR_LIST] });
  expect(r).toEqual({ why: `${sub} changed into another path while it was archived, so the archive is not sent` });
  expect(readdirSync(stage)).toEqual([]);
  // review 7 of #479: the link taken away again after tar read through it, or a new folder put in its place, is no safe
  // ending either: every listed entry is read again by its device and inode, and one gone or another refuses the archive
  for (const after of [`rm ${sub}`, `rm ${sub} && mkdir ${sub}`]) {
    rmSync(sub, { recursive: true, force: true });
    rmSync(`${sub}.was`, { recursive: true, force: true });
    mkdirSync(sub);
    writeFileSync(join(sub, "input"), "PUBLIC\n");
    const undo = `mv ${sub} ${sub}.was && ln -s ${deny} ${sub} && { tar "$@"; c=$?; ${after}; exit $c; }`;
    const u = await stageAssets([work], stage, [deny], { argv: ["sh", "-c", undo, "sh", ...TAR_LIST] });
    expect({ after, u }).toEqual({ after, u: { why: expect.stringMatching(/changed into another path while it was archived|was gone or another file after it was archived/) } });
    expect(readdirSync(stage)).toEqual([]);
  }
});

// review 7 of #479: a name that is not UTF-8 cannot be listed as it is, so it stops the upload instead of being left out
test("a file whose name is not UTF-8 stops the upload with why, instead of the tree arriving without it", async () => {
  const work = join(home, "bytes");
  mkdirSync(work);
  writeFileSync(Buffer.concat([Buffer.from(`${work}/a`), Buffer.from([0xff]), Buffer.from(".bin")]), "x\n");
  const r = await stageAssets([work], join(state.dir, "stage"), []);
  expect(r).toEqual({ why: expect.stringContaining(`${work} holds a name that is not UTF-8, so it cannot be listed to send it`) });
});

// review 7 of #479: a relative value after = is weighed alone, never also as part of the whole word (if=../x is no path)
test("a relative value after = names its own target only, so a job with that target synced runs", () => {
  const work = join(home, "a", "b", "work");
  mkdirSync(work, { recursive: true });
  writeFileSync(join(home, "input"), "in\n");
  const s = shipMissing({ ...job(["dd", "if=../../../input", "of=out"]), cwd: work, sync: [work, join(home, "input")] }, who, [], 1024 ** 3);
  expect(s).toHaveProperty("plan");
});

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
  // the lead after review 12: the advice names the new output's folder (a missing --sync root is a folder on a helper),
  // and doing what it says lets the job go
  const res = join(home, "results");
  const nj = { ...job(["dd", "if=/dev/zero", `of=${join(res, "result.bin")}`]), cwd: work, sync: [work] };
  expect(shipMissing(nj, who, [], 1024 ** 3)).toMatchObject({ refuse: true, why: expect.stringContaining(`(add --sync ${res})`) });
  expect(shipMissing({ ...nj, sync: [work, res] }, who, [], 1024 ** 3)).toHaveProperty("plan");
  // and . or .. in a list is a path item: a covered PYTHONPATH=<lib>:. runs
  mkdirSync(join(home, "lib"));
  expect(shipMissing({ ...job(["env", `PYTHONPATH=${join(home, "lib")}:.`, "true"]), cwd: work, sync: [work, join(home, "lib")] }, who, [], 1024 ** 3)).toHaveProperty("plan");
  writeFileSync(join(home, "a.jar"), "a");
  writeFileSync(join(home, "b.jar"), "b");
  const jars = [join(home, "a.jar"), join(home, "b.jar")];
  expect(shipMissing({ ...job(["true", "-cp", jars.join(":"), "Main"]), cwd: work, sync: [work, ...jars] }, who, [], 1024 ** 3)).toHaveProperty("plan");
});

// review 8 of #479: a relative argument that is itself an existing file, : or = in its name, is weighed whole as well
test("a relative file with : or = in its name is weighed whole: unsynced it stops a job and a batch, synced it runs", () => {
  const work = join(home, "input");
  mkdirSync(work);
  for (const name of ["input:part.txt", "x=y.txt"]) {
    const f = join(home, name);
    writeFileSync(f, "in\n");
    const j = { ...job(["cat", `../${name}`]), cwd: work, sync: [work] };
    expect(shipMissing(j, who, [], 1024 ** 3)).toMatchObject({ refuse: true, why: expect.stringContaining(`(add --sync ${f})`) });
    expect(shipItems(batchOf([], []), [j], who).stops).toEqual([expect.stringContaining(`(add --sync ${f})`)]);
    expect(shipMissing({ ...j, sync: [work, f] }, who, [], 1024 ** 3)).toHaveProperty("plan");
  }
});
