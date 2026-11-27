import { afterEach, beforeEach, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";

import { closeLane, watchTick } from "../src/done-flow.ts";
import { lockWaits } from "../src/lane-lifecycle.ts";
import { reviveTarget } from "../src/lane-revive.ts";
import { QuestionStore } from "../src/messenger/discord-cards.ts";
import type { LaneDied } from "../src/registry.ts";
import { withState } from "./fakes.ts";
import { laneOf, reviveRig, SESSION, T0 } from "./lane-revive-rig.ts";

// Review 1 of #535: a revive must never leave the conversation running in a pane no record names, never open a second
// agent for a pane it only failed to read, never bring back a lane closed meanwhile, must still run for a lane marked dead
// before, and must take the lane's open question cards along.
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

const pane = async (deps: ReturnType<ReturnType<typeof reviveRig>["deps"]>) => (await deps.registry.read("h3-charsheet"))?.pane;

test("an agent start whose outcome is unknown keeps the new pane in the record; a start refused and closed puts the gone one back", async () => {
  // Given: hc answers the start line with no readable result (the agent may run), then with a definite refusal
  const ambiguous = reviveRig(state.dir);
  const d = ambiguous.deps(T0);
  await d.registry.write(laneOf(state.dir));
  ambiguous.fake.knobs.sendGarbled = true;
  // When / Then: the record names the new pane, so no later revive opens the conversation again
  expect(await reviveTarget(d, "h3-charsheet", "")).toContain("hc:t1 failed and that pane is not confirmed closed");
  expect(await pane(d)).toBe("hc:t1");
  // Given / When: a refused start in a fresh world (the record put back in hc:t27)
  await d.registry.write(laneOf(state.dir), { relocate: true });
  const refused = reviveRig(state.dir);
  refused.fake.knobs.sendError = "invalid_params";
  expect(await reviveTarget(refused.deps(T0), "h3-charsheet", "")).toContain("that pane was closed");
  // Then: the new terminal is gone and the record names the gone pane again
  expect(await pane(d)).toBe("hc:t27");
  expect(refused.fake.terminals.get("t1")).toBeUndefined();
});

test("a herdr pane that only failed to be read is not taken for gone: nothing new is opened", async () => {
  const { fake, deps } = reviveRig(state.dir);
  const d = deps(T0);
  const unreachable = { ...d, run: async (argv: readonly string[], o?: Parameters<typeof d.run>[1]) => (argv[0] === "herdr" && argv.includes("get") ? { code: 1, out: "", err: "connect: connection refused" } : d.run([...argv], o)) };
  await d.registry.write(laneOf(state.dir, { pane: "w1:p9" }));
  expect(await reviveTarget(unreachable, "h3-charsheet", "")).toBe("REVIVE_FAIL h3-charsheet: w1:p9 is not known to be gone (its runtime did not answer not found); nothing was opened");
  expect(fake.calls.some((c) => c[0] === "run")).toBe(false);
});

test("a lane closed while its new pane opens is not brought back: the record stays closed and the new pane is closed unused", async () => {
  let closed = false;
  const { fake, deps } = reviveRig(state.dir, {
    before: async (argv) => {
      if (argv[0] === "hc" && argv[2] === "run" && !closed) {
        closed = true;
        await deps(T0).registry.patch("h3-charsheet", { closedAt: new Date(T0).toISOString() });
      }
    },
  });
  const d = deps(T0);
  await d.registry.write(laneOf(state.dir));
  expect(await reviveTarget(d, "h3-charsheet", "")).toStartWith("REVIVE_FAIL h3-charsheet: no new pane was started: hc before start failed in hc:t1: the lane is closed in hc:t27 now");
  expect(await pane(d)).toBe("hc:t27");
  expect(fake.sent.length).toBe(0);
  expect(fake.terminals.get("t1")).toBeUndefined();
});

test("a lane marked dead before (its pane dead, then gone, or a mark from before revive) is revived once its pane is gone; a failed try is not repeated", async () => {
  const mark: LaneDied = { pane: "hc:t27", at: new Date(T0 - 86_400_000).toISOString(), reason: "herdr pane 없음", why: "herdr pane gone", told: false };
  const { fake, deps } = reviveRig(state.dir);
  await deps(T0).registry.write(laneOf(state.dir, { died: mark }));
  const lines = (out: string[]) => out.filter((l) => /^(LANE_|REVIVE_)/.test(l));
  expect(lines(await watchTick(deps(T0)))).toEqual([]);
  // the death was told already: only the revive is
  expect(lines(await watchTick(deps(T0 + 30_000)))).toEqual([`LANE_REVIVED h3-charsheet hc:t1 session ${SESSION} (pane hc:t27 was gone)`, "LANE_REVIVED_TOLD h3-charsheet lead:p1"]);
  // a marked lane whose revive fails is marked tried and left alone after
  fake.terminals.clear();
  fake.knobs.sendError = "invalid_params";
  await deps(T0).registry.write(laneOf(state.dir, { died: mark }), { relocate: true });
  await watchTick(deps(T0 + 60_000));
  expect(lines(await watchTick(deps(T0 + 90_000)))[0]).toStartWith("REVIVE_FAIL h3-charsheet: the agent's start in hc:t2 failed and that pane was closed");
  expect((await deps(T0).registry.read("h3-charsheet"))?.died?.reviveTried).toBe(new Date(T0 + 90_000).toISOString());
  const runs = fake.calls.filter((c) => c[0] === "run").length;
  await watchTick(deps(T0 + 120_000));
  expect(lines(await watchTick(deps(T0 + 150_000)))).toEqual([]);
  expect(fake.calls.filter((c) => c[0] === "run").length).toBe(runs);
});

test("the lane's open cards and the cards answered while its pane was gone follow it, so the watch delivers the answer to the revived agent", async () => {
  // Given: one card still open and one the owner answered during the outage, both asked from hc:t27
  const store = new QuestionStore(join(state.dir, "cards"));
  const open = store.create("which pose set?", ["a", "b"], "1", { tmux: "hc:t27", session: SESSION }, new Date(T0).toISOString());
  const answered = store.create("keep the GPU off?", ["yes", "no"], "1", { tmux: "hc:t27", session: SESSION }, new Date(T0).toISOString());
  store.answer(answered.id, "yes", "button", new Date(T0).toISOString());
  const { deps } = reviveRig(state.dir, { patch: { retargetCards: (from, to, session) => ({ moved: store.retarget({ tmux: from, session }, { tmux: to, session }, true), left: [] }) } });
  const d = deps(T0);
  await d.registry.write(laneOf(state.dir));
  // When
  expect(await reviveTarget(d, "h3-charsheet", "")).toStartWith("REVIVE_OK");
  // Then: both name the new pane, where missedAnswersTick reads the session and types an answer it never saw
  expect([store.get(open.id)?.tmux, store.get(answered.id)?.tmux, store.get(answered.id)?.status]).toEqual(["hc:t1", "hc:t1", "answered"]);
});

test("a close that read the lane before a revive published its new pane closes that pane too and records the lane closed there", async () => {
  // Given: a close took the lane as it was (pane hc:t27); it reaches its final write while the revive starts the agent
  const snapshot = laneOf(state.dir, { thread: "none", done: "merged acme/app#1" });
  // the close runs outside the revive's async context, as another process would (inside it, it would hold the revive's
  // lock and run alongside it), and the revive goes on once the close waits for the lane's lock: no clock
  let closing: Promise<{ readonly closed: boolean }> | undefined;
  const { fake, deps } = reviveRig(state.dir, {
    before: async (argv) => {
      if (argv[0] !== "hc" || argv[2] !== "send" || closing) return;
      const waited = new Promise<void>((resolve) => {
        const on = (e: Event) => {
          if ((e as CustomEvent).detail !== "h3-charsheet") return;
          lockWaits.removeEventListener("wait", on);
          resolve();
        };
        lockWaits.addEventListener("wait", on);
      });
      const close = outside(() => closeLane(deps(T0), snapshot, "done"));
      closing = close;
      await Promise.race([waited, close.then(() => undefined, () => undefined)]);
    },
  });
  const d = deps(T0);
  await d.registry.write(snapshot);
  // When
  await reviveTarget(d, "h3-charsheet", "");
  // Then: the close went through and took the revived pane with it; no terminal of the lane is left running
  expect((await closing)?.closed).toBe(true);
  const after = await d.registry.read("h3-charsheet");
  expect([after?.closedAt !== undefined, after?.pane]).toEqual([true, "hc:t1"]);
  expect([...fake.terminals.values()].filter((t) => t.state === "live")).toEqual([]);
});
