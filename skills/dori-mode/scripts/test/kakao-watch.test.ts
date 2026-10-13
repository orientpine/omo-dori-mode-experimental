import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loginArgv, phoneLogin, readAccount } from "../../setups/discord-aoe/kakao-login.ts";
import { kakaoOptions, kakaoTick, loadKakaoState, type KakaoOptions } from "../../setups/discord-aoe/kakao-watch.ts";
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

// A fake agent-messenger behind flock: message list serves msgs[room], chat list serves chats, mark-read fails while
// failMarks[room] is above 0.
const fakeKakao = (msgs: Record<string, Msg[]>, chats: object[] = [], failMarks: Record<string, number> = {}) => {
  const calls: string[][] = [];
  const runner: Runner = async (argv) => {
    calls.push([...argv]);
    const [, , , , cmd, sub, room] = argv;
    if (cmd === "chat") return { code: 0, out: JSON.stringify(chats), err: "" };
    if (sub === "list") return { code: 0, out: JSON.stringify(msgs[room ?? ""] ?? []), err: "" };
    if ((failMarks[room ?? ""] ?? 0) > 0) {
      failMarks[room ?? ""] = (failMarks[room ?? ""] ?? 0) - 1;
      return { code: 1, out: "", err: "NOTIREAD failed" };
    }
    return { code: 0, out: '{"success":true}', err: "" };
  };
  const marks = () => calls.filter((c) => c[5] === "mark-read").map((c) => `${c[6]} ${c[7]}`);
  return { calls, runner, marks };
};

const ticker = (o: KakaoOptions, runner: Runner) => {
  let t = 0;
  const lines: string[] = [];
  const state = loadKakaoState(o, t);
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
  expect(k.calls.find((c) => c[5] === "mark-read")).toEqual(["flock", o.lock, "agent-messenger", "kakaotalk", "message", "mark-read", "100", "7"]);
  expect([json(o.cursors), json(o.marked)]).toEqual([{ "100": "7" }, { "100": "7" }]);
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
    "KAKAO_MARKREAD_OK R 6 after 2 failed",
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

test("a sweep marks again a room chat list shows unread and a room with recent messages, not an idle one", async () => {
  const o = setup({ rooms: { A: { id: "100" }, B: { id: "200" }, C: { id: "300" } }, cursors: { "100": "5", "200": "9", "300": "3" }, marked: { "100": "5", "200": "9", "300": "3" } });
  const chats = [{ chat_id: "200", display_name: "B", unread_count: 2 }];
  const k = fakeKakao({ "100": [msg("5", 2, "old"), msg("6", 2, "new")], "200": [msg("9", 2, "read")], "300": [msg("3", 2, "idle")] }, chats);
  const w = ticker(o, k.runner);
  await w.at(0);
  await w.at(30_000);
  expect(k.marks()).toEqual(["100 6"]);
  await w.at(60_000);
  expect(k.marks()).toEqual(["100 6", "100 6", "200 9"]);
  chats.length = 0;
  await w.at(6 * 60_000 + 1);
  expect(k.marks()).toEqual(["100 6", "100 6", "200 9"]);
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
  expect([once.code, once.out.trim().split("\n").map((l) => l.replace(/^\S+Z /, ""))]).toEqual([0, ["KAKAO_MSG R 6 2: new", "KAKAO_MARKREAD_OK R 6", "KAKAO_WATCH_ONCE"]]);
  expect(readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n")).toEqual(["kakaotalk chat list --all", "kakaotalk message list 100 -n 15", "kakaotalk message mark-read 100 6"]);
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
