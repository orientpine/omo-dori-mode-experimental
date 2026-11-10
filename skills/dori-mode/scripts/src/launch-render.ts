import { resolve } from "node:path";
import { runWithPrompt } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import type { Lane } from "./registry.ts";
import { iso } from "./run.ts";
import { addedLine, type DirectivePick, type Ledger, mergePicks, missingLines, parsePick, PICK_RUNS, PICK_SYSTEM, pickCandidates, pickPrompt, planDirectives, type ScopeContext, scopeContext, waivedLines, withDirectives } from "./directives.ts";
import { type LaunchInput, LaunchError } from "./launch-types.ts";
import { uiSteps, withUiSteps, eightSteps, withEightSteps, stepsLine, uiWarning, footer } from "./launch-footer.ts";
import { intentFields, launchLedger, laneRepo } from "./launch-state.ts";
import { pastSignals, treeContext, withoutLessons, repoLessons } from "./launch-context.ts";
import { leadModel } from "./lane-model.ts";

const draftLane = (deps: FlowDeps, input: LaunchInput): Lane => ({
  ...(input.noThread?.trim() ? { noThread: input.noThread.trim() } : {}),
  ...(input.whyNew?.trim() ? { whyNew: input.whyNew.trim() } : {}),
  // the brief as an absolute path: the audit, intent-check and freshness read it from another directory than the lead's
  key: input.key, title: input.title, thread: input.thread ?? "none", brief: resolve(input.brief), done: input.done, cwd: input.cwd ?? deps.config.defaultCwd, model: input.model ?? leadModel(deps.config) ?? deps.config.defaultModel,
  ...(input.model ? { modelPinned: true } : {}),
  ...(input.tags?.length ? { tags: input.tags } : {}), ...intentFields(input), openedAt: iso(deps.clock),
  ...(input.budget && Object.keys(input.budget).length ? { budget: input.budget } : {}), ...(input.activityPaths?.length ? { activityPaths: input.activityPaths } : {}),
});

type Chosen = { readonly pick?: DirectivePick; readonly pickFallback?: string };

// Which non-fixed entries this brief needs, from the small model; on any failure the scope rules decide and the record says why.
const pickDirectives = async (deps: FlowDeps, raw: string, ledger: Ledger, ctx: ScopeContext): Promise<Chosen> => {
  const model = deps.config.directives.pickModel;
  if (!model) return {};
  const candidates = pickCandidates(ledger, ctx);
  const prompt = pickPrompt(raw, candidates);
  // an argument this long does not reach the model at all
  if (Buffer.byteLength(prompt) > 120_000) return { pickFallback: "the brief is too long to pass to the model" };
  const runs = await Promise.all(Array.from({ length: PICK_RUNS }, () => runWithPrompt(deps.run, deps.config.reviewers.command, { model, system: PICK_SYSTEM, prompt }, { timeoutMs: 60_000 })));
  const lists = runs.flatMap((r) => (r.code === 0 ? [parsePick(r.out, candidates)] : [])).filter((l) => l !== undefined);
  if (!lists.length) return { pickFallback: `${model} gave no usable list in ${PICK_RUNS} runs (exit ${runs.map((r) => r.code).join(", ")})` };
  return { pick: { model, picked: mergePicks(lists), runs: { asked: PICK_RUNS, answered: lists.length }, evaluated: candidates.map((e) => e.id) } };
};

export type Rendered = {
  readonly draft: Lane;
  readonly text: string;
  readonly steps?: string;
  // LAUNCH_UI_HINT, LAUNCH_DIRECTIVE_ADDED and LAUNCH_DIRECTIVE_WAIVED lines, for the lead and the watch log
  readonly lines: readonly string[];
  // LAUNCH_DIRECTIVE_MISSING lines: the launch stops when there is one
  readonly missing: readonly string[];
};

// The brief as the lane will read it: the lead's text with the eight steps, the UI steps for UI work and the directives of
// the ledger in scope it lacks, then the repo's lessons, Past signals, the hypothesis tree, and the footer.
export const renderBrief = async (deps: FlowDeps, input: LaunchInput): Promise<Rendered> => {
  const briefFile = Bun.file(input.brief);
  if (!(await briefFile.exists())) throw new LaunchError(`brief not found: ${input.brief}`);
  // a brief launched before carries the lessons launch wrote then (one maybe retired since): only that block is cut and made
  // anew; text added after the footer since (backlog's read-only rule, an owner's answer) stays as it is
  const raw = withoutLessons(await briefFile.text()).replace(/\s*$/, "");
  const cwd = input.cwd ?? deps.config.defaultCwd;
  const ledger = launchLedger(deps);
  const ctx = scopeContext(raw, ledger, { ui: input.ui, repo: ledger.entries.length ? await laneRepo(deps, cwd) : "" });
  const chosen = ledger.entries.length ? (input.pick ?? (await pickDirectives(deps, raw, ledger, ctx))) : { pickFallback: "" };
  const plan = planDirectives(raw, ledger, ctx, input.waive, chosen.pick);
  const ui = Boolean(input.ui) || plan.blocks.includes("ui-steps");
  const at = iso(deps.clock);
  const draft: Lane = { ...draftLane(deps, input), ...(ui ? { ui: true } : {}), ...(ledger.entries.length ? { directives: { applied: plan.applied, waived: plan.waived.map(({ e, reason }) => ({ id: e.id, reason, at })), ...chosen } } : {}) };
  const past = await pastSignals(deps, input, draft.cwd ?? deps.config.defaultCwd);
  const tree = await treeContext(deps, draft);
  const skipEight = plan.waived.some(({ e }) => e.block === "eight-steps");
  const eight = skipEight ? { text: raw, added: false, missing: [] } : withEightSteps(raw, await eightSteps());
  const lead = withDirectives(eight.text, plan.add);
  const steps = stepsLine(input.key, eight);
  const hint = uiWarning(input, raw, ledger, ui);
  const added = addedLine(input.key, plan);
  const lessons = repoLessons(deps, draft.cwd ?? deps.config.defaultCwd, lead);
  const picked = chosen.pick ? `LAUNCH_DIRECTIVE_PICKED ${input.key}: ${chosen.pick.model} chose ${chosen.pick.picked.map((p) => p.id).join(", ")} (${chosen.pick.runs?.answered ?? 1} of ${chosen.pick.runs?.asked ?? 1} runs answered)` : chosen.pickFallback ? `LAUNCH_DIRECTIVE_PICK_FALLBACK ${input.key}: the scope rules decide (${chosen.pickFallback})` : undefined;
  const lines = [...(hint ? [hint] : []), ...(added ? [added] : []), ...(picked ? [picked] : []), ...waivedLines(input.key, plan), ...lessons.warnings];
  return { draft, ...(steps ? { steps } : {}), lines, missing: missingLines(input.key, plan), text: `${ui ? withUiSteps(lead, await uiSteps()) : lead}\n${lessons.section ? `${lessons.section}\n` : ""}${past ? `${past}\n` : ""}${tree ? `${tree}\n` : ""}${footer(draft, deps.config.leadPane, deps.config.backend, Object.keys(deps.config.mergeGate.repos))}` };
};

// The first lines of the lead's brief (headings and blank lines left out), for the thread's first message.
export const briefSummary = (brief: string, lines = 4): string =>
  brief.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).slice(0, lines).map((l) => (l.length > 200 ? `${l.slice(0, 199)}…` : l)).join("\n");

// discord.laneStartText filled in; a line whose placeholder has nothing to fill (a lane without --goal) is left out.
export const laneStartText = (template: string, lane: Lane, brief: string): string => {
  const values: Record<string, string> = { title: lane.title, goal: lane.goal ?? "", brief: briefSummary(brief), done: lane.done, key: lane.key, pane: lane.pane ?? "" };
  const text = template
    .split("\n")
    .filter((line) => [...line.matchAll(/\{(\w+)\}/g)].every(([, k]) => !(k && k in values) || values[k]))
    .map((line) => line.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m))
    .join("\n");
  return text.length > 1900 ? `${text.slice(0, 1899)}…` : text;
};

export const goalWarning = (input: LaunchInput): string | undefined =>
  input.goal?.trim() ? undefined : `LAUNCH_NO_GOAL ${input.key}: no --goal "<the owner's words>"; dori intent-check cannot compare the lane's direction with what the owner asked`;
