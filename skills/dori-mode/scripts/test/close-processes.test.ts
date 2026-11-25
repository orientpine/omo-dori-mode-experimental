import { afterEach, beforeEach, expect, test } from "bun:test";
import { closeLane, type FlowDeps } from "../src/done-flow.ts";
import type { Lane } from "../src/registry.ts";
import type { Runner } from "../src/run.ts";
import { depsFor, fakeClock, fakeRunner, newWorld, withState, type World } from "./fakes.ts";
import { terminal } from "./fake-hc.ts";

// upstream sisyphuslabs/dori-superagent#225: close a real lane record against fake runtime and process boundaries.
const lane: Lane = {
  key: "demo-lane",
  title: "demo",
  thread: "none",
  pane: "w1:p1",
  brief: "/briefs/demo.md",
  done: "merged acme/app#1",
  cwd: "/repo",
  openedAt: "2026-01-01T11:00:00.000Z",
};

const PIPE = "4200 1 S /bin/sh -c sleep 9999 | cat";
const SLEEP = "4201 4200 S sleep 9999";
const CAT = "4202 4200 S cat";
const UNRELATED = "4300 1 S sleep 9999";
// The fake herdr reports shell_pid 4000.
const BEFORE = ["4000 1 Ss -bash", "4001 4000 Sl omo", PIPE.replace("4200 1 ", "4200 4001 "), SLEEP, CAT, UNRELATED].join("\n");
const AFTER = [PIPE, SLEEP, CAT, UNRELATED].join("\n");

let state: ReturnType<typeof withState>;
let world: World;
let tables: string[];
let rootEnv: string | undefined;
let rootCommand: string;
let failedClose: boolean;
// what `ps -o pid=,lstart= -p ...` prints, read before and after the close
let starts: string[];
const START = "Wed Nov 25 10:40:10 2026";
const startsOf = (pids: readonly number[], at = START) => pids.map((p) => `${p} ${at}`).join("\n");

const kills = () => world.calls.filter((c) => c[0] === "kill");
const receipt = (lines: readonly string[]) =>
  JSON.parse(lines.at(-1)?.replace(/^CLOSED \S+ /, "") ?? "{}") as { cleanup: string[] };

const deps = (): FlowDeps => {
  const base = depsFor(world, fakeClock(Date.parse("2026-01-01T12:00:00.000Z")), state.dir, {
    backend: "herdr",
    agentCommand: ["claude"],
  });
  const inner = fakeRunner(world);
  const run: Runner = async (argv, opts) => {
    if ((argv[0] === "ps" && argv[1] === "eww") || (argv[0] === "cat" && argv[1] === "/proc/4000/environ")) {
      const out = rootEnv === undefined ? "" : argv[0] === "cat" ? rootEnv : `${rootCommand} ${rootEnv.replaceAll("\0", " ")}`;
      return { code: rootEnv === undefined ? 1 : 0, out, err: "" };
    }
    if (argv[0] === "ps" && argv[1] === "-o" && argv[2] === "pid=,lstart=") {
      world.calls.push([...argv]);
      const out = starts.shift();
      return out === undefined ? { code: 1, out: "", err: "ps: unavailable" } : { code: 0, out, err: "" };
    }
    if (argv[0] === "ps" && argv[1] === "-A") {
      world.calls.push([...argv]);
      const out = tables.shift();
      return out === undefined ? { code: 1, out: "", err: "ps: unavailable" } : { code: 0, out, err: "" };
    }
    if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "close" && failedClose) {
      return { code: 1, out: "", err: "close failed" };
    }
    if (argv[0] === "hc" && argv[1] === "--json" && (argv[2] === "kill" || argv[2] === "rm")) {
      if (argv[2] === "rm" && world.terminals) delete world.terminals["t7"];
      return { code: 0, out: "{}", err: "" };
    }
    if (argv[0] === "kill") {
      world.calls.push([...argv]);
      return { code: 0, out: "", err: "" };
    }
    return inner(argv, opts);
  };
  return { ...base, run };
};

beforeEach(() => {
  state = withState();
  world = newWorld();
  world.panes = [{ pane_id: "w1:p1", workspace_id: "w1", agent: "pi", agent_status: "idle" }];
  rootEnv = "HOME=/home/test\0HERDR_PANE_ID=w1:p1\0TERM=xterm\0";
  rootCommand = "-bash";
  failedClose = false;
  tables = [BEFORE, AFTER];
  starts = [startsOf([4000, 4001, 4200, 4201, 4202]), startsOf([4200, 4201, 4202])];
});

// review 1 of #522: a watch that ended during the close and whose pid a new process with the same command took is not ours
test("a pid reused by the same command after the close (another start time) is left alone", async () => {
  starts = [startsOf([4000, 4001, 4200, 4201, 4202]), `${startsOf([4200, 4202])}\n4201 Wed Nov 25 10:41:00 2026`];
  const r = await closeLane(deps(), lane, "Done");
  expect(kills()).toEqual([["kill", "-TERM", "4200", "4202"]]);
  expect(receipt(r.lines).cleanup).toContain("2 lane processes outlived the pane, stopped: 4200 4202");
});

test("start times that cannot be read after the close stop nothing", async () => {
  starts = [startsOf([4000, 4001, 4200, 4201, 4202])];
  const r = await closeLane(deps(), lane, "Done");
  expect(kills()).toEqual([]);
  expect(receipt(r.lines).cleanup).toContain("lane processes not checked: ps: unavailable");
});
afterEach(() => state.done());

test("close stops reparented lane watches by exact pid and leaves an identical unrelated sleep alone", async () => {
  const r = await closeLane(deps(), lane, "Done");
  expect(r.closed).toBe(true);
  expect(kills()).toEqual([["kill", "-TERM", "4200", "4201", "4202"]]);
  expect(receipt(r.lines).cleanup).toContain("3 lane processes outlived the pane, stopped: 4200 4201 4202");
});

test("close does not signal a reused pid or a zombie", async () => {
  tables = [BEFORE, "4201 1 S /usr/bin/editor notes.md\n4202 1 Z cat"];
  const r = await closeLane(deps(), lane, "Done");
  expect(kills()).toEqual([]);
  expect(receipt(r.lines).cleanup).toContain("no lane process outlived the pane");
});

test.each([["before", []], ["after", [BEFORE]]] as const)(
  "an unreadable table %s close stops nothing and is reported without blocking close",
  async (_when, available) => {
    tables = [...available];
    const r = await closeLane(deps(), lane, "Done");
    expect(r.closed).toBe(true);
    expect(kills()).toEqual([]);
    expect(receipt(r.lines).cleanup).toContain("lane processes not checked: ps: unavailable");
  },
);

test("a runtime's numerical root pid is not proof of a local session", async () => {
  rootEnv = "HOME=/\0";
  // On ps-based hosts the marker must not be accepted from argv either.
  rootCommand = "-bash HERDR_PANE_ID=w1:p1";
  tables = [BEFORE.replace("-bash", rootCommand), AFTER];
  const r = await closeLane(deps(), lane, "Done");
  expect(r.closed).toBe(true);
  expect(kills()).toEqual([]);
  expect(receipt(r.lines).cleanup).toContain(
    "lane processes not checked: session root 4000 on this host does not carry HERDR_PANE_ID=w1:p1 (the session may run on another host)",
  );
});

test("a root with an unreadable environment is not signalled", async () => {
  rootEnv = undefined;
  const r = await closeLane(deps(), lane, "Done");
  expect(kills()).toEqual([]);
  expect(receipt(r.lines).cleanup).toContain("lane processes not checked: session root 4000 could not be read on this host");
});

test.each([["HERDR_PANE_ID=w1:p1", false], ["HERDR_PANE_ID=w1:p1\0HC_TERMINAL_ID=t7", true]] as const)(
  "hc ownership needs its own terminal marker in %j",
  async (env, owned) => {
    world.terminals = { t7: terminal({ pid: 4000 }) };
    rootEnv = env;
    const r = await closeLane(deps(), { ...lane, pane: "hc:t7" }, "Done");
    expect(kills()).toEqual(owned ? [["kill", "-TERM", "4200", "4201", "4202"]] : []);
    expect(receipt(r.lines).cleanup).toContain(
      owned
        ? "3 lane processes outlived the pane, stopped: 4200 4201 4202"
        : "lane processes not checked: session root 4000 on this host does not carry HC_TERMINAL_ID=t7 (the session may run on another host)",
    );
  },
);

test("a failed runtime close does not signal processes in a still-open pane", async () => {
  failedClose = true;
  const r = await closeLane(deps(), lane, "Done");
  expect(kills()).toEqual([]);
  expect(receipt(r.lines).cleanup[0]).toBe("pane w1:p1 not closed");
  expect(receipt(r.lines).cleanup.some((line) => line.includes("lane process"))).toBe(false);
});
