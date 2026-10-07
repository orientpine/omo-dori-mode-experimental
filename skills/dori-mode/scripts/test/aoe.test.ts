import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";

import { deadPaneTick } from "../src/dead-panes.ts";
import { claimDone, watchTick } from "../src/done-flow.ts";
import { launchLane } from "../src/launch.ts";
import { listPanes, sendVerified } from "../src/panes.ts";
import type { Lane } from "../src/registry.ts";
import { resolveSession } from "../src/session-id.ts";
import { depsFor, fakeClock, NEW_AOE_ID, newWorld, sent, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
const LANE_ID = "abcdef1200112233";
const PANE = "aoe_fix-a_abcdef12";

let state: ReturnType<typeof withState>;
let world: World;
const at = (ms: number) => depsFor(world, fakeClock(ms), state.dir, { backend: "aoe", leadPane: "aoe_Dori_0a1b2c3d" });

beforeEach(() => {
  state = withState();
  world = newWorld();
  world.aoe = [
    { id: LANE_ID, title: "fix-a", path: "/repo", tool: "omo", profile: "main" },
    { id: "0a1b2c3d4e5f6a7b", title: "Dori", path: "/home/test/dori", tool: "omo", profile: "main" },
    { id: "0000ffff00000000", title: "stopped", path: "/repo", tool: "omo", profile: "main" },
  ];
  world.tmux = [PANE, "aoe_term_fix-a_abcdef12", "aoe_Dori_0a1b2c3d", "0"];
});
afterEach(() => state.done());

test("each running aoe session is one pane named by its tmux session; terminals and stopped sessions are not panes", async () => {
  const panes = await listPanes(at(T0).run, "aoe");
  expect(panes.map((p) => p.pane_id)).toEqual([PANE, "aoe_Dori_0a1b2c3d"]);
  expect(panes[0]).toEqual({ pane_id: PANE, workspace_id: "main", agent: "omo", title: "fix-a", cwd: "/repo" });
});

test("a launch opens an aoe session, waits for the prompt and types the lane prompt as one argv argument", async () => {
  const brief = join(state.dir, "brief.md");
  await Bun.write(brief, "# brief\n");
  const r = await launchLane(at(T0), { key: "smoke", title: "smoke", brief, done: "file /tmp/ok", cwd: "/tmp/w" });
  expect(world.calls).toContainEqual(["aoe", "add", "/tmp/w", "-t", "smoke", "--tool", "omo", "-l", "--extra-args", "--model anthropic/claude-opus-5-5"]);
  const pane = `aoe_smoke_${NEW_AOE_ID.slice(0, 8)}`;
  expect(r.lane.pane).toBe(pane);
  expect(r.startup).toBe(`STARTUP_OK smoke ${pane}`);
  expect(sent(world)).toEqual([`ulw set goal and work. Read and execute the lane brief at ${brief} in full. You are the smoke lane; report as the brief's footer says.`]);
  expect(world.calls).toContainEqual(["tmux", "send-keys", "-t", `=${pane}:`, "Enter"]);
  expect(await Bun.file(brief).text()).toContain(`"tmux","send-keys","-t","=aoe_Dori_0a1b2c3d:","-l"`);
});

test("five quiet minutes after a claim the lane's aoe session is stopped and trashed, never purged", async () => {
  const lane: Lane = { key: "fix-a", title: "fix-a", thread: "none", pane: PANE, brief: "/b.md", done: "file /etc/hostname", cwd: "/repo", openedAt: new Date(T0 - MIN).toISOString() };
  await at(T0).registry.write(lane);
  await claimDone(at(T0), lane, "file written");
  expect(sent(world)[0]).toStartWith("[LEAD] done claim recorded for fix-a");
  const lines = await watchTick(at(T0 + 5 * MIN + 1));
  expect(lines.at(-1)).toStartWith("LANE_CLOSED fix-a");
  expect(world.calls).toContainEqual(["aoe", "session", "stop", LANE_ID]);
  expect(world.calls).toContainEqual(["aoe", "rm", LANE_ID]);
  expect(world.calls.some((c) => c.includes("--purge"))).toBe(false);
});

test("only omo's input line counts as unsent text: a transcript line above it does not, a stuck input line gets another Enter", async () => {
  const enters = () => world.calls.filter((c) => c[0] === "tmux" && c.at(-1) === "Enter").length;
  world.screen = "❯ [LEAD] stuck text still here\nworking...\n────\n❯ \n────";
  expect(await sendVerified(at(T0).run, at(T0).clock, "aoe", PANE, "[LEAD] stuck text still here")).toBe(true);
  expect(enters()).toBe(1);
  world.screen = "❯ ";
  world.stuckReads = 2;
  expect(await sendVerified(at(T0).run, at(T0).clock, "aoe", PANE, "[LEAD] stuck text still here")).toBe(true);
  expect(enters()).toBe(3);
});

test("an aoe pane's session id is omo's --session-id under the tmux pane pid", async () => {
  const table = [{ pid: 10, ppid: 1, cmd: "/bin/bash /tmp/aoe-pane-env-XeE9cT" }, { pid: 11, ppid: 10, cmd: "/home/u/.bun/bin/bun /x/senpi/dist/bundle/cli.js --extension /x/plugin -e /x/pi-aoe-session-id.js --session-id 40ccbe13-33d4-4c1e-9d0e-0123456789ab" }];
  const hit = await resolveSession(PANE, "/repo", table, { run: at(T0).run, sessionsDir: "/s", backend: "aoe" });
  expect(hit).toEqual({ id: "40ccbe13-33d4-4c1e-9d0e-0123456789ab", via: "argv", pid: 11 });
  expect(world.calls).toContainEqual(["tmux", "display-message", "-p", "-t", `=${PANE}:`, "#{pane_pid}"]);
});

test("a working lane whose aoe session waits for a human is reported once as LANE_BLOCKED, not while its turn still runs", async () => {
  const lane: Lane = { key: "fix-a", title: "fix-a", thread: "none", pane: PANE, brief: "/b.md", done: "file /etc/hostname", cwd: "/repo", openedAt: new Date(T0).toISOString() };
  await at(T0).registry.write(lane);
  world.aoePs = [{ session: LANE_ID, state: "running" }, { session: "0a1b2c3d4e5f6a7b", state: "waiting" }];
  expect(await watchTick(at(T0))).toEqual([]);
  world.aoePs[0] = { session: LANE_ID, state: "waiting" };
  world.screen = "Working (12s • esc to interrupt)\n❯ ";
  expect(await watchTick(at(T0))).toEqual([]);
  world.screen = "Which option? 1) A 2) B\n❯ ";
  expect(await watchTick(at(T0))).toEqual([`LANE_BLOCKED fix-a waiting ${PANE}`]);
  expect(await watchTick(at(T0))).toEqual([]);
  world.aoePs[0] = { session: LANE_ID, state: "error" };
  expect(await watchTick(at(T0))).toEqual([`LANE_BLOCKED fix-a error ${PANE}`]);
  world.aoePs[0] = { session: LANE_ID, state: "idle" };
  expect(await watchTick(at(T0))).toEqual([]);
  world.aoePs[0] = { session: LANE_ID, state: "waiting" };
  expect(await watchTick(at(T0))).toEqual([`LANE_BLOCKED fix-a waiting ${PANE}`]);
});

test("a stopped agent in an aoe session is reported, and the lead's session is skipped", async () => {
  world.screen = "omo has stopped\n$ ";
  const deps = at(T0);
  expect(await deadPaneTick(deps.run, deps.config, new Set(), "2026-01-01T12")).toEqual([`DEAD_PANE ${PANE}`]);
});
