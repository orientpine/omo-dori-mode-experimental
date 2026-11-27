import { afterEach, beforeEach, expect, test } from "bun:test";

import { watchTick } from "../src/done-flow.ts";
import { reviveTarget } from "../src/lane-revive.ts";
import type { Lane } from "../src/registry.ts";
import { sent, withState } from "./fakes.ts";
import { laneOf, reviveRig, SESSION, T0 } from "./lane-revive-rig.ts";

// 2026-11-25 23:17Z: Jjangdori's open lane h3-charsheet lost its hc terminal (hc:t27 gone); dori type said PANE_GONE, the
// watch only asked the lead to decide, and dori revive started an agent only in a pane that is still there. A gone pane of
// an open lane is opened again in a new terminal on the lane's own conversation (omo --session-id), with no prompt.
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

test("dori revive <lane key> opens a lane whose hc terminal is gone in a new terminal on the same session and moves only its pane", async () => {
  // Given: the open lane's terminal hc:t27 is gone from the core
  const { fake, deps } = reviveRig(state.dir);
  const d = deps(T0);
  await d.registry.write(laneOf(state.dir));
  const before = await d.registry.read("h3-charsheet");
  // When
  const line = await reviveTarget(d, "h3-charsheet", "");
  // Then: a new labelled terminal in the lane's cwd runs omo on the recorded session and model, and nothing else is typed
  expect(line).toBe(`REVIVE_OK h3-charsheet hc:t1 session ${SESSION} (pane hc:t27 was gone)`);
  const created = fake.calls.find((c) => c[0] === "run") ?? [];
  expect(created).toContain("dori.lane=h3-charsheet");
  expect(created[created.indexOf("--cwd") + 1]).toBe(state.dir);
  expect(fake.sent.length).toBe(1);
  const start = fake.sent[0]?.text ?? "";
  expect(start).toContain(`--session-id ${SESSION}`);
  expect(start).toContain("--model anthropic-subscription/claude-opus-5-5 --thinking medium");
  // the record keeps every field but its pane (and the session ref it mirrors)
  const after = await d.registry.read("h3-charsheet");
  const { pane: _p, sessionRef: _r, ...kept } = after ?? ({} as Lane);
  const { pane: _p0, sessionRef: _r0, ...was } = before ?? ({} as Lane);
  expect(after?.pane).toBe("hc:t1");
  expect(kept).toEqual(was);
  // a second revive finds it running
  expect(await reviveTarget(d, "hc:t1", "")).toBe("REVIVE_ALREADY_RUNNING hc:t1");
});

test("a lane with no recorded session is not opened on a new conversation", async () => {
  const { fake, deps } = reviveRig(state.dir);
  const d = deps(T0);
  await d.registry.write(laneOf(state.dir, { session: undefined }));
  expect(await reviveTarget(d, "h3-charsheet", "")).toStartWith("REVIVE_FAIL h3-charsheet: no omo session recorded");
  expect(fake.calls.some((c) => c[0] === "run")).toBe(false);
});

test("dori watch opens an open lane's gone hc terminal again on its session by itself and tells the lead, instead of asking", async () => {
  // Given: the lane's terminal is gone on two checks 30 s apart
  const { fake, w, deps } = reviveRig(state.dir);
  await deps(T0).registry.write(laneOf(state.dir));
  const lines = (out: string[]) => out.filter((l) => l.startsWith("LANE_"));
  expect(lines(await watchTick(deps(T0)))).toEqual([]);
  // When: the confirming check
  const out = lines(await watchTick(deps(T0 + 30_000)));
  // Then: revived in a new terminal, the lead told what happened (no "살릴지 정해"), the lane typed nothing but its start
  expect(out).toEqual(["LANE_DIED h3-charsheet hc:t27: hc terminal gone", `LANE_REVIVED h3-charsheet hc:t1 session ${SESSION} (pane hc:t27 was gone)`, "LANE_REVIVED_TOLD h3-charsheet lead:p1"]);
  expect(sent(w)).toEqual(["[DORI] 레인 h3-charsheet 창이 없어져 새 창 hc:t1에서 같은 대화로 다시 열었어 (일은 시키지 않음)"]);
  expect(fake.sent.length).toBe(1);
  expect((await deps(T0).registry.read("h3-charsheet"))?.pane).toBe("hc:t1");
  // and the next check finds it live: nothing more
  expect(lines(await watchTick(deps(T0 + 60_000)))).toEqual([]);
});

test("a gone lane terminal with no session to resume is still left to the lead", async () => {
  const { fake, w, deps } = reviveRig(state.dir);
  await deps(T0).registry.write(laneOf(state.dir, { session: undefined }));
  await watchTick(deps(T0));
  const out = (await watchTick(deps(T0 + 30_000))).filter((l) => l.startsWith("LANE_"));
  expect(out).toEqual(["LANE_DIED h3-charsheet hc:t27: hc terminal gone", "LANE_DIED_TOLD h3-charsheet lead:p1"]);
  expect(sent(w)).toEqual(["[DORI] 레인 h3-charsheet 꺼짐(hc 창 없음) — 이어서 살릴지 정해"]);
  expect(fake.calls.some((c) => c[0] === "run")).toBe(false);
});
