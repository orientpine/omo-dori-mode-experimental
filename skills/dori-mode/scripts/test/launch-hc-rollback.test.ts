import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchLane } from "../src/launch.ts";
import { Reports } from "../src/reports.ts";
import { terminal as hcTerm } from "./fake-hc.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
let state: ReturnType<typeof withState>;
let world: ReturnType<typeof newWorld>;
let previousRuntime: string | undefined;
let brief: string;

beforeEach(async () => {
  state = withState();
  world = newWorld();
  world.terminals = { t1: hcTerm() };
  brief = join(state.dir, "hc-brief.md");
  await Bun.write(brief, "# brief\n");
  previousRuntime = process.env["DORI_RUNTIME"];
  process.env["DORI_RUNTIME"] = "hc";
});

afterEach(() => {
  if (previousRuntime === undefined) delete process.env["DORI_RUNTIME"];
  else process.env["DORI_RUNTIME"] = previousRuntime;
  state.done();
});

const rig = (sendKind: string | undefined, closeRemoves: boolean) => {
  const deps = {
    ...depsFor(world, fakeClock(T0), state.dir, { backend: "herdr" as const, runtime: "hc" as const }),
    readGoal: async () => ({ status: "active" as const }),
  };
  const base = deps.run;
  let reject = sendKind !== undefined;
  const calls: (readonly string[])[] = [];
  const run: typeof deps.run = async (argv, opts) => {
    calls.push(argv);
    if (argv[0] === "hc" && argv[1] === "--json" && argv[2] === "run") {
      world.terminals = { ...world.terminals, t1: hcTerm() };
      return { code: 0, out: JSON.stringify({ address: "t1", state: "live", labels: {} }), err: "" };
    }
    if (argv[0] === "hc" && argv[1] === "--json" && argv[2] === "read") return { code: 0, out: JSON.stringify({ text: "❯ ", complete: true, how: "screen" }), err: "" };
    if (argv[0] === "hc" && argv[1] === "--json" && argv[2] === "send") {
      if (reject) return { code: 1, out: "", err: JSON.stringify({ error: { kind: sendKind, message: sendKind === "unavailable" ? "connection timed out" : "bad command" } }) };
      return { code: 0, out: JSON.stringify({ status: "idle", turn: 1, started: true }), err: "" };
    }
    if (argv[0] === "hc" && argv[1] === "--json" && argv[2] === "kill") return { code: 0, out: "{}", err: "" };
    if (argv[0] === "hc" && argv[1] === "--json" && argv[2] === "rm") {
      if (!closeRemoves) return { code: 1, out: "", err: JSON.stringify({ error: { kind: "live", message: "still running" } }) };
      delete world.terminals?.["t1"];
      return { code: 0, out: "{}", err: "" };
    }
    return base(argv, opts);
  };
  const input = { noThread: "QA", key: "smoke", title: "smoke", brief, done: "file /tmp/ok", cwd: "/tmp/w" } as const;
  return { deps, run, input, calls, succeed: () => { reject = false; } };
};

test("a definite hc start failure with confirmed cleanup unwinds and retries", async () => {
  const fixture = rig("invalid_params", true);
  await expect(launchLane({ ...fixture.deps, run: fixture.run }, fixture.input)).rejects.toThrow("hc send failed");
  expect(await fixture.deps.registry.read("smoke")).toBeNull();
  expect(existsSync(new Reports(state.dir).path("smoke"))).toBe(false);
  fixture.succeed();
  const result = await launchLane({ ...fixture.deps, run: fixture.run }, fixture.input);
  expect(result.startup).toBe("STARTUP_OK smoke hc:t1");
  expect(await fixture.deps.registry.read("smoke")).not.toBeNull();
  expect(new Reports(state.dir).read("smoke")?.state).toBe("running");
});

test("an ambiguous hc send failure preserves registration even after terminal cleanup", async () => {
  const fixture = rig("unavailable", true);
  await expect(launchLane({ ...fixture.deps, run: fixture.run }, fixture.input)).rejects.toThrow("hc send failed");
  expect(await fixture.deps.registry.read("smoke")).not.toBeNull();
  expect(existsSync(new Reports(state.dir).path("smoke"))).toBe(true);
});

test("a still-live hc cleanup outcome preserves registration and journal", async () => {
  const fixture = rig("invalid_params", false);
  await expect(launchLane({ ...fixture.deps, run: fixture.run }, fixture.input)).rejects.toThrow("hc send failed");
  expect(await fixture.deps.registry.read("smoke")).not.toBeNull();
  expect(existsSync(new Reports(state.dir).path("smoke"))).toBe(true);
});

test("an initial journal append failure closes the new terminal and unwinds for retry", async () => {
  const fixture = rig("invalid_params", true);
  const reports = new Reports(state.dir);
  mkdirSync(join(state.dir, "lanes", "smoke"), { recursive: true });
  writeFileSync(reports.path("smoke"), "");
  chmodSync(reports.path("smoke"), 0o400);
  await expect(launchLane({ ...fixture.deps, run: fixture.run }, fixture.input)).rejects.toThrow("EACCES");
  expect(await fixture.deps.registry.read("smoke")).toBeNull();
  expect(existsSync(reports.path("smoke"))).toBe(false);
  expect(fixture.calls.some((call) => call[0] === "hc" && call[2] === "rm")).toBe(true);
  expect(fixture.calls.some((call) => call[0] === "hc" && call[2] === "send")).toBe(false);
  fixture.succeed();
  const result = await launchLane({ ...fixture.deps, run: fixture.run }, fixture.input);
  expect(result.startup).toBe("STARTUP_OK smoke hc:t1");
  expect(reports.read("smoke")?.state).toBe("running");
});
