import { expect, test } from "bun:test";
import { Reports } from "../src/reports.ts";
import { HUNG_MESSAGE } from "../src/supervision.ts";
import { fixture, lane } from "./supervision-setup.ts";

const structured = { ...lane, reportProtocol: "jsonl-v1" as const };

test("a ceiling appends one durable blocker and still alerts the lead", async () => {
  const f = fixture({ defaults: { wallMinutes: 1 } });
  try {
    f.clock.at += 60_000;
    expect((await f.supervisor.sweep(structured, "")).alerts).toEqual(["wallMinutes ceiling reached (1)"]);
    const progress = new Reports(f.dir).read(lane.key);
    expect(progress?.state).toBe("blocked");
    expect(progress?.lastReport).toMatchObject({ kind: "blocker", text: "wallMinutes ceiling reached (1)" });
    expect(f.alerts).toEqual(["wallMinutes ceiling reached (1)"]);
    f.clock.at += 60_000;
    expect((await f.supervisor.sweep(structured, "")).alerts).toEqual([]);
    expect(new Reports(f.dir).read(lane.key)?.lastReport?.text).toBe("wallMinutes ceiling reached (1)");
  } finally { f.done(); }
});

test("a hung structured lane appends stalled activity once", async () => {
  const f = fixture({ staleAfterMinutes: 0 });
  try {
    await f.supervisor.sweep(structured, "Working 20m");
    f.clock.at += 60_000;
    expect((await f.supervisor.sweep(structured, "Working 21m")).alerts).toEqual([HUNG_MESSAGE]);
    expect(new Reports(f.dir).read(lane.key)?.lastEvent).toMatchObject({ type: "activity", state: "stalled" });
    f.clock.at += 60_000;
    await f.supervisor.sweep(structured, "Working 22m");
    expect(new Reports(f.dir).read(lane.key)?.lastEvent).toMatchObject({ type: "activity", state: "stalled" });
    expect(f.alerts).toEqual([HUNG_MESSAGE]);
  } finally { f.done(); }
});

test("a fresh journal report clears a hang and restores running state", async () => {
  const f = fixture({ staleAfterMinutes: 1 });
  try {
    await f.supervisor.sweep(structured, "Working 20m");
    f.clock.at += 60_000;
    await f.supervisor.sweep(structured, "Working 21m");
    expect(new Reports(f.dir).read(lane.key)?.state).toBe("stalled");
    new Reports(f.dir).report(lane.key, "milestone", "fresh work", f.clock.at);
    const result = await f.supervisor.sweep(structured, "Working 22m");
    expect(result.hung).toBe(false);
    expect(result.alerts).toEqual([]);
    expect(result.state).toBe("running");
    expect(new Reports(f.dir).read(lane.key)?.lastEvent).toMatchObject({ type: "report", text: "fresh work" });
  } finally { f.done(); }
});

test("fresh checkpoint activity after a stall appends running activity", async () => {
  const f = fixture({ staleAfterMinutes: 1 });
  try {
    await f.supervisor.sweep(structured, "Working 20m");
    f.clock.at += 60_000;
    await f.supervisor.sweep(structured, "Working 21m");
    expect(new Reports(f.dir).read(lane.key)?.state).toBe("stalled");
    f.supervisor.checkpoints.write(lane.key, { step: "one", result: "fresh checkpoint", evidence: [], remoteEffects: [] }, f.clock.at);
    const result = await f.supervisor.sweep(structured, "Working 22m");
    expect(result.hung).toBe(false);
    expect(result.state).toBe("running");
    expect(new Reports(f.dir).read(lane.key)?.lastEvent).toMatchObject({ type: "activity", state: "running", text: "Fresh report, checkpoint, or file activity observed" });
  } finally { f.done(); }
});

test("a legacy lane ignores its journal and keeps the registry supervision path", async () => {
  const f = fixture({ staleAfterMinutes: 0 });
  try {
    await f.supervisor.sweep(lane, "Working 20m");
    f.clock.at += 60_000;
    new Reports(f.dir).report(lane.key, "done", "finished", f.clock.at);
    const result = await f.supervisor.sweep(lane, "Working 21m");
    expect(result.hung).toBe(true);
    expect(result.alerts).toEqual([HUNG_MESSAGE]);
    expect(new Reports(f.dir).read(lane.key)?.lastEvent.type).toBe("report");
  } finally { f.done(); }
});
