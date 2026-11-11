import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { terminal as hcTerm } from "./fake-hc.ts";
import { launchLane } from "../src/launch.ts";
import { Reports } from "../src/reports.ts";
import type { FlowDeps } from "../src/done-flow.ts";
import { depsFor, fakeClock, launchReadyPath, NEW_AOE_ID, newWorld, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00Z");
let state: ReturnType<typeof withState>;
let world: World;
let restorePath = () => {};

beforeEach(() => {
  restorePath = launchReadyPath();
  state = withState();
  world = newWorld();
  world.aoe = [
    { id: "abcdef1200112233", title: "fix-a", path: "/repo", tool: "omo", profile: "main" },
    { id: "0a1b2c3d4e5f6a7b", title: "Dori", path: "/home/test/dori", tool: "omo", profile: "main" },
  ];
  world.tmux = ["aoe_fix-a_abcdef12", "aoe_Dori_0a1b2c3d"];
});
afterEach(() => {
  state.done();
  restorePath();
});

const at = (ms: number): FlowDeps => ({
  ...depsFor(world, fakeClock(ms), state.dir, { backend: "aoe", leadPane: "aoe_Dori_0a1b2c3d" }),
  readGoal: async () => ({ status: "active" }),
});

test("launch registers jsonl-v1 and starts the activity journal before the agent can report", async () => {
  const brief = join(state.dir, "brief.md");
  await Bun.write(brief, "# brief\n[목표] smoke lane을 끝까지 한다.\n");
  const deps = at(T0);
  const base = deps.run;
  let journalAtPrompt: string | undefined;
  const result = await launchLane({ ...deps, run: async (argv, opts) => {
    if (argv[0] === "tmux" && argv.includes("send-keys") && argv.some((arg) => arg.includes("Read and execute the lane brief"))) {
      journalAtPrompt = new Reports(state.dir).read("smoke")?.lastEvent.type;
    }
    return base(argv, opts);
  } }, {
    noThread: "test lane",
    key: "smoke",
    title: "smoke",
    brief,
    done: "file /tmp/ok",
    cwd: "/tmp/w",
    goal: "형 원문",
  });
  expect(result.startup).toBe(`STARTUP_OK smoke aoe_smoke_${NEW_AOE_ID.slice(0, 8)}`);
  expect(journalAtPrompt).toBe("activity");
  expect(result.lane.reportProtocol).toBe("jsonl-v1");
  const progress = new Reports(state.dir).read("smoke");
  expect(progress?.state).toBe("running");
  expect(progress?.lastReport).toBeNull();
  expect(progress?.lastEvent).toMatchObject({ type: "activity", state: "running", key: "smoke" });
  expect(await Bun.file(brief).text()).toContain("report smoke --kind milestone");
  expect(await Bun.file(brief).text()).toContain("cli.ts");
});

test("herdr launch writes the activity journal before pane run starts the agent", async () => {
  const brief = join(state.dir, "herdr-brief.md");
  await Bun.write(brief, "# brief\n");
  const deps = {
    ...depsFor(world, fakeClock(T0), state.dir, { backend: "herdr" as const }),
    readGoal: async () => ({ status: "active" as const }),
  };
  const base = deps.run;
  let journalAtStart: string | undefined;
  const result = await launchLane({ ...deps, run: async (argv, opts) => {
    if (argv[1] === "tab" && argv[2] === "create") {
      return { code: 0, out: JSON.stringify({ result: { root_pane: { pane_id: "w1:p3", tab_id: "w1:t3" } } }), err: "" };
    }
    if (argv[1] === "pane" && argv[2] === "run") journalAtStart = new Reports(state.dir).read("smoke")?.lastEvent.type;
    return base(argv, opts);
  } }, { noThread: "QA", key: "smoke", title: "smoke", brief, done: "file /tmp/ok", cwd: "/tmp/w" });
  expect(result.startup).toBe("STARTUP_OK smoke w1:p3");
  expect(journalAtStart).toBe("activity");
  expect(result.lane.reportProtocol).toBe("jsonl-v1");
});

test("an unsuccessful hc start rolls back provisional state and can retry", async () => {
  const brief = join(state.dir, "hc-brief.md");
  await Bun.write(brief, "# brief\n");
  world.terminals = { t1: hcTerm() };
  const deps = {
    ...depsFor(world, fakeClock(T0), state.dir, { backend: "herdr" as const, runtime: "hc" as const }),
    readGoal: async () => ({ status: "active" as const }),
  };
  const base = deps.run;
  let reject = true;
  const run: typeof deps.run = async (argv, opts) => {
    if (argv[0] === "hc" && argv[1] === "--json" && argv[2] === "run") return { code: 0, out: JSON.stringify({ address: "t1", state: "live", labels: {} }), err: "" };
    if (argv[0] === "hc" && argv[1] === "--json" && argv[2] === "read") return { code: 0, out: JSON.stringify({ text: "❯ ", complete: true, how: "screen" }), err: "" };
    if (argv[0] === "hc" && argv[1] === "--json" && argv[2] === "send") {
      if (reject) return { code: 1, out: "", err: JSON.stringify({ error: { kind: "invalid_params", message: "bad command" } }) };
      return { code: 0, out: JSON.stringify({ status: "idle", turn: 1, started: true }), err: "" };
    }
    if (argv[0] === "hc" && argv[1] === "--json" && ["kill", "rm"].includes(argv[2] ?? "")) return { code: 0, out: "{}", err: "" };
    return base(argv, opts);
  };
  const input = { noThread: "QA", key: "smoke", title: "smoke", brief, done: "file /tmp/ok", cwd: "/tmp/w" } as const;
  const previousRuntime = process.env["DORI_RUNTIME"];
  process.env["DORI_RUNTIME"] = "hc";
  try {
    await expect(launchLane({ ...deps, run }, input)).rejects.toThrow("hc send failed");
    expect(await deps.registry.read("smoke")).toBeNull();
    expect(existsSync(new Reports(state.dir).path("smoke"))).toBe(false);
    reject = false;
    const result = await launchLane({ ...deps, run }, input);
    expect(result.startup).toBe("STARTUP_OK smoke hc:t1");
    expect(await deps.registry.read("smoke")).not.toBeNull();
    expect(new Reports(state.dir).read("smoke")?.state).toBe("running");
  } finally {
    if (previousRuntime === undefined) delete process.env["DORI_RUNTIME"];
    else process.env["DORI_RUNTIME"] = previousRuntime;
  }
});
