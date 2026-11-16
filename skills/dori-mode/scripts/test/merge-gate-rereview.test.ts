import { afterEach, expect, test } from "bun:test";

import { mergePr, readReceipt, reviewPr } from "../src/merge-gate.ts";
import { A, B, cleanup, DIR, deps, merges, PR, world } from "./merge-gate-world.ts";

// dori-superagent #232 (https://github.com/sisyphuslabs/dori-superagent/pull/232): a review again at the same head takes back
// that head's earlier review receipt before its reviewer runs, so only a CLEAR or BLOCK from this run is merge-eligible
afterEach(cleanup);

const failure = (p: Promise<unknown>): Promise<Error> => p.then(() => { throw new Error("expected a refusal"); }, (e: unknown) => e as Error);

test("a review again at the same head that ends with no verdict takes back the earlier CLEAR, so the merge is refused", async () => {
  const w = world();
  const d = deps(w);
  await reviewPr(d, PR, { dir: DIR });
  w.noVerdict = { code: 0, out: "ran out of budget", times: 99 };
  expect((await failure(reviewPr(d, PR, { dir: DIR }))).message).toStartWith("REVIEW_FAILED acme/app#7: no reviewer printed a VERDICT line:");
  expect(await readReceipt(d.config.stateDir, PR, A, "review")).toBeUndefined();
  await expect(mergePr(d, PR, { dryRun: true })).rejects.toThrow(/^MERGE_REFUSED acme\/app#7 head aaaaaaaaaaaa has no review receipt/);
  expect(merges(w)).toEqual([]);
});

test("a BLOCK at the same head after a CLEAR is refused", async () => {
  const w = world();
  const d = deps(w);
  await reviewPr(d, PR, { dir: DIR });
  w.verdict = "BLOCK";
  await reviewPr(d, PR, { dir: DIR });
  await expect(mergePr(d, PR, { dryRun: true })).rejects.toThrow(/^MERGE_REFUSED acme\/app#7 review at aaaaaaaaaaaa is BLOCK/);
});

test("a reviewer that cannot start leaves no earlier receipt, and the next CLEAR makes the head mergeable again", async () => {
  const w = world();
  const d = deps(w);
  await reviewPr(d, PR, { dir: DIR });
  w.reviewerThrows = true;
  expect((await failure(reviewPr(d, PR, { dir: DIR }))).message).toContain("spawn fake-reviewer ENOENT");
  expect(await readReceipt(d.config.stateDir, PR, A, "review")).toBeUndefined();
  await expect(mergePr(d, PR, { dryRun: true })).rejects.toThrow(/^MERGE_REFUSED acme\/app#7 head aaaaaaaaaaaa has no review receipt/);
  w.reviewerThrows = false;
  await reviewPr(d, PR, { dir: DIR });
  expect(await mergePr(d, PR, { dryRun: true })).toStartWith(`MERGE_OK acme/app#7 head=${A}`);
});

test("a failed review at another head leaves the first head's CLEAR alone", async () => {
  const w = world();
  const d = deps(w);
  await reviewPr(d, PR, { dir: DIR });
  w.head = B;
  w.checkout = B;
  w.noVerdict = { code: 9, out: "", times: 99 };
  await expect(reviewPr(d, PR, { dir: DIR })).rejects.toThrow(/^REVIEW_FAILED/);
  expect((await readReceipt(d.config.stateDir, PR, A, "review"))?.verdict).toBe("CLEAR");
  w.head = A;
  expect(await mergePr(d, PR, { dryRun: true })).toStartWith(`MERGE_OK acme/app#7 head=${A}`);
});
