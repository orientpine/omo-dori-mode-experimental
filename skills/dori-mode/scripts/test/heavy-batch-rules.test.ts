import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, symlinkSync, } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import { batchCode, batchOf, ctxWith, fakeHelper, fresh, logs, realHelper, receipts, start, state, stop, work } from "./heavy-batch-fixture.ts";

// review 4 of #476: the three rules of the batch (the lead, 2026-11-14): a helper leaves only for a helper-level failure, OOM is the runner's word, --out is real and outside every upload
beforeEach(start);
afterEach(stop);

// review 4 of #476, rule 1: only a helper-level failure takes a helper out of the batch; one item's refusal bars that item from it alone
test("a helper that refuses one item stays in the batch for the others, and the refused item runs elsewhere (rule 1, review 4 of #476)", async () => {
  // picky refuses the first item it is offered (a program it lacks) and runs every later one
  const picky = fakeHelper("picky", `if mkdir ${join(state.dir, "picky.once")} 2>/dev/null; then echo "WORKER_REFUSED program python3.99 not found" >&2; exit 1; fi; echo "WORKER_ADMIT slot.1" >&2; cat >/dev/null; echo "O ran on picky" >&2; echo "WORKER_EXIT 0" >&2; tar -cf - -T /dev/null`);
  const ctx = ctxWith([picky], true, undefined, true);
  setTimeout(() => rmSync(join(state.dir, "heavy", "slot.1"), { recursive: true, force: true }), 1000);
  const code = await batchCode(ctx, batchOf(["1", "2", "3"], ["true"]));
  expect(code).toBe(0);
  const rs = receipts();
  expect(rs.find((r) => r.n === 1)).toMatchObject({ host: hostname(), exit: 0, refused: [{ host: "picky", why: "program python3.99 not found" }] });
  expect(rs.filter((r) => r.host === "picky").map((r) => r.n).sort()).toEqual([2, 3]);
  expect(logs.some((l) => l.startsWith("HEAVY_BATCH_GONE"))).toBe(false);
  expect(logs).toContain("HEAVY_BATCH_ITEM_REFUSED b #1 picky: program python3.99 not found; it goes to another host, picky stays in the batch");
});

// rule 2: OOM and the retry are decided from the runner's own state, never from what the command printed
test("a command that prints an OOM-looking line and succeeds runs once, here and on a helper (rule 2, review 4 of #476)", async () => {
  const line = "HEAVY_OOM b.1: killed at MemoryMax=1.0G";
  const talker = fakeHelper("talker", `echo "WORKER_ADMIT slot.1" >&2; cat >/dev/null; echo "E ${line}" >&2; echo "WORKER_EXIT 0" >&2; tar -cf - -T /dev/null`);
  expect(await batchCode(ctxWith([talker, realHelper("ok")]), batchOf(["x"], ["true"]))).toBe(0);
  expect(receipts()).toMatchObject([{ host: "talker", exit: 0, tries: [{ host: "talker", result: "exit 0" }] }]);
  expect(readFileSync(receipts()[0]!.err, "utf8")).toBe(`${line}\n`);
  fresh();
  expect(await batchCode(ctxWith([], false), batchOf(["x"], ["sh", "-c", `echo "${line}" >&2`]))).toBe(0);
  expect(receipts()).toMatchObject([{ host: hostname(), exit: 0, tries: [{ result: "exit 0" }] }]);
  expect(logs.some((l) => l.startsWith("HEAVY_BATCH_RETRY"))).toBe(false);
});

// rule 3: --out is read through realpath and refused (fail closed) when it goes through a link or lies in an upload
test("an --out that goes through a link is refused before any item, wherever the link points (rule 3, review 4 of #476)", async () => {
  mkdirSync(join(work, "results"));
  mkdirSync(join(state.dir, "elsewhere"));
  symlinkSync(join(work, "results"), join(state.dir, "into-work"));
  symlinkSync(join(state.dir, "elsewhere"), join(state.dir, "out-link"));
  for (const out of [join(state.dir, "into-work"), join(state.dir, "into-work", "new", "deeper"), join(state.dir, "out-link")]) expect(await batchCode(ctxWith([]), batchOf(["x"], ["true"], { out }))).toBe(2);
  expect(logs.filter((l) => l.startsWith("HEAVY_BATCH_REFUSED b: --out ") && l.includes("goes through a link"))).toHaveLength(3);
  expect(logs.some((l) => l.startsWith("HEAVY_BATCH_START"))).toBe(false);
});
