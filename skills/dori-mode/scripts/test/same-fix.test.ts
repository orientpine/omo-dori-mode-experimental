import { afterEach, beforeEach, expect, test } from "bun:test";

import { defaultConfig } from "../src/config.ts";
import { freshnessTick } from "../src/freshness.ts";
import type { Lane } from "../src/registry.ts";
import { fixCount, fixTag, recordFix } from "../src/same-fix.ts";
import { depsFor, fakeClock, newWorld, sent, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
let state: ReturnType<typeof withState>;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

const lane: Lane = { key: "e7", title: "e7", thread: "none", pane: "w:p7", brief: "/b.md", done: "merged acme/app#1", openedAt: new Date(T0).toISOString(), lastReplyAt: T0 };
const report = (n: number, tag: string) => ` [REPORT] e7 | milestone | round ${n}: raised the reward ${tag}\n\n❯ `;

test("the third tagged report fixing one metric on one hypothesis alerts the lead once, and nothing reaches the lane by default", async () => {
  const deps = (ms: number) => depsFor(world, fakeClock(ms), state.dir);
  await deps(T0).registry.write(lane);
  const tick = async (n: number, tag: string) => {
    world.screens["lead:p1"] = report(n, tag);
    return (await freshnessTick(deps(T0 + n * MIN), "/home/test")).filter((a) => a.kind === "same_fix_3");
  };
  expect(await tick(1, "(fix: deadlock count / reward too small)")).toEqual([]);
  expect(await tick(2, "(fix: Deadlock  Count / reward too small)")).toEqual([]);
  // another hypothesis on the same metric is a different line of attack
  expect(await tick(3, "(fix: deadlock count / bank too old)")).toEqual([]);
  const third = await tick(4, "(fix: deadlock count / reward too small)");
  expect(third).toEqual([{ kind: "same_fix_3", lane: "e7", detail: 'attempt 3 on "deadlock count" with the same hypothesis "reward too small": stop patching; reproduce it and read the logs for the root cause first' }]);
  // the same report read again on the next sweep is not another attempt
  expect((await freshnessTick(deps(T0 + 5 * MIN), "/home/test")).filter((a) => a.kind === "same_fix_3")).toEqual([]);
  expect(sent(world)).toEqual([]);
  expect((await deps(T0).registry.read("e7"))?.status).toBeUndefined();
});

test("with sameFix.sendToLane on, the lane gets the stop-patching note; the lane keeps working", async () => {
  const sameFix = { ...defaultConfig().sameFix, sendToLane: true };
  const deps = depsFor(world, fakeClock(T0), state.dir, { sameFix });
  await deps.registry.write(lane);
  for (let i = 0; i < 2; i++) expect((await recordFix(deps, "e7", { at: "t", metric: "m", hypothesis: "h", via: "report" })).alert).toBeUndefined();
  const r = await recordFix(deps, "e7", { at: "t", metric: "m", hypothesis: "h", via: "report" });
  expect(r.alert).toEndWith("(sent to the lane)");
  expect(sent(world)).toEqual(["[LEAD] This is fix attempt 3 on m with the same hypothesis (h). Stop patching: reproduce the failure and read the logs for the root cause first, then report what you found."]);
  expect((await deps.registry.read("e7"))?.status).toBeUndefined();
});

test("a fix the lead asked for and the lane then reported counts once", () => {
  const f = (via: "lead" | "report") => ({ at: "t", metric: "m", hypothesis: "h", via });
  expect(fixCount([f("lead"), f("report"), f("lead"), f("report")], "m", "h")).toBe(2);
  expect(fixCount([f("report"), f("report"), f("lead")], "m", "h")).toBe(3);
  expect(fixTag("[REPORT] x | milestone | (fix: <metric> / <hypothesis>)")).toBeUndefined();
});
