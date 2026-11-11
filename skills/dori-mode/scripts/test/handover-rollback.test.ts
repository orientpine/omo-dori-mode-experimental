import { expect, test } from "bun:test";
import { rollBackNew } from "../src/handover-rollback.ts";
import { fakeRunner, newWorld, type World } from "./fakes.ts";

// The 2026-11-11 11:28Z shape: an automatic herdr move w9:p2 -> w9:p13 rolled back at its checks.
const LEAD = "w9:p2";
const NEW = "w9:p13";

const rollBack = async (w: World, routed: string, pane = NEW) => {
  const lines: string[] = [];
  const told: string[] = [];
  await rollBackNew({ run: fakeRunner(w), routedPane: async () => routed, tell: async (p, t) => told.push(`${p} ${t}`) > 0, emit: (l) => lines.push(l), lead: LEAD, pane, why: "verify" });
  const closes = w.calls.filter((c) => c[0] === "herdr" && c.includes("close"));
  return { lines, told, closes };
};

test("a rolled-back move closes the herdr tab it opened and tells no one", async () => {
  const { lines, told, closes } = await rollBack(newWorld(), LEAD);
  expect(lines).toEqual([`HANDOVER_NEW_CLOSED herdr tab w9:t-p13 (${NEW}) stopped and closed`, `HANDOVER_ROLLED_BACK ${LEAD} stays the lead; ${NEW} is closed (its log stays)`]);
  expect(told).toEqual([]);
  expect(closes.length).toBe(1);
  expect(closes.flat()).not.toContain(LEAD);
});

test("a new session that does not close stays open and is told it is not the lead", async () => {
  const w = newWorld();
  w.herdrGone = [NEW];
  const { lines, told } = await rollBack(w, LEAD);
  expect(lines).toEqual([`HANDOVER_NEW_CLOSE_FAIL herdr pane ${NEW} not found`, `HANDOVER_ROLLED_BACK ${LEAD} stays the lead; ${NEW} did not close and is left open, told it is not the lead`]);
  expect(told).toEqual([`${NEW} [LEAD] HANDOVER_ROLLED_BACK: the handover failed (verify); ${LEAD} stays the lead. You are not the lead: do nothing more.`]);
});

test.each([
  ["the routing still names the new session", NEW, NEW, `HANDOVER_NEW_KEPT ${NEW}: the routed lead is still ${NEW}, so it is not closed`],
  ["the routing cannot be read", "", NEW, `HANDOVER_NEW_KEPT ${NEW}: the routed lead is still unreadable, so it is not closed`],
  ["the pane is the old lead", LEAD, LEAD, `HANDOVER_NEW_KEPT ${LEAD}: it is the old lead, so it is not closed`],
])("nothing is closed when %s", async (_, routed, pane, kept) => {
  const { lines, closes } = await rollBack(newWorld(), routed, pane);
  expect(lines[0]).toBe(kept);
  expect(closes).toEqual([]);
});
