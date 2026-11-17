import type { FlowDeps } from "./done-flow.ts";
import { isSourcePath, isTestPath, type PrRef } from "./merge-gate.ts";
import { watchLog } from "./watch-log.ts";

const isDoc = (path: string): boolean => /\.md$/i.test(path) || /(?:^|\/)(?:references|docs)\//i.test(path) || /(?:^|\/)README(?:[./]|$)/i.test(path);

// Inspect the net PR file list, not every commit: a documentation edit reverted later is not a documentation update.
// This is advisory; an unavailable file list must not change the review's existing verdict, receipts or exit code.
export const warnDocsUntouched = async (deps: FlowDeps, pr: PrRef, executables: ReadonlySet<string>): Promise<void> => {
  const files = await deps.run(["gh", "pr", "diff", pr.number, "--repo", pr.repo, "--name-only"]);
  if (files.code !== 0) return;
  const paths = files.out.split("\n").filter(Boolean);
  const code = paths.filter((p) => !isDoc(p) && !isTestPath(p) && (isSourcePath(p) || /(?:^|\/)(?:scripts\/src|setups)\//.test(p) || executables.has(p)));
  if (!code.length || paths.some(isDoc)) return;
  const line = `DOCS_UNTOUCHED ${pr.id}: ${code.length} code file(s) changed and no documentation file was touched (directive docs-same-pr; a warning for now, refusal to be reviewed on 2026-12-01)`;
  console.error(line);
  watchLog(deps.config.watchLog, deps.clock, { source: "review", line });
};
