import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { closeLane } from "../src/done-flow.ts";
import { footer, LaunchError, setDone } from "../src/launch.ts";
import { formatLane, laneSignals } from "../src/lane-signals.ts";
import { type Lane, statusOf } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, sent, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const OLD = "closed acme/app#2";
const NEW = "merged acme/app#1";

let state: ReturnType<typeof withState>;
let world: World;
let lane: Lane;
const deps = () => depsFor(world, fakeClock(T0), state.dir);

beforeEach(async () => {
  state = withState();
  world = newWorld();
  // the plan changed after launch: the issue the old Done line waits on stays open, the work landed in the PR
  world.issueState = "OPEN";
  lane = { key: "demo-lane", title: "demo", thread: "none", pane: "w:p1", brief: join(state.dir, "demo.md"), done: OLD, cwd: "/repo", openedAt: new Date(T0 - 60_000).toISOString() };
  writeFileSync(lane.brief, `do the work\n${footer(lane, "lead:p1")}`);
  await deps().registry.write(lane);
});
afterEach(() => state.done());

test("a changed Done line is read now, recorded with the old one, logged, written into the brief, and close then judges by it", async () => {
  expect((await closeLane(deps(), lane, "x")).closed).toBe(false);
  const lines = await setDone(deps(), lane, NEW, "plan changed: the work landed in PR 1");
  expect(lines[0]).toBe(`SIGNAL OK  ${NEW} -> MERGED abc1234567`);
  expect(lines.at(-1)).toStartWith("DONE_SET demo-lane live 1/1");
  const after = (await deps().registry.read("demo-lane")) as Lane;
  expect(after.done).toBe(NEW);
  expect(after.doneChanges).toEqual([{ at: new Date(T0).toISOString(), from: OLD, to: NEW, reason: "plan changed: the work landed in PR 1", live: true }]);
  expect(readFileSync(join(state.dir, "lanes.log"), "utf8")).toContain(`done-set DONE_SET demo-lane live 1/1; reason: plan changed: the work landed in PR 1; was: ${OLD}; now: ${NEW}`);
  const brief = readFileSync(lane.brief, "utf8");
  expect(brief).toContain(`- Done = ${NEW}. The lane closes only when every signal reads back live.`);
  expect(brief).toContain(`Earlier: Done = ${OLD}`);
  expect(brief).not.toContain(`- Done = ${OLD}.`);
  expect(sent(world).some((t) => t.startsWith("[LEAD] Done line changed for demo-lane"))).toBe(true);
  expect(lines).toContain("LANE_TOLD w:p1");
  expect(formatLane(laneSignals(after, undefined, deps().config)).join("\n")).toContain("Done changed 01-01 12:00 (live when set): plan changed: the work landed in PR 1");
  const closed = await closeLane(deps(), after, "x");
  expect(closed.closed).toBe(true);
  expect(statusOf((await deps().registry.read("demo-lane")) as Lane)).toBe("closed");
});

test("a new line that does not read back live is still recorded, and close keeps refusing until it does", async () => {
  world.prState = "OPEN";
  world.stuckReads = 99;
  const lines = await setDone(deps(), lane, NEW, "plan changed");
  expect(lines.at(-1)).toStartWith("DONE_SET demo-lane live 0/1: not every new signal reads back live yet");
  const after = (await deps().registry.read("demo-lane")) as Lane;
  expect(after.doneChanges?.[0]?.live).toBe(false);
  expect(lines).toContain("DONE_SET_NOT_SENT demo-lane w:p1: not submitted (see NOT_SUBMITTED in the watch log)");
  const r = await closeLane(deps(), after, "x");
  expect(r.closed).toBe(false);
  expect(r.lines).toContain(`SIGNAL NOT ${NEW} -> OPEN`);
});

test("an unreadable line, no reason, or the same line is refused and changes nothing", async () => {
  for (const [done, reason] of [["grep -q ok file", "why"], [NEW, " "], [OLD, "why"]] as const) {
    await expect(setDone(deps(), lane, done, reason)).rejects.toBeInstanceOf(LaunchError);
  }
  expect((await deps().registry.read("demo-lane"))?.done).toBe(OLD);
  expect((await deps().registry.read("demo-lane"))?.doneChanges).toBeUndefined();
  expect(existsSync(join(state.dir, "lanes.log"))).toBe(false);
  expect(readFileSync(lane.brief, "utf8")).toContain(`- Done = ${OLD}.`);
});
