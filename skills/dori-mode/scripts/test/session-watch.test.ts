import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { byStartTime, clockFree, dropSidePanel, lastSaid, sessionDir, watchContext } from "../../setups/discord-aoe/session-watch-lib.ts";
import { loadConfig } from "../src/config.ts";
import { mapThread } from "../src/messenger/thread-map.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "session-watch-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("watch ticks re-read the lead and ignore panes after a handover", async () => {
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify({ stateDir: dir, leadPane: "old-lead", ignorePanes: ["old-ignore"] }));
  const first = await watchContext(() => loadConfig(file), []);
  writeFileSync(file, JSON.stringify({ stateDir: dir, leadPane: "new-lead", ignorePanes: ["new-ignore"] }));
  const second = await watchContext(() => loadConfig(file), []);
  expect({ first: [...first.skip], second: [...second.skip] }).toEqual({ first: ["old-lead", "old-ignore"], second: ["new-lead", "new-ignore"] });
});

test("watch ticks pick up non-lane mappings and prefer a registered lane thread", async () => {
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify({ stateDir: dir }));
  const previous = process.env.DORI_DISCORD_STATE_DIR;
  process.env.DORI_DISCORD_STATE_DIR = join(dir, "cards");
  try {
    const first = await watchContext(() => loadConfig(file), []);
    mapThread(join(dir, "cards"), "300000000000000003", "session-1", "fix login");
    const second = await watchContext(() => loadConfig(file), [{ key: "lane", title: "lane", pane: "lane-pane", thread: "discord:400000000000000004", brief: "", done: "", openedAt: "" }]);
    expect({ before: first.thread("session-1", "other-pane"), mapped: second.thread("session-1", "other-pane"), lane: second.thread("session-1", "lane-pane") }).toEqual({
      before: null, mapped: "discord:300000000000000003", lane: "discord:400000000000000004",
    });
  } finally {
    if (previous === undefined) delete process.env.DORI_DISCORD_STATE_DIR;
    else process.env.DORI_DISCORD_STATE_DIR = previous;
  }
});

test("the watcher switches its skipped panes between actual ticks and emits a mapped non-lane event", async () => {
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify({ stateDir: dir, leadPane: "aoe_old_11111111", ignorePanes: ["aoe_before_33333333"], update: { repo: dir } }));
  mapThread(join(dir, "cards"), "300000000000000003", "11111111-old", "fix login");
  const env: Record<string, string | undefined> = { ...process.env, DORI_CONFIG: file, DORI_STATE_DIR: dir, DORI_ENV_FILE: join(dir, "missing.env"), DORI_DISCORD_STATE_DIR: join(dir, "cards") };
  delete env.DORI_LEAD_PANE;
  const p = Bun.spawn(["bun", "--preload", join(import.meta.dir, "session-watch-cli-fake.ts"), join(import.meta.dir, "../../setups/discord-aoe/session-watch.ts")], { env, stdout: "pipe", stderr: "pipe", timeout: 5000 });
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const events: { kind: string; session: string; thread: string | null }[] = readFileSync(join(dir, "session-events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect({ code, ready: out.startsWith("SESSION_WATCH_READY\n"), err, captures: readFileSync(join(dir, "captures.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)), events: events.map(({ kind, session, thread }) => ({ kind, session, thread })) }).toEqual({
    code: 0, ready: true, err: "",
    captures: [
      { tick: 0, pane: "=aoe_new_22222222:" }, { tick: 0, pane: "=aoe_after_44444444:" },
      { tick: 1, pane: "=aoe_old_11111111:" }, { tick: 1, pane: "=aoe_before_33333333:" },
      { tick: 2, pane: "=aoe_old_11111111:" }, { tick: 2, pane: "=aoe_before_33333333:" },
    ],
    events: [
      { kind: "session-waiting", session: "11111111-old", thread: "discord:300000000000000003" },
      { kind: "session-waiting", session: "33333333-before", thread: null },
    ],
  });
});

test("clockFree: elapsed counters with trailing seconds are clock text, not new output", () => {
  for (const [a, b] of [
    ["elapsed 4m36", "elapsed 4m37"],
    ["started 25m05 ago", "started 25m06 ago"],
    ["up 11h16", "up 11h17"],
    ["Ask user · 28m", "Ask user · 29m"],
    ["Pursuing goal (18h 31m)", "Pursuing goal (18h 32m)"],
    ["retry 12:04", "retry 12:05"],
  ]) {
    expect(clockFree(a!)).toBe(clockFree(b!));
  }
  expect(clockFree("ran 3 tests in 1.5s")).toBe("ran 3 tests in #");
  expect(clockFree("fixed 4 bugs")).toBe("fixed 4 bugs");
});

test("dropSidePanel: removes the last SESSION block above the prompt and keeps the transcript and prompt", () => {
  const lines = [
    "MILESTONE 2: tests green",
    "SESSION  notes in the transcript stay",
    "Ready for review.",
    "SESSION  dori-lane · omo 5.1.27",
    "goal  ship the fix",
    "elapsed 4m36",
    "❯ ",
    "  model claude · ctx 41%",
  ];
  expect(dropSidePanel(lines)).toEqual([
    "MILESTONE 2: tests green",
    "SESSION  notes in the transcript stay",
    "Ready for review.",
    "❯ ",
    "  model claude · ctx 41%",
  ]);
  const noPanel = ["Ready for review.", "❯ "];
  expect(dropSidePanel(noPanel)).toEqual(noPanel);
  const noPrompt = ["SESSION  dori-lane", "elapsed 1m"];
  expect(dropSidePanel(noPrompt)).toEqual(noPrompt);
});

test("lastSaid: newest assistant text from the transcript, skipping tool-only rows, users and broken lines", () => {
  const file = join(dir, "session.jsonl");
  const rows = [
    { type: "message", timestamp: "2026-01-01T00:00:00Z", message: { role: "assistant", content: [{ type: "text", text: "old answer" }] } },
    { type: "message", timestamp: "2026-01-01T00:01:00Z", message: { role: "assistant", content: [{ type: "text", text: "PR opened." }, { type: "toolCall", name: "bash" }, { type: "text", text: "Waiting on CI." }] } },
    { type: "message", timestamp: "2026-01-01T00:02:00Z", message: { role: "assistant", content: [{ type: "toolCall", name: "bash" }] } },
    { type: "message", timestamp: "2026-01-01T00:03:00Z", message: { role: "user", content: [{ type: "text", text: "what next?" }] } },
  ];
  writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n{"truncated":`);
  expect(lastSaid(file)).toEqual({ at: "2026-01-01T00:01:00Z", text: "PR opened.\nWaiting on CI." });
});

test("byStartTime: the transcript in the cwd's session dir created closest to the process start, within 2 minutes", () => {
  const sessions = sessionDir(dir, "/home/ana/work/app");
  expect(sessions).toBe(join(dir, "--home-ana-work-app--"));
  mkdirSync(sessions);
  for (const name of ["2026-01-01T10-00-01-000Z_aaa.jsonl", "2026-01-01T10-01-30-000Z_ccc.jsonl", "2026-01-01T10-05-02-500Z_bbb.jsonl", "notes.txt"]) writeFileSync(join(sessions, name), "");
  expect(byStartTime(sessions, Date.parse("2026-01-01T10:00:00Z"))).toBe(join(sessions, "2026-01-01T10-00-01-000Z_aaa.jsonl"));
  expect(byStartTime(sessions, Date.parse("2026-01-01T10:01:20Z"))).toBe(join(sessions, "2026-01-01T10-01-30-000Z_ccc.jsonl"));
  expect(byStartTime(sessions, Date.parse("2026-01-01T10:04:00Z"))).toBe(join(sessions, "2026-01-01T10-05-02-500Z_bbb.jsonl"));
  expect(byStartTime(sessions, Date.parse("2026-01-01T10:08:00Z"))).toBeNull();
  expect(byStartTime(join(dir, "missing"), Date.parse("2026-01-01T10:00:00Z"))).toBeNull();
});

test("lastSaid: reads only the file's last 512 KB, caps the text at 3000 characters, null without assistant text", () => {
  const file = join(dir, "big.jsonl");
  const said = (text: string) => JSON.stringify({ timestamp: "t", message: { role: "assistant", content: [{ type: "text", text }] } });
  const filler = JSON.stringify({ message: { role: "user", content: [{ type: "text", text: "x".repeat(600 * 1024) }] } });
  writeFileSync(file, `${said("before the window")}\n${filler}\n`);
  expect(lastSaid(file)).toBeNull();
  writeFileSync(file, `${filler}\n${said("y".repeat(5000))}\n`);
  expect(lastSaid(file)?.text).toBe("y".repeat(3000));
});
