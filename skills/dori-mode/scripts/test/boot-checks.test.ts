import { afterEach, beforeEach, expect, test } from "bun:test";
import type { DoriConfig } from "../src/config.ts";
import { bootCheck } from "../src/boot.ts";
import type { Lane, LaneStatus } from "../src/registry.ts";
import { runtimesFor } from "../src/run.ts";
import { terminal as hcTerm } from "./fake-hc.ts";
import { bootDeps, newWorld } from "./boot-fixtures.ts";
import { withState, type World } from "./fakes.ts";

const lane = (key: string, status: LaneStatus, ref: Lane["sessionRef"]): Lane => ({
  key,
  status,
  ...(ref ? { sessionRef: ref, pane: ref.id } : {}),
  title: key,
  thread: "none",
  brief: "/b.md",
  done: "file /done.md",
  openedAt: new Date(Date.parse("2026-01-01T12:00:00Z")).toISOString(),
});

let state: ReturnType<typeof withState>;
beforeEach(() => { state = withState(); });
afterEach(() => state.done());

const boot = async (world: World, patch: Partial<DoriConfig>, lanes: Lane[] = []) => {
  const deps = bootDeps(world, state.dir);
  const config = { ...deps.config, ...patch };
  for (const l of lanes) await deps.registry.write(l);
  return bootCheck({ ...deps, config, rts: runtimesFor({ runtime: config.runtime }, {}, deps.run, deps.clock) });
};

const agent = (pane_id: string, workspace_id: string) => ({ pane_id, workspace_id, agent: "omo", agent_status: "working" });

test("a workspace filter that leaves out laneWorkspace is a CONFIG_WARN and fails boot", async () => {
  const world = newWorld();
  world.panes = [{ pane_id: "w2:p1", workspace_id: "w2" }];
  const result = await boot(world, { workspaces: ["w1"], laneWorkspace: "w2" });
  expect(result.lines).toContain("CONFIG_WARN workspaces=[w1] does not include laneWorkspace=w2");
  expect(result.exitCode).toBe(1);
  expect(result.lines.at(-1)).toBe("BOOT incomplete read-only; nothing restarted, written or stopped");
});

test("live agents in laneWorkspace that no filtered workspace matches are a CONFIG_WARN", async () => {
  const world = newWorld();
  world.panes = [{ pane_id: "w2:p1", workspace_id: "w2" }, agent("w3:p1", "w3"), agent("w3:p2", "w3")];
  const result = await boot(world, { workspaces: ["w1"] });
  expect(result.lines).toContain("CONFIG_WARN workspaces=[w1] match none of the 2 live agent sessions on herdr");
  expect(result.exitCode).toBe(1);
});

test("a filter that covers the agents, or no filter at all, stays quiet", async () => {
  const world = newWorld();
  world.panes = [{ pane_id: "w2:p1", workspace_id: "w2" }, agent("w3:p1", "w3"), agent("w4:p1", "w4")];
  for (const patch of [{ workspaces: ["w3"], laneWorkspace: "w3" }, { workspaces: [] }]) {
    const result = await boot(world, patch);
    expect(result.lines.some((l) => l.startsWith("CONFIG_WARN"))).toBe(false);
    expect(result.exitCode).toBe(0);
  }
});

test("DRIFT counts open lanes whose pane herdr reports gone; closed and live lanes are not counted", async () => {
  const world = newWorld();
  world.herdrGone = ["w1:p8", "w1:p9", "w1:p7"];
  world.panes = [{ pane_id: "w2:p1", workspace_id: "w2" }, agent("w2:p5", "w2")];
  const lanes = [
    lane("stale-a", "working", { runtime: "herdr", id: "w1:p8" }),
    lane("stale-b", "not-done", { runtime: "herdr", id: "w1:p9" }),
    lane("old", "closed", { runtime: "herdr", id: "w1:p7" }),
    lane("live", "working", { runtime: "herdr", id: "w2:p5" }),
  ];
  const result = await boot(world, {}, lanes);
  expect(result.lines).toContain("DRIFT n=2 stale-a stale-b");
  expect(result.exitCode).toBe(1);
  const probed = world.calls.filter((c) => c[0] === "herdr" && c[2] === "get").map((c) => c[3]);
  expect(probed.sort()).toEqual(["w1:p8", "w1:p9"]);
});

test("on hc, DRIFT uses hc's own probe, group filters are checked, and the canonical lead ref is live", async () => {
  const world = newWorld();
  world.terminals = { t1: hcTerm({ labels: { "dori.group": "lanes" } }) };
  const lanes = [
    lane("alive", "working", { runtime: "hc", id: "t1" }),
    lane("lost", "working", { runtime: "hc", id: "t9" }),
  ];
  const result = await boot(world, { runtime: "hc", leadPane: "hc:t1", workspaces: ["other"], laneWorkspace: "lanes" }, lanes);
  expect(result.lines).toContain("DRIFT n=1 lost");
  expect(result.lines).toContain("CONFIG_WARN workspaces=[other] does not include laneWorkspace=lanes");
  expect(result.lines).toContain("PANES lead=hc:t1 leadState=live registeredLive=1 vanished=1 unregistered=0");
  expect(world.calls.some((c) => c[0] === "hc" && c[2] === "get" && c[3] === "t9")).toBe(true);
  expect(result.exitCode).toBe(1);
});

test.each([
  { workspaces: ["other"], warning: true },
  { workspaces: ["lanes"], warning: false },
])("an hc live-agent group filter reports mismatch=$warning", async ({ workspaces, warning }) => {
  const world = newWorld();
  world.terminals = { t1: hcTerm({ labels: { "dori.group": "lanes" } }) };
  const result = await boot(world, { runtime: "hc", leadPane: "hc:t1", workspaces, laneWorkspace: "" });
  expect(result.lines.some((line) => line === "CONFIG_WARN workspaces=[other] match none of the 1 live agent sessions on hc")).toBe(warning);
  expect(result.exitCode).toBe(warning ? 1 : 0);
});

test("a probe that fails is named and fails boot, but is not counted as drift", async () => {
  const world = newWorld();
  world.hcGetError = "t3";
  const result = await boot(world, { runtime: "hc", leadPane: "t1" }, [lane("broken", "working", { runtime: "hc", id: "t3" })]);
  expect(result.lines).toContain("DRIFT n=0");
  expect(result.lines.some((l) => l.startsWith("DRIFT probe-failed broken"))).toBe(true);
  expect(result.exitCode).toBe(1);
});
