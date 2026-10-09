import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clockFree, dropSidePanel, lastSaid } from "../../setups/discord-aoe/session-watch-lib.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "session-watch-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

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

test("lastSaid: reads only the file's last 512 KB, caps the text at 3000 characters, null without assistant text", () => {
  const file = join(dir, "big.jsonl");
  const said = (text: string) => JSON.stringify({ timestamp: "t", message: { role: "assistant", content: [{ type: "text", text }] } });
  const filler = JSON.stringify({ message: { role: "user", content: [{ type: "text", text: "x".repeat(600 * 1024) }] } });
  writeFileSync(file, `${said("before the window")}\n${filler}\n`);
  expect(lastSaid(file)).toBeNull();
  writeFileSync(file, `${filler}\n${said("y".repeat(5000))}\n`);
  expect(lastSaid(file)?.text).toBe("y".repeat(3000));
});
