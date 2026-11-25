import { afterEach, expect, test } from "bun:test";

import { readReceipt, reviewPr } from "../src/merge-gate.ts";
import { A, cleanup, DIR, deps, PR, world } from "./merge-gate-world.ts";

// GitHub refuses the diff of a pull request over 20000 lines (HTTP 406 too_large): the review reads the same diff from the
// clean checkout it already verified at the head, against the PR's base commit
afterEach(cleanup);

const failure = (p: Promise<unknown>): Promise<Error> => p.then(() => { throw new Error("expected a refusal"); }, (e: unknown) => e as Error);

test("a diff GitHub refuses as too large is read from the verified checkout against the PR's base", async () => {
  const w = { ...world(), diffTooLarge: true, base: "c".repeat(40) };
  const d = deps(w);
  await reviewPr(d, PR, { dir: DIR });
  expect(w.calls).toContainEqual(["git", "-C", DIR, "diff", `${"c".repeat(40)}...${A}`]);
  expect(w.prompt).toContain("+LOCAL_DIFF");
  expect((await readReceipt(d.config.stateDir, PR, A, "review"))?.verdict).toBe("CLEAR");
});

test("another gh failure, or a local diff that fails, is still a refusal with no review", async () => {
  const other = world();
  const d1 = deps(other);
  const run = d1.run;
  const failing = { ...d1, run: async (argv: readonly string[], o?: Parameters<typeof run>[1]) => (argv.join(" ").startsWith("gh pr diff") ? { code: 1, out: "", err: "HTTP 502" } : run(argv, o)) };
  expect((await failure(reviewPr(failing, PR, { dir: DIR }))).message).toStartWith("REVIEW_REFUSED cannot read the diff of acme/app#7: ");
  expect(other.prompt).toBeUndefined();
  const local = { ...world(), diffTooLarge: true, localDiffFails: true };
  expect((await failure(reviewPr(deps(local), PR, { dir: DIR }))).message).toStartWith("REVIEW_REFUSED cannot read the diff of acme/app#7: ");
  expect(local.prompt).toBeUndefined();
});
