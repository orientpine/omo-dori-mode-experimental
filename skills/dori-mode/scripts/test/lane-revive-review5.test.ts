import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { reviveTarget } from "../src/lane-revive.ts";
import type { Question } from "../src/messenger/discord-cards.ts";
import { answerLine, unansweredRows } from "../src/missed-answers.ts";
import { sessionDirFor } from "../src/session-id.ts";
import { withState } from "./fakes.ts";
import { laneOf, reviveRig, SESSION, T0 } from "./lane-revive-rig.ts";

// Review 5 of #535: an interrupted handover (its journal left for repair, its owner dead) moves the lane itself, so a
// revive opens nothing; an answer given while the pane was gone counts as seen once the revived session read it, whether
// that lane is still open or closed since.
let state: ReturnType<typeof withState>;
const saved = process.env["DORI_RUNTIME"];
beforeEach(() => {
  state = withState();
  process.env["DORI_RUNTIME"] = "hc";
});
afterEach(() => {
  if (saved === undefined) delete process.env["DORI_RUNTIME"];
  else process.env["DORI_RUNTIME"] = saved;
  state.done();
});

test("a lane whose interrupted handover left its journal (owner dead) is not revived: the repair moves it", async () => {
  // Given: the pending journal of a handover whose process is gone
  const dir = join(state.dir, "handover", "lanes");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "h3-charsheet.pending.json"), JSON.stringify({ key: "h3-charsheet", pid: 2_147_483_000, from: "hc:t27", to: "hc:t9", at: new Date(T0).toISOString() }));
  const { fake, deps } = reviveRig(state.dir);
  const d = deps(T0);
  await d.registry.write(laneOf(state.dir));
  // When / Then
  expect(await reviveTarget(d, "h3-charsheet", "")).toStartWith("REVIVE_FAIL h3-charsheet: an interrupted handover of the lane is left in");
  expect(fake.calls.some((c) => c[0] === "run")).toBe(false);
});

type Case = { readonly closed?: boolean; readonly handover?: "moved" | "current"; readonly sessionDir?: boolean };
const NEXT = "77777777-2222-4333-8444-555555555555";

const answered = async (c: Case) => {
  // Given: a card asked from hc:t27 with no session of its own (dori ask without --session) was answered while the pane
  // was gone; the lane was revived (its move recorded), maybe moved on by a handover, maybe with its own --session-dir
  const own = join(state.dir, "own-sessions");
  const { deps } = reviveRig(state.dir);
  const answeredAt = new Date(T0).toISOString();
  const version: Question = { id: "Q1", text: "keep the GPU off?", options: ["yes", "no"], channel: "1", thread: null, session: null, tmux: "hc:t27", created: answeredAt, status: "answered", answer: "yes", answerKind: "button", answeredAt };
  const base = deps(T0 + 600_000);
  const config = { ...base.config, sessionsDir: join(state.dir, "sessions"), ...(c.sessionDir ? { agentCommand: ["omo", "--session-dir", own, "--model", "{model}", "{prompt}"] } : {}) };
  const d = { ...base, config, answerHistory: () => [version] };
  await d.registry.write(laneOf(state.dir));
  expect(await reviveTarget(d, "h3-charsheet", "")).toStartWith("REVIVE_OK h3-charsheet hc:t1");
  if (c.handover) await d.registry.patch("h3-charsheet", { session: NEXT, pane: "hc:t2" });
  if (c.closed) await d.registry.patch("h3-charsheet", { closedAt: new Date(T0 + 900_000).toISOString() });
  // the answer is in the log of the session that read it: the revived one, or the one the handover started
  const reader = c.handover === "current" ? NEXT : SESSION;
  const logs = c.sessionDir ? own : sessionDirFor(config.sessionsDir, state.dir);
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, `2026-11-21T15-48-52-096Z_${reader}.jsonl`), [{ type: "session", id: reader, cwd: state.dir }, { type: "message", message: { role: "user", content: answerLine(version) } }].map((e) => JSON.stringify(e)).join("\n"));
  const lead = join(state.dir, "lead.jsonl");
  writeFileSync(lead, "");
  // When
  return unansweredRows({ rows: [{ id: "a1", qid: "Q1", tmux: "hc:t27", at: T0 }], cards: [], lead: { pane: "lead:p1", path: lead, title: "" }, sessions: [], table: [], deps: d });
};

test.each<[string, Case]>([
  ["lane still open", {}],
  ["lane closed since", { closed: true }],
  ["a handover after the revive, the answer read before it", { handover: "moved" }],
  ["a handover after the revive, the answer read after it, lane closed since", { handover: "current", closed: true }],
  ["the agent keeps its sessions in its own --session-dir", { sessionDir: true }],
  ["own --session-dir, lane closed since", { sessionDir: true, closed: true }],
])("an answer given while the pane was gone counts as seen once the revived conversation read it: %s", async (_name, c) => {
  expect(await answered(c)).toEqual([]);
});
