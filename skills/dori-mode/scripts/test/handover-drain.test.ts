import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { admissionFile, SETTLE_MS, settleOldLead } from "../src/handover-drain.ts";
import { QuestionStore } from "../src/messenger/discord-cards.ts";
import { holdAdmission } from "../src/checkpoint-lock.ts";
import { quietReason } from "../src/rollover.ts";

const BUSY = ["transcript", "── • Working (2s • esc to interrupt) ──────────", "❯ ", "────────────────────────", " ~/repo • main"].join("\n");
const IDLE = ["transcript", "────────────────────────", "❯ ", "────────────────────────", " ~/repo • main"].join("\n");
const PASSED = { reasons: [] as string[], session: "new-sid" };

const dirs: string[] = [];
// every claim and lock a test takes is let go before its folder is removed: Windows refuses to delete a file held open
const held: (() => void)[] = [];
const once = <F extends (() => void) | null | undefined>(f: F): F => {
  if (!f) return f;
  let done = false;
  const g = () => {
    if (!done) {
      done = true;
      f();
    }
  };
  held.push(g);
  return g as F;
};
afterEach(() => {
  for (const r of held.splice(0)) r();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// screens: what each read of the old lead's pane shows, the last one from then on; atSleep runs before each poll's sleep;
// recheck: the new session's second monitor and todo check
const world = (screens: readonly (string | Error)[], atSleep: (n: number) => void = () => {}, opts: { recheck?: (session: string) => readonly string[] } = {}) => {
  let t = 1_000_000;
  let reads = 0;
  let sleeps = 0;
  const state = mkdtempSync(join(tmpdir(), "settle-"));
  dirs.push(state);
  const deps = {
    run: async (argv: readonly string[]) => {
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
  };
  const settle = async (checked = PASSED) => {
    const r = await settleOldLead(deps, checked, state, "lead", t + 600_000, "the handover of the lead to new is running", opts.recheck ?? (() => []));
    return r.release ? { ...r, release: once(r.release) } : r;
  };
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
  release = once(store.claim(q.id, w.now()));
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
  expect(once(store.claim(q.id, held.now()))).not.toBeNull();
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
  const during = once(store.claim(q.id, w.now()));
  r.release?.();
  const after = once(store.claim(q.id, w.now()));
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
  const holder = once(store.claim(q.id, w.now()));
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
  const reopen = once(store.claim(q.id, w.now()));
  r.release?.();
  // Then
  expect([r.reasons, reopen]).toEqual([[], null]);
});

test("a dori send, thread, ask, reopen or resolve in flight (it holds the pane's admission lock shared) keeps the old lead from rest until it ends; past the time the move rolls back", async () => {
  // Given a command of the old lead's pane that ends at the second poll, and one that never ends
  let send: (() => void) | undefined;
  const ends = world([IDLE], (n) => {
    if (n === 2) send?.();
  });
  send = once(holdAdmission(admissionFile(ends.state, "lead"), "shared"));
  const stays = world([IDLE]);
  const stuck = once(holdAdmission(admissionFile(stays.state, "lead"), "shared"));
  // When
  const results = [await ends.settle(), await stays.settle()];
  stuck?.();
  // Then
  expect([send !== undefined, stuck !== undefined]).toEqual([true, true]);
  expect(results.map((r) => r.reasons)).toEqual([
    [],
    [`the old lead lead did not come to rest within ${SETTLE_MS / 1000} s after the checks passed (a dori send, thread, ask, reopen or resolve of it was still running: its admission lock was held); nothing was frozen or closed`],
  ]);
  expect(ends.sleeps()).toBe(2);
  results[0]?.release?.();
});

test("the admission lock stays taken exclusive until the freeze is done, so a dori command starting meanwhile cannot take it", async () => {
  // Given
  const w = world([IDLE]);
  const lock = admissionFile(w.state, "lead");
  // When
  const r = await w.settle();
  const during = once(holdAdmission(lock, "shared"));
  r.release?.();
  const after = once(holdAdmission(lock, "shared"));
  after?.();
  // Then
  expect([r.reasons, during, after !== undefined]).toEqual([[], undefined, true]);
});

test("the new session's monitors and todos are checked again after the settle: one gone meanwhile rolls the move back and frees the claims", async () => {
  // Given
  const seen: string[] = [];
  const w = world([IDLE], () => {}, { recheck: (session) => { seen.push(session); return ["monitors stopped in new after the first check: owner inbox"]; } });
  const store = new QuestionStore(w.deps.cardDir);
  const q = store.create("Ship it?", ["yes", "no"], "1", { thread: "9", tmux: "lead" }, "2026-11-26T00:00:00Z");
  // When
  const r = await w.settle();
  const free = once(store.claim(q.id, w.now()));
  free?.();
  const admitted = once(holdAdmission(admissionFile(w.state, "lead"), "shared"));
  admitted?.();
  // Then
  expect([r.reasons, r.release, seen, free === null, admitted !== undefined]).toEqual([["monitors stopped in new after the first check: owner inbox"], undefined, ["new-sid"], false, true]);
});
