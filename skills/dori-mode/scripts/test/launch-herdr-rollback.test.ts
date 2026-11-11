import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchLane } from "../src/launch.ts";
import { Reports } from "../src/reports.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
let state: ReturnType<typeof withState>;
let world: ReturnType<typeof newWorld>;
let previousRuntime: string | undefined;
let brief: string;

beforeEach(async () => {
  state = withState();
  world = newWorld();
  brief = join(state.dir, "herdr-brief.md");
  await Bun.write(brief, "# brief\n");
  previousRuntime = process.env["DORI_RUNTIME"];
  process.env["DORI_RUNTIME"] = "herdr";
});

afterEach(() => {
  if (previousRuntime === undefined) delete process.env["DORI_RUNTIME"];
  else process.env["DORI_RUNTIME"] = previousRuntime;
  state.done();
});

const rig = (startError: string | undefined, closeRemoves: boolean) => {
  const deps = {
    ...depsFor(world, fakeClock(T0), state.dir, { backend: "herdr" as const, runtime: "herdr" as const }),
    readGoal: async () => ({ status: "active" as const }),
  };
  const base = deps.run;
  let reject = startError !== undefined;
  const calls: (readonly string[])[] = [];
  const run: typeof deps.run = async (argv, opts) => {
    calls.push(argv);
    if (argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create") {
      world.herdrGone = (world.herdrGone ?? []).filter((pane) => pane !== "w1:p3");
      world.panes = [{ pane_id: "w1:p3", workspace_id: "w1", agent: "omo", agent_status: "idle" }];
      return { code: 0, out: JSON.stringify({ result: { root_pane: { pane_id: "w1:p3", workspace_id: "w1", tab_id: "w1:t3" } } }), err: "" };
    }
    if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "run") {
      if (reject) return { code: 1, out: "", err: startError ?? "bad command" };
      return { code: 0, out: JSON.stringify({ result: {} }), err: "" };
    }
    if (argv[0] === "herdr" && ["pane", "tab"].includes(argv[1] ?? "") && argv[2] === "close") {
      if (!closeRemoves) return { code: 1, out: "", err: "close unavailable" };
      world.panes = [];
      world.herdrGone = [...new Set([...(world.herdrGone ?? []), "w1:p3"])];
      return { code: 0, out: JSON.stringify({ result: {} }), err: "" };
    }
    return base(argv, opts);
  };
  const input = { noThread: "QA", key: "smoke", title: "smoke", brief, done: "file /tmp/ok", cwd: "/tmp/w" } as const;
  return { deps, run, input, calls, succeed: () => { reject = false; } };
};

test("a definite herdr start rejection with confirmed cleanup unwinds and retries", async () => {
  const fixture = rig("bad command", true);
  await expect(launchLane({ ...fixture.deps, run: fixture.run }, fixture.input)).rejects.toThrow("herdr pane run failed");
  expect(await fixture.deps.registry.read("smoke")).toBeNull();
  expect(existsSync(new Reports(state.dir).path("smoke"))).toBe(false);
  fixture.succeed();
  const result = await launchLane({ ...fixture.deps, run: fixture.run }, fixture.input);
  expect(result.startup).toBe("STARTUP_OK smoke w1:p3");
  expect(await fixture.deps.registry.read("smoke")).not.toBeNull();
  expect(new Reports(state.dir).read("smoke")?.state).toBe("running");
});

test("an ambiguous herdr start outcome preserves registration after cleanup", async () => {
  const fixture = rig("connection timed out", true);
  await expect(launchLane({ ...fixture.deps, run: fixture.run }, fixture.input)).rejects.toThrow("herdr pane run failed");
  expect(await fixture.deps.registry.read("smoke")).not.toBeNull();
  expect(existsSync(new Reports(state.dir).path("smoke"))).toBe(true);
});

test("an unconfirmed herdr cleanup preserves registration and journal", async () => {
  const fixture = rig("bad command", false);
  await expect(launchLane({ ...fixture.deps, run: fixture.run }, fixture.input)).rejects.toThrow("herdr pane run failed");
  expect(await fixture.deps.registry.read("smoke")).not.toBeNull();
  expect(existsSync(new Reports(state.dir).path("smoke"))).toBe(true);
});

test("a herdr journal append failure closes the new terminal and unwinds for retry", async () => {
  const fixture = rig("bad command", true);
  const reports = new Reports(state.dir);
  mkdirSync(join(state.dir, "lanes", "smoke"), { recursive: true });
  writeFileSync(reports.path("smoke"), "");
  chmodSync(reports.path("smoke"), 0o400);
  await expect(launchLane({ ...fixture.deps, run: fixture.run }, fixture.input)).rejects.toThrow("EACCES");
  expect(await fixture.deps.registry.read("smoke")).toBeNull();
  expect(existsSync(reports.path("smoke"))).toBe(false);
  expect(fixture.calls.some((call) => call[0] === "herdr" && call[2] === "close")).toBe(true);
  expect(fixture.calls.some((call) => call[0] === "herdr" && call[2] === "run")).toBe(false);
  fixture.succeed();
  const result = await launchLane({ ...fixture.deps, run: fixture.run }, fixture.input);
  expect(result.startup).toBe("STARTUP_OK smoke w1:p3");
  expect(reports.read("smoke")?.state).toBe("running");
});
