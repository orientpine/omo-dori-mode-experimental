import { afterEach, beforeEach, expect, test } from "bun:test";
import { pauseLane } from "../src/done-flow.ts";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { freshnessTick } from "../src/freshness.ts";
import { ackHandover, manifestPath } from "../src/handover.ts";
import { laneHandover, type LaneHandoverDeps, markReady, pendingFile, readyFile, statusLine } from "../src/lane-handover.ts";
import { approvalProblem, compactionsIn, crossed, repeatsOf, quietReason, readRollovers, rolloverStats, sessionSignals } from "../src/rollover.ts";
import { QuestionStore } from "../src/messenger/discord-cards.ts";
import type { Lane } from "../src/registry.ts";
import type { Proc } from "../src/session-id.ts";
import { sessionDirFor } from "../src/session-id.ts";
import { depsFor, fakeClock, NEW_AOE_ID, newWorld, sent, withState, type World } from "./fakes.ts";

const OLD_ID = "1a1a1a1a22223333";
const OLD = "aoe_demo_1a1a1a1a";
const NEW = `aoe_demo-10111635_${NEW_AOE_ID.slice(0, 8)}`;
const CWD = "/work/demo";
const MODEL = "anthropic-subscription/claude-opus-5-5:high";
const EVENTS = "tail -n 0 -F /tmp/events.log";

const status = (model: string, pct = "9.0", account = "x") => `old transcript line\n❯ \n────\n Claude·${account} ▕██▏ 60%\n~/work • CH85.0% • $0.5 • 90K/1M (${pct}%) (auto)    (anthropic-subscription@${account}) ${model} (shift+tab)\n(OmO) mem:x`;
const HIGH = status("claude-opus-5-5 • effort high", "72.0");
const OK = { approvedBy: "https://discord.com/channels/1/2/3 (owner: go)" };

type Sim = { arm: { description: string; command: string; pid: number }[]; thinking: string; ackPane: string; ack: boolean; account: string; chainSurvives: boolean; doubleRun: boolean; restarted: boolean };

let state: { dir: string; done: () => void };
let w: World;
let sim: Sim;
let printed: string[];
let live: Set<number>;
let table: Proc[];

const AGENT_CMD = `bun /g/senpi/dist/bundle/cli.js --model ${MODEL} --session-id old-sid`;
const baseTable = (): Proc[] => [
  { pid: 10, ppid: 1, cmd: "bash /tmp/aoe-pane-env" },
  { pid: 11, ppid: 10, cmd: AGENT_CMD },
  { pid: 12, ppid: 11, cmd: "bun /g/omo-ai/plugin/runtime/ast-grep-mcp/cli.js mcp" },
  { pid: 13, ppid: 11, cmd: "/r/node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64/claude --output-format stream-json" },
  { pid: 20, ppid: 11, cmd: "bun /r/dist/bundle/cli.js --internal-rpc-host-supervisor --socket /x.sock" },
  { pid: 21, ppid: 20, cmd: "bun /r/dist/bundle/cli.js --mode rpc --multi-session" },
  { pid: 14, ppid: 11, cmd: EVENTS },
  { pid: 15, ppid: 11, cmd: "bash -c sleep 7200; echo chain-done" },
  { pid: 16, ppid: 15, cmd: "sleep 7200" },
  { pid: 40, ppid: 1, cmd: "sleep 7201" },
  { pid: 41, ppid: 1, cmd: "sleep 9999" },
];

const monitor = (description: string, command: string, pid: number, extra: Record<string, unknown> = {}) => ({ description, command, filter: "^EV", persistent: true, suspended: false, expiresAt: Date.parse("2026-10-20T00:00:00Z"), runtime: { pid }, ...extra });

const writeManifest = (session: string, monitors: unknown[]) => {
  const file = manifestPath(join(state.dir, "sessions"), CWD, session);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, sessionId: session, monitors }));
};

const lane = (): Lane => ({ key: "demo", title: "Demo lane", thread: "discord:12345678", pane: OLD, brief: join(state.dir, "demo.md"), done: "merged o/r#1", cwd: CWD, model: MODEL, goal: "레인에도 적용", openedAt: "2026-10-11T00:00:00Z", status: "working", lastReport: "[REPORT] demo | milestone | half way" });

const firstMessageSent = () => w.calls.some((c) => c[1] === "send-keys" && c.includes(`=${NEW}:`) && (c.at(-1) ?? "").includes("handover note"));

// The new session as the fake world sees it: once told to read the note it shows its status line and arms its monitors,
// and it acks the probe it receives.
const simulate = () => {
  if (!firstMessageSent()) return;
  w.screens[NEW] = status(`claude-opus-5-5 • effort ${sim.thinking}`, "9.0", sim.account);
  // the new session restarts the chain only when told the old one ended; both copies alive at once is a double run
  if (!sim.restarted && sent(w).some((x) => x.startsWith("[LEAD] HANDOVER_CHAINS_ENDED"))) {
    sim.restarted = true;
    live.add(301);
  }
  if (live.has(301) && live.has(15)) sim.doubleRun = true;
  writeManifest("new-sid", sim.arm.map((m) => monitor(m.description, m.command, m.pid)));
  if (sim.ack && w.calls.some((c) => c[1] === "send-keys" && c.includes(`=${NEW}:`) && (c.at(-1) ?? "").includes("HANDOVER_PROBE n1"))) ackHandover(state.dir, "n1", sim.ackPane, "2026-10-11T16:40:00Z");
};

const setup = async (): Promise<LaneHandoverDeps> => {
  const clock = fakeClock(Date.parse("2026-10-11T16:35:00Z"));
  const base = depsFor(w, { ...clock, sleep: async () => simulate() }, state.dir, { backend: "aoe", sessionsDir: join(state.dir, "sessions") });
  w.aoe = [{ id: OLD_ID, title: "demo", path: CWD, tool: "omo", profile: "main" }];
  w.tmux = [OLD];
  w.screens[OLD] = HIGH;
  writeManifest("old-sid", [monitor("scratch events", EVENTS, 14), monitor("digest", "until false; do sleep 60; done", 17, { persistent: false, expiresAt: null })]);
  const dir = sessionDirFor(join(state.dir, "sessions"), CWD);
  writeFileSync(join(dir, "2026-10-11T10-00-00-000Z_old-sid.jsonl"), JSON.stringify({ type: "custom", customType: "senpi.todo-state", data: { phases: [{ name: "Work", tasks: [{ content: "done thing", status: "completed" }, { content: "train E7", status: "in_progress" }] }] } }));
  mkdirSync(join(dir, "extensions", "goal"), { recursive: true });
  writeFileSync(join(dir, "extensions", "goal", "old-sid.json"), JSON.stringify({ goal: { objective: "ship lane handover", status: "active" } }));
  writeFileSync(lane().brief, "Do the work.\n");
  await base.registry.write(lane());
  new QuestionStore(join(state.dir, "discord")).create("Which run?", ["a", "b"], "1", { thread: "12345678", tmux: OLD, session: "old-sid" }, "2026-10-11T00:00:00Z");
  let n = 0;
  return {
    ...base,
    run: async (argv, opts) => {
      if (argv[0] === "aoe" && argv[1] === "session" && argv[2] === "stop" && argv[3] === OLD_ID) {
        for (const pid of [11, 12, 13, 14, 20, 21, 17]) live.delete(pid);
        if (!sim.chainSurvives) for (const pid of [15, 16]) live.delete(pid);
      }
      simulate();
      return base.run(argv, opts);
    },
    cardDir: join(state.dir, "discord"),
    home: "/home/test",
    sessionOf: async (pane) => (pane === OLD ? "old-sid" : pane === NEW ? "new-sid" : ""),
    procs: async () => table,
    envOf: (pid) => (pid === 40 ? "HOME=/home/test\nPI_SESSION_ID=old-sid" : pid === 41 ? "PI_SESSION_ID=other-sid" : ""),
    alive: (pid) => live.has(pid),
    realpath: (path) => path,
    nonce: () => `n${++n}`,
    print: (line) => printed.push(line),
  };
};

const opened = () => w.calls.some((c) => c[0] === "aoe" && c[1] === "add");
const stoppedIds = () => w.calls.filter((c) => c[0] === "aoe" && c[1] === "session" && c[2] === "stop").map((c) => c[3]);
const readLane = async (deps: LaneHandoverDeps) => (await deps.registry.read("demo")) as Lane;
const ready = (deps: LaneHandoverDeps, chains: number[], at = "2026-10-11T16:30:00Z", pane = OLD) => {
  mkdirSync(join(deps.config.stateDir, "handover", "lanes"), { recursive: true });
  writeFileSync(readyFile(deps.config.stateDir, "demo"), JSON.stringify({ key: "demo", pane, at, chains, note: "E7 seed 3 is mid-eval; rerun eval only" }));
};

beforeEach(() => {
  state = withState();
  w = newWorld();
  sim = { arm: [{ description: "scratch events", command: EVENTS, pid: 201 }, { description: "digest", command: "until false; do sleep 60; done", pid: 202 }], thinking: "high", ackPane: NEW, ack: true, account: "x", chainSurvives: false, doubleRun: false, restarted: false };
  printed = [];
  live = new Set([14, 15, 16, 17, 40, 41, 201, 202]);
  table = baseTable();
});
afterEach(() => state.done());

test("the status line gives model, thinking and context use in both omo formats", () => {
  expect(statusLine(HIGH, MODEL)).toEqual({ model: "claude-opus-5-5", thinking: "high", contextPct: 72, account: "x" });
  expect(statusLine(status("claude-opus-5-5:medium", "43.9", "orientpine"), MODEL)).toEqual({ model: "claude-opus-5-5", thinking: "medium", contextPct: 43.9, account: "orientpine" });
  expect(statusLine("❯ claude-opus-5-5 effort high in the input\n────\n 1K/1M (1%) gpt-6", MODEL)).toEqual({ contextPct: 1 });
});

test("the note carries brief, goal, Done, todos, monitors, local chains, detached jobs, reports and model; --dry-run opens nothing", async () => {
  // Given
  const deps = await setup();
  ready(deps, [15]);
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", { dryRun: true });
  // Then
  expect(r.code).toBe(0);
  const note = readFileSync(r.note ?? "", "utf8");
  for (const part of [
    `Read your brief ${lane().brief} in full`,
    "- Done: merged o/r#1",
    '- Owner goal (owner words): "레인에도 적용"',
    "Work thread: discord:12345678",
    "- Model anthropic-subscription/claude-opus-5-5, thinking high; cwd /work/demo.",
    `- scratch events: command ${JSON.stringify(EVENTS)} filter "^EV"`,
    "- digest: command \"until false; do sleep 60; done\" filter \"^EV\" (was not persistent in the old session; arm it as persistent)",
    "## Goal\nship lane handover (active)",
    "- Work: train E7 (in_progress)",
    "- 15: `bash -c sleep 7200; echo chain-done`",
    "- 40: `sleep 7201`",
    "- Last report: [REPORT] demo | milestone | half way",
    "E7 seed 3 is mid-eval; rerun eval only",
  ]) expect(note).toContain(part);
  for (const absent of ["done thing", "ast-grep-mcp", "claude-agent-sdk", "--mode rpc", "sleep 9999", `- 14: \`${EVENTS}\``]) expect(note).not.toContain(absent);
  expect(printed.at(-1)).toStartWith(`HANDOVER_DRY_RUN demo would open aoe session "demo-10111635" in ${CWD} (--model anthropic-subscription/claude-opus-5-5 --thinking high)`);
  expect(opened()).toBe(false);
  expect((await readLane(deps)).pane).toBe(OLD);
});

test("refuses while a local chain would die, a turn runs or a question is open, and opens nothing", async () => {
  // Given
  const deps = await setup();
  // When
  const chain = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  table = baseTable().filter((p) => p.pid !== 15 && p.pid !== 16);
  w.screens[OLD] = `${HIGH}\n • Working (esc to interrupt)`;
  const turn = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  w.screens[OLD] = `${HIGH}\nAsk user · which seed?`;
  const question = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  const own = await laneHandover(deps, "demo", OLD, OK);
  // Then
  expect([chain.code, turn.code, question.code, own.code]).toEqual([2, 2, 2, 2]);
  expect(printed[0]).toStartWith("HANDOVER_REFUSED demo: 1 local chain(s) would die: 15 bash -c sleep 7200; echo chain-done");
  expect(printed.some((l) => l.includes("a turn is running"))).toBe(true);
  expect(printed.some((l) => l.includes("a question is open in the pane"))).toBe(true);
  expect(printed.at(-1)).toStartWith("HANDOVER_REFUSED demo: run it from the lead, not from the lane's own pane");
  expect(opened()).toBe(false);
});

test("a ready mark covers only the chains it listed, from the lane's pane, within readyMin; --force overrides", async () => {
  // Given
  const deps = await setup();
  // When
  ready(deps, [99]);
  const otherChain = await laneHandover(deps, "demo", "aoe_lead_x", { dryRun: true });
  ready(deps, [15], "2026-10-11T15:00:00Z");
  const stale = await laneHandover(deps, "demo", "aoe_lead_x", { dryRun: true });
  ready(deps, [15], "2026-10-11T16:30:00Z", "aoe_other_9");
  const otherPane = await laneHandover(deps, "demo", "aoe_lead_x", { dryRun: true });
  ready(deps, [15]);
  const covered = await laneHandover(deps, "demo", "aoe_lead_x", { dryRun: true });
  const forced = await laneHandover({ ...deps, registry: deps.registry }, "demo", "aoe_lead_x", { dryRun: true, force: true });
  // Then
  expect([otherChain.code, stale.code, otherPane.code, covered.code, forced.code]).toEqual([2, 2, 2, 0, 0]);
  expect(printed.filter((l) => l.startsWith("HANDOVER_READY_STALE")).length).toBe(2);
});

test("dori handover ready runs only in the lane's own pane and also covers the chain that runs it, which may stay alive", async () => {
  // Given
  const deps = await setup();
  table = [...baseTable(), { pid: 18, ppid: 11, cmd: "bash -lc dori handover ready demo" }, { pid: 19, ppid: 18, cmd: "bun cli.ts handover ready demo" }];
  const noteFile = join(state.dir, "lane-note.md");
  writeFileSync(noteFile, "seed 3 eval pending");
  // When
  const elsewhere = await markReady(deps, lane(), "aoe_lead_x", 19);
  const r = await markReady(deps, lane(), OLD, 19, noteFile);
  // Then
  expect(elsewhere.code).toBe(2);
  expect(r.code).toBe(0);
  expect(r.line).toStartWith(`HANDOVER_READY demo pane=${OLD} chains=1 (15 bash -c sleep 7200; echo chain-done;`);
  expect(r.line).toContain("runner=18 (runs this command; covered too)");
  expect(JSON.parse(readFileSync(readyFile(state.dir, "demo"), "utf8"))).toMatchObject({ pane: OLD, chains: [15, 18], note: "seed 3 eval pending" });
  // the runner (here a shell; in omo the eval kernel) is still alive when the lead moves the lane: not a blocker
  expect((await laneHandover(deps, "demo", "aoe_lead_x", { dryRun: true })).code).toBe(0);
});

test("moves the lane: same cwd, model and thinking, registry and cards repointed, status, monitors and probe checked, then the old session closes", async () => {
  // Given
  const deps = await setup();
  ready(deps, [15]);
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  // Then
  expect(r).toMatchObject({ code: 0, to: NEW });
  expect(readFileSync(r.note ?? "", "utf8")).toContain(`- Moved with the owner's approval: ${OK.approvedBy}`);
  expect(existsSync(pendingFile(state.dir, "demo"))).toBe(false);
  expect(existsSync(readyFile(state.dir, "demo"))).toBe(false);
  const add = w.calls.find((c) => c[0] === "aoe" && c[1] === "add") ?? [];
  expect(add.slice(0, 4)).toEqual(["aoe", "add", CWD, "-t"]);
  expect(add.at(-1)).toBe("--model anthropic-subscription/claude-opus-5-5 --thinking high");
  expect(sent(w).some((t) => t.startsWith("ulw set goal and work. You are the demo lane in a new session") && t.includes(r.note ?? "?"))).toBe(true);
  const now = await readLane(deps);
  expect(now).toMatchObject({ pane: NEW, session: "new-sid", thread: "discord:12345678", brief: lane().brief });
  expect(new QuestionStore(join(state.dir, "discord")).get("Q1")).toMatchObject({ tmux: NEW });
  expect(printed).toContain(`HANDOVER_STATUS_OK ${NEW} claude-opus-5-5 thinking high`);
  expect(printed).toContain(`HANDOVER_MONITORS_OK 2 in ${NEW} (session new-sid)`);
  const probeAt = w.calls.findIndex((c) => c[1] === "send-keys" && c.includes(`=${NEW}:`) && (c.at(-1) ?? "").startsWith("[LEAD] HANDOVER_PROBE n1: run dori handover ack n1"));
  const stopAt = w.calls.findIndex((c) => c[0] === "aoe" && c[1] === "session" && c[2] === "stop" && c[3] === OLD_ID);
  expect(probeAt).toBeGreaterThan(-1);
  expect(stopAt).toBeGreaterThan(probeAt);
  expect(stoppedIds()).toEqual([OLD_ID]);
  expect(w.calls.some((c) => c[0] === "kill")).toBe(false);
  expect(printed).toContain("HANDOVER_DETACHED_ALIVE 1/1 (40)");
  const note = readFileSync(r.note ?? "", "utf8");
  expect(note).toContain("Do NOT start these again now");
  const endedAt = w.calls.findIndex((c) => c[1] === "send-keys" && c.includes(`=${NEW}:`) && (c.at(-1) ?? "").startsWith("[LEAD] HANDOVER_CHAINS_ENDED: the old session is closed and its local chains ended (15 bash -c sleep 7200"));
  expect(endedAt).toBeGreaterThan(stopAt);
  expect(sim.restarted).toBe(true);
  expect(sim.doubleRun).toBe(false);
  expect(printed.some((l) => l.startsWith("HANDOVER_ACCOUNT"))).toBe(false);
});

test("rolls back when the new session runs at another thinking level: lane and cards back, the new session closed, the old one kept and told", async () => {
  // Given
  const deps = await setup();
  ready(deps, [15]);
  sim.thinking = "medium";
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", { ...OK, verifyMin: 1 });
  // Then
  expect(r.code).toBe(3);
  expect(printed.find((l) => l.startsWith("HANDOVER_VERIFY_FAIL"))).toContain(`${NEW} runs at thinking medium, not high`);
  expect((await readLane(deps)).pane).toBe(OLD);
  expect(new QuestionStore(join(state.dir, "discord")).get("Q1")).toMatchObject({ tmux: OLD });
  expect(stoppedIds()).toEqual([NEW_AOE_ID]);
  expect(sent(w).some((t) => t.startsWith("[LEAD] Handover of demo failed") && t.includes("You stay the demo lane"))).toBe(true);
});

test("rolls back when a monitor is not re-armed or the probe is acked from another pane", async () => {
  // Given
  const deps = await setup();
  ready(deps, [15]);
  sim.arm = sim.arm.slice(0, 1);
  // When
  const noMonitor = await laneHandover(deps, "demo", "aoe_lead_x", { ...OK, verifyMin: 1 });
  // Then
  expect(noMonitor.code).toBe(3);
  expect(printed.find((l) => l.startsWith("HANDOVER_VERIFY_FAIL"))).toContain("monitors not running in");

  // Given
  printed = [];
  w = newWorld();
  const again = await setup();
  ready(again, [15]);
  sim.arm = [{ description: "scratch events", command: EVENTS, pid: 201 }, { description: "digest", command: "until false; do sleep 60; done", pid: 202 }];
  sim.ackPane = OLD;
  // When
  const wrongPane = await laneHandover(again, "demo", "aoe_lead_x", { ...OK, verifyMin: 1 });
  // Then
  expect(wrongPane.code).toBe(3);
  expect(printed.find((l) => l.startsWith("HANDOVER_VERIFY_FAIL"))).toContain(`the probe was acked from ${OLD}, not ${NEW}`);
  expect((await readLane(again)).pane).toBe(OLD);
  expect(stoppedIds()).toEqual([NEW_AOE_ID]);
});

test("freshness says a rollover is due once per pane for lanes and the lead, and starts one only with the auto key on", async () => {
  // Given
  const base = await setup();
  await base.registry.patch("demo", { lastReplyAt: base.clock.now() });
  const off = await freshnessTick(base, "/home/test", { signals: async () => ({ contextPct: 99, compactions: 99, ageH: 999 }) });
  const deps = { ...base, config: { ...base.config, handover: { ...base.config.handover, laneContextPct: 80, laneCompactions: 4, laneAgeH: 24, leadContextPct: 80, leadCompactions: 4, leadAgeH: 48 } } };
  await deps.registry.patch("demo", { lastReplyAt: deps.clock.now() });
  const signals: Record<string, { contextPct?: number; compactions?: number; ageH?: number }> = { [OLD]: { contextPct: 85 }, [deps.config.leadPane]: { compactions: 1, ageH: 50 } };
  const autoRuns: string[] = [];
  const hooks = { signals: async (pane: string) => signals[pane] ?? {}, auto: async (who: "lead" | "lane", key: string) => { autoRuns.push(`${who}:${key}`); return "started"; } };
  // When
  const first = await freshnessTick(deps, "/home/test", hooks);
  const second = await freshnessTick(deps, "/home/test", hooks);
  await deps.registry.patch("demo", { pane: "aoe_demo-2_77777777" });
  signals["aoe_demo-2_77777777"] = { contextPct: 79, compactions: 3, ageH: 23 };
  const below = await freshnessTick(deps, "/home/test", hooks);
  signals["aoe_demo-2_77777777"] = { contextPct: 40, compactions: 4, ageH: 5 };
  const auto = await freshnessTick({ ...deps, config: { ...deps.config, handover: { ...deps.config.handover, autoRolloverLanes: true } } }, "/home/test", hooks);
  // Then
  expect(off).toEqual([]);
  expect(first.map((a) => [a.kind, a.lane])).toEqual([["rollover_due", "demo"], ["rollover_due", "lead"]]);
  expect(first[0]?.detail).toStartWith(`context 85% >= 80% in ${OLD}: ask the owner with dori rollover-propose demo`);
  expect(first[1]?.detail).toStartWith(`age 50.0 h >= 48 h in ${deps.config.leadPane}: ask the owner with dori rollover-propose lead`);
  expect(second).toEqual([]);
  expect(below).toEqual([]);
  expect(auto.map((a) => [a.kind, a.lane])).toEqual([["rollover_due", "demo"], ["rollover_auto", "demo"]]);
  expect(autoRuns).toEqual(["lane:demo"]);
  expect(w.calls.some((c) => c[0] === "aoe" && c[1] === "add")).toBe(false);
});

test("a paused lane gets no rollover proposal, and pausing does not make it safe to move: chain and turn checks still refuse", async () => {
  // Given
  const base = await setup();
  const deps = { ...base, config: { ...base.config, handover: { ...base.config.handover, laneContextPct: 80 } } };
  await pauseLane(deps, await readLane(deps), "waits on the owner");
  // When
  const due = await freshnessTick(deps, "/home/test", { signals: async () => ({ contextPct: 99 }) });
  const chain = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  table = baseTable().filter((p) => p.pid !== 15 && p.pid !== 16);
  w.screens[OLD] = `${HIGH}\n • Working (esc to interrupt)`;
  const turn = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  // Then
  expect(due.filter((a) => a.lane === "demo")).toEqual([]);
  expect([chain.code, turn.code]).toEqual([2, 2]);
  expect(printed[0]).toStartWith("HANDOVER_REFUSED demo: 1 local chain(s) would die");
  expect(printed.at(-1)).toContain("a turn is running");
  expect(opened()).toBe(false);
});

test("freshness says a lane's rollover is due at the 3rd attempt of one same fix in its session, with length thresholds off", async () => {
  // Given
  const deps = await setup();
  const fix = (at: string) => ({ at, metric: "loss", hypothesis: "lr too high", via: "report" as const });
  await deps.registry.patch("demo", { lastReplyAt: deps.clock.now(), fixes: [fix("2026-10-11T10:00:00Z"), fix("2026-10-11T11:00:00Z")] });
  const hooks = { signals: async () => ({ contextPct: 99, compactions: 99, ageH: 999 }) };
  // When
  const two = await freshnessTick(deps, "/home/test", hooks);
  await deps.registry.patch("demo", { fixes: [fix("2026-10-11T10:00:00Z"), fix("2026-10-11T11:00:00Z"), fix("2026-10-11T12:00:00Z")] });
  const three = await freshnessTick(deps, "/home/test", hooks);
  // Then
  expect(two.filter((a) => a.kind === "rollover_due")).toEqual([]);
  expect(three.filter((a) => a.kind === "rollover_due").map((a) => [a.lane, a.detail.split(" in ")[0]])).toEqual([["demo", "same fix 3 times >= 3"]]);
});

test("refuses without the owner's approval and opens nothing; --dry-run needs none", async () => {
  // Given
  const deps = await setup();
  ready(deps, [15]);
  // When
  const bare = await laneHandover(deps, "demo", "aoe_lead_x");
  const blank = await laneHandover(deps, "demo", "aoe_lead_x", { approvedBy: "  " });
  const dry = await laneHandover(deps, "demo", "aoe_lead_x", { dryRun: true });
  // Then
  expect([bare.code, blank.code, dry.code]).toEqual([2, 2, 0]);
  expect(printed[0]).toStartWith("HANDOVER_REFUSED demo: a lane moves to a new session only with the owner's approval");
  expect(opened()).toBe(false);
});

test("a new session that does not start is closed and the lane stays where it was", async () => {
  // Given
  const deps = await setup();
  ready(deps, [15]);
  w.screens[NEW] = "Error: usage limit reached for this account";
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  // Then
  expect(r.code).toBe(3);
  expect(printed.some((l) => l.startsWith(`HANDOVER_FAIL demo: new session ${NEW}: usage limit`))).toBe(true);
  expect((await readLane(deps)).pane).toBe(OLD);
  expect(stoppedIds()).toEqual([NEW_AOE_ID]);
  expect(sent(w).some((t) => t.startsWith("[LEAD] Handover of demo failed (the new session did not start"))).toBe(true);
  expect(existsSync(pendingFile(state.dir, "demo"))).toBe(false);
});

test("an error in the middle of the move is repaired: lane and cards back on the old session, the new one closed", async () => {
  // Given
  const deps = { ...(await setup()), nonce: () => { throw new Error("nonce source broke"); } };
  ready(deps, [15]);
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  // Then
  expect(r.code).toBe(3);
  expect(printed).toContain("HANDOVER_FAIL demo: nonce source broke; repairing");
  expect(printed.find((l) => l.startsWith("HANDOVER_RECOVERED"))).toStartWith(`HANDOVER_RECOVERED demo back on ${OLD}; new session: aoe session ${NEW_AOE_ID}`);
  expect((await readLane(deps)).pane).toBe(OLD);
  expect(new QuestionStore(join(state.dir, "discord")).get("Q1")).toMatchObject({ tmux: OLD });
  expect(stoppedIds()).toEqual([NEW_AOE_ID]);
  expect(existsSync(pendingFile(state.dir, "demo"))).toBe(false);
});

const killedRun = async (deps: LaneHandoverDeps, pid: number) => {
  w.aoe.push({ id: NEW_AOE_ID, title: "demo-10111635", path: CWD, tool: "omo", profile: "main" });
  w.tmux.push(NEW);
  await deps.registry.patch("demo", { pane: NEW });
  new QuestionStore(join(state.dir, "discord")).retarget({ tmux: OLD }, { tmux: NEW });
  mkdirSync(join(state.dir, "handover", "lanes"), { recursive: true });
  writeFileSync(pendingFile(state.dir, "demo"), JSON.stringify({ key: "demo", pid, at: "2026-10-11T16:20:00Z", from: OLD, to: NEW, note: "/x.md" }));
};

test("a run killed midway (crash, reboot) is repaired by the next run: old session alive -> back to it, new one closed", async () => {
  // Given
  const deps = await setup();
  await killedRun(deps, 999);
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  // Then
  expect(r.code).toBe(3);
  expect(printed[0]).toStartWith("HANDOVER_INTERRUPTED demo");
  expect((await readLane(deps)).pane).toBe(OLD);
  expect(new QuestionStore(join(state.dir, "discord")).get("Q1")).toMatchObject({ tmux: OLD });
  expect(stoppedIds()).toEqual([NEW_AOE_ID]);
  expect(sent(w).some((t) => t.startsWith("[LEAD] The handover of demo was stopped before it finished. You stay the demo lane"))).toBe(true);
  expect(existsSync(pendingFile(state.dir, "demo"))).toBe(false);
  expect(opened()).toBe(false);
});

test("a killed run whose old session is already gone keeps the lane on the new one; a live run's journal refuses", async () => {
  // Given
  const deps = await setup();
  await killedRun(deps, 999);
  live.add(777);
  w.aoe = w.aoe.filter((s) => s.id !== OLD_ID);
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  await killedRun(deps, 777);
  const running = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  // Then
  expect(r.code).toBe(3);
  expect(printed).toContain(`HANDOVER_RECOVERED demo kept on ${NEW}: the old session ${OLD} is gone`);
  expect((await readLane(deps)).pane).toBe(NEW);
  expect(stoppedIds()).toEqual([]);
  expect(running.code).toBe(2);
  expect(printed.at(-1)).toStartWith("HANDOVER_REFUSED demo: another handover of demo is running (pid 777");
});

test("--keep-old leaves the old session open and tells it it is no longer the lane", async () => {
  // Given
  const deps = await setup();
  ready(deps, [15]);
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", { ...OK, keepOld: true });
  // Then
  expect(r).toMatchObject({ code: 0, to: NEW });
  expect(stoppedIds()).toEqual([]);
  expect(sent(w).some((t) => t.startsWith(`[LEAD] Handover of demo to ${NEW} is done and checked. You are no longer the lane`))).toBe(true);
});

test("a threshold is crossed at its value, not just above it, and 0 turns it off", () => {
  // Given
  const limits = { contextPct: 80, compactions: 4, ageH: 24 };
  // When / Then
  expect(crossed({ contextPct: 80, compactions: 4, ageH: 24 }, limits)).toEqual(["context 80% >= 80%", "compactions 4 >= 4", "age 24.0 h >= 24 h"]);
  expect(crossed({ contextPct: 79.9, compactions: 3, ageH: 23.9 }, limits)).toEqual([]);
  expect(crossed({ contextPct: 100, compactions: 99, ageH: 999 }, { contextPct: 0, compactions: 0, ageH: 0 })).toEqual([]);
  expect(crossed({}, limits)).toEqual([]);
  expect(crossed({ repeats: 3 }, { ...limits, repeats: 3 })).toEqual(["same fix 3 times >= 3"]);
  expect(crossed({ repeats: 2 }, { ...limits, repeats: 3 })).toEqual([]);
  expect(crossed({ repeats: 9 }, limits)).toEqual([]);
});

test("repeats counts one fix's attempts in the lane's current session only, the way fix-attempt counts them", () => {
  // Given
  const fix = (at: string, hypothesis: string, via: "report" | "lead" = "report") => ({ at, metric: "loss", hypothesis, via });
  const moved = { ...lane(), history: [{ at: "2026-10-11T12:00:00Z", status: "working" as const, note: `pane moved aoe_old_1 -> ${OLD} (dori handover --lane)` }] };
  // When / Then
  expect(repeatsOf({ ...lane(), fixes: [fix("2026-10-11T10:00:00Z", "lr"), fix("2026-10-11T11:00:00Z", "lr"), fix("2026-10-11T11:30:00Z", "lr"), fix("2026-10-11T11:40:00Z", "seed")] })).toBe(3);
  expect(repeatsOf({ ...moved, fixes: [fix("2026-10-11T10:00:00Z", "lr"), fix("2026-10-11T11:00:00Z", "lr"), fix("2026-10-11T13:00:00Z", "lr")] })).toBe(1);
  expect(repeatsOf({ ...lane(), fixes: [fix("2026-10-11T10:00:00Z", "lr", "lead"), fix("2026-10-11T10:05:00Z", "lr")] })).toBe(1);
  expect(repeatsOf(lane())).toBe(0);
});

test("an approval is an answered card's first option, a link or words, or auto only with the key on", () => {
  // Given
  const cards: Record<string, { id: string; status: "open" | "answered"; options: string[]; answer?: string }> = {
    Q1: { id: "Q1", status: "answered", options: ["Yes, roll over", "Not yet"], answer: "Yes, roll over" },
    Q2: { id: "Q2", status: "answered", options: ["Yes, roll over", "Not yet"], answer: "Not yet" },
    Q3: { id: "Q3", status: "open", options: ["Yes, roll over", "Not yet"] },
  };
  const card = (id: string) => cards[id] as never;
  const proposal = (key: string, id: string) => ({ kind: "proposal" as const, who: "lane" as const, at: "2026-10-11T00:00:00Z", key, card: id, pane: "p", signals: {}, crossed: [], blockers: "" });
  const log = [proposal("demo", "Q1"), proposal("demo", "Q2"), proposal("demo", "Q3"), proposal("other", "Q4")];
  cards.Q4 = { id: "Q4", status: "answered", options: ["Yes, roll over", "Not yet"], answer: "Yes, roll over" };
  cards.Q5 = { id: "Q5", status: "answered", options: ["Yes", "No"], answer: "Yes" };
  // When / Then
  expect(approvalProblem("Q4", card, false, "demo", log)).toBe("card Q4 is not a rollover proposal for demo; post one with dori rollover-propose demo");
  expect(approvalProblem("Q5", card, false, "demo", log)).toBe("card Q5 is not a rollover proposal for demo; post one with dori rollover-propose demo");
  expect(approvalProblem("Q1", card, false, "demo", log)).toBeUndefined();
  expect(approvalProblem("q1", card, false, "demo", log)).toBeUndefined();
  expect(approvalProblem("Q2", card, false, "demo", log)).toBe('card Q2 was answered "Not yet", not "Yes, roll over"');
  expect(approvalProblem("Q3", card, false, "demo", log)).toBe("card Q3 is not answered yet");
  expect(approvalProblem("Q9", card, false, "demo", log)).toBe("card Q9 not found");
  expect(approvalProblem("https://discord.com/channels/1/2/3", card, false, "demo", log)).toBeUndefined();
  expect(approvalProblem("ok", card, false, "demo", log)).toContain("too short");
  expect(approvalProblem(undefined, card, false, "demo", log)).toStartWith("no approval");
  expect(approvalProblem("auto:handover.autoRolloverLanes", card, false, "demo", log)).toContain("the automation key is off");
  expect(approvalProblem("auto:handover.autoRolloverLanes", card, true, "demo", log)).toBeUndefined();
});

test("the old lane is quiet while it is replaced and may talk again after; every real attempt is logged with signals and steps", async () => {
  // Given
  const deps = await setup();
  ready(deps, [15]);
  const quietSeen: (string | undefined)[] = [];
  const sleep = deps.clock.sleep;
  const watched = { ...deps, clock: { ...deps.clock, sleep: async (ms: number) => { quietSeen.push(quietReason(state.dir, OLD, deps.clock.now())); await sleep(ms); } } };
  // When
  const r = await laneHandover(watched, "demo", "aoe_lead_x", OK);
  await laneHandover(deps, "demo", "aoe_lead_x", OK);
  // Then
  expect(r.code).toBe(0);
  expect(quietSeen.some((q) => q?.startsWith(`HANDOVER_QUIET ${OLD}: the handover of demo to ${NEW} is running`))).toBe(true);
  expect(quietReason(state.dir, OLD, deps.clock.now())).toBeUndefined();
  const log = readRollovers(state.dir);
  expect(log[0]).toMatchObject({ kind: "rollover", who: "lane", key: "demo", from: OLD, to: NEW, approvedBy: OK.approvedBy, signals: { contextPct: 72 }, result: "done" });
  expect(log[0]?.kind === "rollover" && log[0].steps.map((s) => s.step)).toEqual(["open", "startup", "first-message", "verify", "close"]);
  expect(log[1]).toMatchObject({ kind: "rollover", who: "lane", result: "refused" });
});

test("rollover-stats gives counts, approval time, step times and the lane's quality signals before and after", () => {
  // Given
  const entries = [
    { kind: "proposal", who: "lane", at: "2026-10-11T10:00:00Z", key: "demo", pane: OLD, card: "Q4", signals: { contextPct: 75 }, crossed: ["context 75% >= 70%"], blockers: "" },
    { kind: "rollover", who: "lane", at: "2026-10-11T10:30:00Z", key: "demo", from: OLD, to: NEW, approvedBy: "Q4", proposedAt: "2026-10-11T10:00:00Z", approvalMin: 30, signals: { contextPct: 75, compactions: 2 }, steps: [{ step: "open", ms: 4000, ok: true }, { step: "verify", ms: 60000, ok: true }], result: "done", reasons: [] },
  ] as const;
  const watch = ["2026-10-11T09:00:00Z freshness NUDGED demo 16 min silent", "2026-10-11T09:30:00Z freshness NUDGED demo 20 min silent", "2026-10-11T11:00:00Z freshness NO-REPORT demo pane", "2026-10-11T11:00:00Z freshness NUDGED other 1"];
  // When
  const out = rolloverStats(entries as never, watch, Date.parse("2026-10-11T12:30:00Z"));
  // Then
  expect(out[0]).toBe("ROLLOVER_STATS proposals=1 rollovers=1 (done 1) approval_median_min=30 window=24h");
  expect(out[1]).toBe("ROLLOVER_STEPS open median 4s fail 0; verify median 60s fail 0");
  expect(out).toContain(`QUALITY demo 2026-10-11T10:30:00Z before 24h: NUDGED 2 | after 2h: NO-REPORT 1`);
});

test("compactions are counted from the session log, reading only what was added since the last count", () => {
  // Given
  const dir = join(state.dir, "s");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "2026-10-11T10-00-00-000Z_abcdefab-0000-0000-0000-000000000000.jsonl");
  writeFileSync(file, '{"type":"message","text":"{\\"type\\":\\"compaction\\"}"}\n{"type":"compaction","id":"1"}\n');
  // When
  const one = compactionsIn(file);
  appendFileSync(file, '{"type":"compaction","id":"2"}\n{"type":"compac');
  const two = compactionsIn(file);
  appendFileSync(file, 'tion","id":"3"}\n');
  const signals = sessionSignals(dir, "abcdefab-0000-0000-0000-000000000000", Date.parse("2026-10-11T22:00:00Z"));
  // Then
  expect([one, two]).toEqual([1, 2]);
  expect(signals).toEqual({ compactions: 3, ageH: 12 });
});

test("a chain that outlives the close is not restarted, and a new account is logged", async () => {
  // Given
  const deps = await setup();
  ready(deps, [15]);
  sim.chainSurvives = true;
  sim.account = "orientpine";
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  // Then
  expect(r.code).toBe(0);
  expect(sent(w).some((x) => x.startsWith("[LEAD] HANDOVER_CHAINS_ENDED"))).toBe(false);
  expect(sent(w).some((x) => x.startsWith("[LEAD] HANDOVER_CHAIN_SURVIVED: these local chains of the old session still run after it closed: 15 bash -c sleep 7200"))).toBe(true);
  expect(printed).toContain("HANDOVER_CHAIN_SURVIVED demo 15; the new session was told not to restart them");
  expect(sim.doubleRun).toBe(false);
  expect(printed).toContain("HANDOVER_ACCOUNT demo x -> orientpine (the account pool chose it for the new session)");
  expect(readRollovers(state.dir)[0]).toMatchObject({ accounts: { from: "x", to: "orientpine" } });
});
