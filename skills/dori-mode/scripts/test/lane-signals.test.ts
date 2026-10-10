import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defaultConfig } from "../src/config.ts";
import { areaSignals, formatSignals, laneSignals, oneLine, priorFixLines, readLaneLogs } from "../src/lane-signals.ts";
import { launchLane } from "../src/launch.ts";
import type { Lane } from "../src/registry.ts";
import { computeScorecard, dayWindow, formatScorecard, saveScorecard } from "../src/scorecard.ts";
import { depsFor, fakeClock, newWorld, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-03-02T12:00:00.000Z");
let state: ReturnType<typeof withState>;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

const PANE = "aoe_e7_0a1b2c3d";
const e7: Lane = { key: "hr9-e7", title: "e7", thread: "none", pane: PANE, brief: "/b.md", done: "merged a/b#1", cwd: "/work/rl", openedAt: "2026-03-01T00:00:00Z" };

const report = (ts: string, text: string) => JSON.stringify({ type: "message", timestamp: ts, message: { role: "user", content: [{ type: "text", text: `[REPORT] hr9-e7 | milestone | ${text}` }] } });
const lead = (ts: string, text: string) =>
  JSON.stringify({ type: "message", timestamp: ts, message: { role: "assistant", content: [{ type: "toolCall", arguments: { code: `await run(["tmux","send-keys","-t","=${PANE}:","-l","--","[LEAD] ${text}"])` } }] } });

const setupLogs = () => {
  const leadDir = join(state.dir, "lead");
  mkdirSync(leadDir, { recursive: true });
  writeFileSync(
    join(leadDir, "l.jsonl"),
    [
      // the lead's own copy of the footer template is not a report
      JSON.stringify({ type: "message", timestamp: "2026-03-01T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "[REPORT] hr9-e7 | <milestone|blocker> | <what>" }] } }),
      lead("2026-03-01T01:00:00Z", "go with B (adjustment 1/2): shell sink penalty -0.5"),
      report("2026-03-01T02:00:00Z", "adjustment 1 started; canary after 50 iter (adjustment 50 iter is not an attempt number)"),
      report("2026-03-01T03:00:00Z", "adjustment 1 did not help: deadlock 42 -> 46"),
      lead("2026-03-01T04:00:00Z", "adjustment 2: mean-action penalty"),
      report("2026-03-01T05:00:00Z", "adjustment 3 started, entropy schedule (fix: deadlock count / exploration too wide)"),
      lead("2026-03-01T06:00:00Z", "stop adjusting (no adjustment 4); find the root cause by replaying the deadlock"),
      report("2026-03-01T07:00:00Z", "root cause: the projection erased the boom command at the wall"),
    ].join("\n"),
  );
  const lanesLog = join(state.dir, "lanes.log");
  writeFileSync(lanesLog, ["2026-03-01T01:00:00Z freshness NUDGED hr9-e7 16 min silent", "2026-03-01T02:00:00Z freshness NUDGED hr9-e7 16 min silent", "2026-03-01T02:00:00Z freshness NUDGED other 16 min silent"].join("\n"));
  return { ...defaultConfig("/home/test"), stateDir: state.dir, defaultCwd: "/home/test", scorecard: { ...defaultConfig().scorecard, leadSessions: leadDir, lanesLog } };
};

test("signals read numbered fix attempts, the root-cause switch, re-sends and nudges from the lead's logs", async () => {
  const config = setupLogs();
  const logs = await readLaneLogs([e7], { leadSessions: config.scorecard.leadSessions, lanesLog: config.scorecard.lanesLog, sendPattern: config.scorecard.leadSendPattern });
  const s = laneSignals(e7, logs.get("hr9-e7"), config);
  expect({ sends: s.sends, nudges: s.nudges }).toEqual({ sends: 3, nudges: 2 });
  // 50 is a count of iterations, and "no adjustment 4" in the root-cause message is not an attempt
  expect(s.attempts.map((a) => [a.n, a.first.at, a.last.at])).toEqual([
    [1, "2026-03-01T01:00:00Z", "2026-03-01T03:00:00Z"],
    [2, "2026-03-01T04:00:00Z", "2026-03-01T04:00:00Z"],
    [3, "2026-03-01T05:00:00Z", "2026-03-01T05:00:00Z"],
  ]);
  expect(s.rootCause?.at).toBe("2026-03-01T06:00:00Z");
  // a tagged report the freshness sweep never recorded still counts
  expect(s.fixes).toEqual([{ at: "2026-03-01T05:00:00Z", metric: "deadlock count", hypothesis: "exploration too wide", via: "report" }]);
  expect(s.warnings).toEqual([]);
  const text = formatSignals("lane hr9-e7", [s]);
  expect(text).toContain("#1 03-01 01:00 lead: [LEAD] go with B (adjustment 1/2): shell sink penalty -0.5");
  expect(text).toContain("root-cause switch: 03-01 06:00 lead:");
  expect(oneLine(s)).toBe("SIGNALS hr9-e7 [open] fixes 1, attempts 1-3 then root cause, rejected 0/0, re-sends 3, nudges 2");
});

test("three numbered attempts with no root-cause switch, a third same fix and two rejected claims are warnings", () => {
  const cfg = defaultConfig();
  const m = (n: number) => ({ at: `2026-03-01T0${n}:00:00Z`, via: "report" as const, text: `adjustment ${n}: raise the reward` });
  const fix = (h: string) => ({ at: "t", metric: "deadlock count", hypothesis: h, via: "lead" as const });
  const history: Lane["history"] = [
    { at: "1", status: "done-claimed", note: "claim" },
    { at: "2", status: "not-done", note: "gate fails" },
    { at: "3", status: "not-done", note: "PAUSED by owner" },
    { at: "4", status: "done-claimed", note: "claim" },
    { at: "5", status: "not-done", note: "deadlock 136 > 2" },
  ];
  const s = laneSignals({ ...e7, fixes: [fix("reward too small"), fix("reward too small"), fix("reward too small"), fix("std too wide")], history }, { mentions: [m(1), m(2), m(3)], sends: 0, nudges: 0 }, cfg);
  expect(s.warnings).toEqual([
    'SAME_FIX hr9-e7 "deadlock count" / "reward too small" tried 3 times: stop patching, find the root cause',
    'REPEAT hr9-e7 "deadlock count": 4 fix attempts over 2 hypotheses',
    "REPEAT hr9-e7 numbered attempts 1-3 and no switch to a root-cause hunt",
    "REJECTED hr9-e7 2 done claims rejected (last: deadlock 136 > 2)",
  ]);
  expect({ claims: s.claims, rejected: s.rejections.length }).toEqual({ claims: 2, rejected: 2 });
  expect(priorFixLines([s], "hr9-e7", "deadlock count")).toEqual(['PRIOR_FIX hr9-e7 "deadlock count": reward too small x3, std too wide x1', "PRIOR_ATTEMPTS hr9-e7 numbered attempts 1-3, root-cause switch: none"]);
  expect(priorFixLines([s], "hr9-e7", "dump rate")).toEqual(['PRIOR_FIX none on "dump rate" in this area', "PRIOR_ATTEMPTS hr9-e7 numbered attempts 1-3, root-cause switch: none"]);
});

test("a launch in the same repo or topic gets a Past signals section from the earlier lanes; an unrelated launch does not", async () => {
  const config = setupLogs();
  const deps = depsFor(world, fakeClock(T0), state.dir, { ...config, backend: "aoe", leadPane: "aoe_Dori_0a1b2c3d" });
  await deps.registry.write({ ...e7, closedAt: "2026-03-01T08:00:00Z", history: [{ at: "2026-03-01T08:00:00Z", status: "closed", note: "lead" }] });
  await deps.registry.write({ key: "mail-digest", title: "mail", thread: "none", brief: "/b.md", done: "merged a/b#2", openedAt: "2026-03-01T00:00:00Z", fixes: [{ at: "t", metric: "m", hypothesis: "h", via: "lead" }] });
  const brief = join(state.dir, "brief.md");
  await Bun.write(brief, "# next stage\n");
  await launchLane(deps, { key: "hr9-e8", title: "e8", brief, done: 'command ["bun","test"]', cwd: "/work/rl" });
  const text = await Bun.file(brief).text();
  expect(text).toContain("## Past signals (written by dori launch)");
  expect(text).toContain("- hr9-e7 (closed by the lead): attempts 1-3");
  expect(text).toContain("then a root-cause hunt");
  expect(text).not.toContain("mail-digest");
  // the section comes before the footer
  expect(text.indexOf("## Past signals")).toBeLessThan(text.indexOf("## Lane footer"));
  const other = join(state.dir, "other.md");
  await Bun.write(other, "# other\n");
  await launchLane(deps, { key: "news-brief", title: "news", brief: other, done: 'command ["bun","test"]', cwd: "/home/test" });
  expect(await Bun.file(other).text()).not.toContain("## Past signals");
  // the tag on the command line joins a lane to a topic its key does not name
  const tagged = join(state.dir, "tagged.md");
  await Bun.write(tagged, "# tagged\n");
  await launchLane(deps, { key: "news-rl", title: "news", brief: tagged, done: 'command ["bun","test"]', cwd: "/home/test", tags: ["hr9"] });
  expect(await Bun.file(tagged).text()).toContain("- hr9-e7 (closed by the lead)");
  expect((await areaSignals(await deps.registry.list(), { tags: ["hr9"] }, config)).map((s) => s.lane.key).sort()).toEqual(["hr9-e7", "hr9-e8", "news-rl"]);
});

test("the scorecard is saved as <date>.json and latest.md, and days past keepDays are removed", async () => {
  const dir = join(state.dir, "scorecard");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "2026-01-01.json"), "{}");
  writeFileSync(join(dir, "2026-02-20.json"), "{}");
  const d = await computeScorecard({ sessionsDir: join(state.dir, "none"), lanes: [], settings: defaultConfig().scorecard, inbox: "", owner: "" }, dayWindow("2026-03-01", "UTC", 0));
  const text = formatScorecard(d, "en");
  expect(await saveScorecard(dir, d, text, 30)).toBe(join(dir, "2026-03-01.json"));
  expect(readdirSync(dir).sort()).toEqual(["2026-02-20.json", "2026-03-01.json", "latest.md"]);
  expect(await Bun.file(join(dir, "latest.md")).text()).toBe(`${text}\n`);
  expect(((await Bun.file(join(dir, "2026-03-01.json")).json()) as { text: string; window: { date: string } }).window.date).toBe("2026-03-01");
});
