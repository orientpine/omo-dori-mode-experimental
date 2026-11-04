import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noteEdit, type Sent, sendKey, sendOnce } from "../src/send-dedupe.ts";

// windowMs 0: the 10 minute window is over, only the place's last post still counts
const AFTER = { windowMs: 0 };

// review of #338: a thread reply posts, then waits for its status; a send posted meanwhile must stay the place's last post
test("a post that finishes after a later post to the same place never takes the last-post record from it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "send-dedupe-"));
  try {
    let finishA: (s: Sent) => void = () => {};
    const a = sendOnce(dir, "discord:1", sendKey(["A"]), () => new Promise<Sent>((r) => (finishA = r)));
    const b = await sendOnce(dir, "discord:1", sendKey(["B"]), async () => ({ id: "1566900000000000102", content: "B" }));
    finishA({ id: "1566900000000000101", content: "A" });
    await a;
    const againB = await sendOnce(dir, "discord:1", sendKey(["B"]), async () => ({ id: "1566900000000000103" }), AFTER);
    const againA = await sendOnce(dir, "discord:1", sendKey(["A"]), async () => ({ id: "1566900000000000104" }), AFTER);
    expect({ b: b.duplicate, againB, againA: againA.duplicate }).toEqual({ b: false, againB: { id: "1566900000000000102", duplicate: true, ageMs: againB.duplicate ? againB.ageMs : -1, last: true }, againA: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an edit of the place's last post makes the edited text its record; an edit of an older message changes nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "send-dedupe-"));
  try {
    await sendOnce(dir, "slack:C1", sendKey(["A"]), async () => ({ id: "1700000100.000100" }));
    noteEdit(dir, "slack:C1", "1700000000.000001", sendKey(["X"]));
    const stillA = await sendOnce(dir, "slack:C1", sendKey(["A"]), async () => ({ id: "1700000100.000200" }), AFTER);
    noteEdit(dir, "slack:C1", "1700000100.000100", sendKey(["B"]));
    const a = await sendOnce(dir, "slack:C1", sendKey(["A"]), async () => ({ id: "1700000100.000300" }), AFTER);
    noteEdit(dir, "slack:C1", "1700000100.000300", sendKey(["B"]));
    const b = await sendOnce(dir, "slack:C1", sendKey(["B"]), async () => ({ id: "1700000100.000400" }), AFTER);
    expect({ stillA: stillA.duplicate, a: [a.id, a.duplicate], b: [b.id, b.duplicate] }).toEqual({ stillA: true, a: ["1700000100.000300", false], b: ["1700000100.000300", true] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
