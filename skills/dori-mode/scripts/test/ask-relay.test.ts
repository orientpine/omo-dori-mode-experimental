import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AskPlaceInput } from "../src/ask-place.ts";
import { askRelayWarning } from "../src/ask-relay.ts";
import { Registry } from "../src/registry.ts";
import { run } from "../src/run.ts";
import { viaEnvFile, withState } from "./fakes.ts";

const OWNER = "42", THREAD = "300000000000000003";
const original = "https://discord.com/channels/100/500/777000000000000001";
const relayLink = "https://discord.com/channels/100/600/777000000000000002";
const now = Date.now();
const owner = { id: "777000000000000001", channel_id: "500", author_id: OWNER, scope: "channel", ts: new Date(now - 3600_000).toISOString(), content: "Do the task" };
const relay = { id: "777000000000000002", channel_id: "600", author_id: "99", scope: "pair-bot", ts: new Date(now - 1800_000).toISOString(), content: `Delegated scope: implement the fix. Owner original: ${original}` };
const card = `Confirm I should proceed with this task? ${original}`;
const fixture = () => {
  const state = withState();
  const inbox = join(state.dir, "inbox.jsonl");
  const brief = join(state.dir, "brief.md");
  const lane = { key: "relay-task", title: "relay task", thread: `discord:${THREAD}`, pane: "relay-pane", session: "relay-session", brief, done: "file /etc/hostname", openedAt: new Date(now).toISOString() };
  const writeRows = (rows: readonly unknown[]) => writeFileSync(inbox, rows.map((r) => typeof r === "string" ? r : JSON.stringify(r)).join("\n"));
  writeRows([owner, relay]);
  writeFileSync(brief, `Work delegated in ${relayLink}`);
  const input: AskPlaceInput = { here: "", tmux: "relay-pane", lanes: [lane], threads: {}, inbox, owner: OWNER };
  return { ...state, input, lane, writeRows, brief };
};
const place = { kind: "thread" as const, thread: THREAD };

test("a fresh authenticated owner mention in another Dori's channel relayed through pair warns", () => {
  const s = fixture();
  try {
    const crossOriginal = original.replace("/500/", "/700/");
    s.writeRows([
      { ...owner, channel_id: "700", scope: "mention", content: "<@123> Do the task" },
      { ...relay, content: `Delegated scope: implement the fix. Owner original: ${crossOriginal}` },
    ]);
    expect(askRelayWarning(s.input, place, "Confirm I should proceed with this task?", now)).toContain("ASK_RELAY_RECHECK");
  } finally { s.done(); }
});

test("a mention original from another author is still silent", () => {
  const s = fixture();
  try {
    s.writeRows([{ ...owner, author_id: "88", scope: "mention" }, relay]);
    expect(askRelayWarning(s.input, place, card, now)).toBeUndefined();
  } finally { s.done(); }
});

test("warns on a linked fresh owner original or linked relay, including the asking lane's brief", () => {
  const s = fixture();
  try {
    for (const text of [card, `Approve this task? ${relayLink}`, "Should I proceed with this task?"]) {
      expect(askRelayWarning(s.input, place, text, now)).toContain("ASK_RELAY_RECHECK ask:");
      expect(askRelayWarning(s.input, place, text, now)).toContain("(directive pair-owner-relay; a warning for now, refusal to be reviewed on 2026-12-01)");
    }
  } finally { s.done(); }
});

for (const [name, change] of [
  ["older than 24h", { ...owner, ts: new Date(now - 24 * 3600_000).toISOString() }],
  ["future original", { ...owner, ts: new Date(now + 1000).toISOString() }],
  ["unknown author", { ...owner, author_id: "88" }],
  ["wrong channel", { ...owner, channel_id: "999" }],
  ["bad timestamp", { ...owner, ts: "bad" }],
] as const) {
  test(`silent with ${name}`, () => {
    const s = fixture();
    try { s.writeRows([change, relay]); expect(askRelayWarning(s.input, place, card, now)).toBeUndefined(); }
    finally { s.done(); }
  });
}

test("silent with missing original, non-pair relay, missing delegation, or malformed inbox rows", () => {
  const s = fixture();
  try {
    for (const rows of [[relay], [owner, { ...relay, scope: "thread" }], [owner, { ...relay, content: original }], ["{bad", null, 3, { id: "x" }]]) {
      s.writeRows(rows);
      expect(askRelayWarning(s.input, place, card, now)).toBeUndefined();
    }
    s.writeRows(["{bad", owner, relay]);
    expect(askRelayWarning(s.input, place, card, now)).toContain("ASK_RELAY_RECHECK");
  } finally { s.done(); }
});

test("silent for unrelated links, another thread's brief, unknown caller, and ordinary questions", () => {
  const s = fixture();
  try {
    expect(askRelayWarning(s.input, { kind: "thread", thread: "999" }, "Approve this task?", now)).toBeUndefined();
    expect(askRelayWarning({ ...s.input, tmux: "another-pane" }, place, "Approve this task?", now)).toBeUndefined();
    expect(askRelayWarning(s.input, place, `Which color? ${original}`, now)).toBeUndefined();
    writeFileSync(s.brief, "unrelated work");
    expect(askRelayWarning(s.input, place, "Approve this task? https://discord.com/channels/100/500/888", now)).toBeUndefined();
  } finally { s.done(); }
});

for (const text of ["Approve sending the mail?", "Approve sharing this document?", "Approve inviting this user?", "메일 발송 승인", "공유 승인", "초대 승인"]) {
  test(`outward approval passes: ${text}`, () => {
    const s = fixture();
    try { expect(askRelayWarning(s.input, place, `${text} ${original}`, now)).toBeUndefined(); }
    finally { s.done(); }
  });
}

test("real ask CLI warns for a relayed cross-Dori owner mention; clean outward card posts without warning", async () => {
  const s = fixture();
  try {
    const crossOriginal = original.replace("/500/", "/700/");
    s.writeRows([
      { ...owner, channel_id: "700", scope: "mention", content: "<@123> Do the task" },
      { ...relay, content: `Delegated scope: implement the fix. Owner original: ${crossOriginal}` },
    ]);
    await new Registry(s.dir).write(s.lane);
    const http = join(s.dir, "http.json"), log = join(s.dir, "watch.log");
    writeFileSync(join(s.dir, "config.json"), JSON.stringify({ stateDir: s.dir, watchLog: log }));
    const cli = async (text: string) => run(viaEnvFile(["env", "-u", "TMUX", "-u", "HERDR_PANE_ID", "-u", "HC_TERMINAL_ID",
      `DORI_CONFIG=${join(s.dir, "config.json")}`, `DORI_STATE_DIR=${s.dir}`, `DORI_ENV_FILE=${join(s.dir, "fake.env")}`,
      "DORI_DISCORD_TOKEN=fake", `DORI_TEST_HTTP=${http}`, "DORI_DISCORD_CHANNEL=500", `DORI_DISCORD_OWNER=${OWNER}`,
      `DORI_DISCORD_INBOX=${s.input.inbox}`, "bun", "--preload", join(import.meta.dir, "discord-cli-fake.ts"), join(import.meta.dir, "../src/cli.ts"),
      "ask", "--tmux", "relay-pane", "--text", text, "--option", "Approve", "--option", "Wait"]));
    const warned = await cli("Confirm I should proceed with this task?");
    expect(warned.code).toBe(0);
    expect(warned.err).toContain("ASK_RELAY_RECHECK ask:");
    expect(warned.err).toContain("(directive pair-owner-relay; a warning for now, refusal to be reviewed on 2026-12-01)");
    expect(readFileSync(log, "utf8")).toContain(" ask ASK_RELAY_RECHECK ask:");
    expect(warned.out).toContain("ASKED Q1 message=900");
    const clean = await cli("Approve sending the mail?");
    expect(clean.code).toBe(0);
    expect(clean.err).not.toContain("ASK_RELAY_RECHECK");
    expect(clean.out).toContain("ASKED Q2 message=900");
    expect(existsSync(http)).toBe(true);
    const calls = JSON.parse(readFileSync(http, "utf8")).calls as { method: string; path: string }[];
    expect(calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages"))).toHaveLength(2);
  } finally { s.done(); }
}, 30_000);
