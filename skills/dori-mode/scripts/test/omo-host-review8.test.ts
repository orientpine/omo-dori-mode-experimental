import { expect, test } from "bun:test";
import { join } from "node:path";
import { watchTick } from "../src/done-flow.ts";
import { handover, type HandoverDeps } from "../src/handover.ts";
import type { Lane } from "../src/registry.ts";
import { runtimesOf, type Runner } from "../src/run.ts";
import { submitHosted } from "../src/sessions.ts";
import { depsFor, fakeClock, fakeRunner, newWorld, withState } from "./fakes.ts";

// https://github.com/sisyphuslabs/dori-superagent/pull/282 (review 8 of PR 527): a host that cannot be reached holds one
// lane's settlement and leaves the rest of the watch tick running; a slash command whose outcome is unknown is not unsent.
const id = "00000000-0000-4000-8000-000000000081";
const pane = `omo-host:${id}`;
const at = Date.parse("2026-11-25T16:30:00Z");

const failing = (reason: string, code: number): Runner => async (argv) =>
  argv[0] === "omo" ? { code, out: `${JSON.stringify({ action: "error", reason })}\n`, err: "" } : { code: 0, out: "", err: "" };

test("a claimed hosted lane whose host is unreachable is held with a warning, and the tick goes on", async () => {
  const state = withState();
  try {
    const world = newWorld();
    const base = fakeRunner(world);
    const run: Runner = (argv, opts) => (argv[0] === "omo" ? failing("host_unavailable", 1)(argv, opts) : base(argv, opts));
    const deps = { ...depsFor(world, fakeClock(at), state.dir, { runtime: "hc", backend: "herdr", laneWorkspace: "g1", leadPane: "hc:t1" }), run };
    const lane: Lane = { key: "hosted", title: "Hosted", thread: "none", pane, session: id, openedAt: new Date(at - 86_400_000).toISOString(), brief: join(state.dir, "brief.md"), done: "closed acme/app#3", status: "done-claimed", claim: { at: new Date(at - 86_400_000).toISOString(), evidence: "proof", emitted: true } };
    await deps.registry.write(lane);
    const out = await watchTick(deps);
    expect(out).toContainEqual(expect.stringMatching(/^LANE_WATCH_WARN hosted .*host_unavailable/));
    expect((await deps.registry.read("hosted"))?.status).toBe("done-claimed");
  } finally { state.done(); }
});

test("a slash command whose host reply is lost is ambiguous, and one the host refused is not submitted", async () => {
  const state = withState();
  try {
    const ref = { runtime: "omo-host" as const, id };
    expect((await submitHosted(runtimesOf(failing("transport_gone", 1)), ref, "/goal pause")).status).toBe("AMBIGUOUS");
    expect((await submitHosted(runtimesOf(failing("unsupported_command", 3)), ref, "/goal pause")).status).toBe("NOT_SUBMITTED");
    expect((await submitHosted(runtimesOf(failing("busy", 1)), ref, "/goal pause")).status).toBe("NOT_SUBMITTED");
  } finally { state.done(); }
});

test("a lead handover is refused when leadRuntime differs from where the replacement would open", async () => {
  const state = withState();
  try {
    const world = newWorld();
    const printed: string[] = [];
    const base = depsFor(world, fakeClock(at), state.dir, { backend: "aoe", leadPane: "hc:t1", leadRuntime: "hc" });
    const deps: HandoverDeps = {
      ...base, configPath: join(state.dir, "config.json"), envPath: join(state.dir, "dori.env"), cardDir: join(state.dir, "discord"), inbox: join(state.dir, "inbox.jsonl"), home: state.dir,
      sessionOf: async () => "", routedPane: async () => "hc:t1", envLeadPane: "", alive: () => false, procs: async () => [], signal: () => true, realpath: (p) => p,
      timers: async () => [], restart: async () => undefined, nonce: () => "n1", print: (line) => printed.push(line),
    };
    expect((await handover(deps, { approvedBy: "https://discord.com/channels/1/2/3", title: "lead2" })).code).toBe(2);
    expect(printed[0]).toStartWith("HANDOVER_REFUSED leadRuntime hc differs from aoe");
    expect(world.calls.some((c) => c[0] === "aoe" && c[1] === "add")).toBe(false);
  } finally { state.done(); }
});
