import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { launchLane, renderBrief } from "../src/launch.ts";
import { Reports } from "../src/reports.ts";
import { FakeOmoHost } from "./fake-omo-host.ts";
import { syncRegistry } from "../src/sync.ts";
import { watchTick } from "../src/done-flow.ts";
import { listPanes, readScreen } from "../src/panes.ts";
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
  const input = { noThread: "QA", key: "smoke", title: "smoke", brief, done: "file /tmp/ok", cwd: "/tmp/w", model: "m" } as const;
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

test("aoe with explicit hc placement unwinds confirmed hc rollback", async () => {
  const fixture = rig("invalid_params", true);
  const config = { ...fixture.deps.config, backend: "aoe" as const, laneRuntime: "hc" as const };
  await expect(launchLane({ ...fixture.deps, config, run: fixture.run }, fixture.input)).rejects.toThrow("hc send failed");
  expect(await fixture.deps.registry.read("smoke")).toBeNull();
  expect(existsSync(new Reports(state.dir).path("smoke"))).toBe(false);
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
// Compatibility guard for https://github.com/sisyphuslabs/dori-superagent/pull/282.
test("an hc launch without placement overrides uses the same terminal spec and footer", async () => {
  const fixture = rig(undefined, true);
  const expected = await renderBrief(fixture.deps, fixture.input);
  const result = await launchLane({ ...fixture.deps, run: fixture.run }, fixture.input);
  expect(result.lane.pane).toBe("hc:t1");
  const [open] = fixture.calls.filter((argv) => argv[0] === "hc" && argv[2] === "run");
  expect(open?.slice(0, open.indexOf("--"))).toEqual([
    "hc", "--json", "run", "--bg", "--no-parent", "--no-notify", "--keep", "--cwd", "/tmp/w", "--label", "dori.group=dori", "--label", "dori.role=lane", "--label", "dori.name=smoke", "--label", "dori.lane=smoke", "--name", "smoke",
  ]);
  const rendered = await Bun.file(brief).text();
  expect(rendered.split("## Lane footer")[1]).toBe(expected.text.split("## Lane footer")[1]);
  expect(rendered).toContain('run ["dori","type",');
  expect(rendered).not.toContain('["hc","send",');
});

test("without placement overrides hc launch, sync and watch coexist with a stored hosted lane", async () => {
  const fixture = rig(undefined, true);
  const host = new FakeOmoHost(join(state.dir, "sessions"));
  const id = "00000000-0000-4000-8000-000000000073";
  const pane = `omo-host:${id}`;
  const entry = { type: "message", message: { role: "assistant", content: "hosted marker" } };
  const hosted = host.add({ id, entries: [entry] });
  const transcript = String(hosted.state["sessionFile"]);
  mkdirSync(dirname(transcript), { recursive: true });
  writeFileSync(transcript, `${JSON.stringify(entry)}\n`);
  const run: typeof fixture.run = async (argv, opts) => {
    if (argv[0] !== "omo") return fixture.run(argv, opts);
    const result = await host.exec("omo", argv.slice(1));
    return { code: result.code, out: result.stdout, err: result.stderr };
  };
  const deps = { ...fixture.deps, run };
  expect(deps.config.laneRuntime).toBeUndefined();
  expect(deps.config.leadRuntime).toBeUndefined();
  await deps.registry.write({ key: "hosted", title: "Hosted", pane, thread: "none", done: "file /hosted", brief, openedAt: new Date(T0).toISOString() });
  const { lane, startup } = await launchLane(deps, fixture.input);
  expect(startup).toBe("STARTUP_OK smoke hc:t1");
  expect((await listPanes(run, deps.config)).map((p) => p.pane_id)).toEqual(expect.arrayContaining([pane, lane.pane]));
  const sync = await syncRegistry(deps, false);
  expect(sync.drift).toEqual([]);
  expect(sync.rows).toEqual(expect.arrayContaining([expect.objectContaining({ key: "smoke", pane: "hc:t1" }), expect.objectContaining({ key: "hosted", pane, session: `${id} (runtime)` })]));
  expect(await watchTick(deps)).toEqual([]);
  expect(await readScreen(run, deps.config.backend, pane)).toContain("hosted marker");
  expect(host.calls.some(([verb]) => verb === "open")).toBe(false);
});

test("an aoe config with explicit hc runs the lane in the launching instance", async () => {
  const fixture = rig(undefined, true);
  const previous = { DORI_CONFIG: process.env["DORI_CONFIG"], DORI_ENV_FILE: process.env["DORI_ENV_FILE"] };
  const configFile = join(state.dir, "custom.json");
  const envFile = join(state.dir, "custom.env");
  process.env["DORI_CONFIG"] = configFile;
  process.env["DORI_ENV_FILE"] = envFile;
  try {
    const config = { ...fixture.deps.config, backend: "aoe" as const, laneRuntime: "hc" as const };
    const result = await launchLane({ ...fixture.deps, config, run: fixture.run }, fixture.input);
    expect(result.startup).toBe("STARTUP_OK smoke hc:t1");
    const argv = fixture.calls.find((a) => a[0] === "hc" && a[2] === "send");
    expect(argv?.join(" ")).toContain(`DORI_CONFIG=${configFile}`);
    expect(argv?.join(" ")).toContain(`DORI_STATE_DIR=${state.dir}`);
    expect(argv?.join(" ")).toContain(`DORI_ENV_FILE=${envFile}`);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
