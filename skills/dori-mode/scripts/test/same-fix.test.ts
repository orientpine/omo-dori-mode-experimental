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

// the research text rung 3 types into the lane is explore.test.ts's; these tests watch the rungs alone
const quiet = { explore: { ...defaultConfig().explore, sendResearchToLane: false } };

const lane: Lane = { key: "e7", title: "e7", thread: "none", pane: "w:p7", brief: "/b.md", done: "merged acme/app#1", openedAt: new Date(T0).toISOString(), lastReplyAt: T0 };
const report = (n: number, tag: string) => ` [REPORT] e7 | milestone | round ${n}: raised the reward ${tag}\n\n❯ `;
const fix = (hypothesis: string, extra: object = {}) => ({ at: new Date(T0).toISOString(), metric: "m", hypothesis, via: "report" as const, ...extra });

test("tagged reports climb one ladder per metric: one STUCK line at rung 2, 3 and 4, the old names only at its end, nothing typed into the lane", async () => {
  const deps = (ms: number) => depsFor(world, fakeClock(ms), state.dir, quiet);
  await deps(T0).registry.write(lane);
  const tick = async (n: number, tag: string) => {
    world.screens["lead:p1"] = report(n, tag);
    return (await freshnessTick(deps(T0 + n * MIN), "/home/test")).filter((a) => a.kind === "stuck").map((a) => a.detail);
  };
  expect(await tick(1, "(fix: deadlock count / reward too small)")).toEqual([]);
  const two = await tick(2, "(fix: Deadlock  Count / reward too small)");
  expect(two).toHaveLength(1);
  expect(two[0]).toStartWith('"deadlock count" rung 2 (tagged 2, inferred 0, hypotheses 1) -> branch before the next patch');
  expect(two[0]).toEndWith("[HYPOTHESES_REQUIRED]");
  // another hypothesis on the same metric still counts: the count is per metric
  const three = await tick(3, "(fix: deadlock count / bank too old)");
  expect(three).toEqual(['"deadlock count" rung 3 (tagged 3, inferred 0, hypotheses 2) -> ulw research on the exact symptom and a dori challenge of the next plan, in this session, before the next patch (no rollover at this rung) [RESEARCH_DUE]']);
  const four = await tick(4, "(fix: deadlock count / critic lags)");
  expect(four[0]).toStartWith('"deadlock count" rung 4 (tagged 4, inferred 0, hypotheses 3) -> attempt 4 failed after rung 3: the cheap rungs are spent');
  expect(four[0]).toContain('dori handover --lane e7 --approved-by "lead:<your reason and this signal>"');
  expect(four[0]).toEndWith("[ROLLOVER_DUE]");
  // the same report read again on the next sweep is not another attempt, and a rung alerts once
  expect(await tick(4, "(fix: deadlock count / critic lags)")).toEqual([]);
  const log = (await Bun.file(deps(T0).config.watchLog).text()).split("\n").filter(Boolean);
  expect(log.map((l) => l.split(" ").slice(1, 4).join(" "))).toEqual(["stuck STUCK e7", "stuck STUCK e7", "stuck STUCK e7"]);
  expect(sent(world)).toEqual([]);
  expect((await deps(T0).registry.read("e7"))?.status).toBeUndefined();
});

test("one hypothesis tried fixatedAfter times jumps to rung 4 with SAME_FIX_3 at the end, and no research is sent", async () => {
  const deps = depsFor(world, fakeClock(T0), state.dir, { explore: defaultConfig().explore });
  await deps.registry.write(lane);
  expect((await recordFix(deps, "e7", fix("h"))).notes).toEqual([]);
  expect((await recordFix(deps, "e7", fix("h"))).notes[0]).toContain('"m" rung 2 ');
  const third = await recordFix(deps, "e7", fix("h"));
  expect(third.count).toBe(3);
  expect(third.notes).toHaveLength(1);
  expect(third.notes[0]).toStartWith('STUCK e7 "m" rung 4 (tagged 3, inferred 0, hypotheses 1, fixated) -> hypothesis tried 3+ times on "m"');
  expect(third.notes[0]).toEndWith("[ROLLOVER_DUE SAME_FIX_3]");
  expect(sent(world)).toEqual([]);
});

test("--improved starts the count again: the mark goes down silently and the next stuck run alerts afresh", async () => {
  const deps = depsFor(world, fakeClock(T0), state.dir, quiet);
  await deps.registry.write(lane);
  await recordFix(deps, "e7", fix("a"));
  expect((await recordFix(deps, "e7", fix("b"))).notes).toHaveLength(1);
  expect((await recordFix(deps, "e7", fix("c", { improved: true }))).notes).toEqual([]);
  expect((await deps.registry.read("e7"))?.stuck?.m).toMatchObject({ rung: 1, n: 1 });
  expect((await recordFix(deps, "e7", fix("d"))).notes[0]).toContain('"m" rung 2 (tagged 2');
});

test("a fix the lead asked for and the lane then reported counts once", () => {
  const f = (via: "lead" | "report") => ({ at: "t", metric: "m", hypothesis: "h", via });
  expect(fixCount([f("lead"), f("report"), f("lead"), f("report")], "m", "h")).toBe(2);
  expect(fixCount([f("report"), f("report"), f("lead")], "m", "h")).toBe(3);
  expect(fixTag("[REPORT] x | milestone | (fix: <metric> / <hypothesis>)")).toBeUndefined();
});
