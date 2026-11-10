import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordHerdrSession, reviveHerdr } from "../src/herdr-sessions.ts";
import { keepSessions } from "../src/lane-handover.ts";
import { keptModel, laneModel, leadModel } from "../src/lane-model.ts";
import { launchLane } from "../src/launch.ts";
import type { Runner } from "../src/run.ts";
import { depsFor, fakeClock, newWorld, type World } from "./fakes.ts";

// A lane runs its lead's model (owner 2026-11-10): launch, handover and revive read the lead's of now from herdr-sessions.json.
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
  const deps = omo({ agentCommand: ["claude", "--model", "{model}", "{prompt}"] });
  leadRuns(LEAD);
  let n = 1;
  const run: Runner = async (argv, o) => (argv[1] === "tab" && argv[2] === "create" ? { code: 0, out: JSON.stringify({ result: { root_pane: { pane_id: `w1:p${++n}`, tab_id: `w1:t${n}` } } }), err: "" } : deps.run(argv, o));
  const launch = (key: string, model?: string) => launchLane({ ...deps, run, readGoal: async () => ({ status: "active" }) }, { noThread: "QA", key, title: key, brief, done: "file /x", cwd: "/tmp", ...(model ? { model } : {}) });
  const follow = (await launch("follow")).lane;
  expect(follow.model).toBe(LEAD);
  expect(follow.modelPinned).toBeUndefined();
  expect(world.calls.some((c) => c.join(" ").includes(`--model ${LEAD}`))).toBe(true);
  const own = (await launch("own", "anthropic-subscription/claude-opus-5-5:medium")).lane;
  expect(own).toMatchObject({ model: "anthropic-subscription/claude-opus-5-5:medium", modelPinned: true });
});

test("a revive given a model (a lane that follows its lead) starts with that model and level, not the one its session ran", async () => {
  const deps = omo();
  const id = "11111111-2222-4333-8444-555555555555";
  recordHerdrSession(dir, "w1:p5", { session: id, cwd: dir, model: "m/x", at: new Date(0).toISOString() });
  world.herdrDead = ["w1:p5"];
  world.panes = [{ pane_id: "w1:p5", workspace_id: "w1", cwd: dir }];
  expect(await reviveHerdr(deps.run, deps.clock, deps.config, "w1:p5", "", async () => true, "k/lead:max")).toBe(`REVIVE_OK w1:p5 session ${id}`);
  const ran = world.calls.find((c) => c[2] === "run")?.[4] ?? "";
  // on Windows the agent line carries its words as base64 data
  const words = process.platform === "win32" ? [...ran.matchAll(/FromBase64String\('([^']*)'\)/g)].map((m) => Buffer.from(m[1] ?? "", "base64").toString("utf8")).join(" ") : ran;
  expect(words).toEndWith(`omo --session-id ${id} --model k/lead --thinking max`);
});
