import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { failedMetrics, inferRepeats, type LaneEvent, passedMetrics, readReports, suspects } from "../src/auto-signals.ts";
import { defaultConfig } from "../src/config.ts";
import { freshnessTick } from "../src/freshness.ts";
import { ownerDue, parseOwnerReply, quoted, runOwnerCheck } from "../src/owner-check.ts";
import type { Lane } from "../src/registry.ts";
import { crossed } from "../src/rollover.ts";
import type { Runner } from "../src/run.ts";
import { sessionDirFor } from "../src/session-id.ts";
import { depsFor, fakeClock, fakeRunner, newWorld, sent, withState, type World } from "./fakes.ts";

const cfg = defaultConfig("/home/test").autoSignals;
const T0 = Date.parse("2026-10-10T00:00:00Z");
const at = (min: number): string => new Date(T0 + min * 60_000).toISOString();
const ev = (min: number, text: string, source: LaneEvent["source"] = "report"): LaneEvent => ({ at: at(min), source, text });

test("a gate line's failure is read from the item that holds FAIL and from the bare list after it, not from test suites or ids", () => {
  expect(failedMetrics("e7st1g model_795 F1 \ubd88\ud569\uaca9 3/8: \ub364\ud504 \uc131\uacf5 0.6875 FAIL(\u22650.76; 44/64), \uad50\ucc29 554 FAIL(\u22642), \uba48\ucda4 \ud310 8 FAIL(0)", cfg).sort()).toEqual(["\ub364\ud504 \uc131\uacf5", "\uba48\ucda4", "\uad50\ucc29"].sort());
  expect(failedMetrics("6/10 \u2014 FAIL \ub3c4\ub791 \uc704 \ub364\ud504 1\u00b7\uad50\ucc29 58(\ubcbd 2/\ud55c\uacc4 56)\u00b7\ud0c8\ucd9c 0.40 %\u00b7frozen 2.4 %.", cfg).sort()).toEqual(["frozen", "\ub3c4\ub791 \uc704 \ub364\ud504", "\uad50\ucc29", "\ud0c8\ucd9c"].sort());
  // a dash ends the list: \ub364\ud504 is not one of the failed lines
  expect(failedMetrics("7/8 PASS, FAIL \uad50\ucc29 145 \u2014 \ub364\ud504 0.837(123/147), \uc804\ub2ec 0.460", cfg)).toEqual(["\uad50\ucc29"]);
  expect(failedMetrics("suite 48: 381 passed, 13 failed = suite 47 cuda-only list", cfg)).toEqual([]);
  expect(failedMetrics("model_1625 0.5 FAIL, GPU-13 4 FAIL", cfg)).toEqual([]);
  expect(passedMetrics("\ub364\ud504 \uc131\uacf5 0.885 \u2713, \uba48\ucda4 \ud310 0 PASS, \uad50\ucc29 145 FAIL", cfg).sort()).toEqual(["\ub364\ud504 \uc131\uacf5", "\uba48\ucda4"].sort());
});

const loop: LaneEvent[] = [
  ev(0, "model_498 F1: \uad50\ucc29 487 FAIL(\u22642)"),
  ev(10, "\uc870\uc815 1 \uc2dc\uc791: \uad50\ucc29 \uc9c4\uc785 \ubc8c\uc810 rew_limit_push -0.03"),
  ev(100, "model_597 F1: \uad50\ucc29 584 FAIL"),
  ev(110, "\uc870\uc815 2 \uc2dc\uc791: \ud3c9\uade0 \ud589\ub3d9 \uad50\ucc29 \ubc8c\uc810"),
  ev(200, "model_697 F1: \uad50\ucc29 554 FAIL"),
  ev(210, "\uc870\uc815 3: \uad50\ucc29 \uc7ac\uc9c4\uc785 \ubc8c\uc810 \ucd94\uac00"),
];

test("three cycles of a failed gate line re-targeted by a new prescription make a REPEAT_SUSPECT, the third and not the second", () => {
  expect(suspects(inferRepeats(loop.slice(0, 4), cfg), 3)).toEqual([]);
  const hit = suspects(inferRepeats(loop, cfg), 3);
  expect(hit.map((r) => [r.metric, r.n])).toEqual([["\uad50\ucc29", 3]]);
  expect(hit[0]?.evidence.map((e) => e.role)).toEqual(["fail", "attempt", "fail", "attempt", "fail", "attempt"]);
});

test("an attempt counts only after a new failure, outside the duplicate gap, when it is not negated, a pure diagnosis, or after a PASS", () => {
  // attempts with no failure in between are one cycle
  expect(inferRepeats([loop[0] as LaneEvent, ev(40, "\uc870\uc815 1: \uad50\ucc29 \ubc8c\uc810"), ev(80, "\uc870\uc815 1b: \uad50\ucc29 \ubc8c\uc810 \uc218\uc815"), ev(120, "\uc870\uc815 1c: \uad50\ucc29 \ubc8c\uc810 \uc218\uc815")], cfg).counts.get("\uad50\ucc29")?.n).toBe(1);
  // a commit and its report 5 minutes apart are one attempt
  expect(inferRepeats([loop[0] as LaneEvent, ev(10, "fix(rl): \uad50\ucc29 penalty", "commit"), ev(12, "model_x \uad50\ucc29 9 FAIL"), ev(15, "\uc870\uc815: \uad50\ucc29 \ubc8c\uc810 \ubc18\uc601")], cfg).counts.get("\uad50\ucc29")?.n).toBe(1);
  const negated = [loop[0] as LaneEvent, ev(10, "\uad50\ucc29 \ubc8c\uc810 \uc870\uc815 \uc548 \ud568, \uc6d0\uc778 \uc9c4\ub2e8 \uba3c\uc800")];
  expect(inferRepeats(negated, cfg).counts.size).toBe(0);
  const diagnosis = [loop[0] as LaneEvent, ev(10, "\uad50\ucc29 \uc7ac\uc0dd \ud0d0\uce68 \uc2dc\uc791")];
  expect(inferRepeats(diagnosis, cfg).counts.size).toBe(0);
  const passed = [...loop.slice(0, 4), ev(150, "model_600 F1: \uad50\ucc29 2 PASS"), ...loop.slice(4)];
  expect(inferRepeats(passed, cfg).counts.get("\uad50\ucc29")?.n).toBe(1);
});

test("clause scope needs the metric next to the attempt word; sentence scope and aliases widen what counts", () => {
  const context = [ev(0, "\uad50\ucc29 9 FAIL"), ev(40, "\uc7ac\uc0dd(model_795, \uad50\ucc29 \uad6c\uac04) 09:20Z \uc2dc\uc791, \ubc8c\uc810 \uc5c6\uc774")];
  expect(inferRepeats(context, { ...cfg, targetScope: "clause" }).counts.size).toBe(0);
  const near = [ev(0, "\uad50\ucc29 9 FAIL"), ev(40, "e7st1j \uc2dc\uc791 \u2014 \uc870\uc815 4\ub294 \ud3c9\uade0 \ud589\ub3d9 \uc9c4\uc785 \uc81c\ud55c, \ub300\uc0c1 \uad50\ucc29 \uc904\uc774\uae30")];
  expect(inferRepeats(near, { ...cfg, targetScope: "clause" }).counts.size).toBe(0);
  expect(inferRepeats(near, { ...cfg, targetScope: "sentence" }).counts.get("\uad50\ucc29")?.n).toBe(1);
  const english = [ev(0, "\uad50\ucc29 9 FAIL"), ev(40, "feat(rl): stage-1 tuning, deadlocks entry penalty", "commit")];
  expect(inferRepeats(english, cfg).counts.size).toBe(0);
  expect(inferRepeats(english, { ...cfg, aliases: { "\uad50\ucc29": ["deadlock", "deadlocks"] } }).counts.get("\uad50\ucc29")?.n).toBe(1);
});

test("a prescription verdict (REJECTED, \uae30\uac01, \ud310\uc815 \ubd88\uac00) fails the known metrics its sentence names", () => {
  const events = [ev(0, "\uba48\ucda4 \ud310 8 FAIL"), ev(10, "HL1 \ucc98\ubc29: \uc2a4\uc719 \u03c3 \ud558\ud55c 0.20, \ub300\uc0c1 \uba48\ucda4"), ev(100, "n1 \ud6a8\uacfc \ud310\uc815 = \ud310\uc815 \ubd88\uac00, \uba48\ucda4 16 \u2192 15"), ev(110, "T-explore \ucc98\ubc29 \ucd94\uac00, \ub300\uc0c1 \uba48\ucda4")];
  expect(inferRepeats(events, cfg).counts.get("\uba48\ucda4")?.n).toBe(2);
});

test("an inferred repeat crosses laneRepeats with both counts shown; alone it makes a rollover due but never starts one", async () => {
  const limits = { contextPct: 0, compactions: 0, ageH: 0, repeats: 3 };
  expect(crossed({ repeats: 1, inferredRepeats: 3 }, limits)).toEqual(["same fix 3 times >= 3 (tagged 1, inferred 3)"]);
  expect(crossed({ repeats: 3 }, limits)).toEqual(["same fix 3 times >= 3"]);
  expect(crossed({ repeats: 0, inferredRepeats: 2 }, limits)).toEqual([]);
  const state = withState();
  try {
    const w = newWorld();
    const deps = depsFor(w, fakeClock(T0 + 60_000), state.dir, { backend: "aoe", handover: { ...defaultConfig("/home/test").handover, autoRolloverLanes: true } });
    await deps.registry.write({ ...lane(state.dir), pane: "aoe_rl_1", lastReplyAt: T0 + 60_000, inferred: { at: at(0), counts: { "\uad50\ucc29": 3 } } });
    let started = 0;
    const acts = await freshnessTick(deps, "/home/test", { signals: async () => ({}), auto: async () => `started ${++started}` });
    expect(acts.map((a) => a.kind)).toEqual(["rollover_due"]);
    expect(acts[0]?.detail).toContain("(tagged 0, inferred 3)");
    expect(started).toBe(0);
  } finally {
    state.done();
  }
});

const lane = (dir: string): Lane => ({ key: "rl-e7", title: "E7", thread: "none", pane: "w:p1", brief: join(dir, "brief.md"), done: "x", cwd: "/repo", openedAt: at(-60), model: "anthropic/claude-opus-5-5" });

const sessionLine = (min: number, role: "assistant" | "user", text: string): string =>
  JSON.stringify(role === "assistant" ? { type: "message", timestamp: at(min), message: { role, content: [{ type: "toolCall", arguments: { command: `tmux send-keys -t =lead: -l -- "${text}"` } }] } } : { type: "message", timestamp: at(min), message: { role, content: [{ type: "text", text }] } });

let state: ReturnType<typeof withState>;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

const writeSession = (lines: readonly string[]): string => {
  const dir = sessionDirFor(join(state.dir, "sessions"), "/repo");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "2026-10-10T00-00-00-000Z_00000000-0000-0000-0000-000000000000.jsonl");
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
};

test("freshness raises REPEAT_SUSPECT once per new cycle from the lane's untagged reports, and types nothing into the lane", async () => {
  writeSession(loop.map((e) => sessionLine((Date.parse(e.at) - T0) / 60_000, "assistant", `[REPORT] rl-e7 | milestone | ${e.text}`)));
  const deps = depsFor(world, fakeClock(T0 + 220 * 60_000), state.dir, { sessionsDir: join(state.dir, "sessions") });
  await deps.registry.write(lane(state.dir));
  world.screens["lead:p1"] = ` [REPORT] rl-e7 | milestone | ${loop.at(-1)?.text}\n\n\u276f `;
  const acts = await freshnessTick(deps, "/home/test");
  expect(acts.filter((a) => a.kind === "repeat_suspect").map((a) => a.detail.split(" (")[0])).toEqual(['"\uad50\ucc29" 3']);
  expect(await Bun.file(deps.config.watchLog).text()).toMatch(/auto-signals REPEAT_SUSPECT rl-e7 "\uad50\ucc29" 3 \(inferred .*tagged fixes 0\)/);
  expect(sent(world)).toEqual([]);
  expect((await deps.registry.read("rl-e7"))?.inferred?.counts).toEqual({ "\uad50\ucc29": 3 });
  world.screens["lead:p1"] = " [REPORT] rl-e7 | milestone | \ub2e4\uc74c run \uc900\ube44 \uc911\n\n\u276f ";
  expect((await freshnessTick(deps, "/home/test")).filter((a) => a.kind === "repeat_suspect")).toEqual([]);
});

test("reports are read once each, from the lane's typing and the lead's copy, without template leftovers", async () => {
  const file = writeSession([
    sessionLine(1, "assistant", "[REPORT] rl-e7 | milestone | \uc9c4\ud589(09:01 KST): \uad50\ucc29 9 FAIL"),
    sessionLine(2, "user", "[REPORT] rl-e7 | milestone | \uc9c4\ud589(09:02 KST): \uad50\ucc29 9 FAIL"),
    sessionLine(3, "assistant", "[REPORT] rl-e7 | milestone | \uc9c4\ud589(${kst()}): \uad50\ucc29 9 FAIL"),
    sessionLine(4, "assistant", "[REPORT] rl-e7 | milestone | <what, with links>"),
  ]);
  expect((await readReports([file], "rl-e7")).map((r) => r.at)).toEqual([at(1)]);
});

const VIOLATION = 'VERDICT: VIOLATION\nOWNER: "\ud559\uc2b5\uc740 \uba48\ucd94\uc9c0 \ub9d0\uace0"\nREPORT: "\ud559\uc2b5\uc744 \uba48\ucd94\uace0 \ube44\uad50\ud45c\ub97c \ub9cc\ub4e6"\nWHY: the owner said keep training running.';

test("an owner-check reply is parsed in its fixed format, and a quote not in the inputs is marked unverified", () => {
  const owner = "[LEAD] \ud615 \uc9c8\ubb38(\uc6d0\ubb38 https://discord.com/channels/1/2/3): \ud559\uc2b5\uc740 \uba48\ucd94\uc9c0 \ub9d0\uace0 \ube44\uad50\ud45c\ub97c \ub9cc\ub4e4\uc5b4\ub77c";
  const reports = "\uc9c4\ud589: \ud559\uc2b5\uc744 \uba48\ucd94\uace0 \ube44\uad50\ud45c\ub97c \ub9cc\ub4e6";
  expect(parseOwnerReply(VIOLATION, owner, reports)).toEqual([{ kind: "VIOLATION", owner: "\ud559\uc2b5\uc740 \uba48\ucd94\uc9c0 \ub9d0\uace0", report: "\ud559\uc2b5\uc744 \uba48\ucd94\uace0 \ube44\uad50\ud45c\ub97c \ub9cc\ub4e6", why: "the owner said keep training running.", verified: true }]);
  expect(parseOwnerReply(VIOLATION, owner, "\ub2e4\ub978 \ubcf4\uace0")?.[0]?.verified).toBe(false);
  expect(parseOwnerReply("VERDICT: OK", owner, reports)).toEqual([]);
  expect(parseOwnerReply("I would need to read the files first.", owner, reports)).toBeUndefined();
  expect(quoted("\ud559\uc2b5\uc740 \uba48\ucd94\uc9c0\u2026\ube44\uad50\ud45c\ub97c \ub9cc\ub4e4\uc5b4\ub77c", owner)).toBe(true);
});

test("owner-check runs only on a newer report, past the interval and under the daily limit", () => {
  const limits = { minIntervalMin: 30, maxPerDay: 2 };
  const st = { at: at(0), lastReportAt: at(0), day: at(0).slice(0, 10), today: 1, model: "m", kinds: ["OK"] };
  expect(ownerDue(undefined, undefined, T0, limits)).toBe("no report on record");
  expect(ownerDue(st, at(0), T0 + 60 * 60_000, limits)).toContain("no new report");
  expect(ownerDue(st, at(5), T0 + 29 * 60_000, limits)).toContain("rate limit");
  expect(ownerDue(st, at(5), T0 + 30 * 60_000, limits)).toBeUndefined();
  expect(ownerDue({ ...st, today: 2 }, at(5), T0 + 31 * 60_000, limits)).toContain("daily limit");
});

test("owner-check asks a reviewer of another family, GPT first, logs OWNER_CHECK and skips the next run until a new report", async () => {
  writeFileSync(join(state.dir, "brief.md"), "# \ube0c\ub9ac\ud504\n\ud559\uc2b5\uc740 \uba48\ucd94\uc9c0 \ub9d0\uace0 \ube44\uad50\ud45c\ub97c \ub9cc\ub4e4\uc5b4\ub77c\n\n## Past signals (written by dori launch)\n- \uc9c0\ub09c lane \uae30\ub85d");
  const file = writeSession([sessionLine(1, "assistant", "[REPORT] rl-e7 | milestone | \uc9c4\ud589: \ud559\uc2b5\uc744 \uba48\ucd94\uace0 \ube44\uad50\ud45c\ub97c \ub9cc\ub4e6"), sessionLine(2, "user", "[LEAD] \ud615 \uc9c0\uc2dc(\uc6d0\ubb38 https://discord.com/channels/1/2/3): \ud559\uc2b5\uc740 \uba48\ucd94\uc9c0 \ub9d0\uace0")]);
  const asked: string[][] = [];
  const base = fakeRunner(world);
  const run: Runner = async (argv, opts) => {
    if (argv[0] !== "omo") return base(argv, opts);
    asked.push([...argv]);
    const model = argv[argv.indexOf("--model") + 1] ?? "";
    return model.includes("6.1-sol") ? { code: 1, out: "", err: "error: rate limited" } : { code: 0, out: VIOLATION, err: "" };
  };
  const config = { ...defaultConfig("/home/test"), explore: { ...defaultConfig("/home/test").explore, modelsCommand: [] } };
  const deps = { ...depsFor(world, fakeClock(T0 + 10 * 60_000), state.dir, { sessionsDir: join(state.dir, "sessions"), explore: config.explore }), run };
  await deps.registry.write(lane(state.dir));
  const r = await runOwnerCheck(deps, lane(state.dir), { files: [file] });
  expect(asked.map((a) => a[a.indexOf("--model") + 1])).toEqual(["chatgpt-subscription/gpt-6.1-sol", "chatgpt-subscription/gpt-6-luna"]);
  const prompt = asked[1]?.at(-1) ?? "";
  expect(prompt).toContain("\ud559\uc2b5\uc740 \uba48\ucd94\uc9c0 \ub9d0\uace0 \ube44\uad50\ud45c\ub97c \ub9cc\ub4e4\uc5b4\ub77c");
  expect(prompt).not.toContain("\uc9c0\ub09c lane \uae30\ub85d");
  expect(prompt).toContain("[LEAD] \ud615 \uc9c0\uc2dc(\uc6d0\ubb38 https://discord.com/channels/1/2/3)");
  expect(r.lines).toHaveLength(1);
  expect(r.lines[0]).toMatch(/^OWNER_CHECK rl-e7 VIOLATION owner "\ud559\uc2b5\uc740 \uba48\ucd94\uc9c0 \ub9d0\uace0" vs report .*\[reviewer chatgpt-subscription\/gpt-6-luna\]$/);
  expect(await Bun.file(deps.config.watchLog).text()).toContain("owner-check OWNER_CHECK rl-e7 VIOLATION");
  const after = (await deps.registry.read("rl-e7")) as Lane;
  expect(after.ownerCheck?.kinds).toEqual(["VIOLATION"]);
  const again = await runOwnerCheck(deps, after, { files: [file], force: true });
  expect(again.skipped).toContain("OWNER_CHECK_SKIP rl-e7 no new report");
  expect(asked).toHaveLength(2);
});
