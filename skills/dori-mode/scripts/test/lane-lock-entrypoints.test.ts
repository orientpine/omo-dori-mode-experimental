import { afterEach, beforeEach, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { claimDone, closeLane, objectDone, pauseLane, reopenClaim, resumeLane, watchTick } from "../src/done-flow.ts";
import { lockWaits, noteLaneHistory, withLaneLock, writeOnFresh } from "../src/lane-lifecycle.ts";
import { pointLane } from "../src/lane-handover.ts";
import { reviveTarget } from "../src/lane-revive.ts";
import { adoptLane } from "../src/launch.ts";
import { type Lane, statusOf } from "../src/registry.ts";
import { syncRegistry } from "../src/sync.ts";
import { terminal } from "./fake-hc.ts";
import { sessionDirFor } from "../src/session-id.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";
import { laneOf, reviveRig, SESSION, T0 } from "./lane-revive-rig.ts";

// The lead's audit after review 16 of #535 (REPORT.md, entry-point table): every entry point that changes a lane takes the
// lane's lock, reads the record again under it, decides and writes. Each test holds the lock, calls the entry point from
// outside the holder's async context (as another process would), waits for its lock-wait event (no clock), changes the
// record while still holding the lock, lets go, and checks the entry point acted on the changed record.
let state: ReturnType<typeof withState>;
const saved = process.env["DORI_RUNTIME"];
const outside = AsyncLocalStorage.snapshot();
beforeEach(() => {
  state = withState();
  process.env["DORI_RUNTIME"] = "hc";
});
afterEach(() => {
  if (saved === undefined) delete process.env["DORI_RUNTIME"];
  else process.env["DORI_RUNTIME"] = saved;
  state.done();
});

const KEY = "h3-charsheet";
const held = async <T>(op: () => Promise<T>, change: () => Promise<void>): Promise<T> => {
  let running: Promise<T> | undefined;
  await withLaneLock(state.dir, KEY, (ms) => Bun.sleep(ms), Date.now, async () => {
    const waited = new Promise<void>((resolve) => {
      const on = (e: Event) => {
        if ((e as CustomEvent).detail !== KEY) return;
        lockWaits.removeEventListener("wait", on);
        resolve();
      };
      lockWaits.addEventListener("wait", on);
    });
    running = outside(op);
    // an entry point that never takes the lock finishes instead of waiting: the test then sees it acted on the old record
    if ((await Promise.race([waited.then(() => "waited"), running.then(() => "done", () => "done")])) === "waited") await change();
  });
  return running as Promise<T>;
};
const rig = () => reviveRig(state.dir);
const read = async (d: ReturnType<ReturnType<typeof rig>["deps"]>) => (await d.registry.read(KEY)) as Lane;
const titled = (d: ReturnType<ReturnType<typeof rig>["deps"]>) => () => d.registry.patch(KEY, { title: "changed while locked" });

test("claim-done decides on the record under the lock: a lane paused meanwhile records its claim paused", async () => {
  const { deps } = rig();
  const d = deps(T0);
  await d.registry.write(laneOf(state.dir, { thread: "none" }));
  const line = await held(() => claimDone(d, laneOf(state.dir, { thread: "none" }), "merged x"), () => d.registry.patch(KEY, { status: "paused" }));
  expect(line).toStartWith("LANE_DONE_CLAIMED_PAUSED h3-charsheet");
  expect(statusOf(await read(d))).toBe("paused");
});

test.each<[string, (d: ReturnType<ReturnType<typeof rig>["deps"]>, old: Lane) => Promise<unknown>, Partial<Lane>, string]>([
  ["a claim taken back", (d, old) => reopenClaim(d, old, "typed into"), { status: "done-claimed" }, "working"],
  ["a not-done objection", (d, old) => objectDone(d, old, ["signal not live"]), { status: "done-claimed" }, "not-done"],
  ["a pause", (d, old) => pauseLane(d, old, "owner"), {}, "paused"],
  ["a resume", (d, old) => resumeLane(d, old), { status: "paused" }, "working"],
])("%s writes onto the record as it is under the lock, keeping what was written while it waited", async (_name, op, start, status) => {
  const { deps } = rig();
  const d = deps(T0);
  const old = laneOf(state.dir, { thread: "none", ...start });
  await d.registry.write(old);
  await held(() => op(d, old).catch(() => undefined), titled(d));
  const after = await read(d);
  expect([statusOf(after), after.title]).toEqual([status, "changed while locked"]);
});

test("a close waits for the lock and closes the pane the record names then (a revive moved it while it waited)", async () => {
  const { fake, deps } = reviveRig(state.dir, { initial: { t60: terminal() } });
  const d = deps(T0);
  const old = laneOf(state.dir, { thread: "none", done: "merged acme/app#1" });
  await d.registry.write(old);
  const closed = await held(() => closeLane(d, old, "done"), () => d.registry.patch(KEY, { pane: "hc:t60" }, { relocate: true }));
  expect(closed.closed).toBe(true);
  expect([statusOf(await read(d)), (await read(d)).pane, fake.terminals.get("t60")?.state ?? "gone"]).toEqual(["closed", "hc:t60", "gone"]);
});

test("the watch marks a claim emitted only on the record under the lock: a claim taken back while it waited stays taken back", async () => {
  const { deps } = rig();
  const d = deps(T0);
  await d.registry.write(laneOf(state.dir, { thread: "none", status: "done-claimed", claim: { at: new Date(T0).toISOString(), evidence: "x", emitted: false } }));
  await held(() => watchTick(d), () => d.registry.patch(KEY, { status: "working", claim: undefined }));
  const after = await read(d);
  expect([statusOf(after), after.claim]).toEqual(["working", undefined]);
});

test("a revive waits for the lock and opens nothing for a lane closed while it waited", async () => {
  const { fake, deps } = rig();
  const d = deps(T0);
  await d.registry.write(laneOf(state.dir));
  const line = await held(() => reviveTarget(d, KEY, ""), () => d.registry.patch(KEY, { closedAt: new Date(T0).toISOString() }));
  expect(line).toStartWith("REVIVE_FAIL h3-charsheet:");
  expect(fake.calls.some((c) => c[0] === "run")).toBe(false);
});

test("a handover's move of the lane waits for the lock and keeps what was written while it waited", async () => {
  const { deps } = rig();
  const d = deps(T0);
  await d.registry.write(laneOf(state.dir));
  await held(() => pointLane({ ...d, cardDir: join(state.dir, "cards") } as never, KEY, "hc:t27", "hc:t70", "handover", () => {}), titled(d));
  const after = await read(d);
  expect([after.pane, after.title]).toEqual(["hc:t70", "changed while locked"]);
});

test("the lead handover's note on a lane and a launch's final record are written onto the record under the lock", async () => {
  const { deps } = rig();
  const d = deps(T0);
  await d.registry.write(laneOf(state.dir));
  await held(() => noteLaneHistory(d, laneOf(state.dir), (fresh) => ({ at: new Date(T0).toISOString(), status: statusOf(fresh), note: "lead moved" })), titled(d));
  expect([(await read(d)).title, (await read(d)).history?.at(-1)?.note]).toEqual(["changed while locked", "lead moved"]);
  await held(() => writeOnFresh(d, laneOf(state.dir, { model: "m/x" })), () => d.registry.patch(KEY, { pendingGoal: { idle: 0 } }));
  expect([(await read(d)).model, (await read(d)).pendingGoal]).toEqual(["m/x", { idle: 0 }]);
});

test("an adopt waits for the lock before it writes the new record (Registry.write takes the lane lock itself)", async () => {
  const w = newWorld();
  w.panes.push({ pane_id: "w:p2", workspace_id: "w" });
  const d = depsFor(w, fakeClock(T0), state.dir);
  const brief = join(state.dir, "brief.md");
  writeFileSync(brief, "# task\n- Done = closed acme/app#3.\n");
  let during: Lane | null = null;
  const lane = await held(() => adoptLane(d, { key: KEY, title: "t", brief, done: "closed acme/app#3", pane: "w:p2" }), async () => {
    during = await d.registry.read(KEY);
  });
  expect([during, lane.pane, (await d.registry.read(KEY))?.pane]).toEqual([null, "w:p2", "w:p2"]);
});

test("dori sync --write writes a new session only onto the record under the lock, and not after a move of the pane", async () => {
  process.env["DORI_RUNTIME"] = "herdr";
  const w = newWorld();
  w.panes.push({ pane_id: "w:p2", workspace_id: "w", cwd: state.dir });
  w.ps = `4000 1 -bash\n4001 4000 omo --session-id 77777777-2222-4333-8444-555555555555\n`;
  const next = "77777777-2222-4333-8444-555555555555", sessionsDir = join(state.dir, "sessions"), logs = sessionDirFor(sessionsDir, state.dir);
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, `2026-11-27T00-00-00-000Z_${next}.jsonl`), `${JSON.stringify({ type: "session", id: next, cwd: state.dir })}\n`);
  const d = depsFor(w, fakeClock(T0), state.dir, { backend: "herdr", sessionsDir });
  await d.registry.write(laneOf(state.dir, { pane: "w:p2", session: SESSION }));
  await held(() => syncRegistry(d, true), () => d.registry.patch(KEY, { pane: "hc:t80" }, { relocate: true }));
  const after = (await d.registry.read(KEY)) as Lane;
  expect([after.pane, after.session]).toEqual(["hc:t80", SESSION]);
});
