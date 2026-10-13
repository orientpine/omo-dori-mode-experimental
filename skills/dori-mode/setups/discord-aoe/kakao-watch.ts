#!/usr/bin/env bun
// KakaoTalk watcher for a Dori with its own Kakao account (agent-messenger kakaotalk). Off unless DORI_KAKAO_SELF_ID is set.
// Polls every known room, appends new messages to the inbox, prints one KAKAO_MSG line each for the lead's monitor and
// marks them read. --once performs one tick and exits.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  readonly inbox: string;
  readonly pollMs: number;
  readonly sweepMs: number;
  readonly discoverMs: number;
};
// cursors: newest log id taken into the inbox; marked: newest log id a mark-read succeeded for. They differ while a
// mark-read is pending, failed (retried at retryAt, backing off) or re-armed by a sweep.
export type KakaoState = {
  rooms: Record<string, { id: string }>;
  cursors: Record<string, string>;
  marked: Record<string, string>;
  fails: Record<string, number>;
  retryAt: Record<string, number>;
  advancedAt: Record<string, number>;
  unread: Set<string>;
  lastSweep: number;
  lastDiscover: number;
};
type KMsg = { log_id: string; author_id: number | string; author_name?: string; message: string; sent_at: number };
type KChat = { chat_id: string; display_name?: string; unread_count?: number };

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
    inbox: env.DORI_KAKAO_INBOX || env.DORI_DISCORD_INBOX || join(stateDir, "discord", "inbox.jsonl"),
    pollMs: positive(env.DORI_KAKAO_POLL_MS, 8000),
    sweepMs: positive(env.DORI_KAKAO_SWEEP_MS, 300_000),
    discoverMs: positive(env.DORI_KAKAO_DISCOVER_MS, 20_000),
  };
};

const readJson = <T>(path: string, fallback: T): T => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback);
const save = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
export const loadKakaoState = (o: KakaoOptions, now: number): KakaoState => ({
  rooms: readJson(o.rooms, {}),
  cursors: readJson(o.cursors, {}),
  marked: readJson(o.marked, {}),
  fails: {},
  retryAt: {},
  advancedAt: {},
  unread: new Set(),
  lastSweep: now,
  lastDiscover: -Infinity,
});

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

export async function kakaoTick(o: KakaoOptions, s: KakaoState, runner: Runner, now: () => number, log: (line: string) => void): Promise<void> {
  // Every call holds the account's lock: two agent-messenger logins on one device evict each other.
  const kakao = (args: string[], timeoutMs: number) => runner(["flock", o.lock, o.cli, "kakaotalk", ...args], { timeoutMs });

  if (now() - s.lastDiscover >= o.discoverMs) {
    s.lastDiscover = now();
    const r = await kakao(["chat", "list", "--all"], 90_000);
    const chats = r.code === 0 ? parseList<KChat>(r.out, "chats") : null;
    if (r.code !== 0) log(`KAKAO_DISCOVER_FAIL ${oneLine(r, 150)}`);
    const known = new Set(Object.values(s.rooms).map((v) => String(v.id)));
    for (const c of chats ?? []) {
      // chat list returns only chats changed since the account's last sync, so an unread count here is a hint, not a census.
      if ((c.unread_count ?? 0) > 0) s.unread.add(String(c.chat_id));
      if (known.has(String(c.chat_id))) continue;
      const name = c.display_name || String(c.chat_id);
      s.rooms[name] = { id: String(c.chat_id) };
      save(o.rooms, s.rooms);
      log(`KAKAO_NEW_ROOM ${name} ${c.chat_id}`);
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
    if (s.marked[id] === target || now() < (s.retryAt[id] ?? 0)) continue;
    const mr = await kakao(["message", "mark-read", id, target], 60_000);
    if (mr.code === 0) {
      const after = s.fails[id] ? ` after ${s.fails[id]} failed` : "";
      s.marked[id] = target;
      delete s.fails[id];
      delete s.retryAt[id];
      save(o.marked, s.marked);
      log(`KAKAO_MARKREAD_OK ${name} ${target}${after}`);
      continue;
    }
    const n = (s.fails[id] ?? 0) + 1;
    const wait = Math.min(o.pollMs * 2 ** (n - 1), 2 * o.sweepMs);
    s.fails[id] = n;
    s.retryAt[id] = now() + wait;
    log(`KAKAO_MARKREAD_FAIL ${name} ${target} attempt ${n}, retry in ${Math.round(wait / 1000)}s: ${oneLine(mr, 150)}`);
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
  for (const file of [options.rooms, options.inbox]) mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const state = loadKakaoState(options, Date.now());
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
