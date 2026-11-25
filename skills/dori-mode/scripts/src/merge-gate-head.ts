import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { CheckpointError, takeLock } from "./checkpoint-lock.ts";
import type { FlowDeps } from "./done-flow.ts";
import { GateRefusal, type PrRef, receiptPath, unsupported } from "./merge-gate.ts";
import type { Ran } from "./run.ts";

type Prefix = "REVIEW_REFUSED" | "MERGE_REFUSED";
type WorkflowRun = { readonly name?: unknown; readonly status?: unknown; readonly conclusion?: unknown };

const short = (sha: string): string => sha.slice(0, 12);

// Upstream #280 (https://github.com/sisyphuslabs/dori-superagent/pull/280, carries #234): statusCheckRollup lists check
// runs only, so a pull_request workflow waiting for approval or that failed to start shows none and the PR read as one
// without CI. Any pull_request run at the head counts as CI here; a runs answer that is unreadable, cut off or malformed
// refuses instead of counting as none.
const workflowRuns = async (deps: Pick<FlowDeps, "run">, pr: PrRef, sha: string, prefix: Prefix): Promise<string | undefined> => {
  const cannot = (why: string) => new GateRefusal(`${prefix} ${pr.id} cannot read the pull_request workflow runs at ${short(sha)}: ${why}; the merge stays refused until they can be read`);
  const r = await deps.run(["gh", "api", `repos/${pr.repo}/actions/runs?event=pull_request&head_sha=${sha}&per_page=100`]);
  if (r.code !== 0) throw cannot((r.err || r.out).trim().split("\n").slice(-1).join(" ").slice(0, 200) || `exit ${r.code}`);
  let answer: { readonly total_count?: unknown; readonly workflow_runs?: unknown };
  try {
    answer = JSON.parse(r.out) as typeof answer;
  } catch {
    throw cannot("the answer is not JSON");
  }
  const runs = answer?.workflow_runs;
  if (!Array.isArray(runs) || answer.total_count !== runs.length) throw cannot("the answer is cut off or has no workflow_runs list");
  if (!runs.length) return undefined;
  const named = (runs as WorkflowRun[]).map((w) => `${String(w.name ?? "?")} ${String(w.status ?? "?")}/${String(w.conclusion ?? "-")}`);
  return `unsupported:workflows (${runs.length} pull_request workflow run${runs.length > 1 ? "s" : ""} at this head: ${named.slice(0, 3).join(", ")}${runs.length > 3 ? ", ..." : ""}; this gate is for repos without CI)`;
};

// Upstream #278 (https://github.com/sisyphuslabs/dori-superagent/pull/278, carries #232): dori review and dori merge of
// one (pr, sha) take turns. Without it, an earlier review could save CLEAR after a later one cleared the head, and a merge
// could pass on that CLEAR while the later review still ran. The lock is a flock (checkpoint-lock.ts), so a holder that
// dies frees it with no takeover by pid or age; the second actor is refused, never kept waiting.
export const holdHead = async (deps: Pick<FlowDeps, "run" | "config" | "clock">, pr: PrRef, view: Parameters<typeof unsupported>[0], prefix: Prefix): Promise<Disposable> => {
  const notHere = unsupported(view) ?? (await workflowRuns(deps, pr, view.headRefOid, prefix));
  if (notHere) throw new GateRefusal(`${prefix} ${pr.id} ${notHere}`);
  const lock = receiptPath(deps.config.stateDir, pr, view.headRefOid, "review").replace(/\.review\.json$/, ".lock");
  mkdirSync(dirname(lock), { recursive: true });
  try {
    const release = takeLock(lock, deps.clock.now(), "review/merge", `${pr.id}@${short(view.headRefOid)}`);
    return { [Symbol.dispose]: release };
  } catch (e) {
    if (!(e instanceof CheckpointError)) throw e;
    throw new GateRefusal(`${prefix} ${pr.id} head ${short(view.headRefOid)} is held by another dori review or merge (${e.message}); run it again once that one has finished`);
  }
};

const TOO_LARGE = /too_large|exceeded the maximum number of lines/;

// The PR's diff for its review. GitHub refuses one over 20000 lines (HTTP 406 too_large), seen on a 2.4k-line PR as well;
// then the same three-dot diff is read from the clean checkout the review already verified at the head, against the PR's
// base commit. Any other failure stays a failure, so the review is refused as before.
export const prDiff = async (deps: Pick<FlowDeps, "run">, pr: PrRef, root: string, sha: string): Promise<Ran> => {
  const gh = await deps.run(["gh", "pr", "diff", pr.number, "--repo", pr.repo]);
  if (gh.code === 0 || !TOO_LARGE.test(`${gh.err}\n${gh.out}`)) return gh;
  // gh pr view has no base commit field; the REST pull request has it as base.sha
  const view = await deps.run(["gh", "api", `repos/${pr.repo}/pulls/${pr.number}`]);
  if (view.code !== 0) return view;
  const base: unknown = (JSON.parse(view.out) as { base?: { sha?: unknown } }).base?.sha;
  if (typeof base !== "string" || !/^[0-9a-f]{40}$/.test(base)) return { code: 1, out: "", err: `${gh.err.trim()}; and gh named no base commit` };
  // the checkout's own diff drivers and textconv filters must not replace the patch the reviewer reads (an external driver
  // can print nothing and still exit 0), and an empty diff of a PR is no diff to review
  const local = await deps.run(["git", "-C", root, "diff", "--no-ext-diff", "--no-textconv", "--no-color", `${base}...${sha}`]);
  return local.code === 0 && !local.out.trim() ? { code: 1, out: "", err: `git diff ${base.slice(0, 12)}...${sha.slice(0, 12)} in ${root} printed nothing` } : local;
};
