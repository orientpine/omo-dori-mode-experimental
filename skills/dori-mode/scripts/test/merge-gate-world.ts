import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultConfig } from "../src/config.ts";
import type { FlowDeps } from "../src/done-flow.ts";
import { parsePr } from "../src/merge-gate.ts";
import { Registry } from "../src/registry.ts";
import type { Ran, Runner } from "../src/run.ts";

// The fake gh, git, test run and reviewer the dori review / dori merge tests share (merge-gate.test.ts, merge-gate-rereview.test.ts).

export const A = "a".repeat(40);
export const B = "b".repeat(40);
export const PR = parsePr("acme/app#7");
export const DIR = "/wt/app";

export type FakeCommit = { sha: string; subject: string; email?: string; numstat?: string };
export type Gh = { commits?: FakeCommit[]; atHead?: string[]; head: string; checkout: string; state: string; dirtyAfterTests?: boolean; tested?: boolean; statusFails?: boolean; queued?: boolean; viewFailsAfterMerge?: boolean; deleteFails?: boolean; mergeRejects?: boolean; autoMerge?: boolean; diff?: string; prompt?: string | undefined; pushDuringReview?: string; noVerdict?: { code: number; out: string; times: number; err?: string }; reviewerThrows?: boolean; checks: Record<string, string>[]; testsCode: number; verdict: string; mergedAt: string; calls: string[][] };

const dirs: string[] = [];
export const cleanup = (): void => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
};

export const world = (): Gh => ({ head: A, checkout: A, state: "OPEN", checks: [], testsCode: 0, verdict: "CLEAR", mergedAt: "", calls: [] });

export const runner = (w: Gh): Runner => async (argv) => {
  w.calls.push([...argv]);
  const ok = (out = ""): Ran => ({ code: 0, out, err: "" });
  const a = argv.join(" ");
  if (a.startsWith("gh pr view") && w.viewFailsAfterMerge && w.calls.some((c) => c[2] === "merge")) return { code: 1, out: "", err: "HTTP 502" };
  if (a.startsWith("gh pr view")) return ok(JSON.stringify({ state: w.state, headRefOid: w.head, mergedAt: w.mergedAt || null, mergeCommit: w.state === "MERGED" ? { oid: "m".repeat(40) } : null, title: "demo", statusCheckRollup: w.checks, autoMergeRequest: w.autoMerge ? { enabledAt: "2026-11-02T08:00:00Z" } : null }));
  if (a.startsWith("gh pr diff")) return ok(w.diff ?? "diff --git a/x b/x\n+x");
  const listed = w.commits ?? [{ sha: w.head, subject: "feat: demo" }];
  if (a.startsWith("gh api --paginate repos/")) return ok(listed.map((c) => `${c.sha}\n`).join(""));
  const one = listed.find((c) => c.sha === argv.at(-1));
  if (argv[3] === "log" && one) return ok(`Lane\0${one.email ?? "lane@example.org"}\0Lane\0${one.email ?? "lane@example.org"}\0${"0".repeat(40)}\0${one.subject}\n`);
  if (argv[3] === "show" && one) return ok(one.numstat ?? "3\t1\tsrc/x.ts\0");
  if (argv[3] === "ls-tree") return ok((w.atHead ?? ["src/x.ts"]).map((p) => `100644 blob ${"0".repeat(40)}\t${p}\0`).join(""));
  if (a.startsWith("gh pr merge") && argv.includes("--disable-auto")) return ok();
  if (a.startsWith("gh pr merge") && w.mergeRejects) return { code: 1, out: "", err: "GraphQL: Head branch was modified. Review and try the merge again." };
  if (a.startsWith("gh pr merge")) {
    const at = argv[argv.indexOf("--match-head-commit") + 1];
    if (at !== w.head) return { code: 1, out: "", err: "GraphQL: Head branch was modified" };
    if (!w.queued) w.state = "MERGED";
    return w.deleteFails ? { code: 1, out: "", err: "failed to delete remote branch feat" } : ok();
  }
  if (a.includes("rev-parse --show-toplevel")) return ok(`${DIR}\n`);
  if (a.includes("rev-parse HEAD")) return ok(`${w.checkout}\n`);
  if (a.includes(` diff ${A}..${B}`)) return ok("diff --git a/fix b/fix\n+FIXED_SINCE_REVIEW");
  if (a.includes("status --porcelain") && w.statusFails) return { code: 128, out: "", err: "fatal: not a git repository" };
  if (a.includes("status --porcelain")) return ok(w.tested && w.dirtyAfterTests ? " M src/x.ts\n" : "");
  if (argv[0] === "bun" && argv[1] === "test") {
    w.tested = true;
    return { code: w.testsCode, out: "", err: w.testsCode ? "1 fail" : "42 pass\n0 fail" };
  }
  if (argv[0] === "fake-reviewer") {
    if (w.reviewerThrows) throw new Error("spawn fake-reviewer ENOENT");
    if (w.pushDuringReview) w.head = w.pushDuringReview;
    w.prompt = argv.at(-1);
    if (w.noVerdict && w.noVerdict.times-- > 0) return { code: w.noVerdict.code, out: w.noVerdict.out, err: w.noVerdict.err ?? (w.noVerdict.code ? "error: provider overloaded" : "") };
    return ok(`LOW x:1 nit\nVERDICT: ${w.verdict}\n`);
  }
  return { code: 127, out: "", err: `unexpected ${a}` };
};

export const deps = (w: Gh, repos: Record<string, string> = {}, identities: Record<string, { name: string; email: string }> = {}): FlowDeps => {
  const state = mkdtempSync(join(tmpdir(), "merge-gate-"));
  dirs.push(state);
  const base = defaultConfig(state);
  const config = { ...base, stateDir: state, watchLog: join(state, "lanes.log"), explore: { ...base.explore, modelsCommand: [], challengeCommand: ["fake-reviewer", "{model}", "{prompt}"] }, mergeGate: { ...base.mergeGate, repos, identities } };
  return { run: runner(w), clock: { now: () => Date.parse("2026-11-02T08:00:00Z"), sleep: async () => {} }, registry: new Registry(state), config };
};

export const merges = (w: Gh) => w.calls.filter((c) => c[0] === "gh" && c[2] === "merge");
