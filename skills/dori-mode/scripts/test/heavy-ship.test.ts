import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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
  expect(over.err).toContain(`it is not sent along: ${big} holds over 1M (heavyShipMaxMb); it did not run: give that path with --sync, or run it on this host with --local`);
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

test("every file outside --sync the command names goes along, five as well as one", () => {
  const files = [1, 2, 3, 4, 5].map((i) => join(home, `in${i}`, "x.txt"));
  for (const p of files) {
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, "x\n");
  }
  const s = shipMissing(job(["cat", ...files]), who, [], 1024 ** 3);
  if (!("plan" in s)) throw new Error(s.why);
  expect([...s.shipped].sort()).toEqual([...files].sort());
});

test("a path outside --sync that does not exist yet, or cannot be read, stops the job with why", () => {
  const made = shipMissing(job(["touch", join(home, "later", "new.txt")]), who, [], 1024 ** 3);
  expect(made).toMatchObject({ refuse: true, why: expect.stringContaining(`${join(home, "later", "new.txt")} does not exist on this host`) });
  mkdirSync(join(home, "locked", "in"), { recursive: true });
  chmodSync(join(home, "locked"), 0o000);
  try {
    const shut = shipMissing(job(["cat", join(home, "locked", "in", "x.txt")]), who, [], 1024 ** 3);
    expect(shut).toMatchObject({ refuse: true, why: expect.stringMatching(/could not be read here to send it along \(E/) });
  } finally {
    chmodSync(join(home, "locked"), 0o755);
  }
});

// review 2 of #479
test("a file outside --sync that cannot be read stops the job with why, though its folder can be", () => {
  const p = join(home, "shut", "x.txt");
  mkdirSync(join(home, "shut"));
  writeFileSync(p, "x\n");
  chmodSync(p, 0o000);
  try {
    expect(shipMissing(job(["cat", p]), who, [], 1024 ** 3)).toMatchObject({ refuse: true, why: expect.stringContaining(`could not be read here to send it along (EACCES at ${p})`) });
  } finally {
    chmodSync(p, 0o644);
  }
});

test("a path with a space is never sent along by its cut-off start, even when that start exists", () => {
  mkdirSync(join(home, "in"));
  writeFileSync(join(home, "in", "input"), "not this\n");
  writeFileSync(join(home, "in", "input file.txt"), "this\n");
  const s = shipMissing(job(["cat", join(home, "in", "input file.txt")]), who, [], 1024 ** 3);
  expect(s).toMatchObject({ refuse: false, why: expect.stringContaining("is not in a --sync path") });
});

test("a working folder that says it runs here (.dori-heavy-local) stays here before anything of it is weighed for sending", async () => {
  const work = join(home, "big-local");
  mkdirSync(work);
  writeFileSync(join(work, ".dori-heavy-local"), "keep here\n");
  writeFileSync(join(work, "a.bin"), "x".repeat(2 * 1024 ** 2));
  const r = await heavy(work, [], { heavyShipMaxMb: 1 });
  expect(r.err).toContain(`HEAVY_LOCAL t: ${join(work, ".dori-heavy-local")}: keep here`);
  expect(r.err).not.toContain("HEAVY_LOCAL_REFUSED");
  expect(r.code).toBe(0);
}, 60_000);

test("a working folder inside a git checkout --sync leaves out sends the whole checkout along, never part of it", () => {
  const repo = join(home, "repo");
  mkdirSync(join(repo, "sub"), { recursive: true });
  writeFileSync(join(repo, "README"), "r\n");
  Bun.spawnSync(["git", "init", "-q", repo]);
  const s = shipMissing({ ...job(["true"]), cwd: join(repo, "sub") }, who, [], 1024 ** 3);
  if (!("plan" in s)) throw new Error(s.why);
  expect(s.shipped).toEqual([repo]);
});
