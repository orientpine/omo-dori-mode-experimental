import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { shipMissing } from "../src/heavy-ship.ts";
import type { SpreadJob } from "../src/heavy-spread.ts";
import { withState } from "./fakes.ts";

// A --kind job whose working folder lies outside --sync: gongdori's 2026-11-12 jobs said HEAVY_LOCAL "the working folder
// /home/gongdori/Documents/gongdori is not in a --sync path" and ran on 0a83 alone; now the folder goes along, or the job
// stops before it runs, and nothing under heavyNoShip (~/data) ever leaves. The real CLI, with a real worker behind an
// argv that stands in for ssh, as in heavy-back.test.ts.
const CLI = join(import.meta.dir, "../src/cli.ts");
let state: ReturnType<typeof withState>;
let home: string;
let other: string;

const helper = (): string[] => {
  const dir = join(state.dir, "helper");
  mkdirSync(join(dir, "home"), { recursive: true });
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ stateDir: join(dir, "state"), heavyHoldDir: join(dir, "hold"), heavyMaxLoad: 1e9, heavyQueue: { exec: true, execMaxMin: 5, jobDir: join(dir, "jobs") } }));
  const own = Object.entries(process.env).map(([k, v]) => `${k}=${v}`);
  return ["env", "-i", ...own, `HOME=${join(dir, "home")}`, `DORI_CONFIG=${config}`, `DORI_ENV_FILE=${join(dir, "none.env")}`, process.execPath, CLI, "heavy-worker", "--caller", "tester"];
};

// dori heavy t --kind cpu --sync <other> [extra] -- sh -c 'echo ran > ran.txt', run in cwd with one helper configured; where it runs is the scheduler's choice
const heavy = async (cwd: string, extra: string[] = [], settings: Record<string, unknown> = {}): Promise<{ code: number; err: string }> => {
  const config = join(state.dir, "config.json");
  writeFileSync(config, JSON.stringify({ stateDir: join(state.dir, "state"), heavyHoldDir: join(state.dir, "hold"), heavyMaxLoad: 1e9, heavyQueue: { helpers: [{ name: "second", ssh: helper() }] }, ...settings }));
  const own = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("DORI_")));
  const p = Bun.spawn([process.execPath, CLI, "heavy", "t", "--kind", "cpu", "--sync", other, ...extra, "--", "sh", "-c", "echo ran > ran.txt"], { cwd, env: { ...own, HOME: home, DORI_CONFIG: config, DORI_ENV_FILE: join(state.dir, "none.env"), DORI_STATE_DIR: join(state.dir, "state") }, stdout: "pipe", stderr: "pipe" });
  const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
  return { code, err };
};

beforeEach(() => {
  state = withState();
  home = join(state.dir, "home");
  other = join(home, "other");
  mkdirSync(other, { recursive: true });
});
afterEach(() => state.done());

test("a working folder outside --sync goes along with the job instead of keeping it here (gongdori 2026-11-12)", async () => {
  const work = join(home, "Documents", "gongdori");
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "run.py"), "print(1)\n");
  const r = await heavy(work);
  expect(r.err).not.toContain(`HEAVY_LOCAL t: the working folder ${work} is not in a --sync path`);
  expect(r.err).toContain(`HEAVY_SHIP t: ${work} is not in a --sync path, so it goes along: 1 file(s), 9 bytes`);
  expect(r.code).toBe(0);
  expect(readFileSync(join(work, "ran.txt"), "utf8")).toBe("ran\n");
  expect(readFileSync(join(state.dir, "state", "heavy", "heavy.log"), "utf8")).toContain(`HEAVY_SHIP_FILE t: ${join(work, "run.py")} 9\n`);
}, 60_000);

test("--local runs it here on purpose, as before (HEAVY_LOCAL)", async () => {
  const work = join(home, "Documents", "gongdori");
  mkdirSync(work, { recursive: true });
  const r = await heavy(work, ["--local"]);
  expect(r.err).toContain(`HEAVY_LOCAL t: the working folder ${work} is not in a --sync path`);
  expect(r.code).toBe(0);
}, 60_000);

test("a working folder under ~/data never leaves: the job stops before it runs", async () => {
  const work = join(home, "data", "hr35_expert");
  mkdirSync(work, { recursive: true });
  const r = await heavy(work);
  expect(r.code).toBe(2);
  expect(r.err).toContain(`HEAVY_LOCAL_REFUSED t: the working folder ${work} is not in a --sync path; it is not sent along: ${work} is or holds ${join(home, "data")}, a heavyNoShip path that never leaves this host`);
  expect(existsSync(join(work, "ran.txt"))).toBe(false);
}, 60_000);

test("a working folder with a link into ~/data never leaves, nor one over heavyShipMaxMb", async () => {
  mkdirSync(join(home, "data"), { recursive: true });
  const work = join(home, "work");
  mkdirSync(work);
  symlinkSync(join(home, "data"), join(work, "raw"));
  const linked = await heavy(work);
  expect(linked.code).toBe(2);
  expect(linked.err).toContain(`it is not sent along: the link ${join(work, "raw")} leads into ${join(home, "data")}, a heavyNoShip path that never leaves this host`);
  const big = join(home, "big");
  mkdirSync(big);
  writeFileSync(join(big, "a.bin"), "x".repeat(2 * 1024 ** 2));
  const over = await heavy(big, [], { heavyShipMaxMb: 1 });
  expect(over.code).toBe(2);
  expect(over.err).toContain(`it is not sent along: ${big} holds over 1M (heavyShipMaxMb); give the folders it needs with --sync instead; it did not run (--local runs it on this host)`);
  expect(existsSync(join(work, "ran.txt")) || existsSync(join(big, "ran.txt"))).toBe(false);
}, 60_000);

// review 1 of #479
test("--local runs a job here even when its plan could go to a preferred helper, which is never contacted", async () => {
  const contacted = join(state.dir, "contacted");
  const r = await heavy(other, ["--local"], { heavyQueue: { helpers: [{ name: "second", ssh: ["sh", "-c", `touch ${contacted}; exit 255`], prefer: ["cpu"] }] } });
  expect(r.code).toBe(0);
  expect(existsSync(contacted)).toBe(false);
  expect(readFileSync(join(other, "ran.txt"), "utf8")).toBe("ran\n");
}, 60_000);

test("a batch kept off this host is not refused for this host's memory: its helpers weigh their own", async () => {
  writeFileSync(join(state.dir, "items.txt"), "1\n");
  const r = await heavy(other, ["--items", join(state.dir, "items.txt"), "--on", "second", "--mem-per-worker", "100000G", "--out", join(state.dir, "out")]);
  expect(r.err).not.toContain("HEAVY_REFUSED t:");
  expect(r.err).toContain("HEAVY_BATCH_ITEM t #1 -: no host left");
  expect(r.code).toBe(1);
}, 60_000);

const job = (cmd: string[]): SpreadJob => ({ label: "t", kind: "cpu", cmd, cwd: other, sync: [other], env: {} });
const who = { uid: process.getuid?.() ?? -1, home: homedir() };

// review 3 of #479: a helper gets only what is declared (--sync) and the working folder; a path the command names outside
// --sync is never sent by guess, the job stops and names the --sync to add (lead 2026-11-14, Bazel and GNU parallel too)
test("a file outside --sync the command names is never sent: the job stops and says which --sync to add", () => {
  const files = [1, 2].map((i) => join(home, `in${i}`, "x.txt"));
  for (const p of files) {
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, "x\n");
  }
  expect(shipMissing(job(["cat", ...files]), who, [], 1024 ** 3)).toMatchObject({ refuse: true, why: expect.stringContaining(`(add --sync ${files[0]})`) });
  expect(shipMissing(job(["touch", join(home, "later", "new.txt")]), who, [], 1024 ** 3)).toMatchObject({ refuse: true, why: expect.stringContaining(`(add --sync ${join(home, "later", "new.txt")})`) });
});

test("a path cut out of an argument (at a space or a :) stops the job, whether its cut-off start exists or not", () => {
  mkdirSync(join(home, "x"));
  const named = join(home, "x", "input:part.txt");
  writeFileSync(named, "this\n");
  expect(shipMissing(job(["cat", named]), who, [], 1024 ** 3)).toMatchObject({ refuse: true, why: expect.stringContaining(`(add --sync ${named})`) });
  writeFileSync(join(home, "x", "input"), "not this\n");
  expect(shipMissing(job(["cat", named]), who, [], 1024 ** 3)).toMatchObject({ refuse: true });
  writeFileSync(join(home, "x", "input file.txt"), "this\n");
  expect(shipMissing(job(["cat", join(home, "x", "input file.txt")]), who, [], 1024 ** 3)).toMatchObject({ refuse: true });
});

test("an argument whose covered prefix is the working folder sent along still stops the job (challenge of #479 r4)", () => {
  const p = join(home, "input");
  mkdirSync(p);
  writeFileSync(`${p}:part.txt`, "this\n");
  expect(shipMissing({ ...job(["cat", `${p}:part.txt`]), cwd: p, sync: [] }, who, [], 1024 ** 3)).toMatchObject({ refuse: true, why: expect.stringContaining(`(add --sync ${p}:part.txt)`) });
});

test("a path outside home and /tmp stops the job, named in the command or given with --sync itself", () => {
  const p = `/var/tmp/heavy-ship-test-${process.pid}.txt`;
  writeFileSync(p, "input\n");
  try {
    // the fix line must be one that works: --sync cannot take this path either (challenge of #479 r5)
    const where = "only paths in your home or /tmp go to a helper: copy it there and give that with --sync, or run it here with --local";
    expect(shipMissing(job(["cat", p]), who, [], 1024 ** 3)).toMatchObject({ refuse: true, why: expect.stringContaining(where) });
    expect(shipMissing(job(["cat", p]), who, [], 1024 ** 3)).not.toMatchObject({ why: expect.stringContaining("add --sync") });
    expect(shipMissing({ ...job(["cat", p]), sync: [other, p] }, who, [], 1024 ** 3)).toMatchObject({ refuse: true, why: expect.stringContaining(`--sync ${p} must be a folder or file inside your home or /tmp; ${where}`) });
  } finally {
    rmSync(p, { force: true });
  }
});

test("a working folder holding a file or folder that cannot be read stops the job with why", () => {
  const work = join(home, "shut");
  mkdirSync(join(work, "in"), { recursive: true });
  writeFileSync(join(work, "x.txt"), "x\n");
  chmodSync(join(work, "x.txt"), 0o000);
  try {
    expect(shipMissing({ ...job(["true"]), cwd: work }, who, [], 1024 ** 3)).toMatchObject({ refuse: true, why: expect.stringContaining(`could not be read here to send it along (EACCES at ${join(work, "x.txt")})`) });
    chmodSync(join(work, "x.txt"), 0o644);
    chmodSync(join(work, "in"), 0o000);
    expect(shipMissing({ ...job(["true"]), cwd: work }, who, [], 1024 ** 3)).toMatchObject({ refuse: true, why: expect.stringContaining(`could not be read here to send it along (EACCES at ${join(work, "in")})`) });
  } finally {
    chmodSync(join(work, "x.txt"), 0o644);
    chmodSync(join(work, "in"), 0o755);
  }
});

test("a folder marked .dori-heavy-local stays here, with or without --sync, before anything of it is weighed", async () => {
  const work = join(home, "marked");
  mkdirSync(work);
  writeFileSync(join(work, ".dori-heavy-local"), "keep here\n");
  writeFileSync(join(work, "a.bin"), "x".repeat(2 * 1024 ** 2));
  expect(shipMissing({ ...job(["true"]), cwd: work, sync: [] }, who, [], 1)).toMatchObject({ refuse: false, why: `${join(work, ".dori-heavy-local")}: keep here` });
  const r = await heavy(work, [], { heavyShipMaxMb: 1 });
  expect(r.err).toContain(`HEAVY_LOCAL t: ${join(work, ".dori-heavy-local")}: keep here`);
  expect(r.code).toBe(0);
}, 60_000);

// review 4 of #479: only --sync and the working folder go (the lead's preset fallback); a checkout is never picked for the user
test("a working folder inside a git checkout --sync leaves out stops the job and names the checkout's --sync, with or without --sync", () => {
  const repo = join(home, "repo");
  mkdirSync(join(repo, "sub"), { recursive: true });
  writeFileSync(join(repo, "README"), "r\n");
  Bun.spawnSync(["git", "init", "-q", repo]);
  for (const sync of [[other], []]) expect(shipMissing({ ...job(["true"]), cwd: join(repo, "sub"), sync }, who, [], 1024 ** 3)).toMatchObject({ refuse: true, why: expect.stringContaining(`(add --sync ${repo})`) });
});

test("a marker in an outer --sync folder keeps the job here whichever order the --sync paths come in", () => {
  const p = join(home, "p");
  mkdirSync(join(p, "sub"), { recursive: true });
  writeFileSync(join(p, ".dori-heavy-local"), "keep here\n");
  for (const sync of [[join(p, "sub"), p], [p, join(p, "sub")]]) expect(shipMissing({ ...job(["true"]), cwd: join(p, "sub"), sync }, who, [], 1024 ** 3)).toMatchObject({ refuse: false, why: `${join(p, ".dori-heavy-local")}: keep here` });
});

test("a path with : or a space given with --sync runs, whether its cut-off start exists or not", () => {
  mkdirSync(join(home, "in"));
  for (const name of ["input:part.txt", "input file.txt"]) {
    const named = join(home, "in", name);
    writeFileSync(named, "this\n");
    for (const prefix of [false, true]) {
      if (prefix) writeFileSync(join(home, "in", "input"), "not this\n");
      const s = shipMissing({ ...job(["cat", named]), sync: [other, named] }, who, [], 1024 ** 3);
      if (!("plan" in s)) throw new Error(`${name} prefix=${prefix}: ${s.why}`);
      expect(s.shipped).toEqual([]);
      rmSync(join(home, "in", "input"), { force: true });
    }
  }
});
