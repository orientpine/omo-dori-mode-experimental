#!/usr/bin/env bun
// KakaoTalk watcher for a Dori with its own Kakao account (agent-messenger kakaotalk). Off unless DORI_KAKAO_SELF_ID is set.
// Polls every known room, appends new messages to the inbox, prints one KAKAO_MSG line each for the lead's monitor and
// marks them read. --once performs one tick and exits; --mark-read <chat> <log id> is the one-session mark a tick runs.
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { envFilePath, loadEnvFile, resolveInstance } from "../../scripts/src/config.ts";
import { run, type Ran, type Runner } from "../../scripts/src/run.ts";

export type KakaoOptions = {
  readonly self: string;
  readonly owner: string;
  readonly mention: RegExp | null;
  readonly cli: string;
  readonly lock: string;
  readonly rooms: string;
  readonly cursors: string;
  readonly marked: string;
  readonly gaveUp: string;
  readonly inbox: string;
  readonly pollMs: number;
  readonly sweepMs: number;
  readonly discoverMs: number;
};
// cursors: newest log id taken into the inbox; marked: newest log id a mark-read succeeded for. They differ while a
// mark-read is pending, failed (retried at retryAt, backing off) or re-armed by a sweep. gaveUp: the log id whose mark
// failed MARKREAD_TRIES times; that room is not marked again until a newer message moves its cursor.
export type KakaoState = {
  rooms: Record<string, { id: string; type?: string }>;
  cursors: Record<string, string>;
  marked: Record<string, string>;
  gaveUp: Record<string, string>;
  fails: Record<string, number>;
  retryAt: Record<string, number>;
  advancedAt: Record<string, number>;
  unread: Set<string>;
  lastSweep: number;
  lastDiscover: number;
};
type KMsg = { log_id: string; author_id: number | string; author_name?: string; message: string; sent_at: number };
type KChat = { chat_id: string; type?: string | number; display_name?: string; unread_count?: number };

// Room types whose read mark the server does not move. A PlusChat is a KakaoTalk channel (the "카카오계정" room the
// account's notices arrive in): synced and marked like any room, the account's read mark there stayed where it was, so
// such a room is never marked read. The type comes from chat list or from CHATONROOM, never from a room id.
export const NO_READ_MARK_TYPES: ReadonlySet<string> = new Set(["PlusChat"]);
// Failed marks of one log id before the watcher stops and waits for a newer message in that room.
export const MARKREAD_TRIES = 5;

const positive = (value: string | undefined, fallback: number): number => {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n) || n <= 0) throw new Error("Kakao intervals must be positive");
  return n;
};
export const kakaoOptions = (env: Record<string, string | undefined>): KakaoOptions => {
  const stateDir = env.DORI_STATE_DIR || join(homedir(), ".dori", "state");
  const dir = env.DORI_KAKAO_STATE_DIR || stateDir;
  return {
    self: env.DORI_KAKAO_SELF_ID || "",
    owner: env.DORI_KAKAO_OWNER_ID || "",
    mention: env.DORI_KAKAO_MENTION ? new RegExp(env.DORI_KAKAO_MENTION, "i") : null,
    cli: env.DORI_KAKAO_CLI || "agent-messenger",
    lock: join(dir, "kakao.lock"),
    rooms: join(dir, "kakao-rooms.json"),
    cursors: join(dir, "kakao-cursors.json"),
    marked: join(dir, "kakao-markread.json"),
    gaveUp: join(dir, "kakao-markread-giveup.json"),
    inbox: env.DORI_KAKAO_INBOX || env.DORI_DISCORD_INBOX || join(stateDir, "discord", "inbox.jsonl"),
    pollMs: positive(env.DORI_KAKAO_POLL_MS, 8000),
    sweepMs: positive(env.DORI_KAKAO_SWEEP_MS, 300_000),
    discoverMs: positive(env.DORI_KAKAO_DISCOVER_MS, 20_000),
  };
};

const readJson = <T>(path: string, fallback: T): T => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback);
const save = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
// The first tick sweeps with every known room counted as unread: a mark-read that returned success before a restart
// but left the badge is not remembered anywhere else, so each room is marked once more at start.
export const loadKakaoState = (o: KakaoOptions): KakaoState => {
  const rooms = readJson<Record<string, { id: string; type?: string }>>(o.rooms, {});
  return {
    rooms,
    cursors: readJson(o.cursors, {}),
    marked: readJson(o.marked, {}),
    gaveUp: readJson(o.gaveUp, {}),
    fails: {},
    retryAt: {},
    advancedAt: {},
    unread: new Set(Object.values(rooms).map((r) => String(r.id))),
    lastSweep: -Infinity,
    lastDiscover: -Infinity,
  };
};

const oneLine = (r: Ran, max: number) => (r.err || r.out).slice(0, max).replace(/\n/g, " ");
const parseList = <T>(out: string, key: string): T[] | null => {
  try {
    const j: unknown = JSON.parse(out);
    if (Array.isArray(j)) return j as T[];
    const inner = j && typeof j === "object" ? (j as Record<string, unknown>)[key] : undefined;
    return Array.isArray(inner) ? (inner as T[]) : [];
  } catch {
    return null;
  }
};

type Long = { toString(): string };
type LocoReply = { statusCode: number; body: Record<string, unknown> };
export type KakaoSession = {
  syncMessages(chatId: Long, count: number, cur: Long, max: Long): Promise<LocoReply>;
  markRead(chatId: Long, watermark: Long): Promise<LocoReply>;
  getChatInfo(chatId: Long): Promise<LocoReply>;
};
// type is set only when the room is of a type in NO_READ_MARK_TYPES; then nothing was marked.
export type MarkBack = { status: number; watermark: string | null; type?: string };
// Runs fn on a freshly logged-in session and closes it.
export type OpenSession = <T>(fn: (session: KakaoSession) => Promise<T>) => Promise<T>;

// The account's own read mark as the server holds it: CHATONROOM answers with members and their watermarks on its first
// call per session. Sent alone in a fresh session it left the unread count unchanged, so it reads without marking.
// Its "t" is the room type ("MultiChat", "DirectChat", "PlusChat"...).
async function serverReadMark(session: KakaoSession, chatId: Long, self: string): Promise<{ mark: string | null; type: string | null }> {
  const room = await session.getChatInfo(chatId);
  if (room.statusCode !== 0) throw new Error(`CHATONROOM failed: statusCode=${room.statusCode}`);
  const members = Array.isArray(room.body.a) ? room.body.a.map(String) : [];
  const marks = Array.isArray(room.body.w) ? room.body.w.map(String) : [];
  const at = members.indexOf(self);
  return { mark: at >= 0 ? (marks[at] ?? null) : null, type: typeof room.body.t === "string" ? room.body.t : null };
}

// The server acks NOTIREAD with status 0 and still drops it unless the same session first synced the chat from the
// account's read mark up to the target (SYNCMSG), which left the sender's "1" while the CLI said success. So: read the
// server's mark, sync from it and mark in a fresh session, then read the mark back in another fresh session.
export async function markReadConfirmed(open: OpenSession, long: (id: string) => Long, chatId: string, logId: string, from: string, self: string): Promise<MarkBack> {
  const readMark = (session: KakaoSession) => serverReadMark(session, long(chatId), self);
  const { mark: before, type } = await open(readMark);
  if (type !== null && NO_READ_MARK_TYPES.has(type)) return { status: 0, watermark: before, type };
  if (before !== null && BigInt(before) >= BigInt(logId)) return { status: 0, watermark: before };
  const status = await open(async (session) => {
    const sync = await session.syncMessages(long(chatId), 80, long(before ?? from), long(logId));
    if (sync.statusCode !== 0) throw new Error(`SYNCMSG failed: statusCode=${sync.statusCode}`);
    const mark = await session.markRead(long(chatId), long(logId));
    if (mark.statusCode !== 0) throw new Error(`NOTIREAD failed: statusCode=${mark.statusCode}`);
    return typeof mark.body.status === "number" ? mark.body.status : 0;
  });
  return { status, watermark: (await open(readMark)).mark };
}

// The agent-messenger SDK the CLI ships with (its CLI has no sync or read-back), found next to the resolved CLI script.
async function markReadOnce(o: KakaoOptions, chatId: string, logId: string, from: string): Promise<MarkBack> {
  const cli = realpathSync(Bun.which(o.cli) ?? o.cli);
  const sdk = join(dirname(cli), "platforms", "kakaotalk", "index.js");
  const mod = await import(sdk);
  const { Long } = mod.Long ? mod : await import(Bun.resolveSync("bson", dirname(sdk)));
  const open: OpenSession = async (fn) => {
    const client = new mod.KakaoTalkClient();
    await client.login(undefined, undefined);
    try {
      return await client.executeWithReconnect(({ session }: { session: KakaoSession }) => fn(session));
    } finally {
      client.close();
    }
  };
  return markReadConfirmed(open, (id) => Long.fromString(id), chatId, logId, from, o.self);
}

const parseMarkBack = (out: string): MarkBack | null => {
  try {
    const j = JSON.parse(out) as MarkBack;
    return typeof j.status === "number" ? j : null;
  } catch {
    return null;
  }
};

// Records a room's type; a room of a type the server keeps no read mark in gets one KAKAO_MARKREAD_SKIP line.
const noteType = (o: KakaoOptions, s: KakaoState, name: string, type: string, log: (line: string) => void) => {
  const room = s.rooms[name];
  if (!room || room.type === type) return;
  s.rooms[name] = { ...room, type };
  save(o.rooms, s.rooms);
  if (NO_READ_MARK_TYPES.has(type)) log(`KAKAO_MARKREAD_SKIP ${name} ${room.id} ${type}: the server keeps no read mark in this room type, it is not marked read`);
};

export async function kakaoTick(o: KakaoOptions, s: KakaoState, runner: Runner, now: () => number, log: (line: string) => void): Promise<void> {
  // Every call holds the account's lock: two agent-messenger logins on one device evict each other.
  const kakao = (args: string[], timeoutMs: number) => runner(["flock", o.lock, o.cli, "kakaotalk", ...args], { timeoutMs });

  if (now() - s.lastDiscover >= o.discoverMs) {
    s.lastDiscover = now();
    const r = await kakao(["chat", "list", "--all"], 90_000);
    const chats = r.code === 0 ? parseList<KChat>(r.out, "chats") : null;
    if (r.code !== 0) log(`KAKAO_DISCOVER_FAIL ${oneLine(r, 150)}`);
    const known = new Map(Object.entries(s.rooms).map(([name, v]) => [String(v.id), name]));
    for (const c of chats ?? []) {
      // chat list returns only chats changed since the account's last sync, so an unread count here is a hint, not a census.
      if ((c.unread_count ?? 0) > 0) s.unread.add(String(c.chat_id));
      let name = known.get(String(c.chat_id));
      if (name === undefined) {
        name = c.display_name || String(c.chat_id);
        s.rooms[name] = { id: String(c.chat_id) };
        save(o.rooms, s.rooms);
        log(`KAKAO_NEW_ROOM ${name} ${c.chat_id}`);
      }
      if (typeof c.type === "string") noteType(o, s, name, c.type, log);
    }
  }

  // A mark-read can exit 0 and still leave the badge, so rooms with an unread hint or recent messages are marked again.
  if (now() - s.lastSweep >= o.sweepMs) {
    s.lastSweep = now();
    for (const { id } of Object.values(s.rooms)) {
      if (s.unread.has(id) || now() - (s.advancedAt[id] ?? -Infinity) < 6 * o.sweepMs) delete s.marked[id];
    }
    s.unread.clear();
  }

  for (const [name, { id }] of Object.entries(s.rooms)) {
    const r = await kakao(["message", "list", id, "-n", "15"], 60_000);
    if (r.code !== 0) {
      log(`KAKAO_POLL_FAIL ${id} ${oneLine(r, 200)}`);
      continue;
    }
    const msgs = parseList<KMsg>(r.out, "messages");
    if (!msgs) {
      log(`KAKAO_PARSE_FAIL ${id}`);
      continue;
    }
    if (msgs.length === 0) continue;
    const sorted = [...msgs].sort((a, b) => (BigInt(a.log_id) < BigInt(b.log_id) ? -1 : 1));
    const newest = sorted[sorted.length - 1]?.log_id ?? "";
    if (!s.cursors[id]) {
      // A room seen for the first time starts at its newest message; its backlog is neither taken in nor marked read.
      s.cursors[id] = newest;
      s.marked[id] = newest;
      save(o.cursors, s.cursors);
      save(o.marked, s.marked);
      log(`KAKAO_CURSOR_INIT ${name} ${newest}`);
      continue;
    }
    for (const m of sorted) {
      if (BigInt(m.log_id) <= BigInt(s.cursors[id] ?? "0")) continue;
      s.cursors[id] = m.log_id;
      s.advancedAt[id] = now();
      const author = String(m.author_id);
      if (author === o.self) continue;
      const row = {
        ts: new Date(now()).toISOString(),
        id: m.log_id,
        channel_id: id,
        scope: "kakao",
        room: name,
        author_id: author,
        author_name: m.author_name ?? null,
        author_kind: author === o.owner ? "owner" : "member",
        content: m.message,
        sent_at: m.sent_at,
        mentions_self: o.mention ? o.mention.test(m.message) : false,
      };
      appendFileSync(o.inbox, `${JSON.stringify(row)}\n`);
      log(`KAKAO_MSG ${name} ${m.log_id} ${m.author_name ?? m.author_id}: ${m.message.slice(0, 120).replace(/\n/g, " ")}`);
    }
    save(o.cursors, s.cursors);
    const target = s.cursors[id] ?? "";
    if (NO_READ_MARK_TYPES.has(s.rooms[name]?.type ?? "")) continue;
    if (s.marked[id] === target || s.gaveUp[id] === target || now() < (s.retryAt[id] ?? 0)) continue;
    // Marked only when the server's own read mark for this account reached the target; anything else is retried.
    const from = sorted.find((m) => BigInt(m.log_id) < BigInt(target))?.log_id ?? "0";
    const mr = await runner(["flock", o.lock, process.execPath, import.meta.path, "--mark-read", id, target, from], { timeoutMs: 60_000 });
    const back = mr.code === 0 ? parseMarkBack(mr.out) : null;
    if (back?.type && NO_READ_MARK_TYPES.has(back.type)) {
      delete s.fails[id];
      delete s.retryAt[id];
      noteType(o, s, name, back.type, log);
      continue;
    }
    if (back && back.status === 0 && back.watermark !== null && BigInt(back.watermark) >= BigInt(target)) {
      const after = s.fails[id] ? ` after ${s.fails[id]} failed` : "";
      s.marked[id] = target;
      delete s.fails[id];
      delete s.retryAt[id];
      save(o.marked, s.marked);
      if (s.gaveUp[id] !== undefined) {
        delete s.gaveUp[id];
        save(o.gaveUp, s.gaveUp);
      }
      log(`KAKAO_MARKREAD_OK ${name} ${target} server ${back.watermark}${after}`);
      continue;
    }
    const why =
      mr.code !== 0 ? oneLine(mr, 150) : !back ? `unreadable reply ${oneLine(mr, 100)}` : back.status !== 0 ? `NOTIREAD status ${back.status}` : `server read mark ${back.watermark ?? "missing"} is behind ${target}`;
    const n = (s.fails[id] ?? 0) + 1;
    if (n >= MARKREAD_TRIES) {
      // Retrying a mark the server keeps refusing only repeats the alarm; a newer message (another target) starts over.
      delete s.fails[id];
      delete s.retryAt[id];
      s.gaveUp[id] = target;
      save(o.gaveUp, s.gaveUp);
      log(`KAKAO_MARKREAD_GIVEUP ${name} ${target} after ${n} failed, not marked again until a newer message: ${why}`);
      continue;
    }
    const wait = Math.min(o.pollMs * 2 ** (n - 1), 2 * o.sweepMs);
    s.fails[id] = n;
    s.retryAt[id] = now() + wait;
    log(`KAKAO_MARKREAD_FAIL ${name} ${target} attempt ${n}, retry in ${Math.round(wait / 1000)}s: ${why}`);
  }
}

if (import.meta.main) {
  await resolveInstance(process.cwd());
  await loadEnvFile(envFilePath());
  const options = kakaoOptions(process.env);
  if (!options.self) {
    console.log("KAKAO_WATCH_OFF DORI_KAKAO_SELF_ID is not set");
    process.exit(0);
  }
  const at = process.argv.indexOf("--mark-read");
  if (at >= 0) {
    console.log(JSON.stringify(await markReadOnce(options, process.argv[at + 1] ?? "", process.argv[at + 2] ?? "", process.argv[at + 3] ?? "0")));
    process.exit(0);
  }
  for (const file of [options.rooms, options.inbox]) mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const state = loadKakaoState(options);
  const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
  const tick = () => kakaoTick(options, state, run, Date.now, log);
  if (process.argv.includes("--once")) {
    await tick();
    console.log("KAKAO_WATCH_ONCE");
  } else {
    console.log("KAKAO_WATCH_READY");
    for (;;) {
      await tick().catch((e: unknown) => log(`KAKAO_WATCH_FAIL ${e instanceof Error ? e.message : String(e)}`));
      await Bun.sleep(options.pollMs);
    }
  }
}
