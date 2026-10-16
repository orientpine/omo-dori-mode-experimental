import { afterEach, beforeEach, expect, test } from "bun:test";
import { pauseLane } from "../src/done-flow.ts";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { autoReadyLine, freshnessTick } from "../src/freshness.ts";
import { ackHandover, manifestPath } from "../src/handover.ts";
import { type LaneFacts, laneHandover, type LaneHandoverDeps, markReady, missingFrom, pendingFile, readyFile, statusLine } from "../src/lane-handover.ts";
import { approvalProblem, compactionScan, compactionsIn, crossed, quietReason, readRollovers, rolloverStats, sessionSignals } from "../src/rollover.ts";
import { stuckTop, stuckView } from "../src/explore.ts";
import { recordFix } from "../src/same-fix.ts";
import { QuestionStore } from "../src/messenger/discord-cards.ts";
import type { Lane } from "../src/registry.ts";
import type { Proc } from "../src/session-id.ts";
import { sessionDirFor } from "../src/session-id.ts";
import { defaultConfig } from "../src/config.ts";
import { depsFor, fakeClock, NEW_AOE_ID, newWorld, sent, withState, type World } from "./fakes.ts";

const OLD_ID = "1a1a1a1a22223333";
const OLD = "aoe_demo_1a1a1a1a";
const NEW = `aoe_demo-10111635_${NEW_AOE_ID.slice(0, 8)}`;
const CWD = "/work/demo";
const MODEL = "anthropic-subscription/claude-opus-5-5:high";
const EVENTS = "tail -n 0 -F /tmp/events.log";

const status = (model: string, pct = "9.0", account = "x") => `old transcript line\n❯ \n────\n Claude·${account} ▕██▏ 60%\n~/work • CH85.0% • $0.5 • 90K/1M (${pct}%) (auto)    (anthropic-subscription@${account}) ${model} (shift+tab)\n(OmO) mem:x`;
const HIGH = status("claude-opus-5-5 • effort high", "72.0");
const OK = { approvedBy: "https://discord.com/channels/1/2/3" };

// a restatement that covers the lane's goal under every heading the new session must write
const RESTATE = "## Goal\n레인에도 적용: ship it\n## Owner's words\nnone\n## Decisions\nnone\n## Next step\ntrain E7\n## Ruled out\nnone\n## Questions\nnone\n";

type Sim = { arm: { description: string; command: string; pid: number }[]; thinking: string; ackPane: string; ack: boolean; restate?: string; supplement: "fix" | "ignore" | "silent"; handled: string[]; account: string; chainSurvives: boolean; grandchildSurvives?: boolean; doubleRun: boolean; restarted: boolean };

let state: { dir: string; done: () => void };
let w: World;
let sim: Sim;
let printed: string[];
let sigs: string[];
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
  const probe = w.calls.find((c) => c[1] === "send-keys" && c.includes(`=${NEW}:`) && (c.at(-1) ?? "").includes("HANDOVER_PROBE n1"))?.at(-1);
  if (sim.ack && probe) {
    // the new session writes what it understood, then acks
    const file = /write what you understood to (\S+)/.exec(probe)?.[1];
    if (file && sim.restate !== "" && !existsSync(file)) writeFileSync(file, sim.restate ?? RESTATE);
    ackHandover(state.dir, "n1", sim.ackPane, "2026-10-11T16:40:00Z");
  }
  // a supplement round: it adds the items under the headings named ("fix"), acks without adding ("ignore"), or stays silent
  for (const line of sent(w)) {
    const m = /^\[LEAD\] HANDOVER_SUPPLEMENT (\S+) .*Read (\S+), add them to (\S+), then run/.exec(line);
    if (!m?.[1] || !m[2] || !m[3] || sim.handled.includes(m[1])) continue;
    sim.handled.push(m[1]);
    if (sim.supplement === "silent") continue;
    if (sim.supplement === "fix") {
      let text = existsSync(m[3]) ? readFileSync(m[3], "utf8") : "";
      for (const it of readFileSync(m[2], "utf8").matchAll(/^## \d+\. ([^:\n]+): (.*)\nSource: .*Goes under: (.*)\.$/gm)) {
        const [, kind, item = "", under = ""] = it;
        if (!under.startsWith("## ")) text = RESTATE;
        else if (kind === "heading") text += `\n${under}\nnone\n`;
        else text = text.includes(`${under}\n`) ? text.replace(`${under}\n`, `${under}\n${item}\n`) : `${text}\n${under}\n${item}\n`;
      }
      writeFileSync(m[3], text);
    }
    ackHandover(state.dir, m[1], NEW, "2026-10-11T16:41:00Z");
  }
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
        if (!sim.chainSurvives) for (const pid of sim.grandchildSurvives ? [15] : [15, 16]) live.delete(pid);
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
    signal: (pid, sig) => {
      sigs.push(`${sig} ${pid}`);
      return true;
    },
    realpath: (path) => path,
    nonce: () => `n${++n}`,
    print: (line) => printed.push(line),
  };
};

const opened = () => w.calls.some((c) => c[0] === "aoe" && c[1] === "add");
const stoppedIds = () => w.calls.filter((c) => c[0] === "aoe" && c[1] === "session" && c[2] === "stop").map((c) => c[3]);
const readLane = async (deps: LaneHandoverDeps) => (await deps.registry.read("demo")) as Lane;
const ready = (deps: LaneHandoverDeps, chains: number[], at = "2026-10-11T16:30:00Z", pane = OLD, note = "E7 seed 3 is mid-eval; rerun eval only") => {
  mkdirSync(join(deps.config.stateDir, "handover", "lanes"), { recursive: true });
  writeFileSync(readyFile(deps.config.stateDir, "demo"), JSON.stringify({ key: "demo", pane, at, chains, note }));
};
// a message of the old conversation, appended to its log (the log starts with one line, so this is line 2)
const oldSays = (text: string) => appendFileSync(join(sessionDirFor(join(state.dir, "sessions"), CWD), "2026-10-11T10-00-00-000Z_old-sid.jsonl"), `\n${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text }] } })}`);

beforeEach(() => {
  state = withState();
  w = newWorld();
  sim = { arm: [{ description: "scratch events", command: EVENTS, pid: 201 }, { description: "digest", command: "until false; do sleep 60; done", pid: 202 }], thinking: "high", ackPane: NEW, ack: true, supplement: "fix", handled: [], account: "x", chainSurvives: false, doubleRun: false, restarted: false };
  printed = [];
  sigs = [];
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
  writeFileSync(noteFile, "## Owner's words and constraints\n\"레인에도 적용\"\n## Decisions and why\nseed 3 first\n## Ruled out\nlr too high\n## In progress\nseed 3 eval pending\n## Next step\nrerun eval\n");
  const bare = join(state.dir, "bare-note.md");
  writeFileSync(bare, "seed 3 eval pending");
  // When
  const elsewhere = await markReady(deps, lane(), "aoe_lead_x", 19);
  const r = await markReady(deps, lane(), OLD, 19, noteFile);
  // Then
  expect(elsewhere.code).toBe(2);
  expect(r.code).toBe(0);
  expect(r.line).toStartWith(`HANDOVER_READY demo pane=${OLD} chains=1 (15 bash -c sleep 7200; echo chain-done;`);
  expect(r.line).toContain("runner=18 (runs this command; covered too)");
  expect(JSON.parse(readFileSync(readyFile(state.dir, "demo"), "utf8"))).toMatchObject({ pane: OLD, chains: [15, 18], note: readFileSync(noteFile, "utf8") });
  // the conversation summary is required, with its headings
  expect((await markReady(deps, lane(), OLD, 19)).line).toStartWith("HANDOVER_READY_REFUSED demo: write the conversation summary first");
  expect((await markReady(deps, lane(), OLD, 19, bare)).line).toBe(`HANDOVER_READY_REFUSED demo: the summary ${bare} lacks ## Owner's words and constraints, ## Decisions and why, ## Ruled out, ## In progress, ## Next step (dori handover ready --template)`);
  // the runner (here a shell; in omo the eval kernel) is still alive when the lead moves the lane: not a blocker
  expect((await laneHandover(deps, "demo", "aoe_lead_x", { dryRun: true })).code).toBe(0);
});

const guardedHandover = async (useGpu: boolean) => {
  const base = await setup();
  const deps = { ...base, config: { ...base.config, launchEnv: { CUDA_VISIBLE_DEVICES: "" } } };
  if (useGpu) await deps.registry.patch("demo", { useGpu: true });
  ready(deps, [15]);
  return { deps, r: await laneHandover(deps, "demo", "aoe_lead_x", OK) };
};

test("launchEnv: a lane's new session starts with it", async () => {
  expect((await guardedHandover(false)).r).toMatchObject({ code: 0, to: NEW });
  expect(w.aoeEnv).toEqual([{ CUDA_VISIBLE_DEVICES: "" }]);
});

test("launchEnv: a --use-gpu lane's new session starts without it", async () => {
  expect((await guardedHandover(true)).r).toMatchObject({ code: 0, to: NEW });
  expect(w.aoeEnv).toEqual([{ CUDA_VISIBLE_DEVICES: undefined }]);
});

test("launchEnv: a new session tmux did not give it is closed and the old one stays the lane", async () => {
  w.dropEnv = true;
  const { deps, r } = await guardedHandover(false);
  expect(r).toMatchObject({ code: 3, to: NEW });
  expect(printed).toContain(`HANDOVER_FAIL demo: new session ${NEW} lacks launchEnv: CUDA_VISIBLE_DEVICES=(unset)`);
  expect(stoppedIds()).toEqual([NEW_AOE_ID]);
  expect((await readLane(deps)).pane).toBe(OLD);
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
  expect(sent(w).some((t) => t.startsWith("You are the demo lane in a new session") && t.includes(r.note ?? "?"))).toBe(true);
  const now = await readLane(deps);
  expect(now).toMatchObject({ pane: NEW, session: "new-sid", thread: "discord:12345678", brief: lane().brief });
  expect(new QuestionStore(join(state.dir, "discord")).get("Q1")).toMatchObject({ tmux: NEW });
  expect(printed).toContain(`HANDOVER_STATUS_OK ${NEW} claude-opus-5-5 thinking high`);
  expect(printed).toContain(`HANDOVER_MONITORS_OK 2 in ${NEW} (session new-sid)`);
  const probeAt = w.calls.findIndex((c) => c[1] === "send-keys" && c.includes(`=${NEW}:`) && (c.at(-1) ?? "").startsWith("[LEAD] HANDOVER_PROBE n1: write what you understood to"));
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
  // the new session works only after the commit, which comes after the old session closed
  expect(note).toContain("4. Until a [LEAD] HANDOVER_COMMITTED line arrives, do nothing else");
  const commitAt = w.calls.findIndex((c) => c[1] === "send-keys" && c.includes(`=${NEW}:`) && (c.at(-1) ?? "").startsWith("[LEAD] HANDOVER_COMMITTED: the handover is checked and the old session is closed"));
  expect(commitAt).toBeGreaterThan(stopAt);
  expect(endedAt).toBeGreaterThan(commitAt);
  expect(sim.restarted).toBe(true);
  expect(sim.doubleRun).toBe(false);
  expect(printed.some((l) => l.startsWith("HANDOVER_ACCOUNT"))).toBe(false);
  // the old agent is frozen while both sessions live, and resumed only to be closed
  expect(sigs).toEqual(["SIGSTOP 11", "SIGCONT 11"]);
  const firstAt = w.calls.findIndex((c) => c[1] === "send-keys" && c.includes(`=${NEW}:`) && (c.at(-1) ?? "").startsWith("You are the demo lane"));
  expect(firstAt).toBeGreaterThan(-1);
  expect(printed).toContain(`HANDOVER_FROZEN demo agent 11 in ${OLD}`);
  expect(printed.indexOf("HANDOVER_THAWED demo agent 11")).toBeGreaterThan(printed.findIndex((l) => l.startsWith("HANDOVER_DONE")));
  // the new session restated what it understood before the commit
  expect(printed).toContain(`HANDOVER_UNDERSTOOD ${(r.note ?? "").replace(/\.md$/, ".understood.md")}`);
  expect(note).toContain("## Conversation summary (written by the old session)");
  expect(note).toContain(`Its full log is ${join(sessionDirFor(join(state.dir, "sessions"), CWD), "2026-10-11T10-00-00-000Z_old-sid.jsonl")}`);
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
  expect(sent(w).some((t) => t.startsWith("[LEAD] HANDOVER_COMMITTED"))).toBe(false);
  // the old agent was frozen for the switch and resumed when it stayed the lane
  expect(sigs).toEqual(["SIGSTOP 11", "SIGCONT 11"]);
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
  expect(first[0]?.detail).toStartWith(`context 85% >= 80% in ${OLD}: decide it (dori rollover-propose demo shows the note)`);
  expect(first[0]?.detail).toContain(`--approved-by "lead:<reason and this signal>"`);
  expect(first[1]?.detail).toStartWith(`age 50.0 h >= 48 h in ${deps.config.leadPane}: decide it (dori rollover-propose lead shows the note)`);
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

test("a lane's stuck rollover point is rung 4 of the ladder: its STUCK line, not a ROLLOVER_DUE of its own, and the rung goes into the handover log", async () => {
  // Given
  const deps = await setup();
  const fix = (at: string, hypothesis = "lr too high") => ({ at, metric: "loss", hypothesis, via: "report" as const });
  const quiet = { ...deps, config: { ...deps.config, explore: { ...deps.config.explore, sendResearchToLane: false } } };
  await recordFix(quiet, "demo", fix("2026-10-11T10:00:00Z"));
  await recordFix(quiet, "demo", fix("2026-10-11T11:00:00Z", "seed"));
  await recordFix(quiet, "demo", fix("2026-10-11T11:30:00Z"));
  const third = await recordFix(quiet, "demo", fix("2026-10-11T12:00:00Z"));
  await deps.registry.patch("demo", { lastReplyAt: deps.clock.now() });
  // When
  const due = await freshnessTick(deps, "/home/test", { signals: async () => ({ contextPct: 99, compactions: 99, ageH: 999 }) });
  const top = stuckTop(await readLane(deps));
  ready(deps, [15]);
  const r = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  // Then
  expect(third.notes[0]).toContain('"loss" rung 4 (tagged 4, inferred 0, hypotheses 2, fixated)');
  expect(due.filter((a) => a.kind === "rollover_due")).toEqual([]);
  expect(top).toEqual({ metric: "loss", n: 4, rung: 4 });
  expect(r.code).toBe(0);
  // the new session starts its own ladder
  expect(stuckTop(await readLane(deps))).toBeUndefined();
  expect(readRollovers(state.dir)[0]).toMatchObject({ kind: "rollover", signals: { stuck: { metric: "loss", n: 4, rung: 4 } } });
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
  expect(printed[0]).toStartWith("HANDOVER_REFUSED demo: a lane moves to a new session only with an approval");
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
  writeFileSync(pendingFile(state.dir, "demo"), JSON.stringify({ key: "demo", pid, at: "2026-10-11T16:20:00Z", from: OLD, to: NEW, note: "/x.md", chains: [{ pid: 15, cmd: "bash -c sleep 7200; echo chain-done", pids: [15, 16] }] }));
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
  // the new session is released, and told whether the old chains still run (here they do: no restart)
  expect(sent(w).some((t) => t.startsWith(`[LEAD] HANDOVER_COMMITTED: the handover was interrupted after the old session ${OLD} closed`))).toBe(true);
  expect(printed).toContain("HANDOVER_CHAIN_SURVIVED demo 15; the new session was told not to restart them");
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
  expect(sent(w).some((t) => t.startsWith(`[LEAD] HANDOVER_COMMITTED: the handover is checked and the old session ${OLD} stays open but idle`))).toBe(true);
  // the old session is still open, so it stays quiet until the mark expires
  expect(quietReason(state.dir, OLD, deps.clock.now())).toContain("the handover of demo");
});

test("a chain whose parent ended but whose child still runs counts as running: no restart", async () => {
  // Given
  const deps = await setup();
  ready(deps, [15]);
  sim.grandchildSurvives = true;
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  // Then
  expect(r.code).toBe(0);
  expect(sent(w).some((x) => x.startsWith("[LEAD] HANDOVER_CHAINS_ENDED"))).toBe(false);
  expect(printed).toContain("HANDOVER_CHAIN_SURVIVED demo 15; the new session was told not to restart them");
  expect(sim.restarted).toBe(false);
});

test("a threshold is crossed at its value, not just above it, and 0 turns it off", () => {
  // Given
  const limits = { contextPct: 80, compactions: 4, ageH: 24 };
  // When / Then
  expect(crossed({ contextPct: 80, compactions: 4, ageH: 24 }, limits)).toEqual(["context 80% >= 80%", "compactions 4 >= 4", "age 24.0 h >= 24 h"]);
  expect(crossed({ contextPct: 79.9, compactions: 3, ageH: 23.9 }, limits)).toEqual([]);
  expect(crossed({ contextPct: 100, compactions: 99, ageH: 999 }, { contextPct: 0, compactions: 0, ageH: 0 })).toEqual([]);
  expect(crossed({}, limits)).toEqual([]);
  expect(crossed({ repeats: 9 }, limits)).toEqual([]);
});

test("the tagged half of the stuck count counts the lane's current session only, the way fix-attempt counts them", () => {
  // Given
  const fix = (at: string, hypothesis: string, via: "report" | "lead" = "report") => ({ at, metric: "loss", hypothesis, via });
  const moved = { ...lane(), history: [{ at: "2026-10-11T12:00:00Z", status: "working" as const, note: `pane moved aoe_old_1 -> ${OLD} (dori handover --lane)` }] };
  const cfg = { stuck: { hypothesesAt: 2, researchAt: 3, fixatedAfter: 3, rereadText: "" }, autoSignals: { aliases: {} } } as never;
  const view = (l: Lane) => stuckView(l, "loss", cfg);
  // When / Then
  expect(view({ ...lane(), fixes: [fix("2026-10-11T10:00:00Z", "lr"), fix("2026-10-11T11:00:00Z", "lr"), fix("2026-10-11T11:30:00Z", "lr"), fix("2026-10-11T11:40:00Z", "seed")] })).toMatchObject({ tagged: 4, hypotheses: 2, fixated: true });
  expect(view({ ...moved, fixes: [fix("2026-10-11T10:00:00Z", "lr"), fix("2026-10-11T11:00:00Z", "lr"), fix("2026-10-11T13:00:00Z", "lr")] })).toMatchObject({ tagged: 1, fixated: false });
  expect(view({ ...lane(), fixes: [fix("2026-10-11T10:00:00Z", "lr", "lead"), fix("2026-10-11T10:05:00Z", "lr")] }).tagged).toBe(1);
  // a fix marked improved (the one before it moved the metric) starts that metric's count again
  expect(view({ ...lane(), fixes: [fix("2026-10-11T10:00:00Z", "lr"), fix("2026-10-11T11:00:00Z", "lr"), { ...fix("2026-10-11T11:30:00Z", "lr"), improved: true }] })).toMatchObject({ tagged: 1, fixated: false });
  expect(view(lane()).n).toBe(0);
});

test("an approval is an answered rollover card for this lane's current session, a Discord message link, or auto only with the key on", () => {
  // Given
  const yes = { status: "answered", options: ["Yes, roll over", "Not yet"], answer: "Yes, roll over" };
  const cards: Record<string, object> = {
    Q1: { id: "Q1", ...yes },
    Q2: { id: "Q2", ...yes, answer: "Not yet" },
    Q3: { id: "Q3", status: "open", options: ["Yes, roll over", "Not yet"] },
    Q4: { id: "Q4", ...yes },
    Q5: { id: "Q5", status: "answered", options: ["Yes", "No"], answer: "Yes" },
    Q6: { id: "Q6", ...yes },
  };
  const card = (id: string) => cards[id] as never;
  const proposal = (key: string, id: string, pane = "p1") => ({ kind: "proposal" as const, who: "lane" as const, at: "2026-10-11T00:00:00Z", key, card: id, pane, signals: {}, crossed: [], blockers: "" });
  const log = [proposal("demo", "Q1"), proposal("demo", "Q2"), proposal("demo", "Q3"), proposal("other", "Q4"), proposal("demo", "Q6", "p0")];
  const check = (ref: string | undefined, on = false, canReport = false) => approvalProblem(ref, card, { on, key: "handover.autoRolloverLanes" }, "demo", "p1", log, canReport);
  // When / Then
  expect(check("Q1")).toBeUndefined();
  expect(check("q1")).toBeUndefined();
  expect(check("Q2")).toBe('card Q2 was answered "Not yet", not "Yes, roll over"');
  expect(check("Q3")).toBe("card Q3 is not answered yet");
  expect(check("Q9")).toBe("card Q9 not found");
  expect(check("Q4")).toBe("card Q4 is not a rollover proposal for demo; post one with dori rollover-propose demo");
  expect(check("Q5")).toBe("card Q5 is not a rollover proposal for demo; post one with dori rollover-propose demo");
  expect(check("Q6")).toBe("card Q6 was about p0, not the session demo runs in now (p1); post a new one with dori rollover-propose demo");
  expect(check("https://discord.com/channels/1/2/3")).toBeUndefined();
  for (const words of ["not approved", "owner said yes", "https://discord.com/channels/1/2", "https://example.com/channels/1/2/3"]) expect(check(words)).toContain("neither an answered rollover card");
  expect(check(undefined)).toStartWith("no approval");
  expect(check("auto:handover.autoRolloverLanes")).toContain("the automation key is off");
  expect(check("auto:handover.autoRolloverLanes", true)).toContain("an automatic rollover needs a way to tell the owner afterwards");
  expect(check("auto:handover.autoRolloverLanes", true, true)).toBeUndefined();
  expect(check("auto:anything", true)).toBe("auto:anything is not the automatic approval of this side; only auto:handover.autoRolloverLanes is");
  // the lead decides with a reason and the signal behind it, and only when the owner can be told afterwards
  expect(check("lead:STUCK rung 4 on loss, research did not help", false, true)).toBeUndefined();
  expect(check("lead:막힘 4단, 리서치 뒤에도 실패", false, true)).toBeUndefined();
  expect(check("lead:STUCK rung 4 on loss, research did not help")).toContain("needs a way to tell the owner afterwards");
  expect(check("lead:because", false, true)).toContain("does not say the reason and the signal behind it");
  expect(check("lead:it seems a good idea to me now", false, true)).toContain("does not say the reason and the signal behind it");
  // whole tokens only (challenge, grok-4.7): a word that only contains a signal name is no signal
  expect(check("lead:context is fine, the message page looks right", false, true)).toContain("does not say the reason");
  expect(check("lead:\ub2e8\uacc4\ub97c \ud310\ub2e8\ud574 \ubcf4\ub2c8 \uc62e\uae38 \ub54c", false, true)).toContain("does not say the reason");
  expect(check("lead:after the outage 3 h ago it looked off", false, true)).toContain("does not say the reason");
  expect(check("lead:context 85% after 6 compactions", false, true)).toBeUndefined();
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
  const watch = ["2026-10-11T09:00:00Z freshness NUDGED demo 16 min silent", "2026-10-11T09:30:00Z freshness NUDGED demo 20 min silent", "2026-10-11T09:40:00Z owner-check OWNER_CHECK demo OK 6 recent reports", "2026-10-11T09:45:00Z owner-check OWNER_CHECK demo GOAL_LOSS owner x", "2026-10-11T09:50:00Z stuck STUCK demo \"loss\" rung 3 (tagged 3)", "2026-10-11T11:00:00Z freshness NO-REPORT demo pane", "2026-10-11T11:00:00Z freshness NUDGED other 1"];
  // When
  const out = rolloverStats(entries as never, watch, Date.parse("2026-10-11T12:30:00Z"));
  // Then
  expect(out[0]).toBe("ROLLOVER_STATS proposals=1 rollovers=1 (done 1) approval_median_min=30 window=24h");
  expect(out[1]).toBe("ROLLOVER_STEPS open median 4s fail 0; verify median 60s fail 0");
  expect(out).toContain(`QUALITY demo 2026-10-11T10:30:00Z before 24h: NUDGED 2, OWNER_CHECK 1, STUCK 1 | after 2h: NO-REPORT 1`);
  const lead = rolloverStats([{ ...entries[1], approvedBy: "lead:STUCK rung 4", decidedBy: "lead", reason: "STUCK rung 4", ownerReport: { message: "m1" } }, { ...entries[1], decidedBy: "lead", ownerReport: { error: "429" } }] as never, [], Date.parse("2026-10-11T12:30:00Z"));
  expect(lead[2]).toContain("; decided by the lead (STUCK rung 4), owner told: m1");
  expect(lead[4]).toContain("owner told: MISSING (429)");
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

test("a tried fix the restatement leaves out is filled in from the fix ledger and the old log, and one supplement round commits; questions go to the lead", async () => {
  // Given
  const deps = await setup();
  ready(deps, [15]);
  await deps.registry.patch("demo", { fixes: [{ at: "2026-10-11T16:00:00Z", metric: "loss", hypothesis: "lr too high", via: "report" }] });
  oldSays("the owner: lr too high was already tried, do not retry it");
  sim.restate = RESTATE.replace("## Questions\nnone", "## Questions\nwhich seed is the baseline?");
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  // Then
  expect(r.code).toBe(0);
  const note = readFileSync(r.note ?? "", "utf8");
  expect(note).toContain("## Fix attempts in the old session (1)");
  expect(note).toContain("- 2026-10-11T16:00:00Z loss / lr too high (report)");
  expect(printed.find((l) => l.startsWith("HANDOVER_QUESTIONS demo: which seed is the baseline?"))).toBeDefined();
  const sup = (r.note ?? "").replace(/\.md$/, ".supplement-1.md");
  expect(printed).toContain(`HANDOVER_SUPPLEMENT demo round 1/2: 1 left out (tried fix: lr too high); ${sup}`);
  expect(sent(w).some((x) => x.startsWith(`[LEAD] HANDOVER_SUPPLEMENT n2 (round 1/2): your restatement left out 1 item(s). Read ${sup}, add them to`))).toBe(true);
  const text = readFileSync(sup, "utf8");
  expect(text).toContain("## 1. tried fix: lr too high");
  expect(text).toContain('- old log line 2 (user): "the owner: lr too high was already tried, do not retry it"');
  expect(printed).toContain("HANDOVER_SUPPLEMENT_OK demo after 1 round(s)");
  expect(sent(w).some((x) => x.startsWith("[LEAD] HANDOVER_COMMITTED"))).toBe(true);
  expect(readRollovers(state.dir).at(-1)).toMatchObject({ result: "done", supplementRounds: 1, supplements: [{ round: 1, items: [{ kind: "tried fix", text: "lr too high" }], evidence: 1, file: sup }] });
});

test("the owner's words and decisions the restatement leaves out are filled in from the summary, the owner's line quoted from the old log", async () => {
  // Given
  const deps = await setup();
  ready(deps, [15], undefined, OLD, `## Owner's words and constraints\n- Owner: "never restart the sleep chain while an old copy runs"\n## Decisions and why\n- Keep the eval seed fixed at three for every rerun. Why: the owner asked\n## Ruled out\nnone\n## In progress\nE7\n## Next step\ntrain E7\n`);
  oldSays("never restart the sleep chain while an old copy runs");
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  // Then
  expect(r.code).toBe(0);
  expect(printed.find((l) => l.startsWith("HANDOVER_SUPPLEMENT demo round 1/2: 2 left out (owner's words: never restart the sleep chain while an old copy runs; decision: Keep the eval seed fixed at three for every rerun.)"))).toBeDefined();
  const sup = readFileSync((r.note ?? "").replace(/\.md$/, ".supplement-1.md"), "utf8");
  expect(sup).toContain('- old log line 2 (user): "never restart the sleep chain while an old copy runs"');
  expect(sup).toContain("Evidence: no matching line in the old log.");
  const understood = readFileSync((r.note ?? "").replace(/\.md$/, ".understood.md"), "utf8");
  expect(understood).toContain("never restart the sleep chain while an old copy runs");
  expect(understood).toContain("Keep the eval seed fixed at three");
  expect(readRollovers(state.dir).at(-1)).toMatchObject({ result: "done", supplementRounds: 1 });
});

test("a restatement that still leaves out a tried fix after the supplement rounds fails the check, and everything moves back", async () => {
  // Given
  const deps = await setup();
  ready(deps, [15]);
  await deps.registry.patch("demo", { fixes: [{ at: "2026-10-11T16:00:00Z", metric: "loss", hypothesis: "lr too high", via: "report" }] });
  sim.supplement = "ignore";
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  // Then
  expect(r.code).toBe(3);
  expect(printed.filter((l) => l.startsWith("HANDOVER_SUPPLEMENT demo round ")).map((l) => l.split(":")[0])).toEqual(["HANDOVER_SUPPLEMENT demo round 1/2", "HANDOVER_SUPPLEMENT demo round 2/2"]);
  expect(printed.find((l) => l.startsWith("HANDOVER_VERIFY_FAIL"))).toContain("still leaves out after 2 supplement round(s): tried fix: lr too high");
  expect((await readLane(deps)).pane).toBe(OLD);
  expect(sent(w).some((x) => x.startsWith("[LEAD] HANDOVER_COMMITTED"))).toBe(false);
  expect(readRollovers(state.dir).at(-1)).toMatchObject({ result: "rolled-back", supplementRounds: 2 });
});

test("a restatement without the owner's goal gets it from the registry and commits after the round", async () => {
  // Given
  const deps = await setup();
  ready(deps, [15]);
  sim.restate = RESTATE.replace("레인에도 적용: ", "");
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  // Then
  expect(r.code).toBe(0);
  expect(printed.find((l) => l.startsWith("HANDOVER_SUPPLEMENT demo round 1/2: 1 left out (owner goal: 레인에도 적용)"))).toBeDefined();
  expect(readFileSync((r.note ?? "").replace(/\.md$/, ".supplement-1.md"), "utf8")).toContain("Source: the lane's registry entry (the owner's words at launch). Goes under: ## Goal.");
});

test("an owner's line with escaped quotes inside is one item, and it counts as restated either way", () => {
  // Given
  const facts = { lane: { ...lane(), goal: "" }, laneNote: `## Owner's words and constraints\n- Brief: "put only \\"none\\" under Ruled out on purpose"\n` } as unknown as LaneFacts;
  // Then
  expect(missingFrom(RESTATE, facts).map((m) => m.text)).toEqual(['put only "none" under Ruled out on purpose']);
  expect(missingFrom(`${RESTATE}- "put only \\"none\\" under Ruled out on purpose"\n`, facts)).toEqual([]);
  expect(missingFrom(`${RESTATE}- put only "none" under Ruled out on purpose\n`, facts)).toEqual([]);
});

test("a new session that does not answer a supplement fails the check", async () => {
  // Given
  const deps = await setup();
  ready(deps, [15]);
  await deps.registry.patch("demo", { fixes: [{ at: "2026-10-11T16:00:00Z", metric: "loss", hypothesis: "lr too high", via: "report" }] });
  sim.supplement = "silent";
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  // Then
  expect(r.code).toBe(3);
  expect(printed.find((l) => l.startsWith("HANDOVER_VERIFY_FAIL"))).toContain("no ack for the supplement n2");
  expect((await readLane(deps)).pane).toBe(OLD);
});

test("no restatement means the check fails and everything moves back", async () => {
  // Given
  const deps = await setup();
  ready(deps, [15]);
  sim.restate = "";
  sim.supplement = "ignore";
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", { ...OK, verifyMin: 1 });
  // Then
  expect(r.code).toBe(3);
  expect(printed.find((l) => l.startsWith("HANDOVER_SUPPLEMENT demo round 1/2: 1 left out (restatement: the restatement file is missing or empty)"))).toBeDefined();
  expect(printed.find((l) => l.startsWith("HANDOVER_VERIFY_FAIL"))).toContain("restatement");
  expect((await readLane(deps)).pane).toBe(OLD);
  expect(sigs).toEqual(["SIGSTOP 11", "SIGCONT 11"]);
});

test("a job started from the pane's shell dies with it too: it counts as a local chain", async () => {
  // Given
  const deps = await setup();
  ready(deps, [15]);
  table = [...baseTable(), { pid: 50, ppid: 10, cmd: "sleep 300" }];
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  // Then
  expect(r.code).toBe(2);
  expect(printed[0]).toStartWith("HANDOVER_REFUSED demo: 1 local chain(s) would die: 50 sleep 300");
});

test("a ready mark covers chains only: a turn that started after it still refuses", async () => {
  // Given
  const deps = await setup();
  ready(deps, [15]);
  w.screens[OLD] = `${HIGH}\n • Working (esc to interrupt)`;
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  // Then
  expect(r.code).toBe(2);
  expect(printed[0]).toContain("a turn is running");
  expect(opened()).toBe(false);
});

test("when the old session ends during the checks, the new one stays the lane instead of moving back to a dead pane", async () => {
  // Given
  const deps = await setup();
  ready(deps, [15]);
  sim.thinking = "medium";
  const run = deps.run;
  const dying = { ...deps, run: async (argv: readonly string[], opts?: never) => {
    if (firstMessageSent()) w.aoe = w.aoe.filter((s) => s.id !== OLD_ID);
    return run(argv, opts);
  } } as LaneHandoverDeps;
  // When
  const r = await laneHandover(dying, "demo", "aoe_lead_x", { ...OK, verifyMin: 1 });
  // Then
  expect(r).toMatchObject({ code: 1, to: NEW });
  expect(printed.find((l) => l.startsWith("HANDOVER_OLD_GONE demo"))).toBeDefined();
  expect((await readLane(deps)).pane).toBe(NEW);
  expect(stoppedIds()).toEqual([]);
  expect(sent(w).some((x) => x.startsWith("[LEAD] HANDOVER_COMMITTED: the old session ended during the checks"))).toBe(true);
});

test("a job an earlier handover listed (detached, or a chain that outlived its session) is listed again while it runs", async () => {
  // Given
  const deps = await setup();
  mkdirSync(join(state.dir, "handover", "lanes"), { recursive: true });
  writeFileSync(join(state.dir, "handover", "lanes", "demo-20261010-120000.json"), JSON.stringify({ detached: [{ pid: 41, cmd: "sleep 9999" }], chains: [{ pid: 77, cmd: "gone" }] }));
  ready(deps, [15]);
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", { dryRun: true });
  // Then
  const note = readFileSync(r.note ?? "", "utf8");
  expect(note).toContain("- 41: `sleep 9999`");
  expect(note).not.toContain("- 77:");
});

test("a lane whose omo session lives under the real path of a symlinked cwd is still found: monitors, todos and log", async () => {
  // Given
  const deps = await setup();
  const REAL = "/real/demo";
  const realDeps: LaneHandoverDeps = { ...deps, realpath: (p) => (p === CWD ? REAL : p), sessionOf: async (pane, cwd) => (pane === OLD && cwd === REAL ? "old-sid" : pane === NEW ? "new-sid" : "") };
  const file = manifestPath(join(state.dir, "sessions"), REAL, "old-sid");
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, sessionId: "old-sid", monitors: [monitor("scratch events", EVENTS, 14)] }));
  writeFileSync(join(sessionDirFor(join(state.dir, "sessions"), REAL), "2026-10-11T10-00-00-000Z_old-sid.jsonl"), "");
  ready(deps, [15]);
  // When
  const r = await laneHandover(realDeps, "demo", "aoe_lead_x", { dryRun: true });
  // Then
  const note = readFileSync(r.note ?? "", "utf8");
  expect(note).toContain("## Monitors (1)");
  expect(note).toContain(`Its full log is ${join(sessionDirFor(join(state.dir, "sessions"), REAL), "2026-10-11T10-00-00-000Z_old-sid.jsonl")}`);
  expect(printed.some((l) => l.startsWith("HANDOVER_SESSION_UNSEEN"))).toBe(false);
});

test("a rollover the lead decided tells the owner afterwards in the lane's thread and logs that message id; a failed message is ROLLOVER_OWNER_REPORT_MISSING", async () => {
  // Given
  const posted: [string | null, string][] = [];
  const base = await setup();
  const deps: LaneHandoverDeps = { ...base, reportOwner: async (thread, text) => { posted.push([thread, text]); return "msg-1"; } };
  ready(deps, [15]);
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", { approvedBy: "lead:STUCK rung 4 on loss after research" });
  // Then
  expect(r.code).toBe(0);
  expect(posted).toEqual([["12345678", `I moved lane demo (Demo lane) to a new session (${OLD} -> ${NEW}). Why: STUCK rung 4 on loss after research`]]);
  expect(readRollovers(state.dir)[0]).toMatchObject({ kind: "rollover", result: "done", decidedBy: "lead", reason: "STUCK rung 4 on loss after research", ownerReport: { message: "msg-1" } });
  expect(printed).toContain("ROLLOVER_OWNER_REPORTED demo message msg-1");
});

test("without a way to reach the owner a lead's rollover is refused before anything opens; a message that fails after the move is logged as missing", async () => {
  // Given
  const base = await setup();
  ready(base, [15]);
  // When
  const refused = await laneHandover(base, "demo", "aoe_lead_x", { approvedBy: "lead:STUCK rung 4 on loss" });
  const failing: LaneHandoverDeps = { ...base, reportOwner: async () => { throw new Error("429 rate limited"); } };
  const moved = await laneHandover(failing, "demo", "aoe_lead_x", { approvedBy: "lead:STUCK rung 4 on loss" });
  // Then
  expect(refused.code).toBe(2);
  expect(printed[0]).toContain("needs a way to tell the owner afterwards");
  expect(moved.code).toBe(0);
  expect(printed.some((l) => l.startsWith("ROLLOVER_OWNER_REPORT_MISSING demo: 429 rate limited; tell the owner yourself: I moved lane demo"))).toBe(true);
  expect(readRollovers(state.dir).at(-1)).toMatchObject({ decidedBy: "lead", ownerReport: { error: "429 rate limited" } });
});

test("an automatic rollover still in the same pane is started again after autoRetryMin, up to autoMaxTries, then one line gives up; a new pane starts over", async () => {
  // Given
  const base = await setup();
  const clock = fakeClock(Date.parse("2026-10-11T16:35:00Z"));
  const deps = { ...base, clock, config: { ...base.config, handover: { ...base.config.handover, laneContextPct: 80, autoRolloverLanes: true, autoRetryMin: 30, autoMaxTries: 3 } } };
  const starts: string[] = [];
  const hooks = { signals: async (pane: string) => (pane === OLD ? { contextPct: 85 } : {}), auto: async (_who: "lead" | "lane", key: string) => { starts.push(key); return `started ${starts.length}`; } };
  const tick = async (min: number): Promise<string[]> => {
    clock.at = Date.parse("2026-10-11T16:35:00Z") + min * 60_000;
    await deps.registry.patch("demo", { lastReplyAt: clock.at });
    return (await freshnessTick(deps, "/home/test", hooks)).filter((a) => a.lane === "demo" && a.kind.startsWith("rollover")).map((a) => `${a.kind} ${a.detail}`);
  };
  // When
  const first = await tick(0);
  const soon = await tick(10);
  const second = await tick(31);
  const third = await tick(62);
  const gaveUp = await tick(93);
  const after = await tick(200);
  await deps.registry.patch("demo", { pane: "aoe_demo-2_77777777" });
  const moved = await tick(201);
  // Then
  expect(first).toEqual([`rollover_due context 85% >= 80% in ${OLD}: decide it (dori rollover-propose demo shows the note); to go ahead, once the lane is at a safe point (dori handover ready demo), run dori handover --lane demo --approved-by "lead:<reason and this signal>"; the owner is told afterwards`, "rollover_auto started 1"]);
  expect(soon).toEqual([]);
  expect(second).toEqual(["rollover_auto retry 2/3 (context 85% >= 80%): started 2"]);
  expect(third).toEqual(["rollover_auto retry 3/3 (context 85% >= 80%): started 3"]);
  expect(gaveUp).toHaveLength(1);
  expect(gaveUp[0]).toStartWith(`rollover_auto gave up in ${OLD} after 3 automatic starts (handover.autoMaxTries 3)`);
  expect(after).toEqual([]);
  expect(moved).toEqual([]);
  expect(starts).toEqual(["demo", "demo", "demo"]);
  expect((await readLane(deps)).rolloverDue).toMatchObject({ pane: OLD, tries: 3, gaveUp: true });
});

test("an automatic lane rollover tells the owner afterwards with what it crossed; a refused one is only in the log", async () => {
  // Given
  const posted: [string | null, string][] = [];
  const base = await setup();
  const deps: LaneHandoverDeps = { ...base, config: { ...base.config, handover: { ...base.config.handover, autoRolloverLanes: true } }, reportOwner: async (thread, text) => { posted.push([thread, text]); return "msg-2"; } };
  // When: first with the lane's local chain still running (no ready mark), then at a safe point
  const refused = await laneHandover(deps, "demo", "aoe_lead_x", { approvedBy: "auto:handover.autoRolloverLanes" });
  const postedAfterRefusal = posted.length;
  ready(deps, [15]);
  const r = await laneHandover(deps, "demo", "aoe_lead_x", { approvedBy: "auto:handover.autoRolloverLanes" });
  // Then
  expect(refused.code).toBe(2);
  expect(printed.some((l) => l.startsWith("HANDOVER_REFUSED") && l.includes("would die"))).toBe(true);
  expect(postedAfterRefusal).toBe(0);
  expect(r.code).toBe(0);
  expect(posted).toHaveLength(1);
  expect(posted[0]?.[0]).toBe("12345678");
  expect(posted[0]?.[1]).toStartWith(`I moved lane demo (Demo lane) to a new session (${OLD} -> ${NEW}). Why: automatic (handover.autoRolloverLanes)`);
  expect(readRollovers(state.dir).at(-1)).toMatchObject({ result: "done", decidedBy: "auto", ownerReport: { message: "msg-2" } });
});

test("freshness starts with one line that says whether rollovers start by themselves, on what, and how they are retried", () => {
  const h = defaultConfig("/home/test").handover;
  expect(autoReadyLine(h)).toBe("ROLLOVER_AUTO_OFF lanes off, lead off; rollovers wait for the lead's decision");
  expect(autoReadyLine({ ...h, autoRolloverLanes: true, autoRolloverLead: true, laneContextPct: 80, laneCompactions: 4, laneAgeH: 24, leadContextPct: 80, leadCompactions: 4, leadAgeH: 48 })).toBe(
    "ROLLOVER_AUTO_READY lanes on (context >= 80%, compactions >= 4, age >= 24 h, stuck rung 4), lead on (context >= 80%, compactions >= 4, age >= 48 h); retry every 30 min, up to 6 starts per session; the owner is told after each move",
  );
  expect(autoReadyLine({ ...h, autoRolloverLead: true })).toBe("ROLLOVER_AUTO_READY lanes off, lead on (no threshold set); retry every 30 min, up to 6 starts per session; the owner is told after each move");
});

test("a rollover due while the auto key was off starts automatically in the same pane once the key is on, once", async () => {
  // Given
  const base = await setup();
  const deps = { ...base, config: { ...base.config, handover: { ...base.config.handover, laneContextPct: 80 } } };
  await deps.registry.patch("demo", { lastReplyAt: deps.clock.now() });
  const starts: string[] = [];
  const hooks = { signals: async (pane: string) => (pane === OLD ? { contextPct: 85 } : {}), auto: async (who: "lead" | "lane", key: string) => { starts.push(`${who}:${key}`); return "started"; } };
  const on = { ...deps, config: { ...deps.config, handover: { ...deps.config.handover, autoRolloverLanes: true } } };
  const rollovers = async (d: typeof deps) => (await freshnessTick(d, "/home/test", hooks)).filter((a) => a.kind.startsWith("rollover")).map((a) => `${a.kind} ${a.lane} ${a.detail}`);
  // When
  const off = await rollovers(deps);
  const first = await rollovers(on);
  const again = await rollovers(on);
  // Then
  expect(off.map((l) => l.split(" ")[0])).toEqual(["rollover_due"]);
  expect(first).toEqual(["rollover_auto demo context 85% >= 80%: started"]);
  expect(again).toEqual([]);
  expect(starts).toEqual(["lane:demo"]);
});

test("the context after the last compaction is the first assistant turn after it (input + cache read + cache write), read incrementally; a threshold on it makes a rollover due", () => {
  // Given
  const dir = join(state.dir, "after-compact");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "2026-10-11T10-00-00-000Z_abcdefab-0000-0000-0000-000000000001.jsonl");
  const turn = (input: number, cacheRead: number, cacheWrite: number) => JSON.stringify({ type: "message", message: { role: "assistant", usage: { input, output: 10, cacheRead, cacheWrite } } });
  const compaction = JSON.stringify({ type: "compaction", tokensBefore: 790000, details: { tokenEstimate: 640000 } });
  writeFileSync(file, [turn(2, 700000, 5000), compaction, JSON.stringify({ type: "message", message: { role: "user", usage: { input: 1 } } }), turn(2, 17421, 180890), turn(2, 198311, 3125)].join("\n") + "\n");
  // When
  const first = compactionScan(file);
  appendFileSync(file, [compaction, turn(2, 17421, 300000)].join("\n") + "\n");
  const second = compactionScan(file);
  appendFileSync(file, compaction + "\n");
  const pending = compactionScan(file);
  // Then
  expect(first).toEqual({ count: 1, afterK: 198 });
  expect(second).toEqual({ count: 2, afterK: 317 });
  expect(pending).toEqual({ count: 3 });
  expect(sessionSignals(dir, "abcdefab-0000-0000-0000-000000000001", Date.parse("2026-10-11T12:00:00Z"))).toEqual({ compactions: 3, ageH: 2 });
  expect(crossed({ afterCompactK: 317 }, { contextPct: 0, compactions: 0, ageH: 0, afterCompactK: 300 })).toEqual(["context after compaction 317k >= 300k"]);
  expect(crossed({ afterCompactK: 299 }, { contextPct: 0, compactions: 0, ageH: 0, afterCompactK: 300 })).toEqual([]);
  expect(crossed({ afterCompactK: 900 }, { contextPct: 0, compactions: 0, ageH: 0, afterCompactK: 0 })).toEqual([]);
});
