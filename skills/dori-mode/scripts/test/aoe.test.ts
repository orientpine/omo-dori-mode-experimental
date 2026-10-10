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

test("a launch whose Done only checks a file warns LAUNCH_DONE_WEAK and still launches; --done-weak-ok and a behavior signal stay quiet", async () => {
  const brief = join(state.dir, "brief.md");
  const warned: string[] = [];
  await Bun.write(brief, "# brief\n");
  const r = await launchLane(at(T0), { key: "weak", title: "weak", brief, done: "file /tmp/ok", cwd: "/tmp/w" }, (l) => warned.push(l));
  expect(r.startup).toStartWith("STARTUP_OK weak");
  expect(warned).toHaveLength(1);
  expect(warned[0]).toStartWith("LAUNCH_DONE_WEAK weak: every Done signal only checks files or text (file)");
  await launchLane(at(T0), { key: "weak-ok", title: "weak", brief, done: "file /tmp/ok", cwd: "/tmp/w", doneWeakOk: true }, (l) => warned.push(l));
  await launchLane(at(T0), { key: "strong", title: "strong", brief, done: 'file /tmp/ok; command ["bun","test"] stdout~" 0 fail"', cwd: "/tmp/w" }, (l) => warned.push(l));
  expect(warned).toHaveLength(1);
  const logged = (await Bun.file(at(T0).config.watchLog).text()).trim().split("\n");
  expect(logged).toHaveLength(1);
  expect(logged[0]).toMatch(/^\S+ launch LAUNCH_DONE_WEAK weak:/);
});

test("an agent that exits at start is a STARTUP_ERROR with its own message, without waiting out the prompt timeout", async () => {
  const brief = join(state.dir, "brief.md");
  await Bun.write(brief, "# brief\n");
  world.screen = 'Error: Model "nosuch/model" not found. Use --list-models to see available models.\nPane is dead (status 1)';
  const r = await launchLane(at(T0), { key: "smoke", title: "smoke", brief, done: "file /tmp/ok", cwd: "/tmp/w", model: "nosuch/model" });
  expect(r.startup).toBe(`STARTUP_ERROR smoke aoe_smoke_${NEW_AOE_ID.slice(0, 8)}: Model "nosuch/model" not found`);
  expect(world.calls.filter((c) => c[1] === "capture-pane")).toHaveLength(1);
  expect(sent(world)).toEqual([]);
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

test("a working lane whose aoe session waits for a human is reported once as LANE_BLOCKED, never while its turn still runs", async () => {
  const lane: Lane = { key: "fix-a", title: "fix-a", thread: "none", pane: PANE, brief: "/b.md", done: "file /etc/hostname", cwd: "/repo", openedAt: new Date(T0).toISOString() };
  await at(T0).registry.write(lane);
  const state = (s: string) => { world.aoePs = [{ session: LANE_ID, state: s }, { session: "0a1b2c3d4e5f6a7b", state: "waiting" }]; };
  const busy = "Working (12s • esc to interrupt)\n❯ ";
  state("running");
  world.screen = busy;
  expect(await watchTick(at(T0))).toEqual([]);
  state("waiting");
  expect(await watchTick(at(T0))).toEqual([]);
  world.screen = "Allow this command? (y/n)\n❯ ";
  expect(await watchTick(at(T0))).toEqual([`LANE_BLOCKED fix-a waiting ${PANE}`]);
  expect(await watchTick(at(T0))).toEqual([]);
  state("error");
  expect(await watchTick(at(T0))).toEqual([`LANE_BLOCKED fix-a error ${PANE}`]);
  // aoe shows an open omo question as idle; the question UI on screen says otherwise
  state("idle");
  world.screen = " Ask user · 2m\n dori-qa: pick A or B?\n → 1. A\n Submit (0/1 answered) — Enter advances";
  expect(await watchTick(at(T0))).toEqual([`LANE_BLOCKED fix-a question ${PANE}`]);
  world.screen = busy;
  expect(await watchTick(at(T0))).toEqual([]);
  // a turn that ended counts once it stays idle for the settle time, not before, and not while a goal wake is due
  world.screen = "All done here.\n❯ ";
  expect(await watchTick(at(T0 + MIN))).toEqual([]);
  expect(await watchTick(at(T0 + MIN + 30_000))).toEqual([]);
  expect(await watchTick(at(T0 + 2 * MIN))).toEqual([`LANE_BLOCKED fix-a idle ${PANE}`]);
  expect(await watchTick(at(T0 + 3 * MIN))).toEqual([]);
  world.screen = "Pursuing goal · goal continues in 4m\n❯ ";
  expect(await watchTick(at(T0 + 4 * MIN))).toEqual([]);
  world.screen = "All done here.\n❯ ";
  expect(await watchTick(at(T0 + 4 * MIN + 30_000))).toEqual([]);
  expect((await at(T0).registry.read("fix-a"))?.idleSince).toBe(T0 + 4 * MIN + 30_000);
});

test("an idle lane that waits on its own monitor, wake source or goal is never LANE_BLOCKED idle; a question or aoe waiting still is", async () => {
  const lane: Lane = { key: "fix-a", title: "fix-a", thread: "none", pane: PANE, brief: "/b.md", done: "file /etc/hostname", cwd: "/repo", openedAt: new Date(T0).toISOString() };
  await at(T0).registry.write(lane);
  world.aoePs = [{ session: LANE_ID, state: "idle" }];
  const status = (s: string) => `❯ \n Claude │ pool\n(OmO) mem:repo just now ${s}`;
  let t = T0;
  for (const mark of ["◉ watching local_ci approval-path-audit #2 (2m)", "2 wake source(s) on duty", "goal continues in 4m", "Pursuing goal (18m)"]) {
    world.screen = status(mark);
    for (let i = 0; i < 4; i++, t += 30_000) expect(await watchTick(at(t))).toEqual([]);
  }
  world.screen = ` Ask user · 2m\n Submit (0/1 answered)\n${status("Pursuing goal (18m)")}`;
  expect(await watchTick(at(t))).toEqual([`LANE_BLOCKED fix-a question ${PANE}`]);
  world.aoePs = [{ session: LANE_ID, state: "waiting" }];
  world.screen = status("◉ watching ci (1m)");
  expect(await watchTick(at(t + 30_000))).toEqual([`LANE_BLOCKED fix-a waiting ${PANE}`]);
});

test("a stopped agent in an aoe session is reported, and the lead's session is skipped", async () => {
  world.screen = "omo has stopped\n$ ";
  const deps = at(T0);
  expect(await deadPaneTick(deps.run, deps.config, new Set(), "2026-01-01T12")).toEqual([`DEAD_PANE ${PANE}`]);
});
