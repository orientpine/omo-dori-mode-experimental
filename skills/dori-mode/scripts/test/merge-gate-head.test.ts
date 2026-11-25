import { afterEach, expect, test } from "bun:test";

import { mergePr, readReceipt, reviewPr } from "../src/merge-gate.ts";
import { A, cleanup, DIR, deps, merges, PR, world } from "./merge-gate-world.ts";

// Upstream dori-superagent #278 (https://github.com/sisyphuslabs/dori-superagent/pull/278, carries #232): review and
// merge of one head take turns. Upstream #280 (https://github.com/sisyphuslabs/dori-superagent/pull/280, carries #234):
// a pull_request workflow that shows no check run (waiting for approval, failed to start) is not "no CI".

afterEach(cleanup);

test("while a review of a head runs, a second review and a merge of that head are refused; after it, it merges (#278)", async () => {
  const w = world();
  let release = (): void => {};
  w.holdReview = new Promise((r) => (release = r));
  const started = new Promise<void>((r) => (w.reviewing = r));
  const d = deps(w);
  const first = reviewPr(d, PR, { dir: DIR });
  await started;
  await expect(reviewPr(d, PR, { dir: DIR })).rejects.toThrow(/^REVIEW_REFUSED acme\/app#7 head aaaaaaaaaaaa is held by another dori review or merge/);
  await expect(mergePr(d, PR)).rejects.toThrow(/^MERGE_REFUSED acme\/app#7 head aaaaaaaaaaaa is held by another dori review or merge/);
  expect(merges(w)).toEqual([]);
  release();
  expect((await first).at(-1)).toMatch(/^REVIEW acme\/app#7 head=a{40} verdict=CLEAR/);
  expect(await mergePr(d, PR)).toMatch(/^MERGED acme\/app#7/);
});

test("a review whose reviewer cannot start leaves the head free for the next one (#278)", async () => {
  const w = { ...world(), reviewerThrows: true };
  const d = deps(w);
  await expect(reviewPr(d, PR, { dir: DIR })).rejects.toThrow("spawn fake-reviewer ENOENT");
  w.reviewerThrows = false;
  expect((await reviewPr(d, PR, { dir: DIR })).at(-1)).toMatch(/verdict=CLEAR/);
});

const run = (conclusion: string | null, status = "completed") => JSON.stringify({ total_count: 1, workflow_runs: [{ name: "ci", event: "pull_request", head_sha: A, status, conclusion }] });

test("a pull_request run waiting for approval, with no check run, is refused by review and merge (#280)", async () => {
  const w = world();
  const d = deps(w);
  await reviewPr(d, PR, { dir: DIR });
  w.runs = run("action_required");
  await expect(mergePr(d, PR)).rejects.toThrow("MERGE_REFUSED acme/app#7 unsupported:workflows (1 pull_request workflow run at this head: ci completed/action_required; this gate is for repos without CI)");
  expect(merges(w)).toEqual([]);
  const tested = w.calls.filter((c) => c[0] === "bun").length;
  await expect(reviewPr(d, PR, { dir: DIR })).rejects.toThrow(/^REVIEW_REFUSED acme\/app#7 unsupported:workflows \(1 pull_request workflow run at this head: ci completed\/action_required/);
  expect(w.calls.filter((c) => c[0] === "bun")).toHaveLength(tested);
  w.runs = run(null, "queued");
  await expect(mergePr(d, PR)).rejects.toThrow(/unsupported:workflows \(1 pull_request workflow run at this head: ci queued\/-/);
});

test("runs that cannot be read or do not parse refuse instead of counting as none (#280)", async () => {
  const w = world();
  const d = deps(w);
  await reviewPr(d, PR, { dir: DIR });
  w.runsFail = true;
  await expect(mergePr(d, PR)).rejects.toThrow(/^MERGE_REFUSED acme\/app#7 cannot read the pull_request workflow runs at aaaaaaaaaaaa: HTTP 502/);
  w.runsFail = false;
  for (const bad of ["{", '{"total_count":2,"workflow_runs":[]}', '{"workflow_runs":"x"}']) {
    w.runs = bad;
    await expect(mergePr(d, PR)).rejects.toThrow(/^MERGE_REFUSED acme\/app#7 cannot read the pull_request workflow runs at aaaaaaaaaaaa/);
  }
  expect(merges(w)).toEqual([]);
  expect((await readReceipt(d.config.stateDir, PR, A, "review"))?.verdict).toBe("CLEAR");
});
