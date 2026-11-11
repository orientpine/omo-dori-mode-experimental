import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { manifestPath } from "../src/handover.ts";
import type { LaneHandoverDeps } from "../src/lane-handover.ts";
import type { Lane } from "../src/registry.ts";
import { auditHandover, type Classify, committedHandovers, readAudit } from "../src/rollover-audit.ts";
import { sessionDirFor } from "../src/session-id.ts";
import { depsFor, fakeClock, newWorld, sent, withState, type World } from "./fakes.ts";

// dori review #407 round 1: the audit after a lane handover's commit still asked for the path watches the note marked
// ENDED (zzangdori's rv-human-natural, 2026-11-08: a watch whose folder the lane deleted, one whose file had appeared), so
// it would send a false monitor gap the new session cannot close.
const NEW = "aoe_demo-10191000_5e5e5e5e";
const CWD = "/work/demo";
const STAMP = "demo-20261019-100000";
const RESTATE = "## Goal\nship it\n## Owner's words\nnone\n## Decisions\nnone\n## Next step\nship it\n## Ruled out\nnone\n## Questions\nnone\n";

let state: { dir: string; done: () => void };
let w: World;
beforeEach(() => {
  state = withState();
  w = newWorld();
});
afterEach(() => state.done());

const lane = (): Lane => ({ key: "demo", title: "Demo lane", thread: "discord:1", pane: NEW, session: "new-sid", brief: join(state.dir, "demo-brief.md"), done: "merged o/r#1", cwd: CWD, model: "anthropic-subscription/claude-opus-5-5:high", goal: "ship it", openedAt: "2026-10-18T00:00:00Z", status: "working" });

const handover = (monitors: readonly unknown[], newMonitors: readonly unknown[]) => {
  const dir = join(state.dir, "handover", "lanes");
  const stem = join(dir, STAMP);
  const sessionDir = sessionDirFor(join(state.dir, "sessions"), CWD);
  mkdirSync(dir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  const oldLog = join(sessionDir, "2026-10-18T00-00-00-000Z_old-sid.jsonl");
  writeFileSync(oldLog, "");
  writeFileSync(lane().brief, "Do the work. Done: merged o/r#1.\n");
  writeFileSync(`${stem}.md`, "# Lane handover demo\n");
  writeFileSync(`${stem}.json`, JSON.stringify({ lane: lane(), from: { pane: "aoe_demo_old", aoeId: "1a", session: "old-sid", title: "demo", cwd: CWD }, cwd: CWD, model: "m", monitors, todos: [], chains: [], detached: [], laneNote: "", signals: {}, oldLog }));
  writeFileSync(`${stem}.result.json`, JSON.stringify({ at: "2026-10-19T10:01:00.000Z", key: "demo", from: {}, to: NEW, note: `${stem}.md`, result: "done", reasons: [] }));
  writeFileSync(`${stem}.understood.md`, RESTATE);
  writeFileSync(join(sessionDir, "2026-10-19T10-00-00-000Z_new-sid.jsonl"), "");
  const manifest = manifestPath(join(state.dir, "sessions"), CWD, "new-sid");
  mkdirSync(join(manifest, ".."), { recursive: true });
  writeFileSync(manifest, JSON.stringify({ version: 1, sessionId: "new-sid", monitors: newMonitors }));
};

const setup = async (): Promise<LaneHandoverDeps> => {
  const base = depsFor(w, fakeClock(Date.parse("2026-10-19T10:11:00Z")), state.dir, { backend: "aoe", sessionsDir: join(state.dir, "sessions") });
  w.tmux = [NEW];
  w.screens[NEW] = "❯ ";
  await base.registry.write(lane());
  let n = 0;
  return { ...base, cardDir: join(state.dir, "discord"), home: "/home/test", sessionOf: async (pane) => (pane === NEW ? "new-sid" : ""), procs: async () => [], envOf: () => "", alive: () => false, signal: () => true, realpath: (p) => p, nonce: () => `s${++n}`, print: () => {}, inbox: join(state.dir, "inbox.jsonl"), ownerIds: ["owner-1"] };
};

const none: Classify = async (items) => ({ verdicts: items.map(() => ({ verdict: "CHATTER" as const, why: "test" })), model: "test/model" });

test("the audit asks for no path watch that has ended (its folder gone, or its file there); one still waiting and not armed is still a gap", async () => {
  // Given
  const files = join(state.dir, "watched");
  mkdirSync(join(files, "build"), { recursive: true });
  writeFileSync(join(files, "ci.done"), "exit=0\n");
  const gone = { description: "lane folder", path: join(files, "heavy", "ab3.done"), event: "create", persistent: true, ended: `its folder ${join(files, "heavy")} is gone, so omo cannot watch it` };
  const fired = { description: "ci", path: join(files, "ci.done"), event: "create", persistent: true };
  const waiting = { description: "build", path: join(files, "build", "done"), event: "create", persistent: true };
  handover([gone, fired, waiting], []);
  // When
  await auditHandover(await setup(), committedHandovers(state.dir)[0] ?? (() => { throw new Error("no handover"); })(), { classify: none });
  // Then
  expect(readAudit(state.dir).filter((x) => x.kind === "monitor").map((x) => x.text)).toEqual(["build"]);
  const supplements = sent(w).filter((l) => l.startsWith("[LEAD] HANDOVER_SUPPLEMENT"));
  expect(supplements).toHaveLength(1);
});

test("the audit asks for no command watch the new session ran to its end after its signal; one never armed is still a gap", async () => {
  // Given: omo dropped the ended gate from the manifest; its call and its wake are in the new session's log
  const gate = { description: "x ready", command: "until [ -f /tmp/x ]; do sleep 5; done; echo READY", filter: "^READY$", persistent: true };
  const other = { description: "y ready", command: "until [ -f /tmp/y ]; do sleep 5; done; echo READY", filter: "^READY$", persistent: true };
  handover([gate, other], []);
  const call = { type: "message", message: { role: "toolResult", toolName: "eval", details: { toolCalls: [{ name: "monitor", ok: true, args: gate }] } } };
  const wake = { type: "custom_message", customType: "senpi-monitor:notification", content: "<system-reminder>Monitor event(x ready): READY\nwatcher completed (exit code 0)</system-reminder>", details: { monitors: [{ id: "bash_1", description: "x ready", eventCount: 2, kinds: ["line", "summary"] }] } };
  writeFileSync(join(sessionDirFor(join(state.dir, "sessions"), CWD), "2026-10-19T10-00-00-000Z_new-sid.jsonl"), `${JSON.stringify(call)}\n${JSON.stringify(wake)}\n`);
  // When
  await auditHandover(await setup(), committedHandovers(state.dir)[0] ?? (() => { throw new Error("no handover"); })(), { classify: none });
  // Then
  expect(readAudit(state.dir).filter((x) => x.kind === "monitor").map((x) => x.text)).toEqual(["y ready"]);
});
