import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { failedMetrics, inferRepeats, type LaneEvent, passedMetrics, readReports, suspects } from "../src/auto-signals.ts";
import { stuckView } from "../src/explore.ts";
import { defaultConfig } from "../src/config.ts";
import { freshnessTick } from "../src/freshness.ts";
import { claimCheck, ownerDue, parseOwnerReply, quoted, runOwnerCheck, sendReread } from "../src/owner-check.ts";
import type { Lane } from "../src/registry.ts";
import { crossed, dueReasons } from "../src/rollover.ts";
import { recordFix } from "../src/same-fix.ts";
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

test("three cycles of a failed gate line re-targeted by a new prescription count 3, the third and not the second", () => {
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
  // "\uc2dc\uc791" alone starts evals too; it is no attempt without a prescription word
  expect(inferRepeats([loop[0] as LaneEvent, ev(40, "F1 24\ud310 \uc2dc\uc791, \uad50\ucc29 \ub2e4\uc2dc \uc7ac\uae30")], cfg).counts.size).toBe(0);
  // an eval report that states the FAIL and plans the next adjustment is not yet a new attempt (challenge, grok-4.7)
  expect(inferRepeats([ev(0, "model_993 F1: \uad50\ucc29 136 FAIL. \ub2e4\uc74c \uc870\uc815: \uad50\ucc29 \uc9c4\uc785 \ubc8c\uc810")], cfg).counts.size).toBe(0);
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

test("a stuck rung 4 makes a rollover due as a reason, never a measured crossing, and never starts an automatic rollover", async () => {
  const limits = { contextPct: 0, compactions: 0, ageH: 0 };
  expect(dueReasons({ stuck: { metric: "교착", n: 4, rung: 4 } }, limits)).toEqual(['stuck rung 4 on "교착" (4 attempts)']);
  expect(dueReasons({ stuck: { metric: "교착", n: 3, rung: 3 } }, limits)).toEqual([]);
  expect(crossed({ stuck: { metric: "교착", n: 4, rung: 4 } }, limits)).toEqual([]);
  const state = withState();
  try {
    const w = newWorld();
    const deps = depsFor(w, fakeClock(T0 + 60_000), state.dir, { backend: "aoe", handover: { ...defaultConfig("/home/test").handover, autoRolloverLanes: true } });
    await deps.registry.write({ ...lane(state.dir), pane: "aoe_rl_1", lastReplyAt: T0 + 60_000, stuck: { "교착": { rung: 4, n: 4, at: at(0), pane: "aoe_rl_1" } } });
    let started = 0;
    const acts = await freshnessTick(deps, "/home/test", { signals: async () => ({}), auto: async () => `started ${++started}` });
    expect(acts).toEqual([]);
    expect(started).toBe(0);
  } finally {
    state.done();
  }
});

test("the stuck count is the larger of the tagged and the inferred count, under one alias name", async () => {
  const st = withState();
  try {
    const aliases = { "교착": ["deadlock", "deadlocks"] };
    const deps = depsFor(newWorld(), fakeClock(T0), st.dir, { autoSignals: { ...cfg, aliases }, explore: { ...defaultConfig("/home/test").explore, sendResearchToLane: false } });
    await deps.registry.write({ ...lane(st.dir), inferred: { at: at(0), counts: { "교착": 4 } } });
    const r = await recordFix(deps, "rl-e7", { at: at(1), metric: "deadlocks", hypothesis: "reward", via: "report" });
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toStartWith('STUCK rl-e7 "교착" rung 3 (tagged 1, inferred 4, hypotheses 1, inferred only, first count) -> ulw research');
    expect(r.notes[0]).toEndWith("[HYPOTHESES_REQUIRED RESEARCH_DUE REPEAT_SUSPECT]");
    const saved = (await deps.registry.read("rl-e7")) as Lane;
    expect(stuckView(saved, "deadlock", deps.config)).toMatchObject({ metric: "교착", tagged: 1, inferred: 4, n: 4 });
    // a PASS the reports showed after the tagged attempt starts the tagged half again too
    expect(stuckView({ ...saved, inferred: { at: at(2), counts: {}, passedAt: { "교착": at(2) } } }, "deadlocks", deps.config)).toMatchObject({ tagged: 0, inferred: 0, n: 0 });
  } finally {
    st.done();
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

test("freshness turns the untagged loop into one STUCK rung 3 and types the ulw research text into the lane; a later report adds nothing", async () => {
  writeSession(loop.map((e) => sessionLine((Date.parse(e.at) - T0) / 60_000, "assistant", `[REPORT] rl-e7 | milestone | ${e.text}`)));
  const deps = depsFor(world, fakeClock(T0 + 220 * 60_000), state.dir, { sessionsDir: join(state.dir, "sessions") });
  await deps.registry.write(lane(state.dir));
  world.screens["lead:p1"] = ` [REPORT] rl-e7 | milestone | ${loop.at(-1)?.text}\n\n❯ `;
  const acts = (await freshnessTick(deps, "/home/test")).filter((a) => a.kind === "stuck");
  expect(acts.map((a) => a.detail.split(" -> ")[0])).toEqual(['"교착" rung 3 (tagged 0, inferred 3, hypotheses 0, inferred only, first count)']);
  // the first scan of a long loop jumps: the line carries the skipped rung's name too (challenge, grok-4.7)
  expect(acts[0]?.detail).toEndWith("ulw research sent to the lane [HYPOTHESES_REQUIRED RESEARCH_DUE REPEAT_SUSPECT]");
  expect(await Bun.file(deps.config.watchLog).text()).toMatch(/ stuck STUCK rl-e7 "교착" rung 3 /);
  expect(sent(world)).toHaveLength(1);
  expect(sent(world)[0]).toStartWith("ulw research ");
  expect((await deps.registry.read("rl-e7"))?.inferred?.counts).toEqual({ "교착": 3 });
  expect(await Bun.file(join(state.dir, "auto-signals", "rl-e7.md")).text()).toContain('"교착" 3');
  world.screens["lead:p1"] = " [REPORT] rl-e7 | milestone | 다음 run 준비 중\n\n❯ ";
  expect((await freshnessTick(deps, "/home/test")).filter((a) => a.kind === "stuck")).toEqual([]);
});

test("a PASS between two sweeps ends the run: no STUCK line, and the PASS time is kept for the tagged half", async () => {
  const line = (e: LaneEvent) => sessionLine((Date.parse(e.at) - T0) / 60_000, "assistant", `[REPORT] rl-e7 | milestone | ${e.text}`);
  const file = writeSession(loop.slice(0, 2).map(line));
  const deps = depsFor(world, fakeClock(T0 + 20 * 60_000), state.dir, { sessionsDir: join(state.dir, "sessions") });
  await deps.registry.write(lane(state.dir));
  world.screens["lead:p1"] = ` [REPORT] rl-e7 | milestone | ${loop[1]?.text}\n\n❯ `;
  expect((await freshnessTick(deps, "/home/test")).filter((a) => a.kind === "stuck")).toEqual([]);
  const pass = ev(260, "model_800 F1: 교착 1 PASS");
  writeFileSync(file, `${[...loop, pass].map(line).join("\n")}\n`);
  world.screens["lead:p1"] = ` [REPORT] rl-e7 | milestone | ${pass.text}\n\n❯ `;
  const later = { ...deps, clock: fakeClock(T0 + 270 * 60_000) };
  expect((await freshnessTick(later, "/home/test")).filter((a) => a.kind === "stuck")).toEqual([]);
  const after = (await deps.registry.read("rl-e7")) as Lane;
  expect(after.inferred?.counts).toEqual({});
  expect(after.inferred?.passedAt).toEqual({ "교착": at(260) });
  expect(sent(world)).toEqual([]);
});

test("owner-check reads every report since the last check, not only the newest six (challenge, gpt-6-astra)", async () => {
  writeFileSync(join(state.dir, "brief.md"), "# \ube0c\ub9ac\ud504\n\ud559\uc2b5\uc740 \uba48\ucd94\uc9c0 \ub9d0\uace0");
  const reports = Array.from({ length: 9 }, (_, i) => sessionLine(10 + i, "assistant", `[REPORT] rl-e7 | milestone | \uc9c4\ud589 ${i}: ${i === 0 ? "\ud559\uc2b5\uc744 \uba48\ucda4" : "\uc815\uc0c1 \uc9c4\ud589"}`));
  const file = writeSession([sessionLine(1, "assistant", "[REPORT] rl-e7 | milestone | \uc2dc\uc791"), ...reports]);
  const prompts: string[] = [];
  const base = fakeRunner(world);
  const run: Runner = async (argv, opts) => {
    if (argv[0] !== "omo") return base(argv, opts);
    prompts.push(argv.at(-1) ?? "");
    return { code: 0, out: "VERDICT: OK", err: "" };
  };
  const explore = { ...defaultConfig("/home/test").explore, modelsCommand: [] };
  const deps = { ...depsFor(world, fakeClock(T0 + 60 * 60_000), state.dir, { sessionsDir: join(state.dir, "sessions"), explore }), run };
  const checked = { ...lane(state.dir), ownerCheck: { at: at(5), lastReportAt: at(1), day: at(0).slice(0, 10), today: 1, model: "m", kinds: ["OK"] } };
  await deps.registry.write(checked);
  const r = await runOwnerCheck(deps, checked, { files: [file] });
  expect(r.lines[0]).toContain("OWNER_CHECK rl-e7 OK 9 recent reports");
  expect(prompts[0]).toContain("\uc9c4\ud589 0: \ud559\uc2b5\uc744 \uba48\ucda4");
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

test("owner-check asks a reviewer of another family from the one reviewers list, ownerCheck.first in front, and skips the next run until a new report", async () => {
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
  expect(asked.map((a) => a[a.indexOf("--model") + 1])).toEqual(["chatgpt-subscription/gpt-6.1-sol", "chatgpt-subscription/gpt-6-astra"]);
  const prompt = asked[1]?.at(-1) ?? "";
  expect(prompt).toContain("\ud559\uc2b5\uc740 \uba48\ucd94\uc9c0 \ub9d0\uace0 \ube44\uad50\ud45c\ub97c \ub9cc\ub4e4\uc5b4\ub77c");
  expect(prompt).not.toContain("\uc9c0\ub09c lane \uae30\ub85d");
  expect(prompt).toContain("[LEAD] \ud615 \uc9c0\uc2dc(\uc6d0\ubb38 https://discord.com/channels/1/2/3)");
  expect(r.lines).toHaveLength(2);
  expect(r.lines[0]).toMatch(/^OWNER_CHECK rl-e7 VIOLATION owner "\ud559\uc2b5\uc740 \uba48\ucd94\uc9c0 \ub9d0\uace0" vs report .*\[reviewer chatgpt-subscription\/gpt-6-astra\]$/);
  // the finding is the stuck ladder's context rung: one STUCK line in the log, and the lead confirms before the lane re-reads
  expect(r.lines[1]).toMatch(/^STUCK rl-e7 "@context" rung context \(VIOLATION: owner .*-> confirm the finding, then dori owner-check rl-e7 --reread .*\[OWNER_CHECK_VIOLATION\]$/);
  const log = await Bun.file(deps.config.watchLog).text();
  expect(log).toContain('stuck STUCK rl-e7 "@context" rung context');
  expect(log).not.toContain("owner-check OWNER_CHECK rl-e7 VIOLATION");
  expect(sent(world)).toEqual([]);
  const after = (await deps.registry.read("rl-e7")) as Lane;
  expect(after.ownerCheck?.kinds).toEqual(["VIOLATION"]);
  const again = await runOwnerCheck(deps, after, { files: [file], force: true });
  expect(again.skipped).toContain("OWNER_CHECK_SKIP rl-e7 no new report");
  expect(asked).toHaveLength(2);
});

test("intent-check's call needs no new report; a finding again in the next check is rung 4, a clean check ends the context rung, and --reread sends the lane its brief only on a finding", async () => {
  writeFileSync(join(state.dir, "brief.md"), "# 브리프\n학습은 멈추지 말고");
  const file = writeSession([sessionLine(1, "assistant", "[REPORT] rl-e7 | milestone | 진행: 학습을 멈추고 비교표를 만듦")]);
  let reply = VIOLATION;
  const base = fakeRunner(world);
  const run: Runner = async (argv, opts) => (argv[0] !== "omo" ? base(argv, opts) : { code: 0, out: reply, err: "" });
  const explore = { ...defaultConfig("/home/test").explore, modelsCommand: [] };
  const deps = { ...depsFor(world, fakeClock(T0 + 10 * 60_000), state.dir, { sessionsDir: join(state.dir, "sessions"), explore }), run };
  const l = { ...lane(state.dir), direction: { at: at(2), text: "비교표 만들기", next: "학습 재개" } };
  await deps.registry.write(l);
  expect((await sendReread(deps, l)).line).toStartWith("REREAD_REFUSED rl-e7: the last owner check found nothing");
  const first = await runOwnerCheck(deps, l, { files: [file] });
  expect(first.lines.at(-1)).toContain('"@context" rung context');
  // no new report since: a regular check skips, the intent-check call (direction) runs anyway
  expect((await runOwnerCheck(deps, (await deps.registry.read("rl-e7")) as Lane, { files: [file], force: true })).skipped).toContain("no new report");
  // the same finding again before the lead confirmed a re-read: still the context rung, no new line (challenge, grok-4.7)
  const second = await runOwnerCheck(deps, (await deps.registry.read("rl-e7")) as Lane, { files: [file], direction: true });
  expect(second.lines).toHaveLength(1);
  const reread = await sendReread(deps, (await deps.registry.read("rl-e7")) as Lane);
  expect(reread.ok).toBe(true);
  expect(sent(world)).toHaveLength(1);
  // after the confirmed re-read the lane is still off the owner's words: rung 4
  const third = await runOwnerCheck(deps, (await deps.registry.read("rl-e7")) as Lane, { files: [file], direction: true });
  expect(third.lines.at(-1)).toMatch(/^STUCK rl-e7 "@context" rung 4 \(VIOLATION: .*the owner check found the lane off the owner's words again \(3 checks in a row\).*\[OWNER_CHECK_VIOLATION ROLLOVER_DUE\]$/);
  expect(sent(world)[0]).toStartWith("[LEAD] Your last report breaks what the owner asked (VIOLATION owner");
  expect(sent(world)[0]).toContain(join(state.dir, "brief.md"));
  reply = "VERDICT: OK";
  const clean = await runOwnerCheck(deps, (await deps.registry.read("rl-e7")) as Lane, { files: [file], direction: true });
  expect(clean.lines).toHaveLength(1);
  expect(clean.lines[0]).toStartWith("OWNER_CHECK rl-e7 OK");
  expect(((await deps.registry.read("rl-e7")) as Lane).stuck?.["@context"]).toBeUndefined();
  expect((await sendReread(deps, (await deps.registry.read("rl-e7")) as Lane)).line).toStartWith("REREAD_REFUSED rl-e7: the last owner check found nothing");
  expect(sent(world)).toHaveLength(1);
});

test("a quoted report template is no report, and a CONTRADICTION that only names claim-done with no claim on record stays off the ladder (live false alarm, 2026-10-12 00:48:02Z)", async () => {
  writeFileSync(join(state.dir, "brief.md"), "# 로컨 정리\nDone = steps 0, 7a, 6, 5, 7b done and verified");
  // the lane's goal quoted its own report template; the reader took it for a done report
  const template = "[REPORT] rl-e7 | done | ...` (KST) is sent to the lead pane via tmux send-keys argv, and `dori claim-done rl-e7 --evidence ...` ran.";
  const file = writeSession([sessionLine(1, "assistant", template), sessionLine(2, "assistant", "[REPORT] rl-e7 | milestone | 7a 완료, 남은 일: 5단계. 끝나면 dori claim-done rl-e7 --evidence ... 실행 예정")]);
  expect((await readReports([file], "rl-e7")).map((r) => r.text)).toEqual(["7a 완료, 남은 일: 5단계. 끝나면 dori claim-done rl-e7 --evidence ... 실행 예정"]);
  const reply = 'VERDICT: CONTRADICTION\nOWNER: "Done = steps 0, 7a, 6, 5, 7b done and verified"\nREPORT: "끝나면 dori claim-done rl-e7 --evidence ... 실행 예정"\nWHY: 완료를 선언했지만 직전 보고에서 5단계를 남은 작업으로 명시했다.';
  const prompts: string[] = [];
  const base = fakeRunner(world);
  const run: Runner = async (argv, opts) => {
    if (argv[0] !== "omo") return base(argv, opts);
    prompts.push(argv.at(-1) ?? "");
    return { code: 0, out: reply, err: "" };
  };
  const explore = { ...defaultConfig("/home/test").explore, modelsCommand: [] };
  const deps = { ...depsFor(world, fakeClock(T0 + 10 * 60_000), state.dir, { sessionsDir: join(state.dir, "sessions"), explore }), run };
  await deps.registry.write(lane(state.dir));
  const r = await runOwnerCheck(deps, lane(state.dir), { files: [file] });
  expect(prompts[0]).toContain("Done claim on record: none: the lane has not run dori claim-done (status working)");
  expect(prompts[0]).not.toContain("| done | ...");
  expect(r.findings[0]).toMatchObject({ kind: "CONTRADICTION", verified: false });
  expect(r.lines).toHaveLength(1);
  const log = await Bun.file(deps.config.watchLog).text();
  expect(log).toContain("owner-check OWNER_CHECK rl-e7 CONTRADICTION");
  expect(log).toContain("[no done claim is on record; the quote only names the claim-done command]");
  expect(log).not.toContain("STUCK");
  expect(((await deps.registry.read("rl-e7")) as Lane).stuck).toBeUndefined();
  // with a claim on record the same finding stands
  const claimed = { claim: { at: at(3), evidence: "merged o/r#1" } };
  expect(claimCheck({ kind: "CONTRADICTION", owner: "x", report: "dori claim-done rl-e7 ran", why: "w", verified: true }, claimed).verified).toBe(true);
  expect(claimCheck({ kind: "CONTRADICTION", owner: "x", report: "dori claim-done rl-e7 ran", why: "w", verified: true }, {}).verified).toBe(false);
});

test("a PASS in a report lowers a tagged-only metric's rung, and clears an --improved baseline (challenge, gpt-6-astra)", async () => {
  const deps = depsFor(world, fakeClock(T0 + 220 * 60_000), state.dir, { sessionsDir: join(state.dir, "sessions"), explore: { ...defaultConfig("/home/test").explore, sendResearchToLane: false } });
  await deps.registry.write({ ...lane(state.dir), inferred: { at: at(0), counts: {}, baseline: { "\uad50\ucc29": 3 } } });
  for (let i = 0; i < 3; i++) await recordFix(deps, "rl-e7", { at: at(i), metric: "\uad50\ucc29", hypothesis: `h${i}`, via: "report" });
  expect(((await deps.registry.read("rl-e7")) as Lane).stuck?.["\uad50\ucc29"]).toMatchObject({ rung: 3, n: 3 });
  writeSession([sessionLine(200, "assistant", "[REPORT] rl-e7 | milestone | model_800 F1: \uad50\ucc29 1 PASS")]);
  world.screens["lead:p1"] = " [REPORT] rl-e7 | milestone | model_800 F1: \uad50\ucc29 1 PASS\n\n\u276f ";
  expect((await freshnessTick(deps, "/home/test")).filter((a) => a.kind === "stuck")).toEqual([]);
  const after = (await deps.registry.read("rl-e7")) as Lane;
  expect(after.stuck?.["\uad50\ucc29"]).toMatchObject({ rung: 0, n: 0 });
  expect(after.inferred?.baseline).toBeUndefined();
});

test("intent-check's direction is evidence: a finding that quotes it is verified and climbs the ladder (challenge, gpt-6-astra)", async () => {
  writeFileSync(join(state.dir, "brief.md"), "# \ube0c\ub9ac\ud504\n\ud559\uc2b5\uc740 \uba48\ucd94\uc9c0 \ub9d0\uace0");
  const reply = 'VERDICT: VIOLATION\nOWNER: "\ud559\uc2b5\uc740 \uba48\ucd94\uc9c0 \ub9d0\uace0"\nREPORT: "\ud559\uc2b5\uc744 \uba48\ucd94\uace0 \ube44\uad50\ud45c\ub9cc \ub9cc\ub4e0\ub2e4"\nWHY: the owner said keep training.';
  const base = fakeRunner(world);
  const run: Runner = async (argv, opts) => (argv[0] !== "omo" ? base(argv, opts) : { code: 0, out: reply, err: "" });
  const explore = { ...defaultConfig("/home/test").explore, modelsCommand: [] };
  const deps = { ...depsFor(world, fakeClock(T0 + 10 * 60_000), state.dir, { sessionsDir: join(state.dir, "sessions"), explore }), run };
  const l = { ...lane(state.dir), direction: { at: at(1), text: "\ud559\uc2b5\uc744 \uba48\ucd94\uace0 \ube44\uad50\ud45c\ub9cc \ub9cc\ub4e0\ub2e4", next: "\ud45c \uc815\ub9ac" } };
  await deps.registry.write(l);
  const r = await runOwnerCheck(deps, l, { files: [], direction: true });
  expect(r.findings[0]?.verified).toBe(true);
  expect(r.lines.at(-1)).toContain('"@context" rung context');
});

test("a report is read only where one is sent or received: a template in a goal's arguments or in the agent's own text is none (challenge, grok-4.7)", async () => {
  const goalCall = JSON.stringify({ type: "message", timestamp: at(1), message: { role: "assistant", content: [{ type: "toolCall", name: "create_goal", arguments: { objective: "stop when [REPORT] rl-e7 | done | merged, claim-done ran" } }] } });
  const ownText = JSON.stringify({ type: "message", timestamp: at(2), message: { role: "assistant", content: [{ type: "text", text: "I will send [REPORT] rl-e7 | done | all checks green" }] } });
  const typed = JSON.stringify({ type: "message", timestamp: at(3), message: { role: "assistant", content: [{ type: "toolCall", name: "eval", arguments: { code: 'await run(["dori","type","lead","--text","[REPORT] rl-e7 | milestone | step 2 done"])' } }] } });
  const file = writeSession([goalCall, ownText, typed, sessionLine(4, "user", "[REPORT] rl-e7 | milestone | lead copy of step 3")]);
  expect((await readReports([file], "rl-e7")).map((r) => r.text)).toEqual(['step 2 done"])', "lead copy of step 3"].map((t) => t.replace(/"\]\)$/, "")));
});

test("a condition name is no metric, and a failure investigated by hypothesis discrimination is no repeat (live false alarm REPEAT_SUSPECT hr35-e7 \"양토\" 3, 2026-10-12 01:05:19Z)", async () => {
  const chain = (await Bun.file(join(import.meta.dir, "fixtures/hr35-e7-yangto-chain.json")).json()) as LaneEvent[];
  const state = inferRepeats(chain, cfg);
  expect([...state.counts.keys()]).not.toContain("\uc591\ud1a0");
  expect(failedMetrics("FAIL 2: \uad50\ucc29 113(\uc591\ud1a0 1.0 61\u00b7\uc591\ud1a0 0.8 33\u00b7\uc810\ud1a0 0.8 14)", cfg)).toEqual(["\uad50\ucc29"]);
  // without the condition list the old reading comes back: the soil type becomes a metric counted 3 times
  expect(inferRepeats(chain, { ...cfg, conditionWords: [], discriminationPattern: "$^" }).counts.get("\uc591\ud1a0")?.n).toBe(3);
  // a fail, then a discrimination (dori tree H1~H6), then an attempt: not a cycle; a new fail and a new attempt are
  const loop = [ev(0, "\uad50\ucc29 9 FAIL"), ev(40, "\uac00\uc124 \ud310\ubcc4(dori tree H1~H3): H1 \uae30\uac01"), ev(80, "\uc870\uc815 5: \uad50\ucc29 \ubc8c\uc810")];
  expect(inferRepeats(loop, cfg).counts.size).toBe(0);
  expect(inferRepeats([...loop, ev(120, "\uad50\ucc29 7 FAIL"), ev(160, "\uc870\uc815 6: \uad50\ucc29 \ubc8c\uc810")], cfg).counts.get("\uad50\ucc29")?.n).toBe(1);
});
