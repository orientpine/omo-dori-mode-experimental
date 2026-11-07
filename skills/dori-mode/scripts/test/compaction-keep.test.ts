import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { assignArm, keepTick, laneSessionFile, readArms, sessionUsage, trialRows, trialTable } from "../src/compaction-keep.ts";
import { freshnessTick } from "../src/freshness.ts";
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

test("a re-anchor that did not reach the pane is tried again on the next sweep, and a draft in the input box is never sent", async () => {
  const brief = join(state.dir, "brief.md");
  writeFileSync(brief, "[목표] x\n");
  const file = log();
  await deps(T0).registry.write(lane(brief, { compactionsSeen: 0 }));
  const read = async () => (await deps(T0).registry.read("keep-lane"))!;
  appendFileSync(file, compaction("[Deterministic compaction recovery checkpoint]", "senpi.compaction.deterministic-fallback.v1"));
  // Given an agent that shows no input box: the text does not arrive
  world.screens["w:p7"] = "omo has stopped\n$ ";
  expect((await keepTick(deps(T0), await read())).map((a) => a.kind)).toEqual(["reanchor-failed"]);
  expect((await read()).compactionsSeen).toBe(0);
  // When the owner left a draft in the box, nothing is typed
  world.screens["w:p7"] = "❯ half-typed note to the lane";
  const before = sent(world).length;
  expect(await keepTick(deps(T0), await read())).toEqual([]);
  expect(sent(world)).toHaveLength(before);
  // Then the next sweep with an empty box delivers it once
  world.screens["w:p7"] = "❯ ";
  expect((await keepTick(deps(T0), await read())).map((a) => a.kind)).toEqual(["reanchored"]);
  expect((await read()).compactionsSeen).toBe(1);
  expect(await keepTick(deps(T0), await read())).toEqual([]);
});

test("a lane told not-done keeps both: freshness re-anchors it after a compaction that lost its brief", async () => {
  const brief = join(state.dir, "brief.md");
  writeFileSync(brief, "[목표] x\n");
  const file = log();
  const d = deps(T0);
  await d.registry.write(lane(brief, { status: "not-done", compactionsSeen: 0 }));
  world.screens["w:p7"] = "❯ ";
  appendFileSync(file, compaction("[Deterministic compaction recovery checkpoint]", "senpi.compaction.deterministic-fallback.v1"));
  expect((await freshnessTick(d, "/home/test")).map((a) => a.kind)).toContain("reanchored");
  expect(sent(world).some((t) => t.includes(`re-read the brief at ${brief}`))).toBe(true);
  // and, in the early arm above atK, its /compact
  appendFileSync(file, compaction(`kept ${brief}`) + turn(320));
  await d.registry.patch("keep-lane", { trialArm: "early" });
  const trialDeps = deps(T0, { compactionTrial: trial });
  expect((await freshnessTick(trialDeps, "/home/test")).map((a) => a.kind)).toContain("trial-compact");
  expect(sent(world).at(-1)).toBe("/compact");
});

test("a lane whose cwd is a symlink is read under the real path too, in the sweep and in the trial table; a session with no log is counted as unknown", () => {
  const real = join(state.dir, "real-w");
  const link = join(state.dir, "link-w");
  mkdirSync(real, { recursive: true });
  symlinkSync(real, link);
  const sessions = join(state.dir, "sessions");
  const at = (cwd: string, id: string, text: string) => {
    const dir = sessionDirFor(sessions, cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `2026-11-07T14-00-00-000Z_${id}.jsonl`), text);
  };
  at(link, "old", turn(400));
  at(real, "new", turn(100) + turn(200));
  expect(laneSessionFile(sessions, link, "new")).toContain("real-w");
  const config = deps(T0, { compactionTrial: trial }).config;
  mkdirSync(join(state.dir, "compaction-trial"), { recursive: true });
  writeFileSync(join(state.dir, "compaction-trial", "arms.jsonl"), ["keep-lane", "part-lane", "lost-lane"].map((key) => JSON.stringify({ at: "x", key, arm: key === "lost-lane" ? "control" : "early", tags: [] })).join("\n") + "\n");
  const lanes = [
    lane("/b.md", { cwd: link, session: "new", priorSessions: ["old"] }),
    lane("/b.md", { key: "part-lane", cwd: link, session: "new", priorSessions: ["gone"] }),
    lane("/b.md", { key: "lost-lane", cwd: link, session: "gone-too" }),
    lane("/b.md", { key: "cleared-lane", cwd: link, session: undefined, priorSessions: ["old"] }),
  ];
  writeFileSync(join(state.dir, "compaction-trial", "arms.jsonl"), `${JSON.stringify({ at: "x", key: "cleared-lane", arm: "control", tags: [] })}\n`, { flag: "a" });
  const rows = trialRows(config, lanes);
  // a lane with a session not found, or with no current session, adds nothing to the usage columns: they average the
  // complete lanes only
  expect(rows[0]).toMatchObject({ arm: "early", lanes: 2, complete: 1, sessions: 4, missing: 1, calls: 3, over300: 1 });
  expect(rows[1]).toMatchObject({ arm: "control", lanes: 2, complete: 0, missing: 2, calls: 0 });
  const control = trialTable(rows)[3] ?? "";
  expect(control.split("|").map((c) => c.trim()).slice(3, 8)).toEqual(["0 (2)", "-", "-", "-", "-"]);
});

test("an adopted lane whose recorded cwd is not its session's directory is still found by its exact session id", async () => {
  const brief = join(state.dir, "brief.md");
  writeFileSync(brief, "[목표] x\n");
  const dir = sessionDirFor(join(state.dir, "sessions"), "/elsewhere/really");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "2026-11-07T14-00-00-000Z_sid.jsonl"), compaction("[Deterministic compaction recovery checkpoint]", "senpi.compaction.deterministic-fallback.v1"));
  await deps(T0).registry.write(lane(brief, { cwd: "/w", compactionsSeen: 0 }));
  world.screens["w:p7"] = "❯ ";
  expect((await keepTick(deps(T0), (await deps(T0).registry.read("keep-lane"))!)).map((a) => a.kind)).toEqual(["reanchored"]);
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
  world.screens["w:p7"] = "❯ a draft the owner is typing";
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
