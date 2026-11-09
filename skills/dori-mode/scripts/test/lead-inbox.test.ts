import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { DoriConfig } from "../src/config.ts";
import { type FlowDeps, watchTick } from "../src/done-flow.ts";
import { leadInboxTick } from "../src/lead-inbox.ts";
import { depsFor, fakeClock, newWorld, sent, withState, type World } from "./fakes.ts";

// 2026-11-09: three leads ran with no inbox monitor and nobody knew. YooDori's lead (leadPane set back by hand, no handover)
// missed a #dori-pair request at 11:48Z; ZzangDori's lead moved to a new conversation at 11:11Z and missed two posts;
// SooDori's lead lost its monitor when soodori-herdr restarted at 09:22Z and heard nothing until it re-armed by hand at 11:36Z.
const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
const LEAD = "aoe_Dori_0a1b2c3d";
const SID = "40ccbe13-33d4-4c1e-9d0e-0123456789ab";
const OWNER = "100000000000000001";
const iso = (ms: number) => new Date(ms).toISOString();
const SCREEN = "❯ \n Claude │ pool\n(OmO) mem:repo just now ◉ watching 5: Dori inbox";
const DEAD_PID = 2 ** 22 + 12345;
const NEW_SID = "51ddcf24-44e5-4d2d-8eaf-1234567890ab";
const newTranscript = () => join(state.dir, "sessions", "--home-test-dori--", `2026-01-01T12-13-00-000Z_${NEW_SID}.jsonl`);

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
  world.ps = `10 1 /bin/bash /tmp/aoe-pane-env\n11 10 /x/senpi/dist/bundle/cli.js --session-id ${SID}\n`;
  world.agentStart = new Date(T0 - 300 * MIN).toString();
  world.screen = SCREEN;
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

const deps = (ms: number, patch: Partial<DoriConfig> = {}): FlowDeps => ({
  ...depsFor(world, fakeClock(ms), state.dir, { backend: "aoe", leadPane: LEAD, sessionsDir: join(state.dir, "sessions"), ...patch }),
  ownerInbox: { path: inbox, ownerId: OWNER, ownerChannel: "C-OWNER" },
});
const row = (ms: number, id: string, extra: object = {}) =>
  appendFileSync(inbox, `${JSON.stringify({ ts: iso(ms), id, channel_id: "PAIR", scope: "pair-bot", author_id: "200000000000000002", content: `request ${id}`, ...extra })}\n`);
// what omo writes when a monitor delivers a row: the row's JSON inside the event text
const heard = (id: string) =>
  appendFileSync(transcript, `${JSON.stringify({ type: "custom_message", customType: "senpi-monitor:notification", content: `<system-reminder>Monitor event(inbox): ${JSON.stringify({ id })}</system-reminder>` })}\n`);
const queued = (id: string, replyTo?: string) =>
  appendFileSync(transcript, `${JSON.stringify({ type: "custom", customType: "work-custody", data: { state: "queued", payload: { message: { customType: "senpi-monitor:notification", content: `Monitor event(inbox): ${JSON.stringify({ id, ...(replyTo ? { reply_to: replyTo } : {}) })}` } } } })}\n`);
const monitor = (patch: object = {}) => ({ monitorId: "mon_A", description: "받은편지", runtimeKind: "command", command: `tail -n 0 -F ${inbox}`, persistent: true, suspended: false, deliveryPaused: false, expiresAt: null, createdAt: T0 - 200 * MIN, runtime: { pid: process.pid }, ...patch });
const monitors = (...m: object[]) => writeFileSync(manifest, JSON.stringify({ version: 1, sessionId: SID, monitors: m }));

test("a pair-bot or owner row the lead's session never got is typed into the lead once after leadInboxMin; heard rows and other kinds are not", async () => {
  monitors(monitor());
  row(T0 - 30 * MIN, "p-heard");
  heard("p-heard");
  row(T0 - 25 * MIN, "u-1", { kind: "upstream-change", scope: undefined });
  row(T0 - 5 * MIN, "p-1");
  queued("p-1");
  row(T0 - 4 * MIN, "o-1", { scope: "thread", author_id: OWNER });
  expect(await leadInboxTick(deps(T0))).toEqual([]);
  expect(await leadInboxTick(deps(T0 + 6 * MIN))).toEqual([`LEAD_INBOX_UNHEARD ${LEAD} 2 inbox row(s) (pair-bot 1, owner 1) never reached session ${SID}, oldest p-1 ${iso(T0 - 5 * MIN)} (11 min); woke the lead (SUBMITTED)`]);
  expect(sent(world)).toHaveLength(1);
  expect(sent(world)[0]).toStartWith("[DORI] LEAD_INBOX_UNHEARD: 2 inbox row(s) since 11:55 never reached your session (pair-bot 1, owner 1).");
  // one incident, one line: a newer unheard row joins it
  row(T0 + 7 * MIN, "p-2");
  expect(await leadInboxTick(deps(T0 + 8 * MIN))).toEqual([]);
  // the lead read them: said once
  heard("p-1");
  heard("o-1");
  heard("p-2");
  expect(await leadInboxTick(deps(T0 + 9 * MIN))).toEqual([`LEAD_INBOX_OK ${LEAD} session ${SID} hears its inbox again`]);
  expect(await leadInboxTick(deps(T0 + 10 * MIN))).toEqual([]);
  expect(sent(world)).toHaveLength(1);
});

test("a live monitor's first tick baselines the existing 83-row backlog and alerts only for a new undelivered row", async () => {
  rmSync(join(state.dir, "lead-inbox.json"), { force: true });
  monitors(monitor());
  for (let i = 0; i < 83; i++) row(T0 - (84 - i) * MIN, `p-backlog-${i}`);
  expect(await leadInboxTick(deps(T0))).toEqual([]);
  const baseline = JSON.parse(readFileSync(join(state.dir, "lead-inbox.json"), "utf8")) as { heardIds?: string[]; baselineDone?: boolean };
  expect(baseline.heardIds).toHaveLength(83);
  expect(baseline.baselineDone).toBe(true);
  row(T0 + MIN, "p-new");
  expect((await leadInboxTick(deps(T0 + 11 * MIN)))[0]).toContain(`1 inbox row(s) (pair-bot 1) never reached session ${SID}, oldest p-new`);
});

test("no live inbox monitor in the lead's session (none, its process gone, delivery paused) is typed once after leadInboxMin and again after the repeat window", async () => {
  const cases: [string, object[]][] = [
    ["no monitor on inbox.jsonl", [monitor({ command: "tail -F /tmp/lanes.log", description: "lanes" })]],
    ["받은편지 armed but its process is gone", [monitor({ runtime: { pid: DEAD_PID } })]],
    ["받은편지 armed but its delivery is paused", [monitor({ deliveryPaused: true })]],
  ];
  for (const [why, m] of cases) {
    rmSync(join(state.dir, "lead-inbox.json"), { force: true });
    world.calls = [];
    monitors(...m);
    expect(await leadInboxTick(deps(T0))).toEqual([]);
    expect(await leadInboxTick(deps(T0 + 9 * MIN))).toEqual([]);
    expect(await leadInboxTick(deps(T0 + 10 * MIN))).toEqual([`LEAD_INBOX_UNWATCHED ${LEAD} session ${SID} since ${iso(T0)}: ${why}; woke the lead (SUBMITTED)`]);
    expect(sent(world)[0]).toStartWith(`[DORI] LEAD_INBOX_UNWATCHED: your session hears no inbox row (${why}), so owner and pair messages do not reach you.`);
    expect(sent(world)[0]).toContain(`tail -n 0 -F ${inbox}`);
    expect(await leadInboxTick(deps(T0 + 20 * MIN))).toEqual([]);
    expect((await leadInboxTick(deps(T0 + 40 * MIN)))[0]).toStartWith(`LEAD_INBOX_UNWATCHED ${LEAD} session ${SID} since ${iso(T0)}: ${why}; woke the lead (SUBMITTED)`);
    expect(sent(world)).toHaveLength(2);
  }
  monitors(monitor());
  expect(await leadInboxTick(deps(T0 + 41 * MIN))).toEqual([`LEAD_INBOX_OK ${LEAD} session ${SID} hears its inbox again`]);
});

test("a first tick without a live monitor keeps UNWATCHED and does not baseline the backlog", async () => {
  rmSync(join(state.dir, "lead-inbox.json"), { force: true });
  monitors();
  expect(await leadInboxTick(deps(T0))).toEqual([]);
  expect((await leadInboxTick(deps(T0 + 10 * MIN)))[0]).toContain("LEAD_INBOX_UNWATCHED");
  const mark = JSON.parse(readFileSync(join(state.dir, "lead-inbox.json"), "utf8")) as { heardIds?: string[]; baselineDone?: boolean };
  expect(mark.heardIds).toEqual([]);
  expect(mark.baselineDone).toBeUndefined();
});

test("a line that did not reach the lead is logged and typed again next tick; a new session starts its own grace; leadInboxMin 0 never checks", async () => {
  monitors();
  world.stuckReads = 1000;
  expect(await leadInboxTick(deps(T0))).toEqual([]);
  const miss = `LEAD_INBOX_UNWATCHED ${LEAD} session ${SID} since ${iso(T0)}: no monitor on inbox.jsonl; NOT_SUBMITTED: the line did not reach the pane, typed again next tick`;
  expect(await leadInboxTick(deps(T0 + 10 * MIN))).toEqual([miss]);
  expect(await leadInboxTick(deps(T0 + 11 * MIN))).toEqual([miss]);
  world.stuckReads = 0;
  expect((await leadInboxTick(deps(T0 + 12 * MIN)))[0]).toEndWith("woke the lead (SUBMITTED)");
  // rows from before the session started belong to the session before it
  const sid2 = "51ddcf24-44e5-4d2d-8eaf-1234567890ab";
  world.ps = `10 1 /bin/bash /tmp/aoe-pane-env\n11 10 /x/senpi/dist/bundle/cli.js --session-id ${sid2}\n`;
  writeFileSync(join(state.dir, "sessions", "--home-test-dori--", `2026-01-01T12-13-00-000Z_${sid2}.jsonl`), `${JSON.stringify({ type: "session", id: sid2, timestamp: iso(T0 + 13 * MIN) })}\n`);
  row(T0 + 5 * MIN, "p-old");
  expect(await leadInboxTick(deps(T0 + 14 * MIN))).toEqual([]);
  expect((await leadInboxTick(deps(T0 + 24 * MIN)))[0]).toStartWith(`LEAD_INBOX_UNWATCHED ${LEAD} session ${sid2} since ${iso(T0 + 14 * MIN)}: no monitor on inbox.jsonl;`);
  expect(await leadInboxTick(deps(T0 + 60 * MIN, { leadInboxMin: 0 }))).toEqual([]);
});

test("an owner row LEAD_OWNER_WAITING already typed into the lead is not typed again; a pair-bot row beside it still is", async () => {
  monitors(monitor());
  row(T0 - 20 * MIN, "o-1", { scope: "thread", author_id: OWNER });
  writeFileSync(join(state.dir, "lead-limit.json"), JSON.stringify({ pane: LEAD, wakeKey: "o-1|", wokeAt: iso(T0 - 9 * MIN) }));
  expect(await leadInboxTick(deps(T0))).toEqual([]);
  row(T0 - 15 * MIN, "p-1");
  expect((await leadInboxTick(deps(T0 + MIN)))[0]).toStartWith(`LEAD_INBOX_UNHEARD ${LEAD} 1 inbox row(s) (pair-bot 1)`);
});

test("/new in the same agent: the session whose transcript omo wrote last is checked, not the launch argv session", async () => {
  const next = newTranscript();
  writeFileSync(next, `${JSON.stringify({ type: "session", id: NEW_SID, timestamp: iso(T0 + 13 * MIN) })}\n`);
  monitors(monitor());
  writeFileSync(join(state.dir, "sessions", "--home-test-dori--", "extensions", "terminal", `${NEW_SID}.json`), JSON.stringify({ monitors: [monitor()] }));
  utimesSync(transcript, new Date(T0), new Date(T0));
  utimesSync(next, new Date(T0 + 14 * MIN), new Date(T0 + 14 * MIN));
  world.ps = `10 1 /bin/bash /tmp/aoe-pane-env\n11 10 /x/senpi/dist/bundle/cli.js --session-id ${SID}\n12 11 bun process-entry.js\n`;
  const base = deps(T0 + 30 * MIN);
  const run: FlowDeps["run"] = async (argv, opts) => argv[0] === "ps" && argv[1] === "eww" ? { code: 0, out: `bun process-entry.js PI_SESSION_ID=${NEW_SID} PI_SESSION_FILE=${next}`, err: "" } : base.run(argv, opts);
  row(T0 + 14 * MIN, "p-new");
  appendFileSync(next, `${JSON.stringify({ type: "custom_message", customType: "senpi-monitor:notification", content: `Monitor event(inbox): ${JSON.stringify({ id: "p-new" })}` })}\n`);
  expect(await leadInboxTick({ ...base, run })).toEqual([]);
  world.ps = world.ps.replace("\n12 11 bun process-entry.js", "");
  expect(await leadInboxTick({ ...base, run })).toEqual([]);
});

test("heard ids survive transcript compaction", async () => {
  monitors(monitor());
  row(T0 - 20 * MIN, "p-compacted");
  heard("p-compacted");
  expect(await leadInboxTick(deps(T0))).toEqual([]);
  writeFileSync(transcript, `${JSON.stringify({ type: "session", id: SID, timestamp: iso(T0 - 300 * MIN) })}\n`);
  expect(await leadInboxTick(deps(T0 + 20 * MIN))).toEqual([]);
});

test("a SENT reply receipt marks its request heard but a queued reply_to does not", async () => {
  monitors(monitor());
  row(T0 - 20 * MIN, "1569430000000000001");
  row(T0 - 18 * MIN, "1569430000000000003");
  for (const [callId, target] of [["call-sent", "1569430000000000001"], ["call-queued", "1569430000000000003"]]) {
    appendFileSync(transcript, `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: callId, name: "eval", arguments: { code: `await tool.bash({ command: "dori send discord --reply ${target} --text-file /tmp/reply.txt" })` } }] } })}\n`);
  }
  appendFileSync(transcript, `${JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "completion-watcher", content: [{ type: "text", text: "Eval cell call-sent (js) is completed.\nSENT 1569430000000000002 len=40 sha=1234abcd first=\"answered\"" }] } })}\n`);
  const out = await leadInboxTick(deps(T0));
  expect(out).toHaveLength(1);
  expect(out[0]).toContain("1 inbox row(s) (pair-bot 1)");
  expect(out[0]).toContain("oldest 1569430000000000003");
});

test("a delivered reply does not mark the request it names heard", async () => {
  monitors(monitor());
  row(T0 - 20 * MIN, "p-request");
  row(T0 - 19 * MIN, "p-reply", { reply_to: "p-request" });
  appendFileSync(transcript, `${JSON.stringify({ type: "custom_message", customType: "senpi-monitor:notification", content: `Monitor event(inbox): ${JSON.stringify({ id: "p-reply", reply_to: "p-request" })}` })}\n`);
  expect((await leadInboxTick(deps(T0)))[0]).toContain("oldest p-request");
});

test("only owner row ids named by a successful wake are deduped, not every row before its timestamp", async () => {
  monitors(monitor());
  row(T0 - 30 * MIN, "o-covered", { scope: "thread", author_id: OWNER });
  row(T0 - 20 * MIN, "o-backfilled", { scope: "thread", author_id: OWNER });
  writeFileSync(join(state.dir, "lead-limit.json"), JSON.stringify({ pane: LEAD, wakeKey: "o-covered|", wakeIds: ["o-covered"], wokeAt: iso(T0 - 1 * MIN) }));
  expect((await leadInboxTick(deps(T0)))[0]).toContain("oldest o-backfilled");
  expect(sent(world)[0]).not.toContain("o-covered");
});

test("a card answer redelivered by missedAnswersTick is heard even without its interaction id", async () => {
  monitors(monitor());
  row(T0 - 20 * MIN, "interaction-1", { kind: "answer", qid: "Q1", answer: "yes", scope: undefined });
  appendFileSync(transcript, `${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "[DORI] ANSWER Q1 (button, now): yes" }] } })}\n`);
  expect(await leadInboxTick(deps(T0))).toEqual([]);
});

test("a monitor description with unsafe text cannot stop the wake", async () => {
  monitors(monitor({ description: "inbox `bad` $(boom)", deliveryPaused: true }));
  expect(await leadInboxTick(deps(T0))).toEqual([]);
  expect((await leadInboxTick(deps(T0 + 10 * MIN)))[0]).toContain("woke the lead (SUBMITTED)");
  expect(sent(world)[0]).not.toContain("`");
  expect(sent(world)[0]).not.toContain("$(");
});

test("dori watch runs the check for the lead", async () => {
  monitors();
  row(T0 - 20 * MIN, "p-1");
  expect(await watchTick(deps(T0))).toEqual([`LEAD_INBOX_UNHEARD ${LEAD} 1 inbox row(s) (pair-bot 1) never reached session ${SID}, oldest p-1 ${iso(T0 - 20 * MIN)} (20 min), no live inbox monitor (no monitor on inbox.jsonl); woke the lead (SUBMITTED)`]);
  expect(sent(world)[0]).toContain("Your session runs no live inbox monitor (no monitor on inbox.jsonl)");
});
