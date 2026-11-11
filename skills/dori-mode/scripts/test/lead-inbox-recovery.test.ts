import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { DoriConfig } from "../src/config.ts";
import { defaultDiscordWords } from "../src/config-discord.ts";
import { discordText } from "../src/messenger/discord-markdown.ts";
import type { FlowDeps } from "../src/done-flow.ts";
import { leadInboxTick } from "../src/lead-inbox.ts";
import { leadLimitTick } from "../src/lead-limit.ts";
import { depsFor, fakeClock, newWorld, sent, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
const LEAD = "aoe_Dori_0a1b2c3d";
const SID = "40ccbe13-33d4-4c1e-9d0e-0123456789ab";
const NEW_SID = "51ddcf24-44e5-4d2d-8eaf-1234567890ab";
const OWNER = "100000000000000001";
const iso = (ms: number) => new Date(ms).toISOString();
const SCREEN = "❯ \n Claude │ pool\n(OmO) mem:repo just now ◉ watching 5: Dori inbox";

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
const reply = (ms: number) => appendFileSync(transcript, `${JSON.stringify({ timestamp: iso(ms), type: "message", message: { role: "assistant", content: [], stopReason: "stop" } })}\n`);
const monitor = () => ({ monitorId: "mon_A", description: "inbox", command: `tail -n 0 -F ${inbox}`, persistent: true, suspended: false, deliveryPaused: false, expiresAt: null, runtime: { pid: process.pid } });
const monitors = (...m: object[]) => writeFileSync(manifest, JSON.stringify({ version: 1, sessionId: SID, monitors: m }));

test("reading the missed inbox row with an ordinary tool result ends the alert", async () => {
  monitors(monitor());
  row(T0 - 20 * MIN, "p-tool");
  const raw = JSON.stringify({ ts: iso(T0 - 20 * MIN), id: "p-tool", channel_id: "PAIR", scope: "pair-bot", content: "request p-tool" });
  appendFileSync(transcript, `${JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: raw }] } })}\n`);
  expect(await leadInboxTick(deps(T0))).toEqual([]);
});

test("a queued card answer with qid and interaction id is still unheard", async () => {
  monitors(monitor());
  row(T0 - 20 * MIN, "interaction-q", { kind: "answer", qid: "Q2", answer: "yes", scope: undefined });
  const raw = JSON.stringify({ id: "interaction-q", kind: "answer", qid: "Q2", answer: "yes" });
  appendFileSync(transcript, `${JSON.stringify({ type: "custom", customType: "work-custody", data: { state: "queued", payload: { message: { customType: "senpi-monitor:notification", content: raw } } } })}\n`);
  expect((await leadInboxTick(deps(T0)))[0]).toContain("oldest interaction-q");
});

test("two successful owner wakes retain the union of covered row ids", async () => {
  row(T0 - 30 * MIN, "o-a", { scope: "thread", author_id: OWNER });
  reply(T0 - 40 * MIN);
  expect((await leadLimitTick(deps(T0)))[0]).toStartWith("LEAD_OWNER_WAITING");
  reply(T0 + MIN);
  row(T0 + 2 * MIN, "o-b", { scope: "thread", author_id: OWNER });
  expect((await leadLimitTick(deps(T0 + 20 * MIN)))[0]).toStartWith("LEAD_OWNER_WAITING");
  const mark = JSON.parse(readFileSync(join(state.dir, "lead-limit.json"), "utf8")) as { wakeIds?: string[] };
  expect(new Set(mark.wakeIds)).toEqual(new Set(["o-a", "o-b"]));
});

test("a custom --session-dir still gets the inbox check and its own manifest", async () => {
  const custom = join(state.dir, "custom-sessions");
  mkdirSync(join(custom, "extensions", "terminal"), { recursive: true });
  const log = join(custom, `2026-01-01T07-00-00-000Z_${NEW_SID}.jsonl`);
  writeFileSync(log, `${JSON.stringify({ type: "session", id: NEW_SID, timestamp: iso(T0 - 300 * MIN) })}\n`);
  writeFileSync(join(custom, "extensions", "terminal", `${NEW_SID}.json`), JSON.stringify({ monitors: [] }));
  world.ps = `10 1 /bin/bash /tmp/aoe-pane-env\n11 10 /x/senpi/dist/bundle/cli.js --session-id ${NEW_SID} --session-dir ${custom}\n`;
  row(T0 - 20 * MIN, "p-custom");
  expect((await leadInboxTick(deps(T0)))[0]).toContain(`never reached session ${NEW_SID}`);
  expect(sent(world)).toHaveLength(1);
});

test("a selector-resolved session stays checked after its identifying child exits", async () => {
  const dir = join(state.dir, "sessions", "--home-test-dori--");
  const next = join(dir, `2026-01-01T07-00-00-000Z_${NEW_SID}.jsonl`);
  writeFileSync(next, `${JSON.stringify({ type: "session", id: NEW_SID, timestamp: iso(T0 - 300 * MIN) })}\n`);
  writeFileSync(join(dir, "extensions", "terminal", `${NEW_SID}.json`), JSON.stringify({ monitors: [monitor()] }));
  world.ps = `10 1 /bin/bash /tmp/aoe-pane-env\n11 10 /x/senpi/dist/bundle/cli.js --continue\n12 11 bun process-entry.js\n`;
  const base = deps(T0);
  const run: FlowDeps["run"] = async (argv, opts) => argv[0] === "ps" && argv[1] === "eww" ? { code: 0, out: `bun process-entry.js PI_SESSION_ID=${NEW_SID} PI_SESSION_FILE=${next}`, err: "" } : base.run(argv, opts);
  expect(await leadInboxTick({ ...base, run })).toEqual([]);
  world.ps = world.ps.replace("\n12 11 bun process-entry.js", "");
  row(T0 + 5 * MIN, "p-selector");
  expect((await leadInboxTick({ ...deps(T0 + 20 * MIN), run }))[0]).toContain(`never reached session ${NEW_SID}`);
});

test("macOS still finds an identified session's default-directory transcript with no child path", async () => {
  monitors();
  row(T0 - 20 * MIN, "p-darwin");
  const own = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...own, value: "darwin" });
  try {
    expect((await leadInboxTick(deps(T0)))[0]).toContain(`never reached session ${SID}`);
  } finally {
    Object.defineProperty(process, "platform", own);
  }
});

test("an overdue backfilled row appended after a fresh row still wakes the lead", async () => {
  monitors(monitor());
  row(T0 - MIN, "p-fresh");
  row(T0 - 20 * MIN, "p-backfilled");
  expect((await leadInboxTick(deps(T0)))[0]).toContain("oldest p-backfilled");
});

test("a row read while unwatched stays heard after compaction before the first baseline", async () => {
  rmSync(join(state.dir, "lead-inbox.json"), { force: true });
  monitors();
  row(T0 - 20 * MIN, "p-unwatched-read");
  const raw = JSON.stringify({ ts: iso(T0 - 20 * MIN), id: "p-unwatched-read", channel_id: "PAIR", scope: "pair-bot", content: "request p-unwatched-read" });
  appendFileSync(transcript, `${JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: raw }] } })}\n`);
  expect(await leadInboxTick(deps(T0))).toEqual([]);
  writeFileSync(transcript, `${JSON.stringify({ type: "session", id: SID, timestamp: iso(T0 - 300 * MIN) })}\n`);
  const out = await leadInboxTick(deps(T0 + 20 * MIN));
  expect(out.some((line) => line.includes("LEAD_INBOX_UNHEARD"))).toBe(false);
  const saved = JSON.parse(readFileSync(join(state.dir, "lead-inbox.json"), "utf8")) as { heardIds?: string[]; baselineDone?: boolean };
  expect(saved.heardIds).toEqual(["p-unwatched-read"]);
  expect(saved.baselineDone).toBeUndefined();
});

test("one SENT in an ambiguous multi-send eval marks neither request heard", async () => {
  monitors(monitor());
  row(T0 - 20 * MIN, "1569430000000000011");
  row(T0 - 19 * MIN, "1569430000000000013");
  appendFileSync(transcript, `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "call-multi", name: "eval", arguments: { code: "await send(dori send --reply 1569430000000000011); await send(dori send --reply 1569430000000000013);" } }] } })}\n`);
  appendFileSync(transcript, `${JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "completion-watcher", content: [{ type: "text", text: "Eval cell call-multi (js) is completed.\nSENT 1569430000000000012 len=40 sha=1234abcd first=\"one succeeded, the other failed\"" }] } })}\n`);
  const out = await leadInboxTick(deps(T0));
  expect(out).toHaveLength(1);
  expect(out[0]).toContain("2 inbox row(s) (pair-bot 2)");
  expect(out[0]).toContain("oldest 1569430000000000011");
});

test("a failed reply followed by a successful nonreply send stays unheard", async () => {
  monitors(monitor());
  row(T0 - 20 * MIN, "1569430000000000021");
  appendFileSync(transcript, `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "call-mixed", name: "eval", arguments: { code: "await send(dori send discord --reply 1569430000000000021); await send(dori send discord --text ordinary);" } }] } })}\n`);
  appendFileSync(transcript, `${JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "completion-watcher", content: [{ type: "text", text: "Eval cell call-mixed (js) is completed.\nSENT 1569430000000000022 len=40 sha=1234abcd first=\"ordinary send succeeded\"" }] } })}\n`);
  expect((await leadInboxTick(deps(T0)))[0]).toContain("oldest 1569430000000000021");
});

// pair-bot rows are information, never requests (setups/discord-aoe/README.md): MooDori's lead hears only those that call it,
// and 121 of 155 pair-bot rows of 2026-11-11 named another Dori, so LEAD_INBOX_UNHEARD named up to 115 rows it never needed.
test("with discord.callNames set, a pair-bot row counts only when it calls this Dori or is another Dori's lead alert", async () => {
  monitors(monitor());
  row(T0 - 20 * MIN, "p-other", { content: "수돌, the review is CLEAR" });
  row(T0 - 19 * MIN, "p-name", { content: "dori, can you check the relay" });
  row(T0 - 18 * MIN, "p-bot", { content: "<@300000000000000003> your lane is done" });
  row(T0 - 17.7 * MIN, "p-voice", { content: "Please listen", transcript: "Dori, check the relay" });
  row(T0 - 17.5 * MIN, "p-bang", { content: "<@!300000000000000003> the old nickname mention form" });
  // lead alerts as the other Dori's sender posts them (its underscores escaped)
  row(T0 - 17 * MIN, "p-alert", { content: discordText("LEAD_RUNAWAY w1:p2 41: send one short check") });
  row(T0 - 16 * MIN, "p-stuck", { content: discordText("LEAD_COMPACTION_STUCK w3:p1 3: its compaction did not complete") });
  const called = (botId: string) => ({ discord: { ...defaultDiscordWords, callNames: ["Dori"], botId } });
  expect((await leadInboxTick(deps(T0, called("300000000000000003"))))[0]).toStartWith(`LEAD_INBOX_UNHEARD ${LEAD} 6 inbox row(s) (pair-bot 6) never reached session ${SID}, oldest p-name`);
  // with no callNames this Dori cannot tell which rows call it: every pair-bot row counts
  expect((await leadInboxTick(deps(T0 + MIN)))[0]).toStartWith(`LEAD_INBOX_UNHEARD ${LEAD} 7 inbox row(s) (pair-bot 7) never reached session ${SID}, oldest p-other`);
  // no discord.botId: the bot id is read from DORI_DISCORD_TOKEN, so a mention of another bot does not call this one
  const saved = process.env["DORI_DISCORD_TOKEN"];
  process.env["DORI_DISCORD_TOKEN"] = `${Buffer.from("300000000000000009").toString("base64")}.x.y`;
  try {
    expect((await leadInboxTick(deps(T0 + 2 * MIN, called(""))))[0]).toStartWith(`LEAD_INBOX_UNHEARD ${LEAD} 4 inbox row(s) (pair-bot 4) never reached session ${SID}, oldest p-name`);
  } finally {
    if (saved === undefined) delete process.env["DORI_DISCORD_TOKEN"];
    else process.env["DORI_DISCORD_TOKEN"] = saved;
  }
});
