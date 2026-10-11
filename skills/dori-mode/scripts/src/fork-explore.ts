import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fill } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { addNode, laneArea, setStatus, type Tree, updateTree } from "./explore.ts";
import type { ExplorationRecord, Lane } from "./registry.ts";
import { iso } from "./run.ts";
import { watchLog } from "./watch-log.ts";

// dori fork-explore: one short, time-boxed exploration task per competing hypothesis, all measuring the same metric.
// CPU branches run at once; a GPU branch first takes a heavy slot (the same slots as dori heavy), so GPU branches queue.
// Each branch ends with METRIC / VERDICT / EVIDENCE lines; the results become one comparison table, saved under
// <stateDir>/explore/<key>/, recorded on the lane, and fed into the area's hypothesis tree.

export class ForkError extends Error {}

export type Branch = { readonly n: number; readonly hypothesis: string; readonly test: string; readonly gpu: boolean };
export type Verdict = "supports" | "falsifies" | "inconclusive" | "timeout" | "error";
export type BranchResult = Branch & { readonly verdict: Verdict; readonly metric: string; readonly evidence: string; readonly seconds: number; readonly waitedSeconds: number };
export type Mode = "agent" | "cmd";

// takes a heavy slot for label and returns its release
export type SlotTaker = (label: string) => Promise<() => void>;

export const branchesFrom = (hypotheses: readonly string[], tests: readonly string[], gpu: readonly number[], gpuAll: boolean): Branch[] => {
  const hyps = hypotheses.map((h) => h.trim()).filter(Boolean);
  if (hyps.length < 2) throw new ForkError(`fork-explore needs at least 2 --hypotheses (got ${hyps.length})`);
  if (tests.length !== hyps.length) throw new ForkError(`${tests.length} --test for ${hyps.length} --hypotheses: one discriminating test per hypothesis, in the same order`);
  return hyps.map((hypothesis, i) => ({ n: i + 1, hypothesis, test: (tests[i] ?? "").trim(), gpu: gpuAll || gpu.includes(i + 1) }));
};

const LINE = (name: string) => new RegExp(`^\\s*\\**${name}\\**\\s*[:：]\\s*(.+?)\\s*$`, "im");

export const parseBranch = (out: string): { readonly verdict: Verdict; readonly metric: string; readonly evidence: string } => {
  const v = LINE("VERDICT").exec(out)?.[1]?.toLowerCase() ?? "";
  const verdict: Verdict = v.startsWith("support") ? "supports" : v.startsWith("falsif") || v.startsWith("refut") ? "falsifies" : "inconclusive";
  const lastLine = out.trim().split("\n").filter(Boolean).at(-1) ?? "";
  return { verdict, metric: LINE("METRIC").exec(out)?.[1] ?? "-", evidence: LINE("EVIDENCE").exec(out)?.[1] ?? (v ? "-" : `no VERDICT line; last output: ${lastLine.slice(0, 160)}`) };
};

export const branchPrompt = (lane: Lane, metric: string, b: Branch, total: number, minutes: number, scratch: string): string => [
  `You are exploration branch ${b.n} of ${total} for the lane ${lane.key} (${lane.title}).`,
  ...(lane.goal ? [`The owner's goal: "${lane.goal}"`] : []),
  `Hypothesis under test: ${b.hypothesis}`,
  `Discriminating metric (the same for every branch, so results compare): ${metric}`,
  `Cheap test: ${b.test}`,
  `You have ${minutes} minutes and are stopped after that. Run the smallest version of the test that can tell whether the hypothesis holds, nothing else.`,
  `Do not edit tracked files, commit or push. Put any scratch files under ${scratch}.`,
  ...(b.gpu ? ["This branch already holds the GPU slot; run the GPU job directly (do not call dori heavy)."] : ["Do not start GPU jobs in this branch."]),
  "End your answer with exactly these three lines:",
  `METRIC: <the measured value of ${metric}>`,
  "VERDICT: supports | falsifies | inconclusive",
  "EVIDENCE: <one line: the command you ran and the numbers it gave>",
].join("\n");

export type ForkInput = { readonly metric: string; readonly branches: readonly Branch[]; readonly mode: Mode; readonly minutes: number; readonly model?: string };

const runBranch = async (deps: FlowDeps, lane: Lane, input: ForkInput, b: Branch, takeSlot: SlotTaker): Promise<BranchResult> => {
  const asked = deps.clock.now();
  const release = b.gpu ? await takeSlot(`fork-explore ${lane.key} #${b.n}`) : () => {};
  const started = deps.clock.now();
  try {
    const cwd = lane.cwd ?? deps.config.defaultCwd;
    const scratch = mkdtempSync(join(tmpdir(), `dori-fork-${lane.key}-${b.n}-`));
    const argv = input.mode === "cmd" ? ["bash", "-lc", b.test] : fill(deps.config.explore.branchCommand, { model: input.model ?? lane.model ?? deps.config.defaultModel, prompt: branchPrompt(lane, input.metric, b, input.branches.length, input.minutes, scratch) });
    const r = await deps.run(argv, { cwd, timeoutMs: input.minutes * 60_000 });
    const seconds = Math.round((deps.clock.now() - started) / 1000);
    const waitedSeconds = Math.round((started - asked) / 1000);
    if (r.code === 124) return { ...b, verdict: "timeout", metric: "-", evidence: `stopped after ${input.minutes} min`, seconds, waitedSeconds };
    const parsed = parseBranch(r.out);
    if (r.code !== 0 && parsed.verdict === "inconclusive") return { ...b, verdict: "error", metric: parsed.metric, evidence: `exit ${r.code}: ${(r.err || r.out).split("\n").filter(Boolean).at(-1)?.slice(0, 160) ?? ""}`, seconds, waitedSeconds };
    return { ...b, ...parsed, seconds, waitedSeconds };
  } finally {
    release();
  }
};

const cell = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, " ").replace(/\|/g, "/").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export const comparisonTable = (metric: string, results: readonly BranchResult[]): string => [
  `| # | hypothesis | ${cell(metric, 40)} | verdict | evidence | run | slot |`,
  "|---|---|---|---|---|---|---|",
  ...results.map((r) => `| ${r.n} | ${cell(r.hypothesis, 60)} | ${cell(r.metric, 40)} | ${r.verdict} | ${cell(r.evidence, 90)} | ${r.seconds}s | ${r.gpu ? `gpu, waited ${r.waitedSeconds}s` : "cpu"} |`),
].join("\n");

export const feedResults = (tree: Tree, lane: Lane, metric: string, results: readonly BranchResult[], at: string, ref: string): Tree => {
  let t = tree;
  for (const r of results) {
    const added = addNode(t, { kind: "hypothesis", text: r.hypothesis, test: r.test, metric, lane: lane.key, source: "fork-explore" }, at);
    const status = r.verdict === "falsifies" ? "falsified" : r.verdict === "supports" ? "supported" : "open";
    t = setStatus(added.tree, added.node.id, status, `${r.verdict}: ${metric} = ${r.metric}; ${r.evidence} (${ref})`, at).tree;
  }
  return t;
};

export const forkExplore = async (deps: FlowDeps, lane: Lane, input: ForkInput, takeSlot: SlotTaker): Promise<{ readonly table: string; readonly results: readonly BranchResult[]; readonly file: string }> => {
  const results = await Promise.all(input.branches.map((b) => runBranch(deps, lane, input, b, takeSlot)));
  const at = iso(deps.clock);
  const table = comparisonTable(input.metric, results);
  const dir = join(deps.config.stateDir, "explore", lane.key);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${at.replace(/[:.]/g, "-")}.md`);
  await Bun.write(file, [`# fork-explore ${lane.key}`, "", `- At: ${at}`, `- Metric: ${input.metric}`, `- Mode: ${input.mode}, ${input.minutes} min per branch`, "", table, "", "```json", JSON.stringify(results, null, 1), "```", ""].join("\n"));
  await updateTree(deps.config.stateDir, laneArea(lane, deps.config), (t) => feedResults(t, lane, input.metric, results, at, `fork-explore ${file}`));
  const record: ExplorationRecord = { at, metric: input.metric, branches: results.length, file };
  const fresh = await deps.registry.read(lane.key);
  await deps.registry.patch(lane.key, { explorations: [...(fresh?.explorations ?? []), record] });
  watchLog(deps.config.watchLog, deps.clock, { source: "fork-explore", line: `FORK_EXPLORE ${lane.key} "${input.metric}" ${results.map((r) => `#${r.n} ${r.verdict}`).join(", ")} file=${file}` });
  return { table, results, file };
};
