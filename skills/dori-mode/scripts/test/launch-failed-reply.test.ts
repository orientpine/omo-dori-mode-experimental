import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { FlowDeps } from "../src/done-flow.ts";
import type { GoalRead } from "../src/goal.ts";
import { launchLane } from "../src/launch.ts";
import { sessionDirFor } from "../src/session-id.ts";
import { depsFor, fakeClock, launchReadyPath, NEW_AOE_ID, newWorld, withState, type World } from "./fakes.ts";

// A failed model reply of this launch with no failure phrase is no verdict on one read: omo retries and falls back inside
// the same turn (50 of 2275 failed replies in real sessions were followed by a good one, qa/session-errors-retry.txt), and
// no screen text proves the turn is over (dori challenge of the review 7 plan of #471). It is a failed start only where
// launch would say STARTUP_NO_GOAL: three idle reads 10 s apart, no running turn and no job of its own.

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const ID = "99999999-9999-4999-8999-999999999999";
const BOX = "────────\n❯ \n────────";
const PANE = `aoe_smoke_${NEW_AOE_ID.slice(0, 8)}`;

let state: ReturnType<typeof withState>;
let world: World;
let restorePath = () => {};
beforeEach(() => {
  restorePath = launchReadyPath();
  state = withState();
  world = newWorld();
  world.ps = `10 1 /bin/bash /dev/fd/4\n11 10 /home/u/.bun/bin/bun /x/senpi/dist/bundle/cli.js -e /x/pi-aoe-session-id.js --model m --session-id ${ID}`;
});
afterEach(() => {
  state.done();
  restorePath();
});

// the lane's own session: its prompt, then each model reply as written at `at`, failed with errorMessage when given
const session = () => {
  const sessionsDir = join(state.dir, "sessions");
  const dir = sessionDirFor(sessionsDir, "/tmp/w");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `2026-01-01T12-00-01-000Z_${ID}.jsonl`);
  appendFileSync(file, `${JSON.stringify({ type: "message", timestamp: new Date(T0 + 1_000).toISOString(), message: { role: "user", content: "brief" } })}\n`);
  const reply = (at: number, errorMessage?: string) =>
    appendFileSync(file, `${JSON.stringify({ type: "message", timestamp: new Date(at).toISOString(), message: { role: "assistant", ...(errorMessage ? { stopReason: "error", errorMessage } : { stopReason: "stop" }) } })}\n`);
  return { sessionsDir, reply };
};

// launch with the goal store giving reads[i] on the i-th read; during(i) runs before it
const launch = async (sessionsDir: string, reads: readonly GoalRead[], during: (read: number) => void = () => {}) => {
  const brief = join(state.dir, "brief.md");
  await Bun.write(brief, "# brief\n");
  let read = 0;
  const base = depsFor(world, fakeClock(T0), state.dir, { backend: "aoe", leadPane: "aoe_Dori_0a1b2c3d" });
  const deps: FlowDeps = { ...base, config: { ...base.config, sessionsDir }, readGoal: async () => { during(read); return reads[Math.min(read++, reads.length - 1)] as GoalRead; } };
  return (await launchLane(deps, { noThread: "test lane", key: "smoke", title: "smoke", brief, done: "file /tmp/ok", cwd: "/tmp/w" })).startup;
};

test("a failed reply that omo retries into a good one and a goal is STARTUP_OK, though no retry text shows", async () => {
  const s = session();
  s.reply(T0 + 5_000, "Connection error.");
  world.screen = `working on it\n${BOX}`;
  expect(await launch(s.sessionsDir, ["none", { status: "active" }], (read) => { if (read === 1) s.reply(T0 + 30_000); })).toBe(`STARTUP_OK smoke ${PANE}`);
});

test("a failed reply with no failure phrase that is still the newest after three idle reads is STARTUP_ERROR with its text, not STARTUP_NO_GOAL", async () => {
  const s = session();
  s.reply(T0 + 5_000, "usage_not_included");
  // omo's account notice for it, as its renderer wraps it at 32 columns: no own error line
  world.screen = [" The openai account usage limit ", " has been reached. Switch to    ", " another provider with /model.  ", BOX].join("\n");
  expect(await launch(s.sessionsDir, ["none"])).toBe(`STARTUP_ERROR smoke ${PANE}: usage_not_included`);
});

// a goal is good news only when this launch's newest model reply did not fail: a resumed session keeps its goal, and a lane
// may set its goal before a later call fails (review 9 of #471)
test("a session that holds a goal but whose newest reply of this launch failed is STARTUP_ERROR after the same idle reads", async () => {
  const s = session();
  s.reply(T0 + 5_000, "usage_not_included");
  world.screen = [" The openai account usage limit ", " has been reached. Switch to    ", " another provider with /model.  ", BOX].join("\n");
  expect(await launch(s.sessionsDir, [{ status: "active" }])).toBe(`STARTUP_ERROR smoke ${PANE}: usage_not_included`);
});

test("a session that holds a goal and whose failed reply a retry answers is STARTUP_OK", async () => {
  const s = session();
  s.reply(T0 + 5_000, "Connection error.");
  world.screen = `working on it\n${BOX}`;
  expect(await launch(s.sessionsDir, [{ status: "active" }], (read) => { if (read === 1) s.reply(T0 + 30_000); })).toBe(`STARTUP_OK smoke ${PANE}`);
});
