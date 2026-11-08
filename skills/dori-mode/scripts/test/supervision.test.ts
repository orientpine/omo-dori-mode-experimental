import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Checkpoints } from "../src/checkpoints.ts";
import { sessionDirFor } from "../src/session-id.ts";
import { HUNG_MESSAGE, laneSessionUsage, Supervision, transcriptUsage, workingTimer } from "../src/supervision.ts";
import { withState } from "./fakes.ts";
import { fixture, lane } from "./supervision-setup.ts";

describe("supervision", () => {
  // upstream: "legacy lanes perform no commands or state writes"
  test("a lane that is not working, or has no pane, is not supervised: no commands, no state writes", async () => {
    const f = fixture({ usageArgv: ["usage"], defaults: { wallMinutes: 0 } });
    try {
      for (const off of [{ ...lane, status: "done-claimed" as const }, { ...lane, status: "paused" as const }, { ...lane, pane: undefined }]) {
        expect((await f.supervisor.sweep(off, "Working 40m")).enabled).toBe(false);
      }
      expect(f.calls).toEqual([]);
      expect(f.alerts).toEqual([]);
      expect(existsSync(join(f.dir, "lane-state"))).toBe(false);
    } finally { f.done(); }
  });

  test("with no caps and no usage hook a sweep runs no usage command and writes no cost record", async () => {
    const f = fixture();
    try {
      f.setSession({ session: "/s/a.jsonl", tokens: 5, costUsd: 1 });
      expect((await f.supervisor.sweep(lane, "")).usage).toBeNull();
      expect(f.calls).toEqual([]);
      expect(existsSync(join(f.dir, "lane-state", lane.key, "cost.jsonl"))).toBe(false);
    } finally { f.done(); }
  });

  test("growing same timer requires persisted observations and fresh-activity grace", async () => {
    const f = fixture();
    try {
      expect((await f.supervisor.sweep(lane, "Working (21m 0s)")).alerts).toEqual([]);
      f.clock.at += 20 * 60_000;
      const restarted = new Supervision(f.deps, f.options);
      const hung = await restarted.sweep(lane, "Working (41m 0s)");
      expect(hung.hung).toBe(true);
      expect(hung.alerts).toEqual([HUNG_MESSAGE]);
      expect(f.alerts).toHaveLength(1);
      f.clock.at += 60_000;
      expect((await restarted.sweep(lane, "Working (42m 0s)")).alerts).toEqual([]);
      expect(f.alerts).toHaveLength(1);
      expect(f.calls.some((args) => /kill|send-text|send-keys/.test(args.join(" ")))).toBe(false);
    } finally { f.done(); }
  });

  test("timer reset, frozen timer, and changed timer origin do not mark hung", async () => {
    const f = fixture({ staleAfterMinutes: 0 });
    try {
      await f.supervisor.sweep(lane, "Working 25m");
      f.clock.at += 60_000;
      expect((await f.supervisor.sweep(lane, "Working 25m")).alerts).toEqual([]);
      f.clock.at += 60_000;
      expect((await f.supervisor.sweep(lane, "Working 1m")).alerts).toEqual([]);
      f.clock.at += 60_000;
      expect((await f.supervisor.sweep(lane, "Working 30m")).alerts).toEqual([]);
      f.clock.at += 60_000;
      expect((await f.supervisor.sweep(lane, "Running 31m")).alerts).toEqual([]);
    } finally { f.done(); }
  });

  test("a minute-rounded timer is hung even when sweeps do not line up with its minute boundary", async () => {
    const f = fixture({ staleAfterMinutes: 0 });
    try {
      await f.supervisor.sweep(lane, "Working 25m");
      f.clock.at += 90_000; // the real timer went 25m10s -> 26m40s and shows 26m
      expect((await f.supervisor.sweep(lane, "Working 26m")).hung).toBe(true);
    } finally { f.done(); }
  });

  test("hungAfterMinutes 0 turns hung detection off", async () => {
    const f = fixture({ hungAfterMinutes: 0, staleAfterMinutes: 0 });
    try {
      await f.supervisor.sweep(lane, "Working 25m");
      f.clock.at += 60_000;
      expect((await f.supervisor.sweep(lane, "Working 26m")).hung).toBe(false);
    } finally { f.done(); }
  });

  test("report and checkpoint progress suppress hung detection until stale", async () => {
    const f = fixture();
    try {
      await f.supervisor.sweep({ ...lane, lastReport: "[REPORT] demo-lane | milestone | starting" }, "Working 21m");
      f.clock.at += 20 * 60_000;
      const progressed = { ...lane, lastReport: "[REPORT] demo-lane | milestone | progress" };
      expect((await f.supervisor.sweep(progressed, "Working 41m")).hung).toBe(false);
      f.clock.at += 20 * 60_000;
      new Checkpoints(f.dir).write(lane.key, { step: "build", result: "ok", evidence: [], remoteEffects: [] }, f.clock.now());
      expect((await f.supervisor.sweep(progressed, "Working 61m")).hung).toBe(false);
      f.clock.at += 20 * 60_000;
      expect((await f.supervisor.sweep(progressed, "Working 81m")).hung).toBe(true);
    } finally { f.done(); }
  });

  test("an explicit activity file that is a symlink: writes through the unchanged link count as progress", async () => {
    const f = fixture();
    try {
      const target = join(f.dir, "train.log");
      writeFileSync(target, "step 1\n");
      symlinkSync(target, join(f.dir, "latest.log"));
      const activeLane = { ...lane, cwd: f.dir, activityPaths: ["latest.log"] };
      await f.supervisor.sweep(activeLane, "Running 21m");
      f.clock.at += 20 * 60_000;
      appendFileSync(target, "step 2\n");
      expect((await f.supervisor.sweep(activeLane, "Running 41m")).hung).toBe(false);
      f.clock.at += 20 * 60_000;
      expect((await f.supervisor.sweep(activeLane, "Running 61m")).hung).toBe(true);
    } finally { f.done(); }
  });

  test("explicit file and git changed-file activity suppress stalls without scanning", async () => {
    const f = fixture();
    try {
      const path = join(f.dir, "source.ts");
      writeFileSync(path, "first");
      const activeLane = { ...lane, cwd: f.dir, activityPaths: [path] };
      await f.supervisor.sweep(activeLane, "Running 21m");
      f.clock.at += 20 * 60_000;
      utimesSync(path, new Date(f.clock.at), new Date(f.clock.at));
      expect((await f.supervisor.sweep(activeLane, "Running 41m")).hung).toBe(false);
      f.clock.at += 20 * 60_000;
      f.setDirty(" M source.ts\0?? node_modules/\0");
      expect((await f.supervisor.sweep(activeLane, "Running 61m")).hung).toBe(false);
      f.clock.at += 20 * 60_000;
      expect((await f.supervisor.sweep(activeLane, "Running 81m")).hung).toBe(true);
      f.clock.at += 60_000;
      utimesSync(path, new Date(f.clock.at), new Date(f.clock.at));
      expect((await f.supervisor.sweep(activeLane, "Running 82m")).hung).toBe(false);
      expect(f.calls.every((args) => args[0] === "git")).toBe(true);
    } finally { f.done(); }
  });

  test("changes under node_modules or outside the lane's cwd are not activity", async () => {
    const f = fixture();
    try {
      const activeLane = { ...lane, cwd: f.dir };
      f.setDirty(" M node_modules/a/index.js\0");
      await f.supervisor.sweep(activeLane, "Running 21m");
      f.clock.at += 20 * 60_000;
      f.setDirty(" M node_modules/b/index.js\0 M ../elsewhere.ts\0");
      expect((await f.supervisor.sweep(activeLane, "Running 41m")).hung).toBe(true);
    } finally { f.done(); }
  });

  test("parses visible timer variants but not unrelated or absent durations", () => {
    expect(workingTimer("\x1b[32m* Working (1h 2m 3s)\x1b[0m")).toEqual({ kind: "working", seconds: 3723, step: 1 });
    expect(workingTimer("Running 21:05")).toEqual({ kind: "running", seconds: 1265, step: 1 });
    expect(workingTimer("Working 25m")).toEqual({ kind: "working", seconds: 1500, step: 60 });
    expect(workingTimer("Running 1:02:03")).toEqual({ kind: "running", seconds: 3723, step: 1 });
    expect(workingTimer("── • Running bash (2m 5s • esc to interrupt) ──")).toEqual({ kind: "running", seconds: 125, step: 1 });
    expect(workingTimer("Working ...")).toBeNull();
    expect(workingTimer("log mentions Working 20m")).toBeNull();
  });
});

describe("usage from the lane's omo transcript", () => {
  const turn = (at: string, tokens: number, cost?: number) =>
    JSON.stringify({ type: "message", timestamp: at, message: { role: "assistant", usage: { totalTokens: tokens, ...(cost === undefined ? {} : { cost: { total: cost } }) } } });

  test("sums the assistant turns since the lane opened; a turn without a cost leaves the cost unknown", () => {
    const text = [turn("2026-10-28T23:00:00Z", 999, 9), turn("2026-10-29T00:01:00Z", 100, 0.5), JSON.stringify({ type: "message", timestamp: "2026-10-29T00:02:00Z", message: { role: "user", usage: { totalTokens: 7 } } }), turn("2026-10-29T00:03:00Z", 50, 0.25), "{\"usage\": broken"].join("\n");
    expect(transcriptUsage(text, lane.openedAt)).toEqual({ tokens: 150, costUsd: 0.75 });
    expect(transcriptUsage([text, turn("2026-10-29T00:04:00Z", 10)].join("\n"), lane.openedAt)).toEqual({ tokens: 160, costUsd: null });
  });

  test("every session the lane had counts, read whole from its transcript; a session with no transcript leaves the usage unknown", async () => {
    const state = withState();
    try {
      const sessionsDir = join(state.dir, "sessions");
      const cwd = "/work/repo";
      const dir = sessionDirFor(sessionsDir, cwd);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "2026-10-29T00-00-00_old-1.jsonl"), [turn("2026-10-29T00:01:00Z", 200, 1), turn("2026-10-29T03:00:00Z", 50, 0.5)].join("\n"));
      writeFileSync(join(dir, "2026-10-29T04-00-00_new-2.jsonl"), turn("2026-10-29T04:01:00Z", 120, 0.25));
      const read = laneSessionUsage(async () => ({ code: 1, out: "", err: "" }), sessionsDir);
      const moved = { ...lane, cwd, session: "new-2", priorSessions: ["old-1"] };
      expect(await read(moved)).toEqual({ session: "old-1,new-2", tokens: 370, costUsd: 1.75 });
      expect(await read({ ...moved, priorSessions: ["gone-0", "old-1"] })).toBeNull();
      const f = fixture({ defaults: { tokens: 300 } });
      try {
        const capped = await new Supervision({ ...f.deps, sessionUsage: read }, f.options).sweep(moved, "");
        expect(capped.alerts).toEqual(["tokens ceiling reached (300)"]);
      } finally { f.done(); }
    } finally { state.done(); }
  });

  test("a lane whose cwd is a symlink: sessions filed under the written path and under its real path both count", async () => {
    const state = withState();
    try {
      const sessionsDir = join(state.dir, "sessions");
      const real = join(state.dir, "real-repo");
      const link = join(state.dir, "link-repo");
      mkdirSync(real, { recursive: true });
      symlinkSync(real, link);
      mkdirSync(sessionDirFor(sessionsDir, link), { recursive: true });
      mkdirSync(sessionDirFor(sessionsDir, real), { recursive: true });
      writeFileSync(join(sessionDirFor(sessionsDir, link), "a_old-1.jsonl"), turn("2026-10-29T00:01:00Z", 200, 1));
      writeFileSync(join(sessionDirFor(sessionsDir, real), "b_new-2.jsonl"), turn("2026-10-29T04:01:00Z", 120, 0.25));
      const read = laneSessionUsage(async () => ({ code: 1, out: "", err: "" }), sessionsDir);
      expect(await read({ ...lane, cwd: link, session: "new-2", priorSessions: ["old-1"] })).toEqual({ session: "old-1,new-2", tokens: 320, costUsd: 1.25 });
    } finally { state.done(); }
  });

  test("a session is found by its id wherever omo filed it: an adopted lane whose recorded cwd is not where it runs", async () => {
    const state = withState();
    try {
      const sessionsDir = join(state.dir, "sessions");
      mkdirSync(join(sessionsDir, "--home-me-project--"), { recursive: true });
      writeFileSync(join(sessionsDir, "--home-me-project--", "a_s9.jsonl"), turn("2026-10-29T00:01:00Z", 42, 0.5));
      const read = laneSessionUsage(async () => ({ code: 1, out: "", err: "" }), sessionsDir);
      expect(await read({ ...lane, cwd: "/home/me/default-cwd", session: "s9" })).toEqual({ session: "s9", tokens: 42, costUsd: 0.5 });
    } finally { state.done(); }
  });

  test("no transcript means unknown usage, and a token cap says it cannot be checked", async () => {
    const f = fixture({ defaults: { tokens: 300 } });
    try {
      expect((await f.supervisor.sweep(lane, "")).alerts).toEqual(["tokens ceiling cannot be checked: usage unavailable"]);
    } finally { f.done(); }
  });
});
