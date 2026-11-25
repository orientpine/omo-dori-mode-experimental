import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { currentTmuxSession } from "../src/aoe.ts";
import { bootCheck } from "../src/boot.ts";
import { runtimesFor } from "../src/run.ts";
import { Worklog } from "../src/worklog.ts";
import { Reports } from "../src/reports.ts";
import { listPanes } from "../src/panes.ts";
import { launchLane } from "../src/launch.ts";
import { renderBrief } from "../src/launch-render.ts";
import { pauseLane, resumeLane, watchTick } from "../src/done-flow.ts";
import { pendingGoalTick } from "../src/pending-goal.ts";
import type { Lane } from "../src/registry.ts";
import type { Runner } from "../src/run.ts";
import { FakeOmoHost, writeGoal } from "./fake-omo-host.ts";
import { depsFor, fakeClock, fakeRunner, newWorld, withState } from "./fakes.ts";


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

const borders = { type: "message", message: { role: "assistant", content: "──────\n❯ transcript only\n──────" } };

test("structured working state survives transcript borders in claim and pending-goal watch", async () => {
  const f = fixture();
  try {
    f.session.state["isStreaming"] = true;
    f.session.entries.push(borders);
    await f.deps.registry.write({ ...f.lane, status: "done-claimed", claim: { at: new Date(at - 86_400_000).toISOString(), evidence: "proof", emitted: true } });
    await watchTick(f.deps);
    expect((await f.deps.registry.read(f.lane.key))?.status).toBe("done-claimed");
  } finally { f.state.done(); }
});

test("pending-goal uses hosted busy state even when a transcript has borders", async () => {
  const f = fixture();
  try {
    f.session.state["isStreaming"] = true;
    f.session.entries.push(borders);
    await f.deps.registry.write({ ...f.lane, pendingGoal: { idle: 2, at } });
    expect(await pendingGoalTick(f.deps)).toEqual([]);
    expect((await f.deps.registry.read(f.lane.key))?.pendingGoal?.idle).toBe(0);
  } finally { f.state.done(); }
});

test("boot never resumes a parked hosted lane", async () => {
  const f = fixture();
  try {
    f.session.parked = true;
    await f.deps.registry.write(f.lane);
    const result = await bootCheck({ ...f.deps, reports: new Reports(f.state.dir), worklog: new Worklog(f.state.dir), slack: async () => null, rts: runtimesFor(f.deps.config, {}, f.deps.run, f.deps.clock), hcCoreUp: async () => true });
    expect(f.session.parked).toBe(true);
    expect(result.lines.some((l) => l.includes("nothing restarted"))).toBe(true);
  } finally { f.state.done(); }
});

test("a hosted caller resolves its registered lane without a process or terminal", async () => {
  const f = fixture();
  const env = { ...process.env };
  try {
    process.env["PI_SESSION_ID"] = id;
    process.env["SENPI_RPC_HOST_PUBLIC_SOCKET"] = "/fake/rpc.sock";
    await f.deps.registry.write(f.lane);
    expect((await f.deps.registry.byPane(await currentTmuxSession(f.deps.run)))?.key).toBe(f.lane.key);
  } finally {
    for (const key of ["PI_SESSION_ID", "SENPI_RPC_HOST_PUBLIC_SOCKET"]) {
      if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];
    }
    f.state.done();
  }
});

test("a working hosted lane pauses via a command-capable prompt, not steer", async () => {
  const f = fixture();
  try {
    writeGoal(f.session, "active");
    f.session.state["isStreaming"] = true;
    const run: Runner = (argv, opts) => {
      if (argv[0] === "omo" && argv[5] === "/goal pause") {
        if (argv[3] !== "prompt") return Promise.resolve({ code: 3, out: '{"reason":"unsupported_command"}', err: "" });
        writeGoal(f.session, "paused");
        return Promise.resolve({ code: 0, out: '{"disposition":"handled"}', err: "" });
      }
      return f.deps.run(argv, opts);
    };
    await f.deps.registry.write(f.lane);
    await pauseLane({ ...f.deps, run }, f.lane, "wait");
    expect((await f.deps.registry.read(f.lane.key))?.pausedGoal).toBe(true);
  } finally { f.state.done(); }
});

test("a parked hosted lane resumes its paused goal", async () => {
  const f = fixture();
  try {
    writeGoal(f.session, "paused");
    f.session.parked = true;
    const lane = { ...f.lane, status: "paused" as const, pausedGoal: true };
    await f.deps.registry.write(lane);
    await resumeLane(f.deps, lane);
    expect(f.session.parked).toBe(false);
    expect(await Bun.file(join(f.state.dir, "sessions", "--repo--", "extensions", "goal", `${id}.json`)).json()).toMatchObject({ goal: { status: "active" } });
  } finally { f.state.done(); }
});

test("aoe listings keep the hosted lanes when new-lane placement changes", async () => {
  const f = fixture();
  try {
    await f.deps.registry.write(f.lane);
    const config = { ...f.deps.config, backend: "aoe" as const };
    for (const placement of [config, { ...config, laneRuntime: "hc" as const }]) {
      expect((await listPanes(f.deps.run, placement)).map((p) => p.pane_id)).toContain(pane);
    }
  } finally { f.state.done(); }
});

test("failed hosted journal registration releases the lane key after closing the opened session", async () => {
  const f = fixture();
  try {
    await Bun.write(f.lane.brief, "Do the work.");
    const config = { ...f.deps.config, laneRuntime: "omo-host" as const };
    const journal = new Reports(config.stateDir).path("fresh");
    mkdirSync(journal, { recursive: true });
    await expect(launchLane({ ...f.deps, config }, { ...input(f), model: "test/model" })).rejects.toThrow();
    expect((await f.deps.registry.read("fresh"))).toBeNull();
    expect([...f.host.sessions.values()].find((session) => session.name === "dori/g1/fresh")?.parked).toBe(true);
  } finally { f.state.done(); }
});

test("every generated hosted heavy or challenge invocation binds the launching instance", async () => {
  const f = fixture();
  try {
    await Bun.write(f.lane.brief, "Do the work.");
    const config = { ...f.deps.config, laneRuntime: "omo-host" as const };
    const { text } = await renderBrief({ ...f.deps, config }, { ...input(f), challengeBefore: ["commit"] });
    for (const args of ["heavy <label> --mem", "heavy <label> --kind browser|cpu", "heavy <label> --kind gpu", `challenge ${input(f).key} --plan`]) {
      const line = text.split("\n").find((row) => row.includes(args));
      expect(line).toContain(`cli.ts ${args}`);
    }
  } finally { f.state.done(); }
});

test("a hosted lead is refused at config load, while explicit terminal placement remains valid", async () => {
  const f = fixture();
  try {
    await Bun.write(f.configPath, JSON.stringify({ leadRuntime: "omo-host", leadPane: id }));
    await expect(loadConfig(f.configPath)).rejects.toThrow(/hosted lead is not supported yet/);
    for (const kind of ["hc", "herdr"] as const) {
      await Bun.write(f.configPath, JSON.stringify({ leadRuntime: kind }));
      expect((await loadConfig(f.configPath)).leadRuntime).toBe(kind);
    }
  } finally { f.state.done(); }
});
