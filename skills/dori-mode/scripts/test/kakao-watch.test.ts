import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loginArgv, phoneLogin, readAccount } from "../../setups/discord-aoe/kakao-login.ts";
import { kakaoOptions, kakaoTick, loadKakaoState, markReadConfirmed, type KakaoOptions, type KakaoSession, type OpenSession } from "../../setups/discord-aoe/kakao-watch.ts";
import type { Runner } from "../src/run.ts";

const SETUP = join(import.meta.dir, "..", "..", "setups", "discord-aoe");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "kakao-watch-"));
  dirs.push(dir);
  return dir;
};
const msg = (log_id: string, author_id: number, message: string) => ({ log_id, author_id, author_name: `u${author_id}`, message, sent_at: 0 });
type Msg = ReturnType<typeof msg>;

const setup = (files: { rooms?: object; cursors?: object; marked?: object }, env: Record<string, string> = {}) => {
  const dir = scratch();
  const o = kakaoOptions({ DORI_KAKAO_STATE_DIR: dir, DORI_KAKAO_INBOX: join(dir, "inbox.jsonl"), DORI_KAKAO_SELF_ID: "9", DORI_KAKAO_OWNER_ID: "1", DORI_KAKAO_MENTION: "dori", DORI_KAKAO_POLL_MS: "1000", DORI_KAKAO_SWEEP_MS: "60000", ...env });
  if (files.rooms) writeFileSync(o.rooms, JSON.stringify(files.rooms));
  if (files.cursors) writeFileSync(o.cursors, JSON.stringify(files.cursors));
  if (files.marked) writeFileSync(o.marked, JSON.stringify(files.marked));
  return o;
};

// A fake agent-messenger behind flock: message list serves msgs[room], chat list serves chats. The one-session mark
// (--mark-read) fails while failMarks[room] is above 0; while ignored[room] is above 0 the server acks it and keeps its
// read mark where it was ("0" before any applied mark). A room in types answers as that room type and marks nothing.
const fakeKakao = (msgs: Record<string, Msg[]>, chats: object[] = [], failMarks: Record<string, number> = {}, ignored: Record<string, number> = {}, types: Record<string, string> = {}) => {
  const calls: string[][] = [];
  const server: Record<string, string> = {};
  const runner: Runner = async (argv) => {
    calls.push([...argv]);
    if (argv[4] === "--mark-read") {
      const room = argv[5] ?? "";
      if ((failMarks[room] ?? 0) > 0) {
        failMarks[room] = (failMarks[room] ?? 0) - 1;
        return { code: 1, out: "", err: "NOTIREAD failed" };
      }
      if (types[room]) return { code: 0, out: JSON.stringify({ status: 0, watermark: server[room] ?? "0", type: types[room] }), err: "" };
      if ((ignored[room] ?? 0) > 0) ignored[room] = (ignored[room] ?? 0) - 1;
      else server[room] = argv[6] ?? "";
      return { code: 0, out: JSON.stringify({ status: 0, watermark: server[room] ?? "0" }), err: "" };
    }
    const [, , , , cmd, sub, room] = argv;
    if (cmd === "chat") return { code: 0, out: JSON.stringify(chats), err: "" };
    if (sub === "list") return { code: 0, out: JSON.stringify(msgs[room ?? ""] ?? []), err: "" };
    return { code: 0, out: '{"success":true}', err: "" };
  };
  const marks = () => calls.filter((c) => c[4] === "--mark-read").map((c) => `${c[5]} ${c[6]}`);
  return { calls, runner, marks };
};

const ticker = (o: KakaoOptions, runner: Runner) => {
  let t = 0;
  const lines: string[] = [];
  const state = loadKakaoState(o);
  return {
    state,
    lines,
    at: async (ms: number) => {
      t = ms;
      await kakaoTick(o, state, runner, () => t, (l) => lines.push(l));
    },
  };
};
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const inbox = (o: KakaoOptions) => (existsSync(o.inbox) ? readFileSync(o.inbox, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);

test("Kakao watcher environment sets ids, mention, paths and intervals; nothing set leaves it off", () => {
  expect(kakaoOptions({ DORI_KAKAO_SELF_ID: "9", DORI_KAKAO_OWNER_ID: "1", DORI_KAKAO_STATE_DIR: "/s", DORI_KAKAO_INBOX: "/i", DORI_KAKAO_CLI: "/bin/am", DORI_KAKAO_POLL_MS: "5", DORI_KAKAO_SWEEP_MS: "6", DORI_KAKAO_DISCOVER_MS: "7" })).toEqual({
    self: "9",
    owner: "1",
    mention: null,
    cli: "/bin/am",
    lock: "/s/kakao.lock",
    rooms: "/s/kakao-rooms.json",
    cursors: "/s/kakao-cursors.json",
    marked: "/s/kakao-markread.json",
    gaveUp: "/s/kakao-markread-giveup.json",
    inbox: "/i",
    pollMs: 5,
    sweepMs: 6,
    discoverMs: 7,
  });
  const off = kakaoOptions({ DORI_STATE_DIR: "/st", DORI_DISCORD_INBOX: "/d/inbox.jsonl" });
  expect([off.self, off.cli, off.rooms, off.inbox, off.pollMs, off.sweepMs, off.discoverMs]).toEqual(["", "agent-messenger", "/st/kakao-rooms.json", "/d/inbox.jsonl", 8000, 300000, 20000]);
});

test("a new message goes to the inbox and the monitor, own messages do not, and the room is marked read under the lock", async () => {
  const o = setup({ rooms: { R: { id: "100" } }, cursors: { "100": "5" }, marked: { "100": "5" } });
  const k = fakeKakao({ "100": [msg("5", 2, "old"), msg("6", 1, "hi dori"), msg("7", 9, "my reply")] });
  const w = ticker(o, k.runner);
  await w.at(0);
  expect(inbox(o).map((r) => [r.id, r.author_kind, r.mentions_self, r.scope])).toEqual([["6", "owner", true, "kakao"]]);
  expect(w.lines.filter((l) => l.startsWith("KAKAO_MSG"))).toEqual(["KAKAO_MSG R 6 u1: hi dori"]);
  expect(k.calls.find((c) => c[4] === "--mark-read")).toEqual(["flock", o.lock, process.execPath, join(SETUP, "kakao-watch.ts"), "--mark-read", "100", "7", "5"]);
  expect([json(o.cursors), json(o.marked)]).toEqual([{ "100": "7" }, { "100": "7" }]);
});

test("a mark-read the server acks but does not apply fails with the server's read mark and is retried until the read-back reaches the target", async () => {
  const o = setup({ rooms: { R: { id: "100" } }, cursors: { "100": "5" }, marked: { "100": "5" } });
  const k = fakeKakao({ "100": [msg("5", 2, "old"), msg("6", 1, "hi")] }, [], {}, { "100": 1 });
  const w = ticker(o, k.runner);
  await w.at(0);
  expect(json(o.marked)).toEqual({ "100": "5" });
  await w.at(1000);
  expect(k.marks()).toEqual(["100 6", "100 6"]);
  expect(w.lines.filter((l) => l.startsWith("KAKAO_MARKREAD"))).toEqual([
    "KAKAO_MARKREAD_FAIL R 6 attempt 1, retry in 1s: server read mark 0 is behind 6",
    "KAKAO_MARKREAD_OK R 6 server 6 after 1 failed",
  ]);
  expect(json(o.marked)).toEqual({ "100": "6" });
});

test("a mark reads the server's read mark, syncs from it and marks in a fresh session, and reads the mark back in another", async () => {
  const sessions: string[][] = [];
  let server = "4";
  let applies = true;
  // Each session records its packets; the server moves the account's read mark only when NOTIREAD applies.
  const open: OpenSession = async (fn) => {
    const calls: string[] = [];
    sessions.push(calls);
    return fn({
      syncMessages: async (c, n, cur, max) => (calls.push(`SYNCMSG ${c} ${n} ${cur} ${max}`), { statusCode: 0, body: {} }),
      markRead: async (c, wm) => (calls.push(`NOTIREAD ${c} ${wm}`), applies && (server = String(wm)), { statusCode: 0, body: { status: 0 } }),
      getChatInfo: async (c) => (calls.push(`CHATONROOM ${c}`), { statusCode: 0, body: { a: [1, 9], w: ["8", server] } }),
      getChannelInfo: async (c) => (calls.push(`CHATINFO ${c}`), { statusCode: 0, body: { chatInfo: { li: 0 } } }),
    });
  };
  expect(await markReadConfirmed(open, String, "100", "7", "5", "9")).toEqual({ status: 0, watermark: "7" });
  expect(sessions.splice(0)).toEqual([["CHATONROOM 100"], ["SYNCMSG 100 80 4 7", "NOTIREAD 100 7"], ["CHATONROOM 100"]]);
  applies = false;
  expect(await markReadConfirmed(open, String, "100", "8", "5", "9")).toEqual({ status: 0, watermark: "7" });
  expect(sessions.splice(0)).toEqual([["CHATONROOM 100"], ["SYNCMSG 100 80 7 8", "NOTIREAD 100 8"], ["CHATONROOM 100"]]);
  expect(await markReadConfirmed(open, String, "100", "6", "5", "9")).toEqual({ status: 0, watermark: "7" });
  expect(sessions.splice(0)).toEqual([["CHATONROOM 100"]]);
  expect(await markReadConfirmed(open, String, "100", "8", "5", "2")).toEqual({ status: 0, watermark: null });
  expect(sessions.splice(0)[1]).toEqual(["SYNCMSG 100 80 5 8", "NOTIREAD 100 8"]);
});

test("a mark in a room of a type the server keeps no read mark in (a KakaoTalk channel) reads the type and sends no SYNCMSG or NOTIREAD", async () => {
  const sessions: string[][] = [];
  const open: OpenSession = async (fn) => {
    const calls: string[] = [];
    sessions.push(calls);
    const session: KakaoSession = {
      syncMessages: async (c) => (calls.push(`SYNCMSG ${c}`), { statusCode: 0, body: {} }),
      markRead: async (c) => (calls.push(`NOTIREAD ${c}`), { statusCode: 0, body: { status: 0 } }),
      getChatInfo: async (c) => (calls.push(`CHATONROOM ${c}`), { statusCode: 0, body: { t: "PlusChat", a: [1, 9], w: ["3", "4"] } }),
      getChannelInfo: async (c) => (calls.push(`CHATINFO ${c}`), { statusCode: 0, body: {} }),
    };
    return fn(session);
  };
  expect(await markReadConfirmed(open, String, "100", "7", "5", "9")).toEqual({ status: 0, watermark: "4", type: "PlusChat" });
  expect(sessions).toEqual([["CHATONROOM 100"]]);
});

test("a mark in an open chat sends the room's link id from CHATINFO with NOTIREAD; without one it fails and marks nothing", async () => {
  const sessions: string[][] = [];
  let server = "4";
  let li: unknown = { low: 77777, high: 1 };
  // The server applies a NOTIREAD in an open chat only when it carries the room's link id.
  const open: OpenSession = async (fn) => {
    const calls: string[] = [];
    sessions.push(calls);
    return fn({
      syncMessages: async (c, n, cur, max) => (calls.push(`SYNCMSG ${c} ${n} ${cur} ${max}`), { statusCode: 0, body: {} }),
      markRead: async (c, wm, link) => (calls.push(`NOTIREAD ${c} ${wm} li ${link}`), link !== undefined && (server = String(wm)), { statusCode: 0, body: { status: link === undefined ? -1 : 0 } }),
      getChatInfo: async (c) => (calls.push(`CHATONROOM ${c}`), { statusCode: 0, body: { t: "OM", a: [1, 9], w: ["8", server] } }),
      getChannelInfo: async (c) => (calls.push(`CHATINFO ${c}`), { statusCode: 0, body: { chatInfo: { chatId: 100, li } } }),
    });
  };
  expect(await markReadConfirmed(open, String, "100", "7", "5", "9")).toEqual({ status: 0, watermark: "7" });
  expect(sessions.splice(0)).toEqual([["CHATONROOM 100"], ["CHATINFO 100", "SYNCMSG 100 80 4 7", "NOTIREAD 100 7 li 4295045073"], ["CHATONROOM 100"]]);
  li = 0;
  await expect(markReadConfirmed(open, String, "100", "8", "5", "9")).rejects.toThrow("CHATINFO gave no link id for open chat 100");
  expect(sessions.splice(0)).toEqual([["CHATONROOM 100"], ["CHATINFO 100"]]);
});

test("a channel room is never marked read: once its type is known (from the mark or from chat list) it gets one SKIP line, its messages still come in, other rooms are marked", async () => {
  const o = setup({ rooms: { R: { id: "100" }, S: { id: "300" } }, cursors: { "100": "5", "300": "5" }, marked: { "100": "5", "300": "5" } });
  const sys = [msg("5", 4, "old"), msg("6", 4, "notice")];
  const chats: object[] = [];
  const k = fakeKakao({ "100": [msg("5", 2, "old"), msg("6", 2, "new")], "300": sys, "400": [msg("8", 4, "x")] }, chats, {}, {}, { "300": "PlusChat" });
  const w = ticker(o, k.runner);
  await w.at(0);
  expect(k.marks()).toEqual(["100 6", "300 6"]);
  expect(w.lines.filter((l) => l.startsWith("KAKAO_MARKREAD"))).toEqual([
    "KAKAO_MARKREAD_OK R 6 server 6",
    "KAKAO_MARKREAD_SKIP S 300 PlusChat: the server keeps no read mark in this room type, it is not marked read",
  ]);
  sys.push(msg("7", 4, "another notice"));
  chats.push({ chat_id: "300", display_name: "S", type: "PlusChat", unread_count: 1 }, { chat_id: "400", display_name: "Channel", type: "PlusChat", unread_count: 1 });
  await w.at(30_000);
  await w.at(60_000);
  await w.at(10 * 60_000);
  expect(k.marks().filter((m) => !m.startsWith("100 "))).toEqual(["300 6"]);
  expect(inbox(o).map((r) => [r.room, r.id])).toEqual([["R", "6"], ["S", "6"], ["S", "7"]]);
  expect(json(o.rooms)).toEqual({ R: { id: "100" }, S: { id: "300", type: "PlusChat" }, Channel: { id: "400", type: "PlusChat" } });
  expect(w.lines.filter((l) => l.startsWith("KAKAO_MARKREAD_SKIP"))).toHaveLength(2);
  expect(w.lines.filter((l) => l.startsWith("KAKAO_MARKREAD_FAIL"))).toEqual([]);
});

test("a mark that keeps failing gives up after five tries with one GIVEUP line, stays quiet through sweeps and a restart, and starts over at a newer message", async () => {
  const o = setup({ rooms: { R: { id: "100" } }, cursors: { "100": "5" }, marked: { "100": "5" } });
  const msgs = [msg("5", 2, "old"), msg("6", 2, "new")];
  const failMarks = { "100": 99 };
  const k = fakeKakao({ "100": msgs }, [], failMarks);
  const w = ticker(o, k.runner);
  for (const t of [0, 1000, 3000, 7000, 15_000, 16_000, 60_000, 120_000, 600_000]) await w.at(t);
  expect(k.marks()).toEqual(["100 6", "100 6", "100 6", "100 6", "100 6"]);
  expect(w.lines.filter((l) => l.startsWith("KAKAO_MARKREAD"))).toEqual([
    "KAKAO_MARKREAD_FAIL R 6 attempt 1, retry in 1s: NOTIREAD failed",
    "KAKAO_MARKREAD_FAIL R 6 attempt 2, retry in 2s: NOTIREAD failed",
    "KAKAO_MARKREAD_FAIL R 6 attempt 3, retry in 4s: NOTIREAD failed",
    "KAKAO_MARKREAD_FAIL R 6 attempt 4, retry in 8s: NOTIREAD failed",
    "KAKAO_MARKREAD_GIVEUP R 6 after 5 failed, not marked again until a newer message: NOTIREAD failed",
  ]);
  expect(json(o.gaveUp)).toEqual({ "100": "6" });
  const restarted = ticker(o, k.runner);
  await restarted.at(700_000);
  expect(k.marks()).toHaveLength(5);
  failMarks["100"] = 0;
  msgs.push(msg("7", 2, "newer"));
  await restarted.at(701_000);
  expect(k.marks().slice(5)).toEqual(["100 7"]);
  expect(restarted.lines.filter((l) => l.startsWith("KAKAO_MARKREAD"))).toEqual(["KAKAO_MARKREAD_OK R 7 server 7"]);
  expect([json(o.marked), json(o.gaveUp)]).toEqual([{ "100": "7" }, {}]);
});

test("a failed mark-read waits out its backoff, is retried, and the marked id catches up with the cursor", async () => {
  const o = setup({ rooms: { R: { id: "100" } }, cursors: { "100": "5" }, marked: { "100": "5" } });
  const k = fakeKakao({ "100": [msg("5", 2, "old"), msg("6", 2, "new")] }, [], { "100": 2 });
  const w = ticker(o, k.runner);
  await w.at(0);
  await w.at(500);
  expect(k.marks()).toEqual(["100 6"]);
  await w.at(1000);
  await w.at(2500);
  await w.at(3000);
  expect(k.marks()).toEqual(["100 6", "100 6", "100 6"]);
  expect(w.lines.filter((l) => l.startsWith("KAKAO_MARKREAD"))).toEqual([
    "KAKAO_MARKREAD_FAIL R 6 attempt 1, retry in 1s: NOTIREAD failed",
    "KAKAO_MARKREAD_FAIL R 6 attempt 2, retry in 2s: NOTIREAD failed",
    "KAKAO_MARKREAD_OK R 6 server 6 after 2 failed",
  ]);
  expect(json(o.marked)).toEqual({ "100": "6" });
  expect(inbox(o)).toHaveLength(1);
});

test("a mark-read still pending when the watcher restarts is retried without taking the message in again", async () => {
  const o = setup({ rooms: { R: { id: "100" } }, cursors: { "100": "6" }, marked: { "100": "5" } });
  const k = fakeKakao({ "100": [msg("5", 2, "old"), msg("6", 2, "new")] });
  const w = ticker(o, k.runner);
  await w.at(0);
  expect([k.marks(), inbox(o), json(o.marked)]).toEqual([["100 6"], [], { "100": "6" }]);
});

test("every room is marked once at start; later sweeps mark again a room chat list shows unread and a room with recent messages, not an idle one", async () => {
  const o = setup({ rooms: { A: { id: "100" }, B: { id: "200" }, C: { id: "300" } }, cursors: { "100": "5", "200": "9", "300": "3" }, marked: { "100": "5", "200": "9", "300": "3" } });
  const chats = [{ chat_id: "200", display_name: "B", unread_count: 2 }];
  const k = fakeKakao({ "100": [msg("5", 2, "old"), msg("6", 2, "new")], "200": [msg("9", 2, "read")], "300": [msg("3", 2, "idle")] }, chats);
  const w = ticker(o, k.runner);
  await w.at(0);
  await w.at(30_000);
  expect(k.marks()).toEqual(["100 6", "200 9", "300 3"]);
  await w.at(60_000);
  expect(k.marks()).toEqual(["100 6", "200 9", "300 3", "100 6", "200 9"]);
  chats.length = 0;
  await w.at(6 * 60_000 + 1);
  expect(k.marks()).toEqual(["100 6", "200 9", "300 3", "100 6", "200 9"]);
});

test("a room seen for the first time starts at its newest message, unmarked backlog untouched; a new chat is added", async () => {
  const o = setup({ rooms: { R: { id: "100" } } });
  const k = fakeKakao({ "100": [msg("4", 2, "backlog")], "200": [msg("8", 2, "x")] }, [{ chat_id: "200", display_name: "New room" }]);
  const w = ticker(o, k.runner);
  await w.at(0);
  expect([k.marks(), inbox(o), json(o.cursors), json(o.marked), json(o.rooms)]).toEqual([[], [], { "100": "4", "200": "8" }, { "100": "4", "200": "8" }, { R: { id: "100" }, "New room": { id: "200" } }]);
  expect(w.lines).toEqual(["KAKAO_NEW_ROOM New room 200", "KAKAO_CURSOR_INIT R 4", "KAKAO_CURSOR_INIT New room 8"]);
});

const fakeCli = (dir: string) => {
  const cli = join(dir, "agent-messenger");
  writeFileSync(
    cli,
    `#!/bin/sh
echo "$*" >> "${dir}/calls.log"
case "$2 $3" in
  "chat list") echo "[]" ;;
  "message list") echo '[{"log_id":"5","author_id":2,"message":"old","sent_at":0},{"log_id":"6","author_id":2,"message":"new","sent_at":0}]' ;;
  "auth login") cat "$7" > "${dir}/seen-password"; exit 3 ;;
  *) echo '{"success":true}' ;;
esac
`,
  );
  chmodSync(cli, 0o755);
  // The SDK beside the CLI script, as in the agent-messenger package: the one-session mark logs its packets.
  const sdk = join(realpathSync(dir), "platforms", "kakaotalk");
  mkdirSync(sdk, { recursive: true });
  writeFileSync(
    join(sdk, "index.js"),
    `import { appendFileSync } from "node:fs";
const log = (line) => appendFileSync(${JSON.stringify(join(dir, "calls.log"))}, line + "\\n");
export const Long = { fromString: (s) => s };
let mark = "4";
const session = {
  syncMessages: async (c, n, cur, max) => (log("sdk SYNCMSG " + c + " " + cur + " " + max), { statusCode: 0, body: {} }),
  markRead: async (c, w) => (log("sdk NOTIREAD " + c + " " + w), (mark = w), { statusCode: 0, body: { status: 0 } }),
  getChatInfo: async (c) => (log("sdk CHATONROOM " + c), { statusCode: 0, body: { a: [9], w: [mark] } }),
};
export class KakaoTalkClient {
  async login() { log("sdk login"); }
  async executeWithReconnect(op) { return op({ session }); }
  close() { log("sdk close"); }
}
`,
  );
  return cli;
};
const runScript = async (script: string, args: string[], env: Record<string, string>, cwd: string) => {
  const p = Bun.spawn(["bun", join(SETUP, script), ...args], { cwd, env: { PATH: process.env.PATH ?? "", HOME: cwd, DORI_ENV_FILE: join(cwd, "none.env"), ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
};

test("the script stays off without a Kakao id and runs one tick through flock with --once", async () => {
  const dir = scratch();
  const off = await runScript("kakao-watch.ts", [], {}, dir);
  expect([off.code, off.out.trim()]).toEqual([0, "KAKAO_WATCH_OFF DORI_KAKAO_SELF_ID is not set"]);
  writeFileSync(join(dir, "kakao-rooms.json"), JSON.stringify({ R: { id: "100" } }));
  writeFileSync(join(dir, "kakao-cursors.json"), JSON.stringify({ "100": "5" }));
  const env = { DORI_KAKAO_SELF_ID: "9", DORI_KAKAO_STATE_DIR: dir, DORI_KAKAO_INBOX: join(dir, "inbox.jsonl"), DORI_KAKAO_CLI: fakeCli(dir) };
  const once = await runScript("kakao-watch.ts", ["--once"], env, dir);
  expect([once.code, once.out.trim().split("\n").map((l) => l.replace(/^\S+Z /, ""))]).toEqual([0, ["KAKAO_MSG R 6 2: new", "KAKAO_MARKREAD_OK R 6 server 6", "KAKAO_WATCH_ONCE"]]);
  expect(readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n")).toEqual([
    "kakaotalk chat list --all",
    "kakaotalk message list 100 -n 15",
    "sdk login",
    "sdk CHATONROOM 100",
    "sdk close",
    "sdk login",
    "sdk SYNCMSG 100 4 6",
    "sdk NOTIREAD 100 6",
    "sdk close",
    "sdk login",
    "sdk CHATONROOM 100",
    "sdk close",
  ]);
  expect(existsSync(join(dir, "kakao.lock"))).toBe(true);
});

test("login reads the account file, formats a phone login, and hands the password over only in a file it removes", async () => {
  expect(readAccount("# KAKAO_PASSWORD=old\nKAKAO_EMAIL=010-1234-5678\nKAKAO_PASSWORD='p w'\n")).toEqual({ login: "010-1234-5678", password: "p w" });
  expect(phoneLogin("010-1234-5678", "82")).toBe("+82 1012345678");
  expect(loginArgv("/l", "am", "a@b", "/p", "tablet")).toEqual(["flock", "/l", "am", "kakaotalk", "auth", "login", "--email", "a@b", "--password-file", "/p", "--device-type", "tablet", "--pretty"]);
  const dir = scratch();
  writeFileSync(join(dir, "kakao.env"), "KAKAO_EMAIL=010-1234-5678\nKAKAO_PASSWORD=secret\n");
  const r = await runScript("kakao-login.ts", ["--phone", "82"], { DORI_KAKAO_STATE_DIR: dir, DORI_KAKAO_ACCOUNT_FILE: join(dir, "kakao.env"), DORI_KAKAO_CLI: fakeCli(dir), TMPDIR: dir }, dir);
  expect([r.code, r.out.trim(), readFileSync(join(dir, "seen-password"), "utf8")]).toEqual([3, "KAKAO_LOGIN_EXIT 3", "secret"]);
  expect(readFileSync(join(dir, "calls.log"), "utf8").trim()).toMatch(/^kakaotalk auth login --email \+82 1012345678 --password-file \S+\/password --device-type tablet --pretty$/);
  expect(readFileSync(join(dir, "calls.log"), "utf8")).not.toContain("secret");
  expect([...new Bun.Glob("kakao-login-*").scanSync({ cwd: dir, onlyFiles: false })]).toEqual([]);
});
