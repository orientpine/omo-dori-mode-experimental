// Ported from https://github.com/sisyphuslabs/omo-dori-mode-experimental/pull/282.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { goalCommand } from "../src/goal.ts";
import { loadConfig } from "../src/config.ts";
import { launchLane } from "../src/launch.ts";
import { readScreen, sendVerified } from "../src/panes.ts";
import { closeLane } from "../src/done-flow.ts";
import type { Runner } from "../src/run.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";
import { FakeOmoHost, writeGoal } from "./fake-omo-host.ts";

const T0 = Date.parse("2026-11-20T02:00:00Z");

const rig = () => {
  const state = withState();
  const host = new FakeOmoHost(join(state.dir, "sessions"));
  const deps = depsFor(newWorld(), fakeClock(T0), state.dir, { runtime: "hc", backend: "herdr", laneWorkspace: "g1", leadPane: "hc:t3" });
  const base = deps.run;
  const run: Runner = async (argv, opts) => {
    if (argv[0] !== "omo") return base(argv, opts);
    const r = await host.exec("omo", argv.slice(1));
    const session = host.sessions.get(argv[4] ?? "");
    if (r.code === 0 && argv[3] === "prompt" && session && argv[5]?.includes("You are the fix-x lane")) {
      writeGoal(session, "active");
      session.state["isStreaming"] = false;
    }
    return { code: r.code, out: r.stdout.trim(), err: r.stderr };
  };
  return { state, host, deps: { ...deps, run } };
};

test("laneRuntime permits omo-host but runtime remains terminal-only", async () => {
  const { state } = rig();
  try {
    const path = join(state.dir, "config.json");
    await Bun.write(path, JSON.stringify({ runtime: "hc", laneRuntime: "omo-host" }));
    expect(await loadConfig(path)).toMatchObject({ runtime: "hc", laneRuntime: "omo-host" });
    await Bun.write(path, JSON.stringify({ laneRuntime: "tmux" }));
    await expect(loadConfig(path)).rejects.toThrow(/laneRuntime/);
    await Bun.write(path, JSON.stringify({ runtime: "omo-host" }));
    await expect(loadConfig(path)).rejects.toThrow(/runtime must be/);
  } finally { state.done(); }
});

test("a hosted launch can be read, prompted and closed without a terminal", async () => {
  const { state, host, deps } = rig();
  try {
    const path = join(state.dir, "proof");
    const brief = join(state.dir, "brief.md");
    await Bun.write(path, "done");
    await Bun.write(brief, "# brief\nDo the thing.\n");
    const configured = { ...deps, config: { ...deps.config, laneRuntime: "omo-host" as const } };
    const result = await launchLane(configured, { key: "fix-x", title: "t", brief, noThread: "QA", cwd: state.dir, model: "a/m", done: `file ${path}` });
    const pane = result.lane.pane ?? "";
    const [hosted] = host.sessions.values();
    expect(hosted?.name).toBe("dori/g1/fix-x");
    expect(result.startup).toBe(`STARTUP_OK fix-x ${pane}`);
    expect(result.lane.sessionRef).toMatchObject({ runtime: "omo-host", id: hosted?.id });
    expect(host.calls.find(([verb]) => verb === "open")).toContain("a/m");
    const rendered = await Bun.file(brief).text();
    expect(rendered).toContain(`DORI_STATE_DIR=${configured.config.stateDir}`);
    expect(rendered).toContain('["hc","send","t3","--","<report line>"]');
    expect(await readScreen(configured.run, "herdr", pane)).toContain("You are the fix-x lane");
    expect(await sendVerified(configured.run, configured.clock, configured.config, pane, "test follow-up")).toBe(true);
    expect(await readScreen(configured.run, "herdr", pane)).toContain("test follow-up");
    expect((await closeLane(configured, result.lane, "QA complete")).closed).toBe(true);
    expect(hosted?.parked).toBe(true);
  } finally { state.done(); }
});

// A list/state gap can resume a session the lead just closed.
test("startup re-closes a hosted lane closed between list and state", async () => {
  const { state, host, deps } = rig();
  try {
    const brief = join(state.dir, "brief.md");
    await Bun.write(brief, "# brief\n");
    let raced = false;
    const run: Runner = async (argv, opts) => {
      if (!raced && argv[0] === "omo" && argv[3] === "state") {
        raced = true;
        const lane = await deps.registry.read("fix-x");
        if (!lane) throw new Error("fixture did not register before start");
        await host.exec("omo", ["host", "session", "close", argv[4] ?? "", "--json"]);
        await deps.registry.write({ ...lane, status: "closed", closedAt: new Date(T0).toISOString() });
      }
      return deps.run(argv, opts);
    };
    const config = { ...deps.config, laneRuntime: "omo-host" as const };
    const result = await launchLane({ ...deps, config, run }, { key: "fix-x", title: "t", brief, noThread: "QA", cwd: state.dir, model: "a/m", done: "closed acme/app#3" });
    expect(result.startup).toBe("STARTUP_DONE fix-x");
    expect([...host.sessions.values()].map((s) => s.parked)).toEqual([true]);
  } finally { state.done(); }
});

test("pause handles a hosted goal without a pane screen confirmation", async () => {
  const { state, host, deps } = rig();
  try {
    const id = "00000000-0000-4000-8000-000000000012";
    const session = host.add({ id });
    writeGoal(session, "active");
    expect(await goalCommand(deps, `omo-host:${id}`, "pause")).toMatchObject({ outcome: "confirmed" });
    expect(await goalCommand(deps, `omo-host:${id}`, "resume")).toMatchObject({ outcome: "confirmed" });
  } finally { state.done(); }
});
