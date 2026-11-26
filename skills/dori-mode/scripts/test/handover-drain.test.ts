import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SETTLE_MS, settleOldLead } from "../src/handover-drain.ts";
import { QuestionStore } from "../src/messenger/discord-cards.ts";
import { quietReason } from "../src/rollover.ts";
import type { Proc } from "../src/session-id.ts";

const BUSY = ["transcript", "── • Working (2s • esc to interrupt) ──────────", "❯ ", "────────────────────────", " ~/repo • main"].join("\n");
const IDLE = ["transcript", "────────────────────────", "❯ ", "────────────────────────", " ~/repo • main"].join("\n");
const PASSED = { reasons: [] as string[], session: "new-sid" };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// screens: what each read of the old lead's pane shows, the last one from then on; atSleep runs before each poll's sleep;
// table: the process table (its shell is pid 10); recheck: the new session's second monitor and todo check
const AGENT = [{ pid: 10, ppid: 1, cmd: "bash" }, { pid: 11, ppid: 10, cmd: "bun /home/u/.bun/install/global/node_modules/omo-ai/dist/omo.js" }];
const world = (screens: readonly (string | Error)[], atSleep: (n: number) => void = () => {}, opts: { table?: () => readonly Proc[]; recheck?: (session: string) => readonly string[] } = {}) => {
  let t = 1_000_000;
  let reads = 0;
  let sleeps = 0;
  const state = mkdtempSync(join(tmpdir(), "settle-"));
  dirs.push(state);
  const deps = {
    run: async (argv: readonly string[]) => {
      if (argv.includes("#{pane_pid}")) return { code: 0, out: "10", err: "" };
      if (!argv.includes("capture-pane")) return { code: 1, out: "", err: "" };
      const s = screens[Math.min(reads++, screens.length - 1)] ?? IDLE;
      if (s instanceof Error) throw s;
      return { code: 0, out: s, err: "" };
    },
    clock: {
      now: () => t,
      sleep: async (ms: number) => {
        atSleep(++sleeps);
        t += ms;
      },
    },
    cardDir: join(state, "discord"),
    procs: async () => [...(opts.table?.() ?? AGENT)],
  };
  const settle = (checked = PASSED) => settleOldLead(deps, checked, state, "lead", t + 600_000, "the handover of the lead to new is running", opts.recheck ?? (() => []));
  return { deps, state, settle, now: () => t, sleeps: () => sleeps };
};

test("checks that failed are returned as they are: the old lead gets no quiet mark and nothing waits", async () => {
  // Given
  const w = world([BUSY]);
  const failed = { reasons: ["monitors not running"], session: "" };
  // When
  const r = await w.settle(failed);
  // Then
  expect(r).toBe(failed);
  expect(quietReason(w.state, "lead", w.now())).toBeUndefined();
  expect(w.sleeps()).toBe(0);
});

test("after passed checks the old lead is made quiet and the move goes on once its turn ended and no card claim is held", async () => {
  // Given
  const w = world([BUSY, BUSY, IDLE]);
  // When
  const r = await w.settle();
  // Then
  expect(r).toMatchObject(PASSED);
  expect(quietReason(w.state, "lead", w.now())).toStartWith("HANDOVER_QUIET lead: the handover of the lead to new is running");
  expect(w.sleeps()).toBe(2);
});

test("an idle screen is not enough while a card claim is held (a dori ask or resolve in a background job): the move waits for it", async () => {
  // Given
  let release: (() => void) | null = null;
  const w = world([IDLE], (n) => {
    if (n === 3) release?.();
  });
  const store = new QuestionStore(w.deps.cardDir);
  const q = store.create("Ship it?", ["yes", "no"], "1", { thread: "9", tmux: "lead" }, "2026-11-26T00:00:00Z");
  release = store.claim(q.id, w.now());
  // When
  const r = await w.settle();
  // Then
  expect(release).not.toBeNull();
  expect(r).toMatchObject(PASSED);
  expect(w.sleeps()).toBe(3);
});

test("an old lead that does not come to rest in time makes the checks fail, so the move rolls back and nothing is frozen or closed", async () => {
  // Given
  const held = world([IDLE]);
  const store = new QuestionStore(held.deps.cardDir);
  const q = store.create("Ship it?", ["yes", "no"], "1", { thread: "9", tmux: "lead" }, "2026-11-26T00:00:00Z");
  expect(store.claim(q.id, held.now())).not.toBeNull();
  const unreadable = world([new Error("hc read failed"), ""]);
  const busy = world([BUSY]);
  // When
  const results = [await held.settle(), await unreadable.settle(), await busy.settle()];
  // Then
  expect(results.map((r) => r.reasons)).toEqual([
    [`the old lead lead did not come to rest within ${SETTLE_MS / 1000} s after the checks passed (the claim of card ${q.id} was still held); nothing was frozen or closed`],
    [`the old lead lead did not come to rest within ${SETTLE_MS / 1000} s after the checks passed (its screen could not be read); nothing was frozen or closed`],
    [`the old lead lead did not come to rest within ${SETTLE_MS / 1000} s after the checks passed (its turn was still running); nothing was frozen or closed`],
  ]);
  expect(held.now() - 1_000_000).toBeGreaterThanOrEqual(SETTLE_MS);
});

test("the claims a settled old lead had free stay taken until the freeze is done, so no ask, resolve or reopen can take one in between", async () => {
  // Given
  const w = world([IDLE]);
  const store = new QuestionStore(w.deps.cardDir);
  const q = store.create("Ship it?", ["yes", "no"], "1", { thread: "9", tmux: "lead" }, "2026-11-26T00:00:00Z");
  // When
  const r = await w.settle();
  const during = store.claim(q.id, w.now());
  r.release?.();
  const after = store.claim(q.id, w.now());
  after?.();
  // Then
  expect(r.reasons).toEqual([]);
  expect(during).toBeNull();
  expect(after).not.toBeNull();
});

test("a claim held on an answered card (its repaint or a reopen) also keeps the old lead from rest", async () => {
  // Given
  const w = world([IDLE]);
  const store = new QuestionStore(w.deps.cardDir);
  const q = store.create("Ship it?", ["yes", "no"], "1", { thread: "9", tmux: "lead" }, "2026-11-26T00:00:00Z");
  store.answer(q.id, "yes", "button", "2026-11-26T00:01:00Z");
  expect(store.get(q.id)?.status).not.toBe("open");
  const holder = store.claim(q.id, w.now());
  // When
  const r = await w.settle();
  holder?.();
  // Then
  expect(holder).not.toBeNull();
  expect(r.reasons).toEqual([`the old lead lead did not come to rest within ${SETTLE_MS / 1000} s after the checks passed (the claim of card ${q.id} was still held); nothing was frozen or closed`]);
});

test("an answered card with no claim file is taken too, so a dori reopen started after the settle cannot claim it before the freeze", async () => {
  // Given
  const w = world([IDLE]);
  const store = new QuestionStore(w.deps.cardDir);
  const q = store.create("Ship it?", ["yes", "no"], "1", { thread: "9", tmux: "lead" }, "2026-11-26T00:00:00Z");
  store.answer(q.id, "yes", "button", "2026-11-26T00:01:00Z");
  // When
  const r = await w.settle();
  const reopen = store.claim(q.id, w.now());
  r.release?.();
  // Then
  expect([r.reasons, reopen]).toEqual([[], null]);
});

test("a dori send, thread or ask still running under the old lead (a background job past an idle screen) keeps it from rest; past the time the move rolls back", async () => {
  // Given
  const send = { pid: 12, ppid: 11, cmd: "/home/u/.bun/bin/bun /home/u/.dori/src/skills/dori-mode/scripts/src/cli.ts send discord --to 1 --text hi" };
  let running = true;
  const ends = world([IDLE], (n) => {
    if (n === 2) running = false;
  }, { table: () => (running ? [...AGENT, send] : AGENT) });
  const stays = world([IDLE], () => {}, { table: () => [...AGENT, { pid: 13, ppid: 11, cmd: "bash /home/u/.local/bin/dori thread reply 9 --text hi" }] });
  const unlisted = world([IDLE], () => {}, { table: () => { throw new Error("ps failed"); } });
  // When
  const results = [await ends.settle(), await stays.settle(), await unlisted.settle()];
  // Then
  expect(results.map((r) => r.reasons)).toEqual([
    [],
    [`the old lead lead did not come to rest within ${SETTLE_MS / 1000} s after the checks passed (a dori thread of it was still running, pid 13); nothing was frozen or closed`],
    [`the old lead lead did not come to rest within ${SETTLE_MS / 1000} s after the checks passed (its processes could not be listed); nothing was frozen or closed`],
  ]);
  expect(ends.sleeps()).toBe(2);
});

test("the new session's monitors and todos are checked again after the settle: one gone meanwhile rolls the move back and frees the claims", async () => {
  // Given
  const seen: string[] = [];
  const w = world([IDLE], () => {}, { recheck: (session) => { seen.push(session); return ["monitors stopped in new after the first check: owner inbox"]; } });
  const store = new QuestionStore(w.deps.cardDir);
  const q = store.create("Ship it?", ["yes", "no"], "1", { thread: "9", tmux: "lead" }, "2026-11-26T00:00:00Z");
  // When
  const r = await w.settle();
  const free = store.claim(q.id, w.now());
  free?.();
  // Then
  expect([r.reasons, r.release, seen, free === null]).toEqual([["monitors stopped in new after the first check: owner inbox"], undefined, ["new-sid"], false]);
});
