import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { FlowDeps } from "../src/done-flow.ts";
import { leadInboxTick } from "../src/lead-inbox.ts";
import { depsFor, fakeClock, newWorld, withState, type World } from "./fakes.ts";

// The session the lead's agent runs after a handover, when the hc core it runs in was started in the old lead's shell, so the
// agent, its monitors and its provider inherited the old lead's PI_SESSION_ID (MooDori hc:t1, 2026-11-11). Only the shells of
// omo's bash tools and its kernels are handed the session it runs; a monitor carries SENPI_MONITOR_ID.
const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
const LEAD = "aoe_Dori_0a1b2c3d";
const SID = "40ccbe13-33d4-4c1e-9d0e-0123456789ab";
const NEW_SID = "51ddcf24-44e5-4d2d-8eaf-1234567890ab";
const iso = (ms: number) => new Date(ms).toISOString();

let state: ReturnType<typeof withState>;
let world: World;
let inbox: string;
let transcript: string;
let manifest: string;
beforeEach(() => {
  state = withState();
  world = newWorld();
  world.aoe = [{ id: "0a1b2c3d4e5f6a7b", title: "Dori", path: "/home/test/dori", tool: "omo", profile: "main" }];
  world.tmux = [LEAD];
  world.agentStart = new Date(T0 - 300 * MIN).toString();
  world.screen = "❯ \n Claude │ pool\n(OmO) mem:repo just now ◉ watching 5: Dori inbox";
  const dir = join(state.dir, "sessions", "--home-test-dori--");
  mkdirSync(join(dir, "extensions", "terminal"), { recursive: true });
  transcript = join(dir, `2026-01-01T07-00-00-000Z_${SID}.jsonl`);
  writeFileSync(transcript, `${JSON.stringify({ type: "session", id: SID, timestamp: iso(T0 - 300 * MIN) })}\n`);
  manifest = join(dir, "extensions", "terminal", `${SID}.json`);
  inbox = join(state.dir, "inbox.jsonl");
  writeFileSync(inbox, "");
  writeFileSync(join(state.dir, "lead-inbox.json"), JSON.stringify({ pane: LEAD, session: SID, agentPid: 11, log: transcript, heardIds: [], baselineDone: true }));
});
afterEach(() => state.done());

const deps = (ms: number): FlowDeps => ({
  ...depsFor(world, fakeClock(ms), state.dir, { backend: "aoe", leadPane: LEAD, sessionsDir: join(state.dir, "sessions") }),
  ownerInbox: { path: inbox, ownerId: "100000000000000001", ownerChannel: "C-OWNER" },
});
const monitor = () => ({ monitorId: "mon_A", description: "inbox", command: `tail -n 0 -F ${inbox}`, persistent: true, suspended: false, deliveryPaused: false, expiresAt: null, runtime: { pid: process.pid } });
const monitors = (...m: object[]) => writeFileSync(manifest, JSON.stringify({ version: 1, sessionId: SID, monitors: m }));
const checked = () => (JSON.parse(readFileSync(join(state.dir, "lead-inbox.json"), "utf8")) as { session?: string }).session;
const NEXT = () => join(state.dir, "sessions", "--home-test-dori--", `2026-01-01T12-13-00-000Z_${NEW_SID}.jsonl`);
// the agent and its children, each child's environment after its command (ps eww), the old SID's log written last
const lead = (agent: string, children: readonly (readonly [string, string])[]): FlowDeps["run"] => {
  const next = NEXT();
  writeFileSync(next, `${JSON.stringify({ type: "session", id: NEW_SID, timestamp: iso(T0 + 13 * MIN) })}\n`);
  writeFileSync(join(state.dir, "sessions", "--home-test-dori--", "extensions", "terminal", `${NEW_SID}.json`), JSON.stringify({ monitors: [monitor()] }));
  monitors(monitor());
  utimesSync(next, new Date(T0 + 14 * MIN), new Date(T0 + 14 * MIN));
  utimesSync(transcript, new Date(T0 + 15 * MIN), new Date(T0 + 15 * MIN));
  world.ps = `10 1 /bin/bash /tmp/aoe-pane-env\n11 10 ${agent}\n${children.map(([cmd], i) => `${12 + i} 11 ${cmd}`).join("\n")}\n`;
  const base = deps(T0 + 20 * MIN);
  return async (argv, opts) => {
    const at = Number(argv.at(-1)) - 12;
    if (argv[0] !== "ps" || argv[1] !== "eww") return base.run(argv, opts);
    const child = children[at];
    return { code: 0, out: child ? `${child[0]} ${child[1]}` : `${agent} PI_SESSION_ID=${SID} PI_SESSION_FILE=${transcript}`, err: "" };
  };
};
const inherited = () => `PI_SESSION_ID=${SID} PI_SESSION_FILE=${transcript}`;

// MooDori hc:t1 at 15:50:05Z: argv names the new session, seven monitors and the claude provider carry the old one
test("after a handover, the old lead's session that monitors and the provider only inherited is not the lead's session", async () => {
  rmSync(join(state.dir, "lead-inbox.json"), { force: true });
  const run = lead(`/x/senpi/dist/bundle/cli.js --session-id ${NEW_SID}`, [
    [`/bin/bash -c tail -n 0 -F ${inbox}`, `${inherited()} SENPI_MONITOR_ID=mon_A`],
    ["/x/claude-agent-sdk-linux-arm64/claude --output-format stream-json", inherited()],
  ]);
  expect(await leadInboxTick({ ...deps(T0 + 20 * MIN), run })).toEqual([]);
  expect(await leadInboxTick({ ...deps(T0 + 30 * MIN), run })).toEqual([]);
  expect(checked()).toBe(NEW_SID);
});

// review 2 of #460: a --continue agent whose session-aware child ended; only a monitor that inherited its launch session is left
test("a session only a monitor inherited does not win over the one the previous tick recorded for the agent", async () => {
  writeFileSync(join(state.dir, "lead-inbox.json"), JSON.stringify({ pane: LEAD, session: NEW_SID, agentPid: 11, log: NEXT(), heardIds: [], baselineDone: true }));
  const run = lead("/x/senpi/dist/bundle/cli.js --continue", [[`/bin/bash -c tail -n 0 -F ${inbox}`, `${inherited()} SENPI_MONITOR_ID=mon_A`]]);
  expect(await leadInboxTick({ ...deps(T0 + 20 * MIN), run })).toEqual([]);
  expect(checked()).toBe(NEW_SID);
});

// review 3 of #460: a --continue agent that inherited A moved to B and resumed A; its bash tool's shell names A
test("a bash tool's shell names the session omo runs, so a resume back to the inherited one is followed", async () => {
  writeFileSync(join(state.dir, "lead-inbox.json"), JSON.stringify({ pane: LEAD, session: NEW_SID, agentPid: 11, log: NEXT(), heardIds: [], baselineDone: true }));
  const run = lead("/x/senpi/dist/bundle/cli.js --continue", [
    [`/bin/bash -c tail -n 0 -F ${inbox}`, `PI_SESSION_ID=${NEW_SID} SENPI_MONITOR_ID=mon_A`],
    ["/bin/bash -c bun test", inherited()],
  ]);
  expect(await leadInboxTick({ ...deps(T0 + 20 * MIN), run })).toEqual([]);
  expect(checked()).toBe(SID);
});

// review 4 of #460: a watcher before this fix recorded the inherited session for the agent; that record proves nothing
test("a previous tick's record of the inherited session, written before sessions were vetted, does not bring it back", async () => {
  const run = lead(`/x/senpi/dist/bundle/cli.js --session-id ${NEW_SID}`, [[`/bin/bash -c tail -n 0 -F ${inbox}`, `${inherited()} SENPI_MONITOR_ID=mon_A`]]);
  expect(await leadInboxTick({ ...deps(T0 + 20 * MIN), run })).toEqual([]);
  expect(checked()).toBe(NEW_SID);
});

// review 4 of #460: the bash tool's command exec'd another program; it still leads the terminal session omo gave it (sid)
test("a bash tool's command that exec'd another program still names the session omo runs", async () => {
  writeFileSync(join(state.dir, "lead-inbox.json"), JSON.stringify({ pane: LEAD, session: NEW_SID, agentPid: 11, log: NEXT(), heardIds: [], baselineDone: true }));
  const agent = "/x/senpi/dist/bundle/cli.js --continue";
  const base = lead(agent, [["/x/claude-agent-sdk-linux-arm64/claude --output-format stream-json", inherited()], ["sleep 600", inherited()]]);
  // pid ppid sid stat command: the provider stays in the agent's terminal session, the tool's command leads its own
  const table = `10 1 10 S /bin/bash /tmp/aoe-pane-env\n11 10 10 S+ ${agent}\n12 11 10 S+ /x/claude-agent-sdk-linux-arm64/claude --output-format stream-json\n13 11 13 S+ sleep 600\n`;
  const run: FlowDeps["run"] = async (argv, opts) => argv[0] === "ps" && argv[1] === "-A" && argv.some((a) => a.includes("sid=")) ? { code: 0, out: table, err: "" } : base(argv, opts);
  expect(await leadInboxTick({ ...deps(T0 + 20 * MIN), run })).toEqual([]);
  expect(checked()).toBe(SID);
});
