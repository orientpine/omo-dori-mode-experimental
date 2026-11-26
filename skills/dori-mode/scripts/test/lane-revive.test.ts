import { afterEach, beforeEach, expect, test } from "bun:test";

import { watchTick } from "../src/done-flow.ts";
import { reviveTarget } from "../src/lane-revive.ts";
import type { Lane } from "../src/registry.ts";
import type { Runner } from "../src/run.ts";
import { FakeHc, type FakeTerminal } from "./fake-hc.ts";
import { depsFor, fakeClock, fakeRunner, newWorld, sent, withState } from "./fakes.ts";

// 2026-11-25 23:17Z: Jjangdori's open lane h3-charsheet lost its hc terminal (hc:t27 gone); dori type said PANE_GONE, the
// watch only asked the lead to decide, and dori revive started an agent only in a pane that is still there. A gone pane of
// an open lane is opened again in a new terminal on the lane's own conversation (omo --session-id), with no prompt.
const T0 = Date.parse("2026-11-26T00:00:00Z");
const SESSION = "e365459c-71a6-4e51-a5dd-c8a7298cfb91";
const BOX = "omo · resumed\n────────\n❯ \n────────";

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

const laneOf = (patch: Partial<Lane> = {}): Lane => ({ key: "h3-charsheet", title: "H3", thread: "discord:1", brief: "/b.md", done: "file /d", openedAt: new Date(T0 - 3_600_000).toISOString(), pane: "hc:t27", session: SESSION, cwd: state.dir, model: "anthropic-subscription/claude-opus-5-5:medium", ...patch });

// hc calls go to the fake core (an agent drawing omo's box once the start line is typed), the rest to the world (the lead)
const rig = (initial: Record<string, FakeTerminal> = {}) => {
  const fake = new FakeHc(initial);
  const w = newWorld();
  w.screens["lead:p1"] = "❯ ";
  const world = fakeRunner(w);
  const run: Runner = async (argv, opts) => {
    if (argv[0] !== "hc") return world(argv, opts);
    const r = await fake.exec("hc", argv.slice(1));
    if (argv[2] === "send" && argv[3]) {
      const t = fake.terminals.get(argv[3]);
      if (t) t.screen = BOX;
    }
    return { code: r.code, out: r.stdout.trim(), err: r.stderr.trim() };
  };
  const deps = (ms: number) => ({ ...depsFor(w, fakeClock(ms), state.dir, { backend: "herdr", runtime: "hc", leadPane: "lead:p1" }), run });
  return { fake, w, deps };
};

test("dori revive <lane key> opens a lane whose hc terminal is gone in a new terminal on the same session and moves only its pane", async () => {
  // Given: the open lane's terminal hc:t27 is gone from the core
  const { fake, deps } = rig();
  const d = deps(T0);
  await d.registry.write(laneOf());
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
  const { fake, deps } = rig();
  const d = deps(T0);
  await d.registry.write(laneOf({ session: undefined }));
  expect(await reviveTarget(d, "h3-charsheet", "")).toStartWith("REVIVE_FAIL h3-charsheet: no omo session recorded");
  expect(fake.calls.some((c) => c[0] === "run")).toBe(false);
});

test("dori watch opens an open lane's gone hc terminal again on its session by itself and tells the lead, instead of asking", async () => {
  // Given: the lane's terminal is gone on two checks 30 s apart
  const { fake, w, deps } = rig();
  await deps(T0).registry.write(laneOf());
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
  const { fake, w, deps } = rig();
  await deps(T0).registry.write(laneOf({ session: undefined }));
  await watchTick(deps(T0));
  const out = (await watchTick(deps(T0 + 30_000))).filter((l) => l.startsWith("LANE_"));
  expect(out).toEqual(["LANE_DIED h3-charsheet hc:t27: hc terminal gone", "LANE_DIED_TOLD h3-charsheet lead:p1"]);
  expect(sent(w)).toEqual(["[DORI] 레인 h3-charsheet 꺼짐(hc 창 없음) — 이어서 살릴지 정해"]);
  expect(fake.calls.some((c) => c[0] === "run")).toBe(false);
});
