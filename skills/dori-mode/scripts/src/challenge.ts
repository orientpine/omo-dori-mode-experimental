import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { fill } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { formatTree, laneArea, loadTree } from "./explore.ts";
import type { ChallengeRecord, Lane } from "./registry.ts";
import { iso, type Ran } from "./run.ts";
import { watchLog } from "./watch-log.ts";

// dori challenge: before a big step, a model of another family than the lane's own reads the plan in a fresh context
// (no tools, no session, no project files) and argues against it. The review is saved under <stateDir>/challenges/<key>/
// and recorded on the lane. A reply without the three headings (a reviewer that only announces it will read files first)
// gets one stricter retry; a reviewer the host cannot call under its provider gets one more try as the bare model id;
// then the next reviewer in the list.

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
  "Everything you get is in this message. You have no tools: you cannot open files, run code, or ask questions, and there is no second turn. Where the plan points at a file or a result you cannot see, judge from what the plan says about it. Write the whole review in this one reply, under the three headings given after the plan.",
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
  `Start your reply with the line "## ${SECTIONS[0]}".`,
].join("\n");

// The retry after a reply without the headings: the same prompt, what went wrong, and an order to write the review now.
export const strictPrompt = (prompt: string, previous: string, missing: readonly string[]): string => [
  prompt,
  "",
  `Your previous reply was not the review: it lacked ${missing.map((s) => `"## ${s}"`).join(", ")} and began: "${previous.trim().replace(/\s+/g, " ").slice(0, 200)}".`,
  "You cannot read anything else and there is no next turn: this reply is the review. Write all three sections now, from the plan above, with nothing before the first heading:",
  ...SECTIONS.map((s) => `## ${s}`),
].join("\n");

// replaces the agent's own system prompt, which would make the reviewer announce a plan instead of writing the review
export const REVIEWER_SYSTEM = "You are an adversarial plan reviewer. You have no tools and cannot read files; everything you need is in the user's message. You only write the review text the user asks for, under the requested headings, in one reply. You never describe what you are about to do and you never ask questions.";

export const missingSections = (text: string): string[] => SECTIONS.filter((s) => !text.toLowerCase().includes(s.toLowerCase()));

// github-copilot/gpt-6.1-sol -> gpt-6.1-sol: omo resolves a bare id to whichever provider of that model is logged in
export const bareId = (model: string): string | undefined => (model.includes("/") ? model.split("/").pop() || undefined : undefined);

// the line of the reviewer's stderr that says why it failed (omo ends a login error with links to its docs)
const why = (r: Ran): string => {
  const lines = r.err.split("\n").map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => /error|api key|log ?in|authenticat|ambiguous|not found|unknown|timeout/i.test(l)) ?? lines.at(-1) ?? "";
  return `exit ${r.code}${line ? ` ${line.slice(0, 200)}` : ""}`;
};

const stampOf = (at: string): string => at.replace(/[:.]/g, "-");

export type ChallengeResult = { readonly record: ChallengeRecord; readonly text: string; readonly failures: readonly string[] };

// Tries each reviewer of another family in order (explore.challengeModels, or the one --model) until one writes all
// three sections. A reviewer that exits with an error under a provider it cannot reach is tried once more as its bare id;
// one that answers without the sections gets one stricter retry, and if that still lacks them both replies are saved as
// <time>-<model>-raw.md and the next reviewer is asked.
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
  const dir = join(deps.config.stateDir, "challenges", lane.key);
  mkdirSync(dir, { recursive: true });
  const ask = (m: string, text: string): Promise<Ran> => deps.run(fill(cfg.challengeCommand, { model: m, prompt: text, system: REVIEWER_SYSTEM }), { timeoutMs: cfg.challengeMinutes * 60_000 });
  const failures: string[] = [];
  const skip = (line: string): void => {
    failures.push(line);
    watchLog(deps.config.watchLog, deps.clock, { source: "challenge", line: `CHALLENGE_SKIP ${lane.key} ${line}` });
  };
  const tried = new Set<string>();
  for (const listed of candidates) {
    const bare = bareId(listed);
    for (const m of [listed, ...(bare && bare !== listed ? [bare] : [])]) {
      if (tried.has(m)) continue;
      tried.add(m);
      const first = await ask(m, prompt);
      if (first.code !== 0) {
        skip(`${m}: ${why(first)}${m === listed && bare && first.code !== 124 ? `; trying ${bare}` : ""}`);
        if (first.code === 124) break; // the model was reached and ran out of time; its bare id is the same model
        continue;
      }
      let answer = first.out.trim();
      let missing = missingSections(answer);
      let attempts = 1;
      if (missing.length) {
        const second = await ask(m, strictPrompt(prompt, answer, missing));
        attempts = 2;
        const retried = second.out.trim();
        if (second.code !== 0 || missingSections(retried).length) {
          const raw = join(dir, `${stampOf(iso(deps.clock))}-${m.replace(/[^A-Za-z0-9._-]+/g, "-")}-raw.md`);
          await Bun.write(raw, [`# Incomplete challenge replies of ${m} for ${lane.key}`, "", `- Plan: ${planFile}`, "", "## First reply", "", answer || "(empty)", "", `## Stricter retry (exit ${second.code})`, "", retried || "(empty)", ...(second.err.trim() ? ["", "stderr:", second.err.trim()] : []), ""].join("\n"));
          skip(`${m}: no complete review after a stricter retry (first reply lacked ${missing.join(", ")}: "${answer.split("\n")[0]?.slice(0, 100) ?? ""}"; retry ${second.code !== 0 ? why(second) : `lacked ${missingSections(retried).join(", ")}`}); raw replies: ${raw}`);
          break;
        }
        answer = retried;
        missing = [];
      }
      const at = iso(deps.clock);
      const path = join(dir, `${stampOf(at)}.md`);
      await Bun.write(path, [`# Challenge of ${lane.key}`, "", `- At: ${at}`, `- Reviewer: ${m} (${familyOf(m)}); lane model ${own} (${familyOf(own)})`, `- Plan: ${planFile}`, ...(attempts > 1 ? ["- Attempts: 2 (the first reply had no complete review; a stricter retry wrote it)"] : []), "", answer, ""].join("\n"));
      const record: ChallengeRecord = { at, model: m, plan: planFile, file: path };
      const fresh = await deps.registry.read(lane.key);
      await deps.registry.patch(lane.key, { challenges: [...(fresh?.challenges ?? []), record] });
      watchLog(deps.config.watchLog, deps.clock, { source: "challenge", line: `CHALLENGE ${lane.key} reviewer=${m} plan=${planFile} file=${path}${attempts > 1 ? " after a stricter retry" : ""}` });
      return { record, text: answer, failures };
    }
  }
  const line = `no reviewer wrote a complete review: ${failures.join(" | ")}`;
  watchLog(deps.config.watchLog, deps.clock, { source: "challenge", line: `CHALLENGE_FAILED ${lane.key} ${line}` });
  throw new ChallengeError(line);
};

// A lane launched with --challenge-before cannot claim done before one challenge is on record.
export const challengeMissing = (lane: Lane): string | undefined =>
  lane.challengeBefore?.length && !lane.challenges?.length
    ? `CHALLENGE_MISSING ${lane.key}: launched with --challenge-before ${lane.challengeBefore.map((s) => `"${s}"`).join(", ")} and no challenge on record; run dori challenge ${lane.key} --plan <file> first`
    : undefined;
