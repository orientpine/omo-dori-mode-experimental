import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { paneActivity } from "../src/aoe.ts";
import { leadNow, useDoriState } from "../src/hc-pane.ts";
import { listPanes } from "../src/panes.ts";
import { renderBrief } from "../src/launch-render.ts";
import { watchTick } from "../src/done-flow.ts";
import { pendingGoalTick } from "../src/pending-goal.ts";
import type { Lane } from "../src/registry.ts";
import type { Runner } from "../src/run.ts";
import { FakeOmoHost } from "./fake-omo-host.ts";
import { depsFor, fakeClock, fakeRunner, newWorld, withState } from "./fakes.ts";
import { terminal } from "./fake-hc.ts";

const id = "00000000-0000-4000-8000-000000000052";
const pane = `omo-host:${id}`;
const at = Date.parse("2026-11-25T11:30:00Z");
const openedAt = new Date(at - 60_000).toISOString();
const fixture = () => {
  const state = withState();
  const host = new FakeOmoHost(join(state.dir, "sessions"));
  const session = host.add({ id, name: "dori/g1/hosted" });
  const world = newWorld();
  const clock = fakeClock(at);
  const configPath = join(state.dir, "config.json");
  const base = fakeRunner(world);
  const run: Runner = async (argv, opts) => {
    if (argv[0] !== "omo") return base(argv, opts);
    const r = await host.exec("omo", argv.slice(1));
    return { code: r.code, out: r.stdout, err: r.stderr };
  };
  const deps = { ...depsFor(world, clock, state.dir, { runtime: "hc", backend: "herdr", laneWorkspace: "g1", leadPane: "hc:t1" }), run };
  const lane: Lane = { key: "hosted", title: "Hosted", thread: "none", pane, session: id, openedAt, brief: join(state.dir, "brief.md"), done: "closed acme/app#3" };
  return { state, host, session, world, deps, lane, configPath };
};

const input = (f: ReturnType<typeof fixture>) => ({ key: "fresh", title: "Fresh", noThread: "test", brief: f.lane.brief, cwd: f.state.dir, done: f.lane.done });

test("hosted footer delivers through the instance-bound dori type instead of a terminal shell", async () => {
  const f = fixture();
  try {
    await Bun.write(f.lane.brief, "Do the work.");
    const config = { ...f.deps.config, laneRuntime: "omo-host" as const };
    const { text } = await renderBrief({ ...f.deps, config }, input(f));
    const route = text.split("\n").find((line) => line.includes("--text") && line.includes("<report line>"));
    expect(route).toMatch(/DORI_STATE_DIR=.*cli\.ts.*type.*hc:t1.*--text/);
    expect(text).not.toContain('["hc","send"');
  } finally { f.state.done(); }
});

test("all executable hosted footer instructions select the instance and its env file", async () => {
  const f = fixture();
  const env = process.env["DORI_ENV_FILE"];
  try {
    const customEnv = join(f.state.dir, "custom env");
    process.env["DORI_ENV_FILE"] = customEnv;
    await Bun.write(f.lane.brief, "Do the work.");
    const config = { ...f.deps.config, laneRuntime: "omo-host" as const };
    const { text } = await renderBrief({ ...f.deps, config }, { ...input(f), goal: "goal", challengeBefore: ["commit"] });
    const commands = ["report", "tree", "heavy", "intent-check", "challenge", "checkpoint", "checkpoints", "claim-done"];
    for (const command of commands) {
      const line = text.split("\n").find((row) => row.includes(`cli.ts ${command} `));
      expect(line).toContain(`DORI_ENV_FILE=${customEnv}`);
      expect(line).toContain(`DORI_STATE_DIR=${f.state.dir}`);
    }
  } finally {
    if (env === undefined) delete process.env["DORI_ENV_FILE"]; else process.env["DORI_ENV_FILE"] = env;
    f.state.done();
  }
});

test("a hosted lane's settled claim reopens when it starts a new turn", async () => {
  const f = fixture();
  try {
    const claim = { at: openedAt, evidence: "proof", emitted: true, idleAt: at - 50_000 };
    f.session.state["isStreaming"] = true;
    await f.deps.registry.write({ ...f.lane, status: "done-claimed", claim });
    expect((await watchTick(f.deps)).some((l) => l.startsWith("LANE_CLAIM_REOPENED hosted"))).toBe(true);
    expect((await f.deps.registry.read(f.lane.key))?.status).toBe("working");
  } finally { f.state.done(); }
});

test("watch does not settle a hosted claim while its first post-claim turn is busy", async () => {
  const f = fixture();
  try {
    f.session.state["isStreaming"] = true;
    const claim = { at: new Date(at - 86_400_000).toISOString(), evidence: "proof", emitted: true };
    await f.deps.registry.write({ ...f.lane, status: "done-claimed", claim });
    expect(await watchTick(f.deps)).not.toContainEqual(expect.stringMatching(/^LANE_CLOSED hosted/));
    expect((await f.deps.registry.read(f.lane.key))?.status).toBe("done-claimed");
    expect(f.session.parked).not.toBe(true);
  } finally { f.state.done(); }
});

test("hc-only listing discovers recorded hosted lanes even when the placement override is absent", async () => {
  const f = fixture();
  const previous = process.env["DORI_RUNTIME"];
  process.env["DORI_RUNTIME"] = "hc";
  try {
    f.world.terminals = { t1: terminal() };
    await f.deps.registry.write(f.lane);
    await Bun.write(f.configPath, JSON.stringify({ runtime: "hc", leadPane: "hc:t1" }));
    useDoriState({ stateDir: f.state.dir, configPath: f.configPath });
    expect((await listPanes(f.deps.run, f.deps.config)).map((p) => p.pane_id)).toContain(pane);
    expect(f.world.calls.filter((c) => c[0] === "herdr" && c.includes("list"))).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env["DORI_RUNTIME"]; else process.env["DORI_RUNTIME"] = previous;
    useDoriState(undefined);
    f.state.done();
  }
});

test("stored hc discovery and activity keep their terminal behavior without overrides", async () => {
  const f = fixture();
  const previous = process.env["DORI_RUNTIME"];
  process.env["DORI_RUNTIME"] = "hc";
  try {
    f.world.terminals = { t1: terminal() };
    await f.deps.registry.write({ ...f.lane, pane: "hc:t1" });
    await Bun.write(f.configPath, JSON.stringify({ runtime: "hc", leadPane: "hc:t1" }));
    useDoriState({ stateDir: f.state.dir, configPath: f.configPath });
    expect((await listPanes(f.deps.run, f.deps.config)).map((p) => p.pane_id)).toEqual(["hc:t1"]);
    expect((await paneActivity(f.deps.run, ["hc:t1"])).get("hc:t1")).toBe("idle");
    expect(f.host.calls).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env["DORI_RUNTIME"]; else process.env["DORI_RUNTIME"] = previous;
    useDoriState(undefined);
    f.state.done();
  }
});

test("watch lead refresh keeps a bare hc ID on the same runtime as initial load", async () => {
  const f = fixture();
  try {
    await Bun.write(f.configPath, JSON.stringify({ leadRuntime: "hc", leadPane: "t3" }));
    expect((await loadConfig(f.configPath)).leadPane).toBe("hc:t3");
    expect(leadNow(f.configPath)).toBe("hc:t3");
  } finally { f.state.done(); }
});

test("pending goal does not count a hosted streaming turn as idle", async () => {
  const f = fixture();
  try {
    f.session.state["isStreaming"] = true;
    await f.deps.registry.write({ ...f.lane, pendingGoal: { idle: 2, at } });
    expect(await pendingGoalTick(f.deps)).toEqual([]);
    expect((await f.deps.registry.read(f.lane.key))?.pendingGoal).toEqual({ idle: 0, at });
  } finally { f.state.done(); }
});

test("pending goal re-closes a hosted session closed after liveness but before state", async () => {
  const f = fixture();
  try {
    const lane = { ...f.lane, pendingGoal: { idle: 2, at } };
    await f.deps.registry.write(lane);
    let closed = false;
    const run: Runner = async (argv, opts) => {
      if (!closed && argv[0] === "omo" && argv[3] === "state") {
        closed = true;
        await f.deps.run(["omo", "host", "session", "close", id, "--json"]);
        await f.deps.registry.write({ ...lane, closedAt: openedAt });
      }
      return f.deps.run(argv, opts);
    };
    const lines = await pendingGoalTick({ ...f.deps, run });
    expect(f.session.parked).toBe(true);
    expect(lines).toEqual([]);
  } finally { f.state.done(); }
});

test("the setup example leaves an hc install on hc for both placements", async () => {
  const config = await loadConfig(new URL("../../references/config.example.json", import.meta.url).pathname);
  expect(config.laneRuntime).toBeUndefined();
  expect(config.leadRuntime).toBeUndefined();
});
