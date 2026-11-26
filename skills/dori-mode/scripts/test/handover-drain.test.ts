import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { quietOldLead, REPLY_DRAIN_MS } from "../src/handover-drain.ts";
import { quietReason } from "../src/rollover.ts";
import type { Proc } from "../src/session-id.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// the old lead's pane: shell 10, its agent 11, the agent's inbox monitor 13 and, while it answers the owner, a dori send 12
const world = (sendEndsAfter: number) => {
  let t = 1_000_000;
  let polls = 0;
  const lines: string[] = [];
  const base: Proc[] = [{ pid: 10, ppid: 1, cmd: "bash" }, { pid: 11, ppid: 10, cmd: "node /x/senpi/dist/bundle/cli.js" }, { pid: 13, ppid: 11, cmd: "tail -n 0 -F /x/inbox.jsonl" }];
  const send: Proc[] = [{ pid: 12, ppid: 11, cmd: "bun /x/src/cli.ts send discord --to 1 --reply 9 --text hi" }, { pid: 14, ppid: 12, cmd: "curl https://discord.example" }];
  const deps = {
    run: async (argv: readonly string[]) => ({ code: argv[0] === "tmux" ? 0 : 1, out: argv[0] === "tmux" ? "10\n" : "", err: "" }),
    procs: async () => (polls++ < sendEndsAfter ? [...base, ...send] : base),
    clock: {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
    },
  };
  const state = mkdtempSync(join(tmpdir(), "drain-"));
  dirs.push(state);
  return { deps, state, lines, now: () => t, emit: (l: string) => void lines.push(l) };
};

test("at the commit the old lead is made quiet, and a dori send it is still running gets time to end before the freeze", async () => {
  // Given
  const w = world(3);
  const start = w.now();
  // When
  const spare = await quietOldLead(w.deps, w.state, "lead", start + 60_000, "the handover of the lead to new is running", w.emit);
  // Then
  expect(quietReason(w.state, "lead", w.now())).toStartWith("HANDOVER_QUIET lead: the handover of the lead to new is running");
  expect(spare).toEqual([]);
  expect(w.now() - start).toBeLessThan(REPLY_DRAIN_MS);
  expect(w.lines).toEqual([]);
});

test("a dori send of the old lead that does not end in time is left out of the freeze with its children; other processes are not", async () => {
  // Given
  const w = world(Number.POSITIVE_INFINITY);
  const start = w.now();
  // When
  const spare = await quietOldLead(w.deps, w.state, "lead", start + 60_000, "moving", w.emit);
  // Then
  expect(spare).toEqual([12]);
  expect(w.now() - start).toBeGreaterThanOrEqual(REPLY_DRAIN_MS);
  expect(w.lines).toEqual([`HANDOVER_REPLY_KEPT lead: a dori send, ask or thread of the old lead still ran after ${REPLY_DRAIN_MS / 1000} s (12); it is left out of the freeze so it can end`]);
});
