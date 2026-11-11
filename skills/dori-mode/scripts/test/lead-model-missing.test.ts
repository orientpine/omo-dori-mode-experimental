import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionFile } from "../src/background.ts";
import { makeBacklogDeps } from "../src/cli-deps-backlog.ts";
import { herdrLeadSession, readHerdrSessions, recordHerdrSession } from "../src/herdr-sessions.ts";
import { leadModel } from "../src/lane-model.ts";
import { leadDownTick } from "../src/lead-down.ts";
import { LaunchError, launchLane } from "../src/launch.ts";
import type { Runner } from "../src/run.ts";
import { sessionDirFor } from "../src/session-id.ts";
import { depsFor, fakeClock, fakeRunner, newWorld, type World } from "./fakes.ts";

// A lane runs the model its lead runs now, or none (owner 2026-11-11: "리드 모델을 읽지 못하면 기존 model을 지우지 않고 유지하고,
// launch는 기본 Kimi 대신 실제 리드 모델을 읽거나 멈춘다"): the lead's session log decides, a startup --model never does.
let world: World;
let dir: string;
beforeEach(() => {
  world = newWorld();
  dir = mkdtempSync(join(tmpdir(), "lead-model-missing-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const LEAD = "kimi-coding/k3.1-pro:max";
const OPUS = "anthropic-subscription/claude-opus-5-5:medium";
const omo = (patch = {}) => depsFor(world, fakeClock(0), dir, { backend: "herdr", leadPane: "w1:p37", ...patch });
const readsLogs = process.platform === "linux" || process.platform === "win32";

test("launch reads a blank lead record's current transcript instead of starting on defaultModel", async () => {
  const brief = join(dir, "brief.md");
  await Bun.write(brief, "# brief\n");
  const id = "11111111-2222-4333-8444-555555555555";
  const log = join(dir, `2026-11-11T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(log, `${JSON.stringify({ type: "model_change", provider: "anthropic-subscription", modelId: "claude-opus-5-5" })}\n${JSON.stringify({ type: "thinking_level_change", thinkingLevel: "medium", provider: "anthropic-subscription", modelId: "claude-opus-5-5" })}\n`);
  recordHerdrSession(dir, "w2:p2", { session: id, cwd: dir, at: new Date(0).toISOString() });
  recordHerdrSession(dir, "w1:pA", { session: "old-lead", cwd: dir, model: LEAD, at: new Date(0).toISOString() });
  world.panes = [{ pane_id: "w2:p2", workspace_id: "w2", cwd: dir }];
  world.ps = `4000 1 -bash\n4001 4000 omo --session-id ${id}\n4002 4001 python3 -u prelude.py`;
  const deps = omo({ leadPane: "w2:p2", sessionsDir: join(dir, "sessions"), agentCommand: ["omo", "--thinking", "low", "--model", "{model}", "{prompt}"] });
  const run: Runner = async (argv, o) => {
    if (argv[0] === "ps" && argv[1] === "eww" && argv.at(-1) === "4002") return { code: 0, out: `python3 -u prelude.py PI_SESSION_ID=${id} PI_SESSION_FILE=${log}`, err: "" };
    if (argv[1] === "tab" && argv[2] === "create") return { code: 0, out: JSON.stringify({ result: { root_pane: { pane_id: "w2:p9", tab_id: "w2:t9" } } }), err: "" };
    return deps.run(argv, o);
  };
  const recovered = (await launchLane({ ...deps, run, readGoal: async () => ({ status: "active" }) }, { noThread: "QA", key: "recovered", title: "recovered", brief, done: "file /x", cwd: "/tmp" })).lane;
  expect(recovered.model).toBe(OPUS);
  expect(recovered.modelPinned).toBeUndefined();
  expect(readHerdrSessions(dir)["w2:p2"]?.model).toBe(OPUS);
  expect(world.calls.some((c) => c.join(" ").includes("--model anthropic-subscription/claude-opus-5-5 --thinking medium ") && !c.join(" ").includes("--thinking low"))).toBe(true);
});

test("launch without --model refuses an unknown current lead model before writing, opening, or registering", async () => {
  const brief = join(dir, "brief.md");
  await Bun.write(brief, "# brief\n");
  const deps = omo({ leadPane: "w2:p2", sessionsDir: join(dir, "sessions") });
  recordHerdrSession(dir, "w2:p2", { session: "new-current", cwd: dir, at: new Date(0).toISOString() });
  recordHerdrSession(dir, "w1:pA", { session: "old-lead", cwd: dir, model: OPUS, at: new Date(0).toISOString() });
  const failure = await launchLane({ ...deps, run: async (argv, o) => (argv[1] === "tab" && argv[2] === "create" ? { code: 0, out: JSON.stringify({ result: { root_pane: { pane_id: "w2:p11", tab_id: "w2:t11" } } }), err: "" } : deps.run(argv, o)), readGoal: async () => ({ status: "active" }) }, { noThread: "QA", key: "unknown", title: "unknown", brief, done: "file /x", cwd: "/tmp" }).catch((e: unknown) => e);
  if (!(failure instanceof LaunchError)) throw new Error("launch did not refuse the unknown lead model");
  expect(failure.message).toContain("LAUNCH_LEAD_MODEL_MISSING w2:p2");
  expect(await Bun.file(brief).text()).toBe("# brief\n");
  expect(world.calls.some((c) => c[1] === "tab" && c[2] === "create")).toBe(false);
  expect(world.calls.some((c) => c.join(" ").includes(deps.config.defaultModel))).toBe(false);
  expect(await deps.registry.read("unknown")).toBeNull();
});

// A live lead w2:p2 started with --model startup, whose session log (PI_SESSION_FILE) is log; a new tab opens as w2:p9.
const liveLead = (base: Runner, id: string, log: string, startup = "kimi-coding/k3.1-pro"): Runner => {
  world.panes = [{ pane_id: "w2:p2", workspace_id: "w2", cwd: dir }];
  world.ps = `4000 1 -bash\n4001 4000 omo --session-id ${id} --model ${startup}\n4002 4001 python3 -u prelude.py`;
  return async (argv, o) => {
    if (argv[0] === "ps" && argv[1] === "eww" && argv.at(-1) === "4002") return { code: 0, out: `python3 -u prelude.py PI_SESSION_ID=${id} PI_SESSION_FILE=${log}`, err: "" };
    if (argv[1] === "tab" && argv[2] === "create") return { code: 0, out: JSON.stringify({ result: { root_pane: { pane_id: "w2:p9", tab_id: "w2:t9" } } }), err: "" };
    return base(argv, o);
  };
};
const ID = "11111111-2222-4333-8444-666666666666";
const changes = (...models: readonly [string, string][]): string => models.map(([m, level]) => { const [provider, modelId] = m.split("/"); return `${JSON.stringify({ type: "model_change", provider, modelId })}\n${JSON.stringify({ type: "thinking_level_change", thinkingLevel: level, provider, modelId })}\n`; }).join("");

test("launch with a blank lead record and an unreadable transcript stops, and never takes the lead's startup --model", async () => {
  const brief = join(dir, "brief.md");
  await Bun.write(brief, "# brief\n");
  const deps = omo({ leadPane: "w2:p2", sessionsDir: join(dir, "sessions") });
  recordHerdrSession(dir, "w2:p2", { session: ID, cwd: dir, at: new Date(0).toISOString() });
  const run = liveLead(deps.run, ID, join(dir, `gone_${ID}.jsonl`));
  const failure = await launchLane({ ...deps, run, readGoal: async () => ({ status: "active" }) }, { noThread: "QA", key: "stale", title: "stale", brief, done: "file /x", cwd: "/tmp" }).catch((e: unknown) => e);
  if (!(failure instanceof LaunchError)) throw new Error("launch started a lane on the lead's startup model");
  expect(failure.message).toContain("LAUNCH_LEAD_MODEL_MISSING w2:p2");
  expect(world.calls.some((c) => c[1] === "tab" && c[2] === "create")).toBe(false);
  expect(await deps.registry.read("stale")).toBeNull();
});

test("dori lead records the model the lead's session log changed to with /model; a startup --model alone is marked argv and no lane follows it", async () => {
  const config = omo({ leadPane: "w2:p2", sessionsDir: join(dir, "sessions") }).config;
  const log = join(dir, `2026-11-11T00-00-00-000Z_${ID}.jsonl`);
  writeFileSync(log, changes(["kimi-coding/k3.1-pro", "max"], ["anthropic-subscription/claude-opus-5-5", "medium"]));
  await herdrLeadSession(liveLead(omo().run, ID, log), config, "w2:p2", true);
  expect(readHerdrSessions(dir)["w2:p2"]?.model).toBe(OPUS);
  rmSync(join(dir, "herdr-sessions.json"));
  await herdrLeadSession(liveLead(omo().run, ID, join(dir, `gone_${ID}.jsonl`)), config, "w2:p2", true);
  expect(readHerdrSessions(dir)["w2:p2"]).toMatchObject({ session: ID, model: "kimi-coding/k3.1-pro", modelFrom: "argv" });
  expect(leadModel(config)).toBeUndefined();
  writeFileSync(log, changes(["anthropic-subscription/claude-opus-5-5", "medium"]));
  await herdrLeadSession(liveLead(omo().run, ID, log), config, "w2:p2", true);
  expect(readHerdrSessions(dir)["w2:p2"]?.modelFrom).toBeUndefined();
  expect(leadModel(config)).toBe(OPUS);
});

test("the backlog checks the quota of the model a blank lead record resolves to from the transcript, not defaultModel's", async () => {
  const deps = omo({ leadPane: "w2:p2", sessionsDir: join(dir, "sessions"), defaultModel: LEAD });
  const log = join(dir, `2026-11-11T00-00-00-000Z_${ID}.jsonl`);
  writeFileSync(log, changes(["anthropic-subscription/claude-opus-5-5", "medium"]));
  writeFileSync(join(dir, "credential-pool-state.json"), JSON.stringify({ providers: { "anthropic-subscription": { lanes: { a: { slots: { s: { blockedUntil: Date.now() + 3_600_000 } } } } } } }));
  recordHerdrSession(dir, "w2:p2", { session: ID, cwd: dir, at: new Date(0).toISOString() });
  const { backlogDeps } = makeBacklogDeps({ config: deps.config, deps: { ...deps, run: liveLead(deps.run, ID, log) }, discordToken: undefined });
  expect(await backlogDeps().limited()).toContain("no anthropic-subscription account is free");
});

test("launch reads the lead's /model from its transcript over a model cached before it", async () => {
  const brief = join(dir, "brief.md");
  await Bun.write(brief, "# brief\n");
  const deps = omo({ leadPane: "w2:p2", sessionsDir: join(dir, "sessions") });
  const log = join(dir, `2026-11-11T00-00-00-000Z_${ID}.jsonl`);
  writeFileSync(log, changes(["kimi-coding/k3.1-pro", "max"], ["anthropic-subscription/claude-opus-5-5", "medium"]));
  recordHerdrSession(dir, "w2:p2", { session: ID, cwd: dir, model: LEAD, log, at: new Date().toISOString() });
  const lane = (await launchLane({ ...deps, run: liveLead(deps.run, ID, log), readGoal: async () => ({ status: "active" }) }, { noThread: "QA", key: "moved", title: "moved", brief, done: "file /x", cwd: "/tmp" })).lane;
  expect(lane.model).toBe(OPUS);
  expect(readHerdrSessions(dir)["w2:p2"]?.model).toBe(OPUS);
});

test("launch --model wins when the current lead model is unknown", async () => {
  const brief = join(dir, "brief.md");
  await Bun.write(brief, "# brief\n");
  const deps = omo({ leadPane: "w2:p2", sessionsDir: join(dir, "sessions") });
  const run: Runner = async (argv, o) => (argv[1] === "tab" && argv[2] === "create" ? { code: 0, out: JSON.stringify({ result: { root_pane: { pane_id: "w2:p10", tab_id: "w2:t10" } } }), err: "" } : deps.run(argv, o));
  const own = (await launchLane({ ...deps, run, readGoal: async () => ({ status: "active" }) }, { noThread: "QA", key: "own", title: "own", brief, done: "file /x", cwd: "/tmp", model: "x/own:high" })).lane;
  expect(own).toMatchObject({ model: "x/own:high", modelPinned: true });
  expect(world.calls.some((c) => c.join(" ").includes("--model x/own --thinking high "))).toBe(true);
});

test.if(readsLogs)("a /model reaches the lead's record within 10 minutes though owner-row session reads keep rewriting its time", async () => {
  const id = "11111111-2222-4333-8444-555555555555";
  const patch = { backend: "herdr" as const, leadPane: "w1:p1", leadReviveMin: 5, sessionsDir: dir };
  const logDir = sessionDirFor(dir, dir);
  mkdirSync(logDir, { recursive: true });
  const log = join(logDir, `2026-11-11T07-00-00-000Z_${id}.jsonl`);
  const entry = (e: object) => `${JSON.stringify(e)}\n`;
  writeFileSync(log, entry({ type: "session", id, cwd: dir }) + entry({ type: "model_change", provider: "p", modelId: "m" }) + entry({ type: "thinking_level_change", thinkingLevel: "high", provider: "p", modelId: "m" }));
  world.panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: dir }];
  world.ps = `4000 1 -bash\n4001 4000 omo --session-id ${id} --model p/m:high`;
  world.agentStart = "Wed Nov 11 07:00:00 2026";
  const t0 = Date.parse("2026-11-11T07:00:00Z");
  try {
    setSystemTime(new Date(t0));
    await leadDownTick(depsFor(world, fakeClock(t0), dir, patch));
    expect(readHerdrSessions(dir)["w1:p1"]?.model).toBe("p/m:high");
    appendFileSync(log, entry({ type: "model_change", provider: "p", modelId: "n" }) + entry({ type: "thinking_level_change", thinkingLevel: "low", provider: "p", modelId: "n" }));
    // 11 minutes on, an owner row's lead-limit check reads the lead's session (background.ts sessionFile) just before the tick
    const later = t0 + 11 * 60_000;
    setSystemTime(new Date(later));
    await sessionFile(fakeRunner(world), dir, "w1:p1", dir, undefined, dir);
    expect(Date.parse(readHerdrSessions(dir)["w1:p1"]?.at ?? "")).toBe(later);
    await leadDownTick(depsFor(world, fakeClock(later), dir, patch));
    expect(readHerdrSessions(dir)["w1:p1"]?.model).toBe("p/n:low");
  } finally {
    setSystemTime();
  }
});
