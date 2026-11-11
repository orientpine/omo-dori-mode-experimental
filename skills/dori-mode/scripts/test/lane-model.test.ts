import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBacklogDeps } from "../src/cli-deps-backlog.ts";
import { herdrLeadSession, readHerdrSessions, recordHerdrSession } from "../src/herdr-sessions.ts";
import { keepSessions, type LaneHandoverDeps, recover } from "../src/lane-handover.ts";
import { keptModel, laneModel, leadModel, modelMove, moveThinking, resolveLeadModel, withThinking } from "../src/lane-model.ts";
import { LaunchError, launchLane } from "../src/launch.ts";
import type { Runner } from "../src/run.ts";
import { depsFor, fakeClock, newWorld, type World } from "./fakes.ts";

// A lane runs its lead's model (owner 2026-11-10): launch and handover read the lead's of now from herdr-sessions.json.
let world: World;
let dir: string;
beforeEach(() => {
  world = newWorld();
  dir = mkdtempSync(join(tmpdir(), "lane-model-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const LEAD = "kimi-coding/k3.1-pro:max";
const OPUS = "anthropic-subscription/claude-opus-5-5:medium";
const omo = (patch = {}) => depsFor(world, fakeClock(0), dir, { backend: "herdr", leadPane: "w1:p37", ...patch });
const leadRuns = (model: string) => recordHerdrSession(dir, "w1:p37", { session: "lead-sid", cwd: dir, model, at: new Date(0).toISOString() });

test("the lead's model is the one recorded for its pane, and none while nothing is recorded", () => {
  const { config } = omo();
  expect(leadModel(config)).toBeUndefined();
  leadRuns(LEAD);
  expect(leadModel(config)).toBe(LEAD);
  expect(leadModel({ ...config, leadPane: "w9:p9" })).toBeUndefined();
});

test("a model-less rewrite keeps the current pane's last model and leaves the old lead's record alone", () => {
  recordHerdrSession(dir, "w2:p2", { session: "previous-current", cwd: dir, model: LEAD, at: new Date(0).toISOString() });
  recordHerdrSession(dir, "w1:pA", { session: "old-lead", cwd: dir, model: OPUS, at: new Date(0).toISOString() });
  recordHerdrSession(dir, "w2:p2", { session: "new-current", cwd: dir, at: new Date(1).toISOString() });
  const all = readHerdrSessions(dir);
  expect(all["w2:p2"]?.model).toBe(LEAD);
  expect(all["w1:pA"]?.model).toBe(OPUS);
  recordHerdrSession(dir, "w2:p2", { session: "newer-current", cwd: dir, model: "x/startup", modelFrom: "argv", at: new Date(2).toISOString() });
  expect(readHerdrSessions(dir)["w2:p2"]).toMatchObject({ session: "newer-current", model: LEAD });
  expect(readHerdrSessions(dir)["w2:p2"]?.modelFrom).toBeUndefined();
});

test("a lane's next session takes the lead's model of now; a model chosen now or before wins; with no lead known the lane keeps its own", () => {
  const { config } = omo();
  const lane = { model: "anthropic-subscription/claude-opus-5-5:medium" };
  expect(laneModel(config, lane)).toEqual({ model: lane.model, lead: false });
  leadRuns(LEAD);
  expect(laneModel(config, lane)).toEqual({ model: LEAD, lead: true });
  // the lead moved to another model: the lane follows at its next move
  leadRuns("anthropic-subscription/claude-opus-5-5:medium");
  expect(laneModel(config, { model: LEAD })).toEqual({ model: "anthropic-subscription/claude-opus-5-5:medium", lead: true });
  expect(laneModel(config, { ...lane, modelPinned: true })).toEqual({ model: lane.model, lead: false });
  expect(laneModel(config, lane, "x/own:high")).toEqual({ model: "x/own:high", lead: false });
});

test("after a move the registry names the model and level the new session runs, and keeps the mark of a chosen one", async () => {
  const deps = omo();
  await deps.registry.write({ key: "k", title: "k", thread: "none", brief: "/b", done: "file /x", openedAt: "2026-01-01T00:00:00Z", model: "kimi-coding/k3.1-pro:max" });
  await keepSessions(deps, "k", "old-sid", "new-sid", keptModel({}, "anthropic-subscription/claude-opus-5-5", "medium"));
  expect(await deps.registry.read("k")).toMatchObject({ session: "new-sid", priorSessions: ["old-sid"], model: "anthropic-subscription/claude-opus-5-5:medium" });
  expect((await deps.registry.read("k"))?.modelPinned).toBeUndefined();
  expect(keptModel({}, "x/own", undefined, "x/own")).toEqual({ model: "x/own", modelPinned: true });
  expect(keptModel({ modelPinned: true }, "x/own", "low")).toEqual({ model: "x/own:low", modelPinned: true });
});

test("launch without --model starts the lane on its lead's model of now and leaves it unpinned; --model pins its own", async () => {
  const brief = join(dir, "brief.md");
  await Bun.write(brief, "# brief\n");
  const deps = omo({ agentCommand: ["omo", "--thinking", "low", "--model", "{model}", "{prompt}"] });
  leadRuns(LEAD);
  let n = 1;
  const run: Runner = async (argv, o) => (argv[1] === "tab" && argv[2] === "create" ? { code: 0, out: JSON.stringify({ result: { root_pane: { pane_id: `w1:p${++n}`, tab_id: `w1:t${n}` } } }), err: "" } : deps.run(argv, o));
  const launch = (key: string, model?: string) => launchLane({ ...deps, run, readGoal: async () => ({ status: "active" }) }, { noThread: "QA", key, title: key, brief, done: "file /x", cwd: "/tmp", ...(model ? { model } : {}) });
  const follow = (await launch("follow")).lane;
  expect(follow.model).toBe(LEAD);
  expect(follow.modelPinned).toBeUndefined();
  // an omo agent gets the level as its own --thinking, over the template's
  expect(world.calls.some((c) => c.join(" ").includes("--model kimi-coding/k3.1-pro --thinking max ") && !c.join(" ").includes("--thinking low"))).toBe(true);
  // the lead moving on while the brief renders (its work thread opens between two renders): the lane runs and records one model
  const moving = await launchLane({ ...deps, run, readGoal: async () => ({ status: "active" }), openThread: async () => {
      leadRuns("anthropic-subscription/claude-opus-5-5:medium");
      return "discord:9";
    } }, { thread: "new", key: "moving", title: "moving", brief, done: "file /x", cwd: "/tmp" });
  expect(moving.lane.model).toBe(LEAD);
  leadRuns(LEAD);
  const own = (await launch("own", "anthropic-subscription/claude-opus-5-5:medium")).lane;
  expect(own).toMatchObject({ model: "anthropic-subscription/claude-opus-5-5:medium", modelPinned: true });
});

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

test("launch --model wins when the current lead model is unknown", async () => {
  const brief = join(dir, "brief.md");
  await Bun.write(brief, "# brief\n");
  const deps = omo({ leadPane: "w2:p2", sessionsDir: join(dir, "sessions") });
  const run: Runner = async (argv, o) => (argv[1] === "tab" && argv[2] === "create" ? { code: 0, out: JSON.stringify({ result: { root_pane: { pane_id: "w2:p10", tab_id: "w2:t10" } } }), err: "" } : deps.run(argv, o));
  const own = (await launchLane({ ...deps, run, readGoal: async () => ({ status: "active" }) }, { noThread: "QA", key: "own", title: "own", brief, done: "file /x", cwd: "/tmp", model: "x/own:high" })).lane;
  expect(own).toMatchObject({ model: "x/own:high", modelPinned: true });
  expect(world.calls.some((c) => c.join(" ").includes("--model x/own --thinking high "))).toBe(true);
});

test("an omo agent gets the model's level as its own --thinking, over one of the template; a model with no level leaves the argv as it is", () => {
  expect(withThinking(["omo", "--session-id", "s", "--model", LEAD, "do it"], LEAD)).toEqual(["omo", "--session-id", "s", "--model", "kimi-coding/k3.1-pro", "--thinking", "max", "do it"]);
  expect(withThinking(["omo", "--thinking", "low", `--model=${LEAD}`, "--thinking=high", "p"], LEAD)).toEqual(["omo", "--model=kimi-coding/k3.1-pro", "--thinking", "max", "p"]);
  expect(withThinking(["omo", "--thinking", "low", "--model", "p/m", "x"], "p/m")).toEqual(["omo", "--thinking", "low", "--model", "p/m", "x"]);
});

test("a move interrupted after the registry took the new model goes back to the old model with the old pane, or keeps the new one with the new pane", async () => {
  const deps = { ...omo(), cardDir: join(dir, "discord"), signal: () => true, sessionOf: async () => "" } as unknown as LaneHandoverDeps;
  const lane = { key: "k", title: "k", thread: "none", brief: "/b", done: "file /x", openedAt: "2026-01-01T00:00:00Z", model: LEAD } as const;
  const pending = (to: string) => ({ key: "k", pid: 1, at: "2026-01-01T00:00:00Z", from: "w1:p1", to, note: "/n", models: modelMove(lane, "anthropic-subscription/claude-opus-5-5", "medium") });
  const moved = { ...lane, model: "anthropic-subscription/claude-opus-5-5:medium" };
  // both alive: the old pane stays the lane, with its own model
  await deps.registry.write({ ...moved, pane: "w1:p2" });
  await recover(deps, pending("w1:p2"), () => {});
  expect(await deps.registry.read("k")).toMatchObject({ pane: "w1:p1", model: LEAD, modelPinned: false });
  // the old one gone: the new pane stays, with the model it runs
  world.herdrDead = ["w1:p1"];
  await deps.registry.write({ ...lane, pane: "w1:p1" });
  await recover(deps, pending("w1:p3"), () => {});
  expect(await deps.registry.read("k")).toMatchObject({ pane: "w1:p3", model: "anthropic-subscription/claude-opus-5-5:medium" });
});

test("a handover's level: a --thinking, else the followed lead's or a --model's, over the level its screen shows", () => {
  const opus = "anthropic-subscription/claude-opus-5-5:medium";
  expect(moveThinking(opus, false, { model: opus }, "high")).toBe("medium");
  expect(moveThinking(opus, false, { model: opus, thinking: "low" }, "high")).toBe("low");
  expect(moveThinking(LEAD, true, {}, "high")).toBe("max");
  expect(moveThinking(opus, false, {}, "high")).toBe("high");
  expect(keptModel({}, "anthropic-subscription/claude-opus-5-5", moveThinking(opus, false, { model: opus }, "high"), opus)).toEqual({ model: opus, modelPinned: true });
});

test("an interrupted move of a lane that had no model gives the kept old pane no model", async () => {
  const deps = { ...omo(), cardDir: join(dir, "discord"), signal: () => true, sessionOf: async () => "" } as unknown as LaneHandoverDeps;
  const lane = { key: "a", title: "a", thread: "none", brief: "/b", done: "file /x", openedAt: "2026-01-01T00:00:00Z" } as const;
  const models = JSON.parse(JSON.stringify(modelMove({}, "kimi-coding/k3.1-pro", "max")));
  await deps.registry.write({ ...lane, model: LEAD, pane: "w1:p2" });
  await recover(deps, { key: "a", pid: 1, at: "2026-01-01T00:00:00Z", from: "w1:p1", to: "w1:p2", note: "/n", models }, () => {});
  const back = await deps.registry.read("a");
  expect(back?.pane).toBe("w1:p1");
  expect(back?.model).toBeUndefined();
});

test("a lane with no --model starts on the lead's recorded model; an aoe lead with none recorded keeps defaultModel", async () => {
  const { config, run } = omo();
  leadRuns(OPUS);
  expect(await resolveLeadModel(run, { ...config, defaultModel: LEAD })).toBe(OPUS);
  rmSync(join(config.stateDir, "herdr-sessions.json"), { force: true });
  expect(await resolveLeadModel(run, { ...config, backend: "aoe", defaultModel: LEAD })).toBe(LEAD);
});
