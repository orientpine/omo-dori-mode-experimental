import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { freshnessTick } from "../src/freshness.ts";
import { Reports } from "../src/reports.ts";
import { defaultSupervision } from "../src/supervision.ts";
import type { Lane } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const working: Lane = {
  key: "quiet-lane",
  title: "quiet",
  thread: "chat:team/1",
  pane: "w:p7",
  brief: "/b.md",
  done: "merged acme/app#1",
  openedAt: new Date(T0).toISOString(),
  lastReplyAt: T0,
};

const typed = (calls: string[][], pane: string): string[] => calls.flatMap((call) => (call[0] === "herdr" && call[2] === "send-text" && call[3] === pane ? [call[4] ?? ""] : []));

test("a paused structured lane has no freshness action or journal change", async () => {
  const state = withState();
  try {
    const world = newWorld();
    const deps = depsFor(world, fakeClock(T0 + 30 * 60_000), state.dir);
    await deps.registry.write({ ...working, reportProtocol: "jsonl-v1" });
    const reports = new Reports(state.dir);
    reports.report(working.key, "milestone", "old milestone", T0 - 60 * 60_000);
    await deps.registry.patch(working.key, { status: "paused", pausedFrom: "working" });
    world.screen = "❯ ";
    const before = readFileSync(reports.path(working.key), "utf8");
    expect(await freshnessTick(deps, "/home/test")).toEqual([]);
    expect(readFileSync(reports.path(working.key), "utf8")).toBe(before);
    expect(typed(world.calls, "w:p7")).toEqual([]);
  } finally { state.done(); }
});

test("a running lane becomes blocked at its cap without a nudge in that sweep", async () => {
  const state = withState();
  try {
    const world = newWorld();
    world.screen = "Working (1m)\n❯ ";
    const deps = depsFor(world, fakeClock(T0 + 6 * 60_000), state.dir, { nudgeAfterMin: 1, postAfterMin: 1, supervision: { ...defaultSupervision(), defaults: { wallMinutes: 5 } } });
    await deps.registry.write({ ...working, reportProtocol: "jsonl-v1" });
    const reports = new Reports(state.dir);
    reports.report(working.key, "milestone", "started", T0);
    const acts = await freshnessTick(deps, "/home/test");
    expect(acts.map((a) => a.kind)).toEqual(["lane_cap", "lead-told"]);
    expect(acts.filter((a) => a.kind === "nudged")).toEqual([]);
    expect(reports.read(working.key)?.state).toBe("blocked");
    expect(typed(world.calls, "w:p7")).toEqual([]);
  } finally { state.done(); }
});

test("a running lane becomes stalled without a nudge or relay in that sweep", async () => {
  const state = withState();
  try {
    const world = newWorld();
    const deps = (ms: number) => depsFor(world, fakeClock(ms), state.dir, { nudgeAfterMin: 1, postAfterMin: 1, supervision: { ...defaultSupervision(), hungAfterMinutes: 5, staleAfterMinutes: 1 } });
    await deps(T0).registry.write({ ...working, reportProtocol: "jsonl-v1" });
    const reports = new Reports(state.dir);
    reports.report(working.key, "milestone", "started", T0);
    world.screen = "── • Working bash (1m • esc to interrupt) ──\n❯ ";
    expect(await freshnessTick(deps(T0), "/home/test")).toEqual([]);
    world.screen = "── • Working bash (6m • esc to interrupt) ──\n❯ ";
    const acts = await freshnessTick(deps(T0 + 6 * 60_000), "/home/test");
    expect(acts.map((a) => a.kind)).toEqual(["stalled"]);
    expect(reports.read(working.key)?.state).toBe("stalled");
    expect(typed(world.calls, "w:p7")).toEqual([]);
  } finally { state.done(); }
});
