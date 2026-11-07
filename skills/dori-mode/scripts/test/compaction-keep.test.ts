import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { assignArm, keepTick, readArms, sessionUsage } from "../src/compaction-keep.ts";
import type { DoriConfig } from "../src/config.ts";
import type { Lane } from "../src/registry.ts";
import { sessionDirFor } from "../src/session-id.ts";
import { depsFor, fakeClock, newWorld, RUNNING, sent, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-11-07T14:00:00.000Z");
const H = 3_600_000;
let state: ReturnType<typeof withState>;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

const trial = { from: new Date(T0 - H).toISOString(), until: new Date(T0 + 96 * H).toISOString(), atK: 300, exclude: "rl|render" };
const deps = (ms: number, patch: Partial<DoriConfig> = {}) => depsFor(world, fakeClock(ms), state.dir, { sessionsDir: join(state.dir, "sessions"), ...patch });

const lane = (brief: string, extra: Partial<Lane> = {}): Lane => ({ key: "keep-lane", title: "keep", thread: "none", pane: "w:p7", brief, done: "file /tmp/ok", goal: "형 원문 그대로", cwd: "/w", session: "sid", openedAt: new Date(T0).toISOString(), lastReplyAt: T0, ...extra });

const log = (): string => {
  const dir = sessionDirFor(join(state.dir, "sessions"), "/w");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "2026-11-07T14-00-00-000Z_sid.jsonl");
  writeFileSync(file, "");
  return file;
};
const turn = (k: number) => `${JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 2, cacheRead: k * 1000, cacheWrite: 0, output: 10 } } })}\n`;
const compaction = (summary: string, schema = "senpi.compaction.summary.v1") => `${JSON.stringify({ type: "compaction", summary, details: { schema } })}\n`;

test("a compaction whose summary lost the brief path re-anchors the lane once with its goal, Done and the owner's words; one that kept it does not", async () => {
  // Given a working lane whose session log the sweep has read once
  const brief = join(state.dir, "brief.md");
  writeFileSync(brief, "ulw\n\n[목표] 압축 뒤에도 과제를 잃지 않게 한다.\n");
  const file = log();
  appendFileSync(file, turn(100));
  await deps(T0).registry.write(lane(brief));
  world.screens["w:p7"] = "❯ ";
  expect(await keepTick(deps(T0), lane(brief))).toEqual([]);
  // When omo's deterministic fallback compacts it
  appendFileSync(file, compaction("[Deterministic compaction recovery checkpoint]", "senpi.compaction.deterministic-fallback.v1"));
  const first = await keepTick(deps(T0 + 60_000), (await deps(T0).registry.read("keep-lane"))!);
  // Then the lane is told once, with the anchor
  expect(first.map((a) => a.kind)).toEqual(["reanchored"]);
  expect(sent(world)).toHaveLength(1);
  expect(sent(world)[0]).toContain(`re-read the brief at ${brief}`);
  expect(sent(world)[0]).toContain("[목표] 압축 뒤에도 과제를 잃지 않게 한다.");
  expect(sent(world)[0]).toContain("Done = file /tmp/ok");
  expect(sent(world)[0]).toContain(`Owner's words: "형 원문 그대로"`);
  expect(await keepTick(deps(T0 + 120_000), (await deps(T0).registry.read("keep-lane"))!)).toEqual([]);
  // And a generated summary that kept the brief path is left alone
  appendFileSync(file, compaction(`## 1. User Requests (Verbatim)\n- "Read and execute the lane brief at ${brief} in full."`));
  expect(await keepTick(deps(T0 + 180_000), (await deps(T0).registry.read("keep-lane"))!)).toEqual([]);
  expect(sent(world)).toHaveLength(1);
});

test("the trial puts launched lanes in arms in turn and leaves excluded ones out, once per key", () => {
  const config = deps(T0, { compactionTrial: trial }).config;
  expect(assignArm(config, "a", [], T0)).toBe("early");
  expect(assignArm(config, "b", [], T0)).toBe("control");
  expect(assignArm(config, "rl-e9", ["rl"], T0)).toBeUndefined();
  expect(assignArm(config, "c", [], T0)).toBe("early");
  expect(assignArm(config, "b", [], T0)).toBe("control");
  expect(readArms(state.dir).map((a) => a.arm)).toEqual(["early", "control", "excluded", "early"]);
  expect(assignArm({ ...config, compactionTrial: { ...trial, until: "" } }, "d", [], T0)).toBeUndefined();
  expect(assignArm(config, "e", [], T0 + 97 * H)).toBeUndefined();
});

test("an early-arm lane gets /compact at its idle moment once its context reaches atK, not while a turn runs, not below it, not in control", async () => {
  const brief = join(state.dir, "brief.md");
  writeFileSync(brief, "[목표] x\n");
  const file = log();
  const d = (ms: number) => deps(ms, { compactionTrial: trial });
  await d(T0).registry.write(lane(brief, { trialArm: "early", compactionsSeen: 0 }));
  const read = async () => (await d(T0).registry.read("keep-lane"))!;
  appendFileSync(file, turn(250));
  world.screens["w:p7"] = "❯ ";
  expect(await keepTick(d(T0), await read())).toEqual([]);
  appendFileSync(file, turn(310));
  world.screens["w:p7"] = `${RUNNING}\n❯ `;
  expect(await keepTick(d(T0), await read())).toEqual([]);
  world.screens["w:p7"] = "❯ ";
  expect((await keepTick(d(T0 + 60_000), await read())).map((a) => a.kind)).toEqual(["trial-compact"]);
  expect(sent(world)).toEqual(["/compact"]);
  // the same compaction count is not typed again within 30 minutes
  expect(await keepTick(d(T0 + 120_000), await read())).toEqual([]);
  await d(T0).registry.patch("keep-lane", { trialArm: "control" });
  expect(await keepTick(d(T0 + 40 * 60_000), await read())).toEqual([]);
  expect(sent(world)).toEqual(["/compact"]);
});

test("session usage counts calls, context, compactions with fallbacks, and reads after a compaction of paths read before it", () => {
  const read = (path: string) => `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path } }] } })}\n`;
  const text = [turn(100), read("/a"), read("/b"), turn(400), compaction("s", "senpi.compaction.deterministic-fallback.v1"), read("/a"), read("/a"), read("/c"), turn(50)].join("");
  expect(sessionUsage(text)).toMatchObject({ calls: 3, over300: 1, compactions: 1, fallbacks: 1, rereads: 1 });
});
