import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { type Lane, Registry } from "../src/registry.ts";
import { HUNG_MESSAGE, laneSessionUsage, Supervision, supervisionProblem } from "../src/supervision.ts";
import { keepSessions } from "../src/lane-handover.ts";
import { run } from "../src/run.ts";
import { withState } from "./fakes.ts";
import { fixture, lane } from "./supervision-setup.ts";

describe("supervision", () => {
  test("a lane working in a subdirectory of its repository: git's root-relative changed paths count as its activity", async () => {
    const f = fixture();
    try {
      const repo = join(f.dir, "repo");
      const file = join(repo, "sub", "a.ts");
      mkdirSync(join(repo, "sub"), { recursive: true });
      writeFileSync(file, "one");
      const git = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-C", repo, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
      git("init", "-q");
      git("add", ".");
      git("commit", "-qm", "one");
      writeFileSync(file, "two");
      const real = new Supervision({ ...f.deps, run }, f.options);
      const inSub = { ...lane, cwd: join(repo, "sub") };
      await real.sweep(inSub, "Running 21m");
      f.clock.at += 20 * 60_000;
      utimesSync(file, new Date(f.clock.at), new Date(f.clock.at));
      expect((await real.sweep(inSub, "Running 41m")).hung).toBe(false);
      f.clock.at += 20 * 60_000;
      expect((await real.sweep(inSub, "Running 61m")).hung).toBe(true);
    } finally { f.done(); }
  });

  test("a lane told not done keeps working and stays supervised: its cap and a hung call still reach the lead", async () => {
    const f = fixture({ defaults: { wallMinutes: 1 }, staleAfterMinutes: 0 });
    try {
      const rejected = { ...lane, status: "not-done" as const };
      f.clock.at += 2 * 60_000;
      expect((await f.supervisor.sweep(rejected, "Working 25m")).alerts).toEqual(["wallMinutes ceiling reached (1)"]);
      f.clock.at += 60_000;
      expect((await f.supervisor.sweep(rejected, "Working 26m")).alerts).toEqual([HUNG_MESSAGE]);
    } finally { f.done(); }
  });

  test("a file written inside an untracked directory counts as activity", async () => {
    const f = fixture();
    try {
      const repo = join(f.dir, "repo");
      mkdirSync(join(repo, "out"), { recursive: true });
      writeFileSync(join(repo, "a.ts"), "one");
      const git = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-C", repo, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
      git("init", "-q");
      git("add", "a.ts");
      git("commit", "-qm", "one");
      const log = join(repo, "out", "train.log");
      writeFileSync(log, "step 1\n");
      const real = new Supervision({ ...f.deps, run }, f.options);
      const working = { ...lane, cwd: repo };
      await real.sweep(working, "Running 21m");
      f.clock.at += 20 * 60_000;
      appendFileSync(log, "step 2\n");
      utimesSync(log, new Date(f.clock.at), new Date(f.clock.at));
      expect((await real.sweep(working, "Running 41m")).hung).toBe(false);
    } finally { f.done(); }
  });

  test("a lane whose cwd is a symlink into its repository: changes git prints under the real path count", async () => {
    const f = fixture();
    try {
      const repo = join(f.dir, "repo");
      mkdirSync(repo, { recursive: true });
      const file = join(repo, "a.ts");
      writeFileSync(file, "one");
      const git = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-C", repo, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
      git("init", "-q");
      git("add", ".");
      git("commit", "-qm", "one");
      writeFileSync(file, "two");
      const link = join(f.dir, "link");
      symlinkSync(repo, link);
      const real = new Supervision({ ...f.deps, run }, f.options);
      const linked = { ...lane, cwd: link };
      await real.sweep(linked, "Running 21m");
      f.clock.at += 20 * 60_000;
      utimesSync(file, new Date(f.clock.at), new Date(f.clock.at));
      expect((await real.sweep(linked, "Running 41m")).hung).toBe(false);
    } finally { f.done(); }
  });

  test("a lane that claimed done is not alerted on, even past its caps with a long timer", async () => {
    const f = fixture({ defaults: { wallMinutes: 0 }, staleAfterMinutes: 0 });
    try {
      const claimed = { ...lane, status: "done-claimed" as const };
      await f.supervisor.sweep(claimed, "Working 30m");
      f.clock.at += 60_000;
      expect((await f.supervisor.sweep(claimed, "Working 31m")).alerts).toEqual([]);
      expect(f.alerts).toEqual([]);
    } finally { f.done(); }
  });
});

describe("a lane's session history", () => {
  test("whatever path changes a lane's session, the registry keeps the outgoing one, once and in order", async () => {
    const state = withState();
    try {
      const registry = new Registry(state.dir);
      await registry.write({ ...lane, session: "s1" });
      await registry.patch(lane.key, { session: "s2" });
      await registry.write({ ...lane, session: "s3" });
      await registry.patch(lane.key, { lastReport: "[REPORT] demo-lane | milestone | x" });
      await registry.patch(lane.key, { session: "s1" });
      expect(await registry.read(lane.key)).toMatchObject({ session: "s1", priorSessions: ["s2", "s3"] });
    } finally { state.done(); }
  });
});

describe("a move whose new session is not known yet", () => {
  test("leaves the lane with no current session and its usage unknown, never the old transcript twice", async () => {
    const state = withState();
    try {
      const registry = new Registry(state.dir);
      await registry.write({ ...lane, session: "s1" });
      await keepSessions({ registry } as never, lane.key, "", "");
      const moved = await registry.read(lane.key);
      expect(moved?.session).toBeUndefined();
      expect(moved?.priorSessions).toEqual(["s1"]);
      const sessionsDir = join(state.dir, "sessions");
      mkdirSync(join(sessionsDir, "--work--"), { recursive: true });
      writeFileSync(join(sessionsDir, "--work--", "a_s1.jsonl"), JSON.stringify({ type: "message", timestamp: "2026-10-29T00:01:00Z", message: { role: "assistant", usage: { totalTokens: 100, cost: { total: 1 } } } }));
      expect(await laneSessionUsage(async () => ({ code: 1, out: "", err: "" }), sessionsDir)(moved as Lane)).toBeNull();
    } finally { state.done(); }
  });
});

describe("supervision config", () => {
  test("a misspelt or malformed supervision entry is refused by name, never dropped", async () => {
    expect(supervisionProblem(undefined)).toBeUndefined();
    expect(supervisionProblem({ defaults: { wallMinutes: 600, tokens: null }, lanes: { a: { costUsd: 5 } }, hungAfterMinutes: 0 })).toBeUndefined();
    expect(supervisionProblem({ defaults: { toknes: 5 } })).toContain("supervision.defaults.toknes is not a ceiling");
    expect(supervisionProblem({ lanes: { a: { costUSD: 1 } } })).toContain("supervision.lanes.a.costUSD is not a ceiling");
    expect(supervisionProblem({ lanes: { a: null } })).toContain("supervision.lanes.a must be an object");
    expect(supervisionProblem({ defaults: { wallMinutes: -1 } })).toContain("must be a number >= 0 or null");
    expect(supervisionProblem({ usageArgv: "usage" })).toContain("supervision.usageArgv must be a list of strings");
    expect(supervisionProblem({ hungAfter: 5 })).toContain("supervision.hungAfter is not a supervision setting");
    const state = withState();
    try {
      const path = join(state.dir, "config.json");
      writeFileSync(path, JSON.stringify({ supervision: { defaults: { toknes: 5 } } }));
      await expect(loadConfig(path, state.dir, () => {})).rejects.toThrow("invalid supervision.defaults.toknes is not a ceiling");
      writeFileSync(path, JSON.stringify({}));
      const config = await loadConfig(path, state.dir, () => {});
      expect(config.supervision.defaults).toEqual({ wallMinutes: null, tokens: null, costUsd: null });
      expect(config.supervision.hungAfterMinutes).toBe(20);
    } finally { state.done(); }
  });
});
