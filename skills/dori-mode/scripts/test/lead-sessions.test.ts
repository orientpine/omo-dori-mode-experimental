import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { laneSessionFiles } from "../src/auto-signals.ts";
import { defaultConfig } from "../src/config.ts";
import { logSources, readLaneLogs } from "../src/lane-signals.ts";
import { leadSessionFiles, leadSessionIds } from "../src/lead-sessions.ts";
import type { Lane } from "../src/registry.ts";
import { computeScorecard, dayWindow } from "../src/scorecard.ts";
import { withState } from "./fakes.ts";

let state: ReturnType<typeof withState>;
beforeEach(() => { state = withState(); });
afterEach(() => state.done());

const OLD = "11111111-1111-4111-8111-111111111111";
const NEW = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const fileName = (id: string) => `2026-03-01T09-00-00-000Z_${id}.jsonl`;
const lane: Lane = { key: "work", title: "work", pane: "aoe_work_01234567", thread: "none", brief: "/b.md", done: "tests pass", cwd: "/work", openedAt: "2026-03-01T00:00:00Z" };

test.each([
  { name: "only the lead when lanes share its folder", ids: [OLD], cost: 1 },
  { name: "the whole folder when the id set becomes empty", ids: [], cost: 43 },
  { name: "old and new leads across a handover", ids: [OLD, NEW], cost: 3 },
])("lead metrics count $name", async ({ ids, cost }) => {
  // Given: every session has cost, a reply, a re-send and a distinct report.
  const dir = join(state.dir, "lead");
  const history = join(state.dir, "handover");
  mkdirSync(dir);
  mkdirSync(history);
  const facts = join(history, "20260301-090000.json");
  writeFileSync(facts, JSON.stringify({ from: { session: OLD } }));
  if (ids.some((id) => id === NEW)) {
    writeFileSync(join(history, "20260301-090000.result.json"), JSON.stringify({ from: { session: OLD }, to: { session: NEW }, result: "done-frozen" }));
  }
  for (const [id, amount] of [[OLD, 1], [NEW, 2], [OTHER, 40]] as const) {
    const entry = (message: unknown) => JSON.stringify({ type: "message", timestamp: "2026-03-01T09:00:10Z", message });
    writeFileSync(join(dir, fileName(id)), [
      JSON.stringify({ type: "custom_message", timestamp: "2026-03-01T09:00:01Z", content: `inbox id=${id}` }),
      entry({ role: "assistant", usage: { input: amount * 100, cost: { total: amount, cacheRead: amount / 2 } }, content: [{ type: "toolCall", arguments: { code: `run(["tmux","send-keys","-t","=${lane.pane}:","-l","--","[LEAD] retry"])` } }] }),
      entry({ role: "toolResult", content: [{ type: "text", text: "POSTED 123456" }] }),
      entry({ role: "user", content: [{ type: "text", text: `[REPORT] work | milestone | result ${id}` }] }),
    ].join("\n"));
  }
  const inbox = join(state.dir, "inbox.jsonl");
  writeFileSync(inbox, [OLD, NEW, OTHER].map((id) => JSON.stringify({ id, author_id: "owner", ts: "2026-03-01T09:00:00Z" })).join("\n"));
  const config = { ...defaultConfig(), stateDir: state.dir, sessionsDir: join(state.dir, "sessions"), scorecard: { ...defaultConfig().scorecard, leadSessions: dir } };
  if (ids.length === 0) {
    // Prove identity selection before dropping the only record; this transition
    // also catches removal of filtering, unlike a fallback-only assertion.
    expect(leadSessionFiles(dir, state.dir)).toEqual([join(dir, fileName(OLD))]);
    rmSync(facts);
  }

  // When: all three readers scan the same mixed folder.
  const files = leadSessionFiles(dir, state.dir);
  const card = await computeScorecard({ stateDir: state.dir, sessionsDir: dir, settings: config.scorecard, lanes: [lane], inbox, owner: "owner" }, dayWindow("2026-03-01", "UTC", 0));
  const logs = (await readLaneLogs([lane], logSources(config))).get(lane.key);
  const repeatFiles = laneSessionFiles(config, lane);

  // Then: each reader uses the same identities; aggregate cost stays host-wide.
  const expected = (ids.length ? ids : [OLD, NEW, OTHER]).map((id) => join(dir, fileName(id))).sort();
  expect([...leadSessionIds(state.dir)].sort()).toEqual([...ids]);
  expect(files.sort()).toEqual(expected);
  expect(repeatFiles.sort()).toEqual(expected);
  expect(card.cost).toBe(43);
  expect(card.lead?.cost).toBe(cost);
  expect(card.lead?.cacheReadCost).toBe(cost / 2);
  expect(card.reply?.n).toBe(expected.length);
  expect(card.rework[0]?.sends).toBe(expected.length);
  expect(logs?.sends).toBe(expected.length);
  expect(logs?.mentions.filter((m) => m.via === "report")).toHaveLength(expected.length);
});

test("lead selection ignores incomplete records and keeps the lane's own files", () => {
  // Given: only one lead identity, plus unrelated and incomplete state files.
  const history = join(state.dir, "handover");
  const leadDir = join(state.dir, "lead");
  const config = { ...defaultConfig(), stateDir: state.dir, sessionsDir: join(state.dir, "sessions"), scorecard: { ...defaultConfig().scorecard, leadSessions: leadDir } };
  const own = join(config.sessionsDir, "--work--");
  mkdirSync(history);
  mkdirSync(leadDir);
  mkdirSync(own, { recursive: true });
  writeFileSync(join(history, "facts.json"), JSON.stringify({ from: { session: OLD }, to: { session: "" } }));
  writeFileSync(join(history, "partial.result.json"), "{");
  writeFileSync(join(history, "other.json"), JSON.stringify({ session: OTHER }));
  for (const id of [OLD, OTHER]) writeFileSync(join(leadDir, fileName(id)), "");
  writeFileSync(join(own, fileName(OTHER)), "");

  // When: auto-signals combines its own files with the filtered lead files.
  const files = laneSessionFiles(config, lane);

  // Then: the unrelated file is admitted only from the lane's own folder.
  expect(files.sort()).toEqual([join(leadDir, fileName(OLD)), join(own, fileName(OTHER))].sort());
});
