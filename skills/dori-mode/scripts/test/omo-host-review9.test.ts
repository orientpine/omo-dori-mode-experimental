import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { blockedTick } from "../src/done-flow.ts";
import { missedAnswersTick } from "../src/missed-answers.ts";
import type { Question } from "../src/messenger/discord-cards.ts";
import type { Lane } from "../src/registry.ts";
import { childEnv, runtimesOf, type Runner } from "../src/run.ts";
import { FakeOmoHost, type HostSession } from "./fake-omo-host.ts";
import { depsFor, fakeClock, fakeRunner, newWorld, withState } from "./fakes.ts";

// https://github.com/sisyphuslabs/dori-superagent/pull/282 (review 9 of PR 527): one unreachable hosted session holds only
// its own lane or card, and a hosted session's marker never reaches a terminal server's environment.
const up = "00000000-0000-4000-8000-000000000091";
const down = "00000000-0000-4000-8000-000000000092";
const at = Date.parse("2026-11-25T16:40:00Z");
const openedAt = new Date(at - 600_000).toISOString();

const fixture = () => {
  const state = withState();
  const host = new FakeOmoHost(join(state.dir, "sessions"));
  const healthy = host.add({ id: up, name: "dori/g1/up" });
  host.add({ id: down, name: "dori/g1/down" });
  const world = newWorld();
  const base = fakeRunner(world);
  const run: Runner = async (argv, opts) => {
    if (argv[0] !== "omo") return base(argv, opts);
    if (argv.includes(down)) return { code: 1, out: `${JSON.stringify({ action: "error", reason: "host_unavailable" })}\n`, err: "" };
    const r = await host.exec("omo", argv.slice(1));
    return { code: r.code, out: r.stdout, err: r.stderr };
  };
  const deps = { ...depsFor(world, fakeClock(at), state.dir, { runtime: "hc", backend: "herdr", laneWorkspace: "g1", leadPane: "hc:t1" }), run };
  const lane = (key: string, id: string, over: Partial<Lane> = {}): Lane => ({ key, title: key, thread: "none", pane: `omo-host:${id}`, session: id, openedAt, brief: join(state.dir, `${key}.md`), done: "closed acme/app#3", status: "working", ...over });
  return { state, healthy, deps, lane };
};

const logFor = (s: HostSession): void => {
  const path = String(s.state["sessionFile"]);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ type: "session", timestamp: new Date(at - 900_000).toISOString() })}\n`);
};

test("blocked detection keeps an unreachable hosted lane's state and still reads the other lanes", async () => {
  const f = fixture();
  try {
    await f.deps.registry.write(f.lane("down", down, { blocked: "question" }));
    await f.deps.registry.write(f.lane("up", up));
    const out = await blockedTick(f.deps, false);
    expect(out).toContainEqual(expect.stringMatching(/^LANE_WATCH_WARN down .*host_unavailable/));
    expect((await f.deps.registry.read("down"))?.blocked).toBe("question");
    expect((await f.deps.registry.read("up"))?.idleSince).toBe(at);
  } finally { f.state.done(); }
});

test("a card whose host is unreachable is held while an earlier delivery's mark is kept, so nothing is sent twice", async () => {
  const f = fixture();
  try {
    logFor(f.healthy);
    await f.deps.registry.write(f.lane("up", up));
    await f.deps.registry.write(f.lane("down", down));
    const answeredAt = new Date(at - 240_000).toISOString();
    const cards = [
      { id: "Q31", status: "answered", tmux: `omo-host:${up}`, answeredAt, text: "which?", answer: "blue" },
      { id: "Q32", status: "answered", tmux: `omo-host:${down}`, answeredAt, text: "which?", answer: "red" },
    ] as Question[];
    const deps = { ...f.deps, answeredCards: () => cards };
    const first = await missedAnswersTick(deps);
    expect(first).toContainEqual(expect.stringContaining(`CARD_ANSWER_REDELIVERED Q31 omo-host:${up}`));
    expect(first).toContainEqual(expect.stringMatching(/^CARD_ANSWER_HELD Q32 .*host_unavailable/));
    await missedAnswersTick(deps);
    expect(f.healthy.entries).toHaveLength(1);
  } finally { f.state.done(); }
});

test("a terminal server never inherits the hosted-session marker, so its agents are told by their terminal", () => {
  const env = childEnv(["hc", "run"], { SENPI_RPC_HOST_PUBLIC_SOCKET: "/run/host.sock", HC_TERMINAL_ID: "t3", PATH: "/bin" });
  expect(env["SENPI_RPC_HOST_PUBLIC_SOCKET"]).toBeUndefined();
  expect(runtimesOf(fakeRunner(newWorld())).selfAny({ ...env, PI_SESSION_ID: up })).toEqual({ runtime: "hc", id: "t3" });
});
