import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";

import { closeLane, claimDone, watchTick } from "../src/done-flow.ts";
import { launchLane, LaunchError, setThread } from "../src/launch.ts";
import type { Lane } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
const THREAD = "discord:100000000000000001";
const lane: Lane = { key: "demo-lane", title: "demo", thread: THREAD, pane: "w:p1", brief: "/briefs/demo.md", done: "merged acme/app#1", cwd: "/repo", openedAt: new Date(T0 - MIN).toISOString() };

let state: ReturnType<typeof withState>;
let world: World;
const at = (ms: number) => depsFor(world, fakeClock(ms), state.dir, { hooks: { threadDone: ["notify", "{thread}", "{text}"] } });
const hookCalls = () => world.calls.filter((c) => c[0] === "notify");

beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

const launch = async (thread: string | undefined) => {
  const brief = join(state.dir, "brief.md");
  await Bun.write(brief, "# brief\n");
  const aoe = depsFor(world, fakeClock(T0), state.dir, { backend: "aoe", leadPane: "aoe_Dori_0a1b2c3d" });
  return launchLane(aoe, { key: "new-lane", title: "new", brief, done: "merged acme/app#1", ...(thread === undefined ? {} : { thread }) });
};

for (const [why, ref] of [["an empty id", "discord:"], ["an empty id on another adapter", "chat:"], ["an empty ref", ""], ["no adapter", "100000000000000001"], ["a non-numeric Discord id", "discord:abc"], ["whitespace in the id", "chat:team 1"]] as const) {
  test(`launch refuses a thread ref with ${why} and registers nothing`, async () => {
    await expect(launch(ref)).rejects.toBeInstanceOf(LaunchError);
    expect(await at(T0).registry.read("new-lane")).toBeNull();
    expect(world.calls).toEqual([]);
  });
}

test("launch without --thread still opens the lane, with no thread", async () => {
  const r = await launch(undefined);
  expect(r.lane.thread).toBe("none");
  expect((await at(T0).registry.read("new-lane"))?.thread).toBe("none");
});

test("launch keeps a well-formed thread ref", async () => {
  expect((await launch(THREAD)).lane.thread).toBe(THREAD);
});

test("set-thread points a lane registered with an empty thread at a real one", async () => {
  await at(T0).registry.write({ ...lane, thread: "discord:" });
  expect(await setThread(at(T0), { ...lane, thread: "discord:" }, THREAD)).toBe(`THREAD_SET demo-lane discord: -> ${THREAD}`);
  expect((await at(T0).registry.read("demo-lane"))?.thread).toBe(THREAD);
});

test("set-thread refuses a malformed ref and leaves the lane as it was", async () => {
  await at(T0).registry.write(lane);
  await expect(setThread(at(T0), lane, "discord:")).rejects.toBeInstanceOf(LaunchError);
  await expect(setThread(at(T0), lane, "nothread")).rejects.toBeInstanceOf(LaunchError);
  expect((await at(T0).registry.read("demo-lane"))?.thread).toBe(THREAD);
});

for (const thread of ["discord:", "none", ""]) {
  test(`close with thread ${JSON.stringify(thread)} warns THREAD_MISSING instead of skipping the hook silently`, async () => {
    const r = await closeLane(at(T0), { ...lane, thread }, "manual");
    expect(r.closed).toBe(true);
    expect(r.lines.some((l) => l.startsWith("THREAD_MISSING demo-lane "))).toBe(true);
    expect(hookCalls()).toEqual([]);
  });
}

test("close with a thread runs the threadDone hook and warns nothing", async () => {
  const r = await closeLane(at(T0), lane, "manual");
  expect(hookCalls()).toEqual([["notify", THREAD, "manual"]]);
  expect(r.lines.some((l) => l.startsWith("THREAD_MISSING"))).toBe(false);
});

test("the claim-done auto close also prints THREAD_MISSING for a lane with an empty thread", async () => {
  const empty = { ...lane, thread: "discord:" };
  await at(T0).registry.write(empty);
  await claimDone(at(T0), empty, "merged acme/app#1");
  const lines = await watchTick(at(T0 + 6 * MIN));
  expect(lines.find((l) => l.startsWith("THREAD_MISSING"))).toStartWith("THREAD_MISSING demo-lane ");
  expect(lines.at(-1)).toStartWith("LANE_CLOSED demo-lane");
  expect(hookCalls()).toEqual([]);
});
