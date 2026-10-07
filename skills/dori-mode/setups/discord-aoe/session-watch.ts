#!/usr/bin/env bun
// Watches the other aoe/tmux agent sessions and appends an event when one stops for a human:
// aoe reports `waiting` or `error`, a turn ended and the pane stayed idle (no goal continuation),
// or a briefed session printed a new `MILESTONE <id>:` line. Each event carries the pane's last
// 20 lines and the lane's thread from the dori registry, so the Dori can answer or ask the owner.
// Output: <stateDir>/session-events.jsonl, one JSON object per line, also printed to stdout.
import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { loadConfig, loadEnvFile, envFilePath } from "../../scripts/src/config.ts";
import { Registry } from "../../scripts/src/registry.ts";
import { run } from "../../scripts/src/run.ts";

const INTERVAL_MS = 15_000;
const IDLE_SETTLE_MS = 45_000;

await loadEnvFile(envFilePath());
const config = await loadConfig();
const registry = new Registry(config.stateDir);
const out = join(config.stateDir, "session-events.jsonl");
const skip = new Set([config.leadPane, process.env.DORI_LEAD_TMUX ?? "", ...config.ignorePanes].filter(Boolean));

type Listed = { id: string; title: string; path: string };
type Seen = { busy: boolean; idleSince: number; notified: boolean; aoeState: string; body: string; milestone: string };
const seen = new Map<string, Seen>();

const sh = async (argv: string[]): Promise<string> => {
  const r = await run(argv);
  if (r.code !== 0) throw new Error(`${argv.slice(0, 3).join(" ")} failed: ${r.err.slice(0, 200)}`);
  return r.out;
};

const emit = (row: Record<string, unknown>): void => {
  const line = JSON.stringify({ at: new Date().toISOString(), ...row });
  appendFileSync(out, `${line}\n`, { mode: 0o600 });
  console.log(line);
};

const tick = async (): Promise<void> => {
  const listed = JSON.parse(await sh(["aoe", "list", "--json", "--state", "live"])) as Listed[];
  const ps = new Map((JSON.parse(await sh(["aoe", "ps", "--json"])) as { session: string; state: string }[]).map((p) => [p.session, p.state]));
  const tmuxNames = (await sh(["tmux", "ls", "-F", "#S"])).split("\n").filter(Boolean);
  const lanes = await registry.open();
  const now = Date.now();
  for (const s of listed) {
    const aoeState = ps.get(s.id);
    const tmux = tmuxNames.find((n) => n.startsWith("aoe_") && !n.startsWith("aoe_term_") && n.endsWith(`_${s.id.slice(0, 8)}`));
    if (!aoeState || !tmux || skip.has(tmux)) {
      seen.delete(s.id);
      continue;
    }
    const pane = await sh(["tmux", "capture-pane", "-p", "-t", `=${tmux}:`]);
    // omo shows "esc to interrupt" only while the main turn runs; aoe says `running` even when only background children do
    const busy = pane.includes("esc to interrupt");
    const goalContinuing = pane.includes("goal continues in");
    const lines = pane.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() && !/^[─━\s]+$/.test(l));
    const promptAt = lines.findLastIndex((l) => l.startsWith("❯"));
    // elapsed-time counters ("4m ago", "(18h 31m)") tick while a pane waits; they are not new output
    const body = (promptAt >= 0 ? lines.slice(0, promptAt) : lines).join("\n").replace(/\b\d+(?:\.\d+)?(?:ms|s|m|h|d)\b/g, "#").replace(/\b(?:retry|resets) \d{1,2}:\d{2}\b/g, "#");
    // the milestone id ("3", "4-auth") is the identity: sessions restate the same milestone in new words on each wake
    const milestone = lines.findLast((l) => /^\s*MILESTONE\b/.test(l) && !/in progress/i.test(l))?.match(/MILESTONE\s+([^\s:(]+)/)?.[1] ?? "";
    const base = { session: s.id, title: s.title, path: s.path, tmux, thread: lanes.find((l) => l.pane === tmux)?.thread ?? null, tail: lines.slice(-20).map((l) => l.slice(0, 200)) };
    const prev = seen.get(s.id);
    if (!prev) {
      seen.set(s.id, { busy, idleSince: now, notified: true, aoeState, body, milestone });
      continue;
    }
    if (milestone && milestone !== prev.milestone && !busy && goalContinuing) {
      emit({ kind: "session-milestone", ...base });
      prev.notified = true;
    }
    if (!busy) prev.milestone = milestone;
    if ((aoeState === "waiting" || aoeState === "error") && prev.aoeState !== aoeState) {
      emit({ kind: `session-${aoeState}`, ...base });
      prev.notified = true;
    }
    if (busy) prev.notified = false;
    else if (prev.busy || body !== prev.body) {
      prev.idleSince = now;
      prev.notified = false;
    }
    if (!busy && !prev.notified && !goalContinuing && now - prev.idleSince >= IDLE_SETTLE_MS) {
      emit({ kind: "session-idle", ...base });
      prev.notified = true;
    }
    prev.busy = busy;
    prev.aoeState = aoeState;
    prev.body = body;
  }
};

console.log("SESSION_WATCH_READY");
for (;;) {
  await tick().catch((e: unknown) => console.error(`SESSION-WATCH-FAIL ${e instanceof Error ? e.message : String(e)}`));
  await Bun.sleep(INTERVAL_MS);
}
