import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

const cli = async (...args: string[]) => {
  const config = join(state.dir, "config.json");
  writeFileSync(config, JSON.stringify({ stateDir: state.dir, discord: { statusStyle: "emoji" } }));
  const p = Bun.spawn(["bun", "--preload", join(import.meta.dir, "discord-cli-fake.ts"), join(import.meta.dir, "../src/cli.ts"), "thread", ...args], {
    env: { ...process.env, DORI_CONFIG: config, DORI_ENV_FILE: join(state.dir, "missing.env"), DORI_STATE_DIR: state.dir, DORI_DISCORD_STATE_DIR: join(state.dir, "cards"), DORI_DISCORD_TOKEN: "fake", DORI_DISCORD_CHANNEL: "200000000000000002", DORI_TEST_HTTP: join(state.dir, "http.json") },
    stdout: "pipe", stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code, out: out.trim(), err: err.trim() };
};
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
