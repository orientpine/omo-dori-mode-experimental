// Pure pieces of session-watch.ts, kept apart so they can be tested without tmux or aoe.
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";

export type Said = { at: string; text: string };

// Elapsed-time counters ("Ask user · 28m", "Pursuing goal (18h 31m)", "4m ago", side panel "elapsed 4m36",
// "25m05 ago", "11h16") and retry clocks tick while a pane waits; they are not new output.
export const clockFree = (text: string): string =>
  text.replace(/\b\d+(?:\.\d+)?(?:ms|s|m|h|d)(?:\d{1,2})?\b/g, "#").replace(/\b(?:retry|resets) \d{1,2}:\d{2}\b/g, "#");

// The omo side panel (5.1.27+) stacks under the transcript on narrow panes: its block runs from the last
// "SESSION  " header above the prompt down to the line before the prompt. It is status, not session output.
export const dropSidePanel = (lines: string[]): string[] => {
  const promptAt = lines.findLastIndex((l) => l.startsWith("❯"));
  const panelAt = lines.findLastIndex((l, i) => i < promptAt && /^SESSION {2}/.test(l));
  return panelAt >= 0 ? [...lines.slice(0, panelAt), ...lines.slice(promptAt)] : lines;
};

// omo keeps transcripts in <sessionsRoot>/--<cwd without the leading /, every / turned into ->--/, each named
// <created as YYYY-MM-DDTHH-MM-SS-mmmZ>_<id>.jsonl. A fresh, idle omo names its file nowhere, so take the one in
// its cwd's dir created closest to the process start, within 2 minutes; sessions sharing a cwd started apart.
export const sessionDir = (sessionsRoot: string, cwd: string): string =>
  join(sessionsRoot, `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`);

export const byStartTime = (dir: string, startedMs: number): string | null => {
  if (!existsSync(dir)) return null;
  let best: { file: string; gap: number } | null = null;
  for (const name of readdirSync(dir)) {
    const m = name.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_.*\.jsonl$/);
    if (!m) continue;
    const gap = Math.abs(Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) - startedMs);
    if (gap < 120_000 && (!best || gap < best.gap)) best = { file: join(dir, name), gap };
  }
  return best?.file ?? null;
};

// What a session last said, from its transcript jsonl: the newest assistant row with text, read from the
// file's last 512 KB and cut to 3000 characters.
export const lastSaid = (file: string): Said | null => {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const rows = buf.toString("utf8").split("\n");
    for (let i = rows.length - 1; i >= 0; i--) {
      let row: { timestamp?: string; message?: { role?: string; content?: { type: string; text?: string }[] | string } };
      try {
        row = JSON.parse(rows[i] ?? "");
      } catch {
        continue;
      }
      if (row.message?.role !== "assistant" || !Array.isArray(row.message.content)) continue;
      const text = row.message.content.filter((c) => c.type === "text" && c.text).map((c) => c.text).join("\n").trim();
      if (text) return { at: row.timestamp ?? "", text: text.slice(0, 3000) };
    }
    return null;
  } finally {
    closeSync(fd);
  }
};
