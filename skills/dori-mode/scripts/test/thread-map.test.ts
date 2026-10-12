import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { dropThread, mapThread, threads } from "../src/messenger/thread-map.ts";
import { withState } from "./fakes.ts";

const ID = "300000000000000003";
const REF = `discord:${ID}`;
let state: ReturnType<typeof withState>;
beforeEach(() => { state = withState(); });
afterEach(() => state.done());

test("a missing thread map is empty", () => {
  expect(threads(state.dir)).toEqual({});
});

test("mapping a session preserves a carried-over title and writes privately without leftover temp files", () => {
  writeFileSync(join(state.dir, "threads.json"), JSON.stringify({ [ID]: { session: "old", title: "fix login" } }), { mode: 0o600 });
  mapThread(state.dir, ID, "new");
  expect({ map: threads(state.dir), files: readdirSync(state.dir), mode: statSync(join(state.dir, "threads.json")).mode & 0o777 }).toEqual({
    map: { [ID]: { session: "new", title: "fix login" } }, files: ["threads.json"], mode: 0o600,
  });
});

test("a new mapping accepts a null session and a later drop removes it", () => {
  mapThread(state.dir, ID, null, "fix login");
  const opened = threads(state.dir);
  dropThread(state.dir, ID);
  expect({ opened, closed: threads(state.dir) }).toEqual({ opened: { [ID]: { session: null, title: "fix login" } }, closed: {} });
});

const dori = async (...args: string[]) => {
  const config = join(state.dir, "config.json");
  writeFileSync(config, JSON.stringify({ stateDir: state.dir, defaultCwd: state.dir, discord: { statusStyle: "emoji" } }));
  const p = Bun.spawn(["bun", "--preload", join(import.meta.dir, "discord-cli-fake.ts"), join(import.meta.dir, "../src/cli.ts"), ...args], {
    env: { ...process.env, DORI_CONFIG: config, DORI_ENV_FILE: join(state.dir, "missing.env"), DORI_STATE_DIR: state.dir, DORI_DISCORD_STATE_DIR: join(state.dir, "cards"), DORI_DISCORD_TOKEN: "fake", DORI_DISCORD_CHANNEL: "200000000000000002", DORI_TEST_HTTP: join(state.dir, "http.json") },
    stdout: "pipe", stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code, out: out.trim(), err: err.trim() };
};
const cli = (...args: string[]) => dori("thread", ...args);
const http = (): { name: string; archived: boolean; calls: { method: string; path: string; body: Record<string, unknown> }[] } => JSON.parse(readFileSync(join(state.dir, "http.json"), "utf8"));
const map = () => threads(join(state.dir, "cards"));

test("thread open creates a standalone marked thread, first message and session mapping", async () => {
  const result = await cli("open", "✅ 🔄 fix login", "--first", "Start here", "--session", "session-1");
  expect({ result, http: http(), map: map() }).toEqual({
    result: { code: 0, out: `THREAD_OPENED ${REF}`, err: "" },
    http: { name: "🔄 fix login", archived: false, calls: [
      { method: "POST", path: "/channels/200000000000000002/threads", body: { name: "🔄 fix login", type: 11, auto_archive_duration: 10080 } },
      { method: "POST", path: `/channels/${ID}/messages`, body: { content: "Start here", allowed_mentions: { parse: [] } } },
    ] }, map: { [ID]: { session: "session-1", title: "fix login" } },
  });
});

test("thread open from a message does not post a standalone first message", async () => {
  const result = await cli("open", "fix login", "--from", "10001", "--first", "unused");
  expect({ result, calls: http().calls, map: map() }).toEqual({
    result: { code: 0, out: `THREAD_OPENED ${REF}`, err: "" },
    calls: [{ method: "POST", path: "/channels/200000000000000002/messages/10001/threads", body: { name: "🔄 fix login" } }],
    map: { [ID]: { session: null, title: "fix login" } },
  });
});

test("thread open refuses an empty standalone thread before calling Discord", async () => {
  const result = await cli("open", "fix login");
  expect({ code: result.code, called: existsSync(join(state.dir, "http.json")) }).toEqual({ code: 1, called: false });
});

test("thread map preserves the title, list shows it, and none clears the session without Discord", async () => {
  mapThread(join(state.dir, "cards"), ID, "old", "fix login");
  const mapped = await cli("map", REF, "new");
  const listed = await cli("list");
  const cleared = await cli("map", REF, "none");
  expect({ mapped, listed, cleared, map: map(), called: existsSync(join(state.dir, "http.json")) }).toEqual({
    mapped: { code: 0, out: `THREAD_MAPPED ${REF} new`, err: "" },
    listed: { code: 0, out: `${ID} new fix login`, err: "" },
    cleared: { code: 0, out: `THREAD_MAPPED ${REF} none`, err: "" },
    map: { [ID]: { session: null, title: "fix login" } }, called: false,
  });
});

test("thread set honors open-card, while done wins, archives and drops the map", async () => {
  await cli("open", "fix login", "--first", "Start");
  await cli("set", REF, "working", "--open-card");
  const waiting = http().name;
  const result = await cli("set", REF, "done", "--open-card");
  expect({ waiting, result, name: http().name, archived: http().archived, map: map() }).toEqual({
    waiting: "⏸️ fix login", result: { code: 0, out: "", err: `THREAD_STATUS_APPLIED ${ID} done` }, name: "✅ fix login", archived: true, map: {},
  });
});

test("thread done keeps its existing posted output and removes the archived mapping", async () => {
  await cli("open", "fix login", "--first", "Start");
  const result = await cli("done", REF, "Finished");
  expect({ result, archived: http().archived, map: map() }).toEqual({
    result: { code: 0, out: "POSTED 900 THREAD_DONE", err: `THREAD_STATUS_APPLIED ${ID} done` }, archived: true, map: {},
  });
});

// another user of the thread, as the registry and the card store keep them
const openLane = (key: string, fields: Record<string, unknown> = {}) => {
  mkdirSync(join(state.dir, "lanes"), { recursive: true });
  writeFileSync(join(state.dir, "lanes", `${key}.json`), JSON.stringify({ key, title: key, brief: "/b.md", done: "file x", thread: REF, pane: `w:${key}`, openedAt: "2026-10-12T00:00:00Z", ...fields }));
};
// a lane dori close can close: no pane or tab to close, a Done signal that reads back live
const closable = (key: string) => openLane(key, { done: "file /etc/hostname", pane: undefined, cwd: state.dir });
const named = () => http().calls.filter((c) => c.method === "PATCH" && c.body.name).map((c) => c.body.name);
const openCard = (id: string) => {
  mkdirSync(join(state.dir, "cards"), { recursive: true });
  writeFileSync(join(state.dir, "cards", "questions.json"), JSON.stringify({ seq: 1, questions: [{ id, text: "Ship?", options: ["Yes", "No"], status: "open", thread: ID, askedAt: "2026-10-12T00:00:00Z" }] }));
};
const renamed = () => http().calls.filter((c) => c.method === "PATCH").length;

test("thread done leaves a thread that another open lane uses as it is, but the closing lane itself is no other user (feature-verify 2026-10-12, follow-up b)", async () => {
  await cli("open", "fix login", "--first", "Start");
  openLane("lane-b");
  const left = await cli("done", REF, "lane-a finished");
  expect({ left, renames: renamed(), name: http().name, archived: http().archived }).toEqual({
    left: { code: 0, out: `POSTED 900 THREAD_LEFT_OPEN ${REF}: open lane lane-b uses it; not marked done (--force marks it done anyway)`, err: "" }, renames: 0, name: "🔄 fix login", archived: false,
  });
  // lane-b's own close runs hooks.threadDone with DORI_CLOSING_LANE=lane-b (--lane says the same): that marks it done
  process.env.DORI_CLOSING_LANE = "lane-b";
  const own = await cli("done", REF, "lane-b finished").finally(() => delete process.env.DORI_CLOSING_LANE);
  expect({ own, archived: http().archived }).toEqual({ own: { code: 0, out: "POSTED 900 THREAD_DONE", err: `THREAD_STATUS_APPLIED ${ID} done` }, archived: true });
});

test("thread done with an open card is left open, and --force marks it done with a warning", async () => {
  await cli("open", "fix login", "--first", "Start");
  openCard("Q1");
  const left = await cli("done", REF, "finished");
  expect({ out: left.out, renames: renamed() }).toEqual({ out: `POSTED 900 THREAD_LEFT_OPEN ${REF}: open card Q1; not marked done (--force marks it done anyway)`, renames: 0 });
  const forced = await cli("done", REF, "finished", "--force");
  expect({ forced, name: http().name, archived: http().archived }).toEqual({
    forced: { code: 0, out: `THREAD_DONE_FORCED ${REF}: open card Q1; marking it done anyway\nPOSTED 900 THREAD_DONE`, err: `THREAD_STATUS_APPLIED ${ID} done` }, name: "✅ fix login", archived: true,
  });
});

test("thread set done makes the same check: an open lane keeps the thread, --force marks it done with a warning", async () => {
  await cli("open", "fix login", "--first", "Start");
  openLane("lane-b");
  const left = await cli("set", REF, "done");
  expect({ left, renames: renamed(), archived: http().archived }).toEqual({
    left: { code: 0, out: `THREAD_LEFT_OPEN ${REF}: open lane lane-b uses it; not marked done (--force marks it done anyway)`, err: "" }, renames: 0, archived: false,
  });
  const forced = await cli("set", REF, "done", "--force");
  expect({ forced, archived: http().archived }).toEqual({
    forced: { code: 0, out: `THREAD_DONE_FORCED ${REF}: open lane lane-b uses it; marking it done anyway`, err: `THREAD_STATUS_APPLIED ${ID} done` }, archived: true,
  });
});

// feature-reverify 2026-10-13: the last working lane closed while a card stayed open, and the thread kept 🔄
test("closing the last working lane of a thread with an open card turns it waiting, not done", async () => {
  await cli("open", "fix login", "--first", "Start");
  openCard("Q1");
  closable("lane-a");
  const closed = await dori("close", "lane-a");
  expect({ code: closed.code, err: closed.err, names: named(), archived: http().archived }).toEqual({
    code: 0, err: `THREAD_STATUS_APPLIED ${ID} waiting`, names: ["⏸️ fix login"], archived: false,
  });
  expect(closed.out).toContain("thread left open: open card Q1; result posted\",\"waiting requested: applied");
});

test("a lane still working in the thread keeps it working when another lane closes, open card or not", async () => {
  await cli("open", "fix login", "--first", "Start");
  openCard("Q1");
  openLane("lane-b");
  closable("lane-a");
  const closed = await dori("close", "lane-a");
  expect({ code: closed.code, err: closed.err, names: named(), archived: http().archived }).toEqual({
    code: 0, err: `THREAD_STATUS_APPLIED ${ID} working unchanged open=Q1 working=lane-b`, names: [], archived: false,
  });
});

test("a paused lane is not working: when the last working lane closes beside it, the thread turns waiting", async () => {
  await cli("open", "fix login", "--first", "Start");
  openLane("lane-b", { status: "paused" });
  closable("lane-a");
  const closed = await dori("close", "lane-a");
  expect({ code: closed.code, err: closed.err, names: named(), archived: http().archived }).toEqual({
    code: 0, err: `THREAD_STATUS_APPLIED ${ID} waiting`, names: ["⏸️ fix login"], archived: false,
  });
  expect(closed.out).toContain("thread left open: open lane lane-b uses it too");
});

test("closing the only lane with no card left marks the thread done and archives it", async () => {
  await cli("open", "fix login", "--first", "Start");
  closable("lane-a");
  const closed = await dori("close", "lane-a");
  expect({ code: closed.code, err: closed.err, names: named(), archived: http().archived }).toEqual({
    code: 0, err: `THREAD_STATUS_APPLIED ${ID} done`, names: ["✅ fix login"], archived: true,
  });
});

test("the reply hook a closing lane runs does not count that lane as working (DORI_CLOSING_LANE)", async () => {
  await cli("open", "fix login", "--first", "Start");
  openCard("Q1");
  openLane("lane-a");
  process.env.DORI_CLOSING_LANE = "lane-a";
  const own = await cli("reply", REF, "lane-a: done").finally(() => delete process.env.DORI_CLOSING_LANE);
  expect({ err: own.err, names: named() }).toEqual({ err: `THREAD_STATUS_APPLIED ${ID} waiting open=Q1`, names: ["⏸️ fix login"] });
});
