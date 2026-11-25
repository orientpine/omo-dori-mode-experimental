import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { prDiff } from "../src/merge-gate-head.ts";
import { parsePr, readReceipt, reviewPr } from "../src/merge-gate.ts";
import { run } from "../src/run.ts";
import { A, cleanup, DIR, deps, PR, world } from "./merge-gate-world.ts";

// GitHub refuses the diff of a pull request over 20000 lines (HTTP 406 too_large): the review reads the same diff from the
// clean checkout it already verified at the head, against the PR's base commit
afterEach(cleanup);

const failure = (p: Promise<unknown>): Promise<Error> => p.then(() => { throw new Error("expected a refusal"); }, (e: unknown) => e as Error);

test("a diff GitHub refuses as too large is read from the verified checkout against the PR's base", async () => {
  const w = { ...world(), diffTooLarge: true, base: "c".repeat(40) };
  const d = deps(w);
  await reviewPr(d, PR, { dir: DIR });
  expect(w.calls).toContainEqual(["git", "-C", DIR, "diff", "--no-ext-diff", "--no-textconv", "--no-color", `${"c".repeat(40)}...${A}`]);
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
  const empty = { ...world(), diffTooLarge: true, localDiff: "" };
  expect((await failure(reviewPr(deps(empty), PR, { dir: DIR }))).message).toContain("printed nothing");
  expect(empty.prompt).toBeUndefined();
  const local = { ...world(), diffTooLarge: true, localDiffFails: true };
  expect((await failure(reviewPr(deps(local), PR, { dir: DIR }))).message).toStartWith("REVIEW_REFUSED cannot read the diff of acme/app#7: ");
  expect(local.prompt).toBeUndefined();
});

test("a local diff driver or textconv the checkout configures cannot replace the patch the reviewer reads", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pr-diff-"));
  try {
    const git = (...args: string[]) => run(["git", "-C", repo, ...args]);
    await git("init", "-q");
    await git("config", "user.email", "t@example.org");
    await git("config", "user.name", "t");
    writeFileSync(join(repo, "x.ts"), "old\n");
    await git("add", ".");
    await git("commit", "-qm", "base");
    const base = (await git("rev-parse", "HEAD")).out.trim();
    writeFileSync(join(repo, "x.ts"), "NEW_LINE\n");
    writeFileSync(join(repo, ".gitattributes"), "*.ts diff=hide\n");
    await git("add", ".");
    await git("commit", "-qm", "change");
    const head = (await git("rev-parse", "HEAD")).out.trim();
    await git("config", "diff.external", "/bin/true");
    await git("config", "diff.hide.textconv", "/bin/true");
    const runGh = async (argv: readonly string[]) => {
      if (argv[0] === "gh" && argv[2] === "diff") return { code: 1, out: "", err: "HTTP 406: Sorry, the diff exceeded the maximum number of lines (20000)" };
      if (argv[0] === "gh") return { code: 0, out: JSON.stringify({ base: { sha: base } }), err: "" };
      return run(argv);
    };
    const got = await prDiff({ run: runGh }, parsePr("acme/app#7"), repo, head);
    expect(got.code).toBe(0);
    expect(got.out).toContain("+NEW_LINE");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
