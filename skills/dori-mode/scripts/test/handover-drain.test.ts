import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { quietOldLead, TURN_END_MS } from "../src/handover-drain.ts";
import { quietReason } from "../src/rollover.ts";

const BUSY = ["transcript", "── • Working (2s • esc to interrupt) ──────────", "❯ ", "────────────────────────", " ~/repo • main"].join("\n");
const IDLE = ["transcript", "────────────────────────", "❯ ", "────────────────────────", " ~/repo • main"].join("\n");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// the old lead's screen shows its turn running for the first busyReads reads (a dori send, ask or resolve inside it)
const world = (busyReads: number) => {
  let t = 1_000_000;
  let reads = 0;
  const deps = {
    run: async (argv: readonly string[]) => ({ code: 0, out: argv.includes("capture-pane") ? (reads++ < busyReads ? BUSY : IDLE) : "", err: "" }),
    clock: {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
    },
  };
  const state = mkdtempSync(join(tmpdir(), "drain-"));
  dirs.push(state);
  return { deps, state, now: () => t, reads: () => reads };
};

test("at the commit the old lead is made quiet and is frozen only once its running turn has ended", async () => {
  // Given
  const w = world(3);
  const start = w.now();
  // When
  const busy = await quietOldLead(w.deps, w.state, "lead", start + 60_000, "the handover of the lead to new is running");
  // Then
  expect(quietReason(w.state, "lead", w.now())).toStartWith("HANDOVER_QUIET lead: the handover of the lead to new is running");
  expect(busy).toBeUndefined();
  expect(w.reads()).toBe(4);
  expect(w.now() - start).toBeLessThan(TURN_END_MS);
});

test("an old lead whose turn still runs at the bound is not frozen: the reason sends the commit the freeze-failed way", async () => {
  // Given
  const w = world(Number.POSITIVE_INFINITY);
  const start = w.now();
  // When
  const busy = await quietOldLead(w.deps, w.state, "lead", start + 600_000, "moving");
  // Then
  expect(busy).toBe(`its turn still ran ${TURN_END_MS / 1000} s after the commit, and a stopped turn would keep any question claim it holds`);
  expect(w.now() - start).toBeGreaterThanOrEqual(TURN_END_MS);
  expect(quietReason(w.state, "lead", w.now())).toBeDefined();
});
