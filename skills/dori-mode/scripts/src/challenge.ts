import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { fill } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { formatTree, laneArea, loadTree } from "./explore.ts";
import type { ChallengeRecord, Lane } from "./registry.ts";
import { iso } from "./run.ts";
import { watchLog } from "./watch-log.ts";

// dori challenge: before a big step, a model of another family than the lane's own reads the plan in a fresh context
// (no tools, no session, no project files) and argues against it. The review is saved under <stateDir>/challenges/<key>/
// and recorded on the lane.

export class ChallengeError extends Error {}

const FAMILIES: readonly [RegExp, string][] = [
  [/claude|opus|sonnet|haiku|fable/, "anthropic"],
  [/gpt|^o\d|codex|davinci/, "openai"],
  [/grok/, "xai"],
  [/gemini|gemma/, "google"],
  [/qwen/, "qwen"],
  [/kimi|moonshot/, "moonshot"],
  [/glm|zhipu/, "zhipu"],
  [/deepseek/, "deepseek"],
  [/minimax/, "minimax"],
  [/mistral|pixtral|codestral/, "mistral"],
  [/nova/, "amazon"],
  [/llama/, "meta"],
];

// The model's family from its id, whatever provider serves it (github-copilot/gpt-6.1-sol is openai).
export const familyOf = (model: string): string => {
  const id = (model.split("/").pop() ?? model).toLowerCase();
  return FAMILIES.find(([re]) => re.test(id))?.[1] ?? (model.includes("/") ? (model.split("/")[0] ?? id) : id);
};

export const reviewers = (laneModel: string, candidates: readonly string[]): string[] => candidates.filter((m) => familyOf(m) !== familyOf(laneModel));

export const SECTIONS = ["Reasons this will fail", "Missing alternatives", "Cheapest falsifying test"] as const;

const MAX_PLAN = 60_000;

export const challengePrompt = (lane: Lane, plan: string, tree: string): string => [
  "You are an adversarial reviewer with no stake in this plan. You did not write it and you will not carry it out. Your job is to find why it will fail before anyone spends time on it.",
  `Project: ${lane.title} (lane ${lane.key}).`,
  ...(lane.goal ? [`The owner's goal, in their words: "${lane.goal}"`] : []),
  "What the project already tried and learned (hypothesis tree):",
  tree,
  "The plan under review:",
  "<<<PLAN",
  plan.length > MAX_PLAN ? `${plan.slice(0, MAX_PLAN)}\n[plan cut at ${MAX_PLAN} characters]` : plan,
  "PLAN>>>",
  "Answer in plain markdown with exactly these three headings, in this order:",
  `## ${SECTIONS[0]}`,
  "Concrete, specific failure modes, most likely first. Name the assumption each one breaks. No generic risks.",
  `## ${SECTIONS[1]}`,
  "Competing explanations or approaches the plan ignores, including ones the tree has not ruled out.",
  `## ${SECTIONS[2]}`,
  "The single cheapest experiment (minutes, not hours) whose result would show the plan is wrong, with the number or observation that would decide it.",
  "Be blunt and short. Do not praise the plan.",
].join("\n");

// replaces the agent's own system prompt, which would make the reviewer announce a plan instead of writing the review
export const REVIEWER_SYSTEM = "You are an adversarial plan reviewer. You only write the review text the user asks for, under the requested headings. You never describe what you are about to do and you never ask questions.";

export const missingSections = (text: string): string[] => SECTIONS.filter((s) => !text.toLowerCase().includes(s.toLowerCase()));

export type ChallengeResult = { readonly record: ChallengeRecord; readonly text: string; readonly failures: readonly string[]; readonly missing: readonly string[] };

// Tries each reviewer of another family in order (explore.challengeModels, or the one --model) until one answers.
export const runChallenge = async (deps: FlowDeps, lane: Lane, planFile: string, model?: string): Promise<ChallengeResult> => {
  const file = Bun.file(planFile);
  if (!(await file.exists())) throw new ChallengeError(`plan not found: ${planFile}`);
  const plan = (await file.text()).trim();
  if (!plan) throw new ChallengeError(`plan ${planFile} is empty`);
  const cfg = deps.config.explore;
  const own = lane.model ?? deps.config.defaultModel;
  const candidates = model ? [model] : reviewers(own, cfg.challengeModels);
  if (!candidates.length) throw new ChallengeError(`no reviewer in explore.challengeModels is of another family than the lane's model ${own} (${familyOf(own)})`);
  if (model && familyOf(model) === familyOf(own)) throw new ChallengeError(`--model ${model} is the lane's own family (${familyOf(own)}); pick another family`);
  const tree = formatTree(await loadTree(deps.config.stateDir, laneArea(lane, deps.config)));
  const prompt = challengePrompt(lane, plan, tree);
  const failures: string[] = [];
  for (const m of candidates) {
    const r = await deps.run(fill(cfg.challengeCommand, { model: m, prompt, system: REVIEWER_SYSTEM }), { timeoutMs: cfg.challengeMinutes * 60_000 });
    if (r.code !== 0 || !r.out.trim()) {
      failures.push(`${m}: ${r.code !== 0 ? `exit ${r.code} ${r.err.split("\n").filter(Boolean).at(-1)?.slice(0, 160) ?? ""}` : "empty answer"}`);
      continue;
    }
    const missing = missingSections(r.out);
    if (missing.length === SECTIONS.length) {
      failures.push(`${m}: the answer has none of the three sections (${r.out.trim().split("\n")[0]?.slice(0, 100) ?? ""})`);
      continue;
    }
    const at = iso(deps.clock);
    const dir = join(deps.config.stateDir, "challenges", lane.key);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${at.replace(/[:.]/g, "-")}.md`);
    await Bun.write(path, [`# Challenge of ${lane.key}`, "", `- At: ${at}`, `- Reviewer: ${m} (${familyOf(m)}); lane model ${own} (${familyOf(own)})`, `- Plan: ${planFile}`, "", r.out.trim(), ""].join("\n"));
    const record: ChallengeRecord = { at, model: m, plan: planFile, file: path };
    const fresh = await deps.registry.read(lane.key);
    await deps.registry.patch(lane.key, { challenges: [...(fresh?.challenges ?? []), record] });
    watchLog(deps.config.watchLog, deps.clock, { source: "challenge", line: `CHALLENGE ${lane.key} reviewer=${m} plan=${planFile} file=${path}${missing.length ? ` missing: ${missing.join(", ")}` : ""}` });
    return { record, text: r.out.trim(), failures, missing };
  }
  throw new ChallengeError(`no reviewer answered: ${failures.join(" | ")}`);
};

// A lane launched with --challenge-before cannot claim done before one challenge is on record.
export const challengeMissing = (lane: Lane): string | undefined =>
  lane.challengeBefore?.length && !lane.challenges?.length
    ? `CHALLENGE_MISSING ${lane.key}: launched with --challenge-before ${lane.challengeBefore.map((s) => `"${s}"`).join(", ")} and no challenge on record; run dori challenge ${lane.key} --plan <file> first`
    : undefined;
