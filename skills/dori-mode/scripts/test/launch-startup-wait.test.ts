import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FlowDeps } from "../src/done-flow.ts";
import type { GoalRead } from "../src/goal.ts";
import { launchLane, startupFailure } from "../src/launch.ts";
import { terminal as hcTerm } from "./fake-hc.ts";
import { depsFor, newWorld, withState, type World } from "./fakes.ts";

// A slow host starts the agent late: launch waits for it (startupWaitSeconds, 180 s: the 20 s check, then sixteen 10 s
// re-reads), and only a gone pane, an agent that ended or a real failure ends the wait at once (dori-superagent issue #202
// reproduced here (MIT): https://github.com/sisyphuslabs/dori-superagent/issues/202, upstream PR #203). In four real lanes
// the agent's session got its argv prompt as the first user message 47, 61, 63 and 140 s after launch; launch had already
// said STARTUP_UNCONFIRMED or STARTUP_NO_GOAL, so the lead sent the prompt again and the lane read its brief twice.

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const PANE = "w:p9";
const CWD = "/tmp/w";
const BUSY = "reading the brief\n⠋ Working… (esc to interrupt)\n❯ ";
const PROMPT_WORDS = "Read and execute the lane brief";

let state: ReturnType<typeof withState>;
let world: World;
let brief: string;

beforeEach(async () => {
  state = withState();
  world = newWorld();
  brief = join(state.dir, "brief.md");
  await Bun.write(brief, "# brief\n");
});

afterEach(() => state.done());

// a clock whose every sleep moves it on and fires what is due by then (seconds after launch)
const timeline = (events: Record<number, () => void>) => {
  const due = Object.entries(events).map(([s, fire]) => ({ at: T0 + Number(s) * 1000, fire })).sort((a, b) => a.at - b.at);
  const clock = { at: T0, sleeps: 0, now: () => clock.at, sleep: async (ms: number) => {
    clock.at += ms;
    clock.sleeps++;
    while (due[0] && due[0].at <= clock.at) due.shift()?.fire();
  } };
  return clock;
};

const deliveries = (calls: readonly (readonly string[])[]): number => calls.filter((c) => c.join(" ").includes(PROMPT_WORDS)).length;

// a herdr omo lane: herdr starts the agent with its prompt in the command line and launch's own --session-id, whose
// transcript and goal record omo writes under sessionsDir once it took the prompt
const herdrLane = (events: (lane: { arrive: (goal?: string) => void; header: () => void }) => Record<number, () => void>, patch: Record<string, unknown> = {}) => {
  const sessions = join(state.dir, "sessions");
  const base = depsFor(world, { now: () => T0, sleep: async () => {} }, state.dir, { sessionsDir: sessions, ...patch });
  let session = "";
  const dir = join(sessions, `--${CWD.replace(/^\//, "").replace(/\//g, "-")}--`);
  const file = () => join(dir, `2026-01-01T12-00-01-000Z_${session}.jsonl`);
  // omo's control endpoint writes the session header before it takes the initial message
  const header = (): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file(), `${JSON.stringify({ type: "session", id: session, cwd: CWD })}\n`);
  };
  const arrive = (goal?: string): void => {
    mkdirSync(join(dir, "extensions", "goal"), { recursive: true });
    appendFileSync(file(), `${JSON.stringify({ type: "message", message: { role: "user", content: "ulw. Read and execute the lane brief" } })}\n`);
    if (goal) writeFileSync(join(dir, "extensions", "goal", `${session}.json`), JSON.stringify({ goal: { status: goal } }));
  };
  const clock = timeline(events({ arrive, header }));
  const deps: FlowDeps = { ...base, clock, run: async (argv, o) => {
    if (argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create") return { code: 0, out: JSON.stringify({ result: { root_pane: { pane_id: PANE }, tab_id: "w:t9" } }), err: "" };
    if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "run") session = /--session-id[= ](\S+)/.exec(argv.join(" "))?.[1]?.replace(/'/g, "") ?? "";
    return base.run(argv, o);
  } };
  return { deps, clock, launch: (key: string) => launchLane(deps, { noThread: "QA", key, title: key, brief, done: "file /tmp/ok", cwd: CWD, model: "m" }) };
};

test("a herdr omo lane whose first prompt arrives 47, 61, 63 or 140 s after launch is STARTUP_OK once its goal shows, the prompt sent once", async () => {
  for (const s of [47, 61, 63, 140]) {
    world = newWorld();
    const lane = herdrLane(({ arrive }) => ({ [s]: () => arrive("active") }));
    expect((await lane.launch(`slow-${s}`)).startup).toBe(`STARTUP_OK slow-${s} ${PANE}`);
    expect(deliveries(world.calls)).toBe(1);
    // the 20 s check, then a re-read every 10 s until the one at or after the arrival
    expect(lane.clock.sleeps).toBe(1 + Math.ceil((s - 20) / 10));
  }
});

test("a session whose transcript holds only its header is still waited for: a prompt taken at 60 s is STARTUP_OK, none at all is STARTUP_UNCONFIRMED after the whole wait", async () => {
  const late = herdrLane(({ arrive, header }) => ({ 1: header, 60: () => arrive("active") }));
  expect((await late.launch("header")).startup).toBe(`STARTUP_OK header ${PANE}`);
  expect(late.clock.sleeps).toBe(5);
  world = newWorld();
  const never = herdrLane(({ header }) => ({ 1: header }));
  expect((await never.launch("header-only")).startup).toStartWith(`STARTUP_UNCONFIRMED header-only ${PANE}: the agent runs but its session holds no transcript`);
  expect(never.clock.sleeps).toBe(17);
});

test("a first prompt that arrives at 63 s into a running first turn is STARTUP_PENDING_GOAL; one that ends idle is STARTUP_NO_GOAL three reads after it, not before", async () => {
  const running = herdrLane(({ arrive }) => ({ 63: () => { arrive(); world.screens[PANE] = BUSY; } }));
  expect((await running.launch("pending")).startup).toStartWith(`STARTUP_PENDING_GOAL pending ${PANE}`);
  expect(deliveries(world.calls)).toBe(1);
  world = newWorld();
  const idle = herdrLane(({ arrive }) => ({ 61: () => arrive() }));
  expect((await idle.launch("idle")).startup).toStartWith(`STARTUP_NO_GOAL idle ${PANE}: the agent runs but no goal in its session: its first turn ended 90 s after its prompt`);
});

test("an agent that never takes its prompt is STARTUP_UNCONFIRMED after the whole wait, never STARTUP_NO_GOAL; startupWaitSeconds sets the wait", async () => {
  const never = herdrLane(() => ({}));
  expect((await never.launch("never")).startup).toStartWith(`STARTUP_UNCONFIRMED never ${PANE}: the agent runs but its session holds no transcript of its prompt, so it has not taken its launch prompt, 180 s after it; last lines:`);
  expect(never.clock.sleeps).toBe(17);
  expect(deliveries(world.calls)).toBe(1);
  world = newWorld();
  const short = herdrLane(() => ({}), { startupWaitSeconds: 60 });
  expect((await short.launch("short")).startup).toStartWith(`STARTUP_UNCONFIRMED short ${PANE}: the agent runs but its session holds no transcript`);
  expect(short.clock.sleeps).toBe(5);
});

test("an omo that draws no ❯ prompt by the 20 s check is waited for in the same wait; one that never draws it is STARTUP_UNCONFIRMED after it", async () => {
  const boot = "$ env DORI_CONFIG=/x omo --session-id 1 --model m";
  const late = herdrLane(({ arrive }) => ({ 1: () => { world.screens[PANE] = boot; }, 47: () => { world.screens[PANE] = "omo · session started\n────────\n❯ \n────────"; }, 61: () => arrive("active") }));
  expect((await late.launch("late")).startup).toBe(`STARTUP_OK late ${PANE}`);
  // 20 s, three re-reads to the ❯ at 50 s, two more to the goal at 70 s
  expect(late.clock.sleeps).toBe(6);
  world = newWorld();
  const none = herdrLane(() => ({ 1: () => { world.screens[PANE] = boot; } }));
  expect((await none.launch("no-prompt")).startup).toStartWith(`STARTUP_UNCONFIRMED no-prompt ${PANE}: no running turn and no ❯ prompt on screen after 180 s; last lines:`);
  expect(none.clock.sleeps).toBe(17);
});

test("a pane that goes, an agent that exits, or the agent's own failure line while launch waits ends the wait at once", async () => {
  const at40 = (key: string, change: () => void) => herdrLane(() => ({ 40: change })).launch(key);
  expect((await at40("gone", () => { world.herdrGone = [PANE]; })).startup).toBe(`STARTUP_ERROR gone ${PANE}: the herdr pane is gone`);
  world = newWorld();
  expect((await at40("exit", () => { world.herdrDead = [PANE]; })).startup).toBe(`STARTUP_ERROR exit ${PANE}: no agent runs in the pane any more`);
  world = newWorld();
  expect((await at40("module", () => { world.screens[PANE] = "error: Cannot find module '/opt/omo/dist/cli.js'\n────────\n❯ \n────────"; })).startup).toBe(`STARTUP_ERROR module ${PANE}: Cannot find module`);
  world = newWorld();
  const boot = herdrLane(() => ({ 1: () => { world.screens[PANE] = "$ omo"; }, 30: () => { world.screens[PANE] = "$ omo\nerror: Cannot find module '/opt/omo/dist/cli.js'\n$ "; } }));
  expect((await boot.launch("boot")).startup).toBe(`STARTUP_ERROR boot ${PANE}: Cannot find module`);
  expect(boot.clock.sleeps).toBe(2);
});

test("an hc lane whose agent takes its prompt at 63 s is STARTUP_OK, and one that never does is STARTUP_UNCONFIRMED after the whole wait", async () => {
  const previous = process.env["DORI_RUNTIME"];
  process.env["DORI_RUNTIME"] = "hc";
  try {
    const hc = (arrival?: number) => {
      world = newWorld();
      world.terminals = { t1: hcTerm() };
      let goal: GoalRead = "unknown";
      const clock = timeline(arrival === undefined ? {} : { [arrival]: () => { goal = { status: "active" }; } });
      const base = depsFor(world, clock, state.dir, { backend: "herdr", runtime: "hc" });
      const run: FlowDeps["run"] = async (argv, o) => {
        if (argv[0] === "hc") world.calls.push([...argv]);
        if (argv[0] === "hc" && argv[1] === "--json" && argv[2] === "run") return { code: 0, out: JSON.stringify({ address: "t1", state: "live", labels: {} }), err: "" };
        if (argv[0] === "hc" && argv[1] === "--json" && argv[2] === "read") return { code: 0, out: JSON.stringify({ text: "❯ ", complete: true, how: "screen" }), err: "" };
        if (argv[0] === "hc" && argv[1] === "--json" && argv[2] === "send") return { code: 0, out: JSON.stringify({ status: "idle", turn: 1, started: true }), err: "" };
        return base.run(argv, o);
      };
      return { clock, launch: (key: string) => launchLane({ ...base, run, readGoal: async () => goal }, { noThread: "QA", key, title: key, brief, done: "file /tmp/ok", cwd: CWD, model: "m" }) };
    };
    const slow = hc(63);
    expect((await slow.launch("hc-slow")).startup).toBe("STARTUP_OK hc-slow hc:t1");
    expect(deliveries(world.calls)).toBe(1);
    const never = hc();
    expect((await never.launch("hc-never")).startup).toStartWith("STARTUP_UNCONFIRMED hc-never hc:t1: the agent runs but its session holds no transcript");
    expect(never.clock.sleeps).toBe(17);
  } finally {
    if (previous === undefined) delete process.env["DORI_RUNTIME"];
    else process.env["DORI_RUNTIME"] = previous;
  }
});

// omo (senpi reportDiagnostics) prints a user extension it cannot load as a yellow "Warning: Failed to load extension
// "<path>": Failed to load extension: <the import error>" and starts anyway; the same as an error diagnostic it prints as
// "Error: ..." and exits 1
const WARNING = `Warning: Failed to load extension "/home/u/.omo/agent/extensions/gone.js": Failed to load extension: Cannot find module '../lib/gone.mjs' from '/home/u/.omo/agent/extensions/gone.js'`;

test("omo's warning about an extension it cannot load is no startup failure, also wrapped on a narrow pane; a real missing module and omo's fatal load error are", () => {
  const box = "────────\n❯ \n────────";
  expect(startupFailure(`${WARNING}\n${box}`)).toBeUndefined();
  // omo's TUI (measured on this fork's omo, 2026-11-11) lists it under "Extension issues", indented
  expect(startupFailure(` Extension issues\n Conflicting or invalid loaded resources were found.\n   /home/u/ext/gone.js\n     Failed to load extension: Cannot find module '../lib/gone.mjs' imported from /home/u/ext\n${box}`)).toBeUndefined();
  // a narrow pane wraps the warning: its next row starts inside the import error
  expect(startupFailure(`Warning: Failed to load extension "/home/u/.omo/agent/extensions/gone.js": Failed to\n load extension: Cannot find module '../lib/gone.mjs'\n${box}`)).toBeUndefined();
  expect(startupFailure(`${WARNING}\nerror: Cannot find module '/opt/omo/dist/cli.js'\n${box}`)).toBe("Cannot find module");
  expect(startupFailure(`$ omo\n${WARNING}\nerror: Cannot find module '/opt/omo/dist/cli.js'\n$ `)).toBe("Cannot find module");
  expect(startupFailure(`Error: Failed to load extension "/x/gone.js": Failed to load extension: Cannot find module '../gone.mjs'\n$ `)).toBe("Cannot find module");
});

test("a herdr omo lane whose screen shows the extension warning above its prompt is STARTUP_OK once its goal shows", async () => {
  const lane = herdrLane(({ arrive }) => ({ 1: () => { world.screens[PANE] = `${WARNING}\nomo · session started\n────────\n❯ \n────────`; }, 50: () => arrive("active") }));
  expect((await lane.launch("ext-warning")).startup).toBe(`STARTUP_OK ext-warning ${PANE}`);
  expect(deliveries(world.calls)).toBe(1);
});
