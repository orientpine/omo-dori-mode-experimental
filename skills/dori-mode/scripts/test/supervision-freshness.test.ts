import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Lane } from "../src/registry.ts";
import { defaultSupervision } from "../src/supervision.ts";
import { claimDone, closeLane, watchTick } from "../src/done-flow.ts";
import { takeLock } from "../src/checkpoints.ts";
import { freshnessTick } from "../src/freshness.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

describe("supervision in the freshness sweep and the close", () => {
  const T0 = Date.parse("2026-01-01T12:00:00.000Z");
  const working: Lane = { key: "quiet-lane", title: "quiet", thread: "none", pane: "w:p7", brief: "/b.md", done: "merged acme/app#1", openedAt: new Date(T0).toISOString(), lastReplyAt: T0 };
  const typed = (calls: string[][], pane: string): string[] => calls.flatMap((c) => (c[0] === "herdr" && c[2] === "send-text" && c[3] === pane ? [c[4] ?? ""] : []));

  test("a lane at its cap: freshness tells the lead once and types nothing into the lane", async () => {
    const state = withState();
    try {
      const world = newWorld();
      const deps = (ms: number) => depsFor(world, fakeClock(ms), state.dir, { nudgeAfterMin: 999, supervision: { ...defaultSupervision(), defaults: { wallMinutes: 5 } } });
      await deps(T0).registry.write(working);
      expect((await freshnessTick(deps(T0 + 4 * 60_000), "/home/test")).filter((a) => a.kind === "lane_cap")).toEqual([]);
      const capped = (await freshnessTick(deps(T0 + 6 * 60_000), "/home/test")).filter((a) => a.kind === "lane_cap");
      expect(capped.map((a) => [a.lane, a.detail.split(";")[0]])).toEqual([["quiet-lane", "wallMinutes ceiling reached (5)"]]);
      expect(typed(world.calls, "lead:p1").filter((t) => t.startsWith("[DORI] quiet-lane: wallMinutes ceiling reached (5)"))).toHaveLength(1);
      expect((await freshnessTick(deps(T0 + 7 * 60_000), "/home/test")).filter((a) => a.kind === "lane_cap")).toEqual([]);
      expect(typed(world.calls, "w:p7")).toEqual([]);
      expect(world.calls.some((c) => c.includes("close") || c.includes("kill"))).toBe(false);
    } finally { state.done(); }
  });

  test("a lane told not done is still swept: its cap reaches the lead", async () => {
    const state = withState();
    try {
      const world = newWorld();
      const deps = depsFor(world, fakeClock(T0 + 6 * 60_000), state.dir, { nudgeAfterMin: 999, supervision: { ...defaultSupervision(), defaults: { wallMinutes: 5 } } });
      await deps.registry.write({ ...working, status: "not-done" });
      expect((await freshnessTick(deps, "/home/test")).filter((a) => a.kind === "lane_cap").map((a) => a.detail.split(";")[0])).toEqual(["wallMinutes ceiling reached (5)"]);
    } finally { state.done(); }
  });

  test("a lane told not done that keeps reporting is not called hung: its new report counts as progress", async () => {
    const state = withState();
    try {
      const world = newWorld();
      const deps = (ms: number) => depsFor(world, fakeClock(ms), state.dir, { nudgeAfterMin: 999 });
      await deps(T0).registry.write({ ...working, status: "not-done", lastReport: "[REPORT] quiet-lane | milestone | first" });
      world.screens["w:p7"] = "── • Running bash (21m 0s • esc to interrupt) ──\n❯ ";
      world.screens["lead:p1"] = " [REPORT] quiet-lane | milestone | first\n❯ ";
      await freshnessTick(deps(T0), "/home/test");
      world.screens["w:p7"] = "── • Running bash (41m 0s • esc to interrupt) ──\n❯ ";
      world.screens["lead:p1"] = " [REPORT] quiet-lane | milestone | first\n [REPORT] quiet-lane | milestone | objection fixed, rerunning the checks\n❯ ";
      expect((await freshnessTick(deps(T0 + 20 * 60_000), "/home/test")).filter((a) => a.kind === "stalled")).toEqual([]);
      expect((await deps(T0).registry.read("quiet-lane"))?.lastReport).toContain("objection fixed");
    } finally { state.done(); }
  });

  test("with no lead pane the cap note counts as not sent: once a lead pane is set, it goes out", async () => {
    const state = withState();
    try {
      const world = newWorld();
      const deps = (ms: number, leadPane: string) => depsFor(world, fakeClock(ms), state.dir, { leadPane, nudgeAfterMin: 999, supervision: { ...defaultSupervision(), defaults: { wallMinutes: 5 } } });
      await deps(T0, "").registry.write(working);
      const first = (await freshnessTick(deps(T0 + 6 * 60_000, ""), "/home/test")).filter((a) => a.kind === "lane_cap");
      expect(first.map((a) => a.detail)).toEqual(["wallMinutes ceiling reached (5); lead not told: leadPane is not configured; sent again next sweep"]);
      const second = (await freshnessTick(deps(T0 + 7 * 60_000, "lead:p1"), "/home/test")).filter((a) => a.kind === "lane_cap");
      expect(second.map((a) => a.detail)).toEqual(["wallMinutes ceiling reached (5); lead told"]);
    } finally { state.done(); }
  });

  test("with no supervision config nothing is capped, however long the lane runs", async () => {
    const state = withState();
    try {
      const world = newWorld();
      const deps = depsFor(world, fakeClock(T0 + 30 * 24 * 60 * 60_000), state.dir, { nudgeAfterMin: 999_999 });
      await deps.registry.write(working);
      expect((await freshnessTick(deps, "/home/test")).filter((a) => ["lane_cap", "usage_unknown", "supervision_error"].includes(a.kind))).toEqual([]);
    } finally { state.done(); }
  });

  test("an unreadable supervision state is started over and said once; the lane stays supervised", async () => {
    const state = withState();
    try {
      const world = newWorld();
      const deps = depsFor(world, fakeClock(T0), state.dir, { nudgeAfterMin: 999 });
      await deps.registry.write(working);
      const path = join(state.dir, "lane-state", "quiet-lane", "supervision.json");
      mkdirSync(join(state.dir, "lane-state", "quiet-lane"), { recursive: true });
      writeFileSync(path, "{not json");
      expect((await freshnessTick(deps, "/home/test")).map((a) => a.kind)).toEqual(["supervision_error"]);
      expect(JSON.parse(readFileSync(path, "utf8")).alerts).toEqual([]);
      expect(await freshnessTick(deps, "/home/test")).toEqual([]);
    } finally { state.done(); }
  });

  test("a close refused after its Done signals (no summary for a thread) records no cost; the close that goes through takes the reading then", async () => {
    const state = withState();
    try {
      const world = newWorld();
      const deps = depsFor(world, fakeClock(T0), state.dir);
      const threaded = { ...working, thread: "discord:1566844859174756462" };
      await deps.registry.write(threaded);
      const refused = await closeLane(deps, threaded, "verified");
      expect(refused.closed).toBe(false);
      expect(refused.lines.some((l) => l.startsWith("COST "))).toBe(false);
      expect(existsSync(join(state.dir, "lane-state", "quiet-lane", "cost.jsonl"))).toBe(false);
      const closed = await closeLane(deps, working, "verified");
      expect(closed.closed).toBe(true);
      expect(closed.lines).toContain("COST quiet-lane tokens=unknown costUsd=unknown");
    } finally { state.done(); }
  });

  test("a close that finds another close taking the cost tears nothing down; once that one is gone the close goes through", async () => {
    const state = withState();
    try {
      const world = newWorld();
      const deps = depsFor(world, fakeClock(T0), state.dir);
      await deps.registry.write(working);
      const dir = join(state.dir, "lane-state", "quiet-lane");
      mkdirSync(dir, { recursive: true });
      const held = takeLock(join(dir, "cost.lock"), T0, "cost record", "quiet-lane");
      const busy = await closeLane(deps, working, "verified");
      expect(busy.closed).toBe(false);
      expect(busy.lines.at(-1)).toStartWith("CLOSE_IN_PROGRESS quiet-lane: cost record locked: quiet-lane");
      expect(world.calls.some((c) => c.includes("close") || (c.includes("worktree") && c.includes("remove")))).toBe(false);
      expect((await deps.registry.read("quiet-lane"))?.status).not.toBe("closed");
      held();
      const closed = await closeLane(deps, working, "verified");
      expect(closed.closed).toBe(true);
      expect(closed.lines).toContain("COST quiet-lane tokens=unknown costUsd=unknown");
    } finally { state.done(); }
  });

  test("the watcher's close that finds a manual close taking the cost leaves the lane to it and does not tell the lane it is not done", async () => {
    const state = withState();
    try {
      const world = newWorld();
      const at = (ms: number) => depsFor(world, fakeClock(ms), state.dir);
      const claimed = { ...working, done: "file /etc/hostname" };
      await at(T0).registry.write(claimed);
      await claimDone(at(T0), claimed, "file written");
      const dir = join(state.dir, "lane-state", "quiet-lane");
      mkdirSync(dir, { recursive: true });
      const held = takeLock(join(dir, "cost.lock"), T0, "cost record", "quiet-lane");
      const sent = world.calls.length;
      const lines = await watchTick(at(T0 + 5 * 60_000 + 1));
      held();
      expect(lines.some((l) => l.startsWith("CLOSE_IN_PROGRESS quiet-lane"))).toBe(true);
      expect(lines.some((l) => l.startsWith("LANE_CLOSED") || l.startsWith("NOT_DONE"))).toBe(false);
      expect(typed(world.calls.slice(sent), "w:p7")).toEqual([]);
      expect(world.calls.slice(sent).some((c) => c.includes("close") || (c.includes("worktree") && c.includes("remove")))).toBe(false);
      expect((await at(T0).registry.read("quiet-lane"))?.status).toBe("verified-done");
    } finally { state.done(); }
  });

  test("an automatic close by the watcher prints the lane's COST line too", async () => {
    const state = withState();
    try {
      const world = newWorld();
      const at = (ms: number) => depsFor(world, fakeClock(ms), state.dir);
      const claimed = { ...working, done: "file /etc/hostname" };
      await at(T0).registry.write(claimed);
      await claimDone(at(T0), claimed, "file written");
      const lines = await watchTick(at(T0 + 5 * 60_000 + 1));
      expect(lines.at(-1)).toStartWith("LANE_CLOSED quiet-lane");
      expect(lines).toContain("COST quiet-lane tokens=unknown costUsd=unknown");
    } finally { state.done(); }
  });

  test("a close prints the lane's cost and records it once", async () => {
    const state = withState();
    try {
      const world = newWorld();
      const deps = depsFor(world, fakeClock(T0), state.dir);
      await deps.registry.write(working);
      const r = await closeLane(deps, working, "verified");
      expect(r.lines).toContain("COST quiet-lane tokens=unknown costUsd=unknown");
      const stored = readFileSync(join(state.dir, "lane-state", "quiet-lane", "cost.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ key: "quiet-lane", tokens: null, costUsd: null, final: true });
    } finally { state.done(); }
  });
});
