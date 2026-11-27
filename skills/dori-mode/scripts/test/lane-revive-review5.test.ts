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

const answered = async (lane: Parameters<typeof laneOf>[1]) => {
  // Given: the card was asked from hc:t27; the lane runs that session in hc:t1 now, and its log holds the answer
  const { deps } = reviveRig(state.dir);
  const answeredAt = new Date(T0).toISOString();
  const version: Question = { id: "Q1", text: "keep the GPU off?", options: ["yes", "no"], channel: "1", thread: null, session: SESSION, tmux: "hc:t27", created: answeredAt, status: "answered", answer: "yes", answerKind: "button", answeredAt };
  const d = { ...deps(T0 + 600_000), config: { ...deps(T0).config, sessionsDir: join(state.dir, "sessions") }, answerHistory: () => [version] };
  await d.registry.write(laneOf(state.dir, { pane: "hc:t1", ...lane }));
  const logs = sessionDirFor(d.config.sessionsDir, state.dir);
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, `2026-11-21T15-48-52-096Z_${SESSION}.jsonl`), [{ type: "session", id: SESSION, cwd: state.dir }, { type: "message", message: { role: "user", content: answerLine(version) } }].map((e) => JSON.stringify(e)).join("\n"));
  const lead = join(state.dir, "lead.jsonl");
  writeFileSync(lead, "");
  // When
  return unansweredRows({ rows: [{ id: "a1", qid: "Q1", tmux: "hc:t27", at: T0 }], cards: [], lead: { pane: "lead:p1", path: lead, title: "" }, sessions: [], table: [], deps: d });
};

test("an answer given while the pane was gone counts as seen once the revived session read it (lane still open)", async () => {
  expect(await answered({})).toEqual([]);
});

test("the same answer still counts as seen after the revived lane closed", async () => {
  expect(await answered({ closedAt: new Date(T0 + 300_000).toISOString() })).toEqual([]);
});
