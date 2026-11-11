import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { closeLane } from "../src/done-flow.ts";
import { recordHerdrSession } from "../src/herdr-sessions.ts";
import { reconcileRows } from "../src/missed-answers.ts";
import { type Lane, statusOf } from "../src/registry.ts";
import { sessionDirFor } from "../src/session-id.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

test.each(["default", "recorded-log"])("card delivery survives lane closure before its first reconciliation (%s)", async (kind) => {
  const state = withState(), at = Date.parse("2026-01-01T12:00:00Z"), pane = "aoe_asking_12345678";
  const id = "11111111-1111-1111-1111-111111111111", cwd = "/repo/asking";
  const world = newWorld(), clock = fakeClock(at + 1000), sessionsDir = join(state.dir, "sessions");
  const deps = depsFor(world, clock, state.dir, { backend: "aoe", sessionsDir });
  const lane: Lane = { key: "asking-lane", title: "asking", thread: "none", pane, session: id, cwd, brief: "/brief", done: "merged acme/app#1", openedAt: new Date(at - 60_000).toISOString() };
  const folder = kind === "default" ? sessionDirFor(sessionsDir, cwd) : join(state.dir, "custom logs");
  mkdirSync(folder, { recursive: true });
  const path = join(folder, `2026-01-01T11-59-00-000Z_${id}.jsonl`);
  const delivered = { id: "answer-delivered", qid: "Q1", tmux: pane, thread: "CARD", at };
  const pending = { ...delivered, id: "answer-pending", qid: "Q11" };
  writeFileSync(path, `${JSON.stringify({ type: "custom_message", customType: "senpi-monitor:notification", content: JSON.stringify({ kind: "answer", qid: "Q1", id: delivered.id, ts: new Date(at).toISOString() }) })}\n`);
  if (kind === "recorded-log") recordHerdrSession(state.dir, pane, { session: id, cwd, log: path, at: new Date(at).toISOString() });
  const leadPath = join(state.dir, "lead.jsonl");
  writeFileSync(leadPath, "");
  try {
    await deps.registry.write(lane);
    expect(existsSync(join(state.dir, "lead-answered.json"))).toBe(false);
    expect((await closeLane(deps, lane, "delivered answer then finished")).closed).toBe(true);
    expect(statusOf((await deps.registry.read(lane.key)) ?? lane)).toBe("closed");
    const input = { rows: [delivered, pending], cards: [], lead: { pane: "lead", path: leadPath, title: "", text: "" }, sessions: [], table: [], deps };
    expect(await reconcileRows(input)).toEqual({ waiting: [pending], answeredIds: [delivered.id] });
    expect(JSON.parse(readFileSync(join(state.dir, "lead-answered.json"), "utf8"))).toEqual([delivered.id]);
  } finally { state.done(); }
});
