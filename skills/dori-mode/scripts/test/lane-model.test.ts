import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordHerdrSession } from "../src/herdr-sessions.ts";
import { keepSessions, type LaneHandoverDeps, recover } from "../src/lane-handover.ts";
import { keptModel, laneModel, launchProvider, leadModel, modelMove, moveThinking, withThinking } from "../src/lane-model.ts";
import { launchLane } from "../src/launch.ts";
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
const omo = (patch = {}) => depsFor(world, fakeClock(0), dir, { backend: "herdr", leadPane: "w1:p37", ...patch });
const leadRuns = (model: string) => recordHerdrSession(dir, "w1:p37", { session: "lead-sid", cwd: dir, model, at: new Date(0).toISOString() });

test("the lead's model is the one recorded for its pane, and none while nothing is recorded", () => {
  const { config } = omo();
  expect(leadModel(config)).toBeUndefined();
  leadRuns(LEAD);
  expect(leadModel(config)).toBe(LEAD);
  expect(leadModel({ ...config, leadPane: "w9:p9" })).toBeUndefined();
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

test("the backlog checks the quota of the provider its lanes start on: the lead's, else defaultModel's", () => {
  const config = omo().config;
  leadRuns("anthropic-subscription/claude-opus-5-5:medium");
  expect(launchProvider({ ...config, defaultModel: LEAD })).toBe("anthropic-subscription");
  rmSync(join(config.stateDir, "herdr-sessions.json"), { force: true });
  expect(launchProvider({ ...config, defaultModel: LEAD })).toBe("kimi-coding");
});
