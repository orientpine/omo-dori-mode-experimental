import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { checkReviewers, ChallengeError, reviewers } from "./challenge.ts";
import { fill } from "./config.ts";
import { APPLIED_HEADING, appliesWhy, briefGaps, type Directive, type DirectiveBlock, DirectiveError, directiveText, type Gap, type Ledger, leadGaps, scopeContext, unledgered } from "./directives.ts";
import type { FlowDeps } from "./done-flow.ts";
import { eightSteps, laneRepo, launchLedger, uiSteps } from "./launch.ts";
import { sendVerified } from "./panes.ts";
import type { Lane } from "./registry.ts";
import { iso } from "./run.ts";
import { watchLog } from "./watch-log.ts";

// dori directive-audit and owner-check: a launched lane's brief and the lead's actions against the directive ledger.

export const blockTexts = async (): Promise<Record<DirectiveBlock, string>> => ({ "eight-steps": await eightSteps(), "ui-steps": await uiSteps() });

const readBrief = async (path: string): Promise<string> => {
  const f = Bun.file(path);
  return (await f.exists()) ? await f.text() : "";
};

export const laneDirectiveGaps = async (deps: Pick<FlowDeps, "run" | "config">, lane: Lane, ledger: Ledger, blocks: Readonly<Record<DirectiveBlock, string>>): Promise<Gap[]> => {
  if (!ledger.entries.length) return [];
  const brief = await readBrief(lane.brief);
  if (!brief) return [{ lane: lane.key, id: "-", line: `DIRECTIVE_GAP ${lane.key} -: its brief ${lane.brief} is not there to check` }];
  const repo = await laneRepo(deps, lane.cwd ?? deps.config.defaultCwd);
  return [...briefGaps(lane, brief, ledger, repo, blocks), ...leadGaps(lane, ledger)];
};

// The directives in scope for a lane, as the owner's words: owner-check reads them next to the brief.
export const laneDirectiveWords = async (deps: Pick<FlowDeps, "run" | "config">, lane: Lane, ledger: Ledger): Promise<string[]> => {
  const brief = await readBrief(lane.brief);
  const ctx = scopeContext(brief, ledger, { ui: lane.ui, repo: await laneRepo(deps, lane.cwd ?? deps.config.defaultCwd) });
  const waived = new Set((lane.directives?.waived ?? []).map((w) => w.id));
  return ledger.entries.filter((e) => e.words && !waived.has(e.id) && appliesWhy(e, ctx)).map((e) => `[${e.id}, ${e.date}] "${e.words}"`);
};

// --- dori directives apply: a lane launched before a directive was in the ledger gets it now ---

const FOOTER = /\n## (?:Past signals|Hypothesis tree|Lane footer) \(written by dori launch\)/;

// The brief with the texts at the end of the lead's part, under APPLIED_HEADING (added to the heading already there),
// before what dori launch appended (past signals, tree, footer). Nothing above is changed.
export const withApplied = (brief: string, texts: readonly string[]): string => {
  const m = FOOTER.exec(brief);
  const head = (m ? brief.slice(0, m.index) : brief).replace(/\s*$/, "");
  const tail = m ? brief.slice(m.index) : "\n";
  const body = texts.join("\n\n");
  return `${head.includes(APPLIED_HEADING) ? `${head}\n\n${body}` : `${head}\n\n${APPLIED_HEADING}\n\n${body}`}\n${tail}`;
};

export const applyMessage = (brief: string, texts: readonly string[]): string =>
  `[LEAD] 지침 보충: 이 lane을 열 때 브리프에 없던 형 지침·리드 규칙이다. 하던 일은 그대로 이어가고, 지금부터 아래 지침도 따른다. 브리프 ${brief}의 "${APPLIED_HEADING.slice(3)}" 절에도 적었다.\n\n${texts.join("\n\n")}`;

export type ApplyResult = { readonly lines: readonly string[]; readonly added: readonly string[]; readonly ok: boolean; readonly message?: string };

// The directives in scope the lane's brief lacks now (scope judged again from its brief, cwd repo and --ui, as owner-check
// does), in launch's format: an owner directive as [형 지침 id, date] and its prompt, a lead rule as [리드 규칙 id] and its
// rule, a built-in block as its text. They are typed into the lane as one [LEAD] message; once it is SUBMITTED the same
// texts go into the brief under APPLIED_HEADING and DIRECTIVES_APPLIED into the watch log. A require directive (the four
// fields) is not something to send: it is listed for the lead. Nothing missing: DIRECTIVES_APPLY_NONE and no change.
export const applyDirectives = async (deps: FlowDeps, lane: Lane, opts: { readonly dryRun?: boolean } = {}): Promise<ApplyResult> => {
  const ledger = launchLedger(deps);
  const brief = await readBrief(lane.brief);
  if (!brief) throw new DirectiveError(`lane ${lane.key}: its brief ${lane.brief} is not there`);
  const blocks = await blockTexts();
  const gaps = briefGaps(lane, brief, ledger, await laneRepo(deps, lane.cwd ?? deps.config.defaultCwd), blocks);
  const byId = new Map(ledger.entries.map((e) => [e.id, e] as const));
  const send: Directive[] = [];
  const lines: string[] = [];
  for (const g of gaps) {
    const e = byId.get(g.id);
    if (!e) continue;
    if (e.block || e.mode === "inject") send.push(e);
    else lines.push(`DIRECTIVES_APPLY_REQUIRE ${lane.key} ${e.id}: ${e.name} is a brief requirement, not a text to send; the lead writes it into the lane's brief`);
  }
  if (!send.length) return { ok: true, added: [], lines: [...lines, `DIRECTIVES_APPLY_NONE ${lane.key}: the brief has every directive in scope it can be sent`] };
  const texts = send.map((e) => (e.block ? blocks[e.block] : directiveText(e)));
  const ids = send.map((e) => e.id);
  const message = applyMessage(lane.brief, texts);
  if (opts.dryRun) return { ok: true, added: ids, message, lines: [...lines, `DIRECTIVES_APPLY_DRY ${lane.key}: would send ${ids.join(", ")} to ${lane.pane ?? "(no pane)"} and add them to ${lane.brief}`] };
  if (!lane.pane) throw new DirectiveError(`lane ${lane.key} has no pane to send the directives to`);
  if (!(await sendVerified(deps.run, deps.clock, deps.config, lane.pane, message))) {
    const line = `DIRECTIVES_APPLY_NOT_SENT ${lane.key} ${lane.pane}: the [LEAD] message was not submitted; the brief is unchanged (run it again)`;
    watchLog(deps.config.watchLog, deps.clock, { source: "directives", line });
    return { ok: false, added: [], message, lines: [...lines, line] };
  }
  await Bun.write(lane.brief, withApplied(brief, texts));
  await deps.registry.patch(lane.key, { directives: { applied: [...new Set([...(lane.directives?.applied ?? []), ...ids])], waived: lane.directives?.waived ?? [] } });
  const line = `DIRECTIVES_APPLIED ${lane.key}: ${ids.join(", ")} sent to ${lane.pane} (SUBMITTED) and added to ${lane.brief} under "${APPLIED_HEADING.slice(3)}"`;
  watchLog(deps.config.watchLog, deps.clock, { source: "directives", line });
  return { ok: true, added: ids, message, lines: [...lines, line] };
};

// --- dori directives check: a reviewer of another family compares each prompt with his message ---

export const MEANING_SYSTEM = "You compare an owner's message with a directive a lead rewrote from it. You answer only in the requested format. You never ask questions and never translate quotes.";

export const meaningPrompt = (e: Pick<Directive, "id" | "name" | "basis" | "words" | "original" | "prompt">): string => [
  "An owner gave a standing directive in Korean. WORDS is the directive as he said it: his message with only fillers and whole unrelated sentences left out. ORIGINAL is his whole message, for context. PROMPT is the lead's rewrite of WORDS as a directive for coding agents: imperative or declarative, no question, no spoken filler.",
  `CONTEXT (the lead's notes, not his words): the directive is called "${e.name}"; ${e.basis ?? ""}`,
  "The rewrite may change the form (question to order, spoken to written, \"해 줘\" to \"한다\"), say who \"나\" and \"너\" are (형 = the owner, 리드 = the agent he spoke to) and name what a bare reference points at when CONTEXT says it, and nothing else. Check that PROMPT keeps every condition, target, scope, exception, step and the strength of WORDS (반드시 / 항상 / 절대 / 모두 / 가끔 stay as strong or as weak), and adds no requirement, target or method he did not state.",
  `ORIGINAL:\n<<<\n${e.original ?? e.words}\n>>>`,
  `WORDS:\n<<<\n${e.words}\n>>>`,
  `PROMPT:\n<<<\n${e.prompt ?? ""}\n>>>`,
  "Answer with the first line exactly \"VERDICT: SAME\" when PROMPT means what WORDS means, or \"VERDICT: CHANGED\" followed by one line per problem:",
  "- MISSING: <what of WORDS is not in PROMPT>",
  "- ADDED: <what PROMPT asks that WORDS does not>",
  "- STRENGTH: <a word whose strength changed, WORDS vs PROMPT>",
  "- QUESTION: <a part of PROMPT that is still a question>",
  "Nothing else.",
].join("\n");

export type MeaningVerdict = { readonly same: boolean; readonly problems: readonly string[] };

export const parseMeaning = (reply: string): MeaningVerdict | undefined => {
  const m = /^\s*\**VERDICT:\**\s*(SAME|CHANGED)\b/im.exec(reply);
  if (!m) return undefined;
  const problems = reply.split("\n").map((l) => l.trim().replace(/^[-*]\s*/, "")).filter((l) => /^(?:MISSING|ADDED|STRENGTH|QUESTION):/.test(l));
  return { same: m[1] === "SAME" && !problems.length, problems };
};

const meaningKey = (e: Directive): string => createHash("sha256").update(JSON.stringify([e.id, e.original ?? "", e.words, e.prompt ?? ""])).digest("hex").slice(0, 32);
type MeaningCache = Record<string, { readonly id: string; readonly model: string; readonly at: string }>;
export const meaningCachePath = (stateDir: string): string => join(stateDir, "directives", "meaning.json");

// Every owner entry with a prompt, against his words, by a reviewer of another family than the lead's model (reviewers.models,
// ownerCheck.first first, the ownerCheck command). A SAME verdict is kept per (id, original, words, prompt) in the state
// directory, so only a new or changed prompt is read again. Lines: DIRECTIVES_MEANING_OK, DIRECTIVES_BAD (meaning changed),
// DIRECTIVES_MEANING_FAILED (no reviewer answered: not checked, and the check fails).
export const checkMeaning = async (deps: Pick<FlowDeps, "run" | "config" | "clock">, ledger: Ledger): Promise<{ readonly lines: readonly string[]; readonly ok: boolean }> => {
  const path = meaningCachePath(deps.config.stateDir);
  const file = Bun.file(path);
  const cache: MeaningCache = (await file.exists()) ? (JSON.parse(await file.text()) as MeaningCache) : {};
  const todo = ledger.entries.filter((e) => e.by === "owner" && e.words && e.prompt);
  const fresh = todo.filter((e) => !cache[meaningKey(e)]);
  const lines: string[] = todo.filter((e) => cache[meaningKey(e)]).map((e) => `DIRECTIVES_MEANING_OK ${e.id} (read before by ${cache[meaningKey(e)]?.model})`);
  if (!fresh.length) return { lines, ok: true };
  const oc = deps.config.autoSignals.ownerCheck;
  const listed = reviewers(deps.config.defaultModel, oc.first ? [oc.first, ...deps.config.reviewers.models.filter((m) => m !== oc.first)] : deps.config.reviewers.models);
  let calls: string[] = [];
  try {
    calls = (await checkReviewers(deps as FlowDeps, listed)).flatMap((c) => (c.call ? [c.call] : []));
  } catch (e) {
    if (!(e instanceof ChallengeError)) throw e;
  }
  if (!calls.length) return { ok: false, lines: [...lines, ...fresh.map((e) => `DIRECTIVES_MEANING_FAILED ${e.id}: no callable reviewer of another family than ${deps.config.defaultModel} in reviewers.models`)] };
  let ok = true;
  // four at a time: a reviewer call takes minutes, and thirty at once trips provider rate limits
  const results: string[] = new Array(fresh.length);
  let next = 0;
  const one = async (e: Directive): Promise<string> => {
    const tried: string[] = [];
    for (const model of calls) {
      const r = await deps.run(fill(oc.command, { model, prompt: meaningPrompt(e), system: MEANING_SYSTEM }), { timeoutMs: oc.minutes * 60_000 });
      const v = r.code === 0 ? parseMeaning(r.out) : undefined;
      if (!v) {
        tried.push(`${model}: ${r.code !== 0 ? `exit ${r.code}` : `no VERDICT line in "${r.out.trim().slice(0, 80)}"`}`);
        continue;
      }
      if (v.same) {
        cache[meaningKey(e)] = { id: e.id, model, at: iso(deps.clock) };
        return `DIRECTIVES_MEANING_OK ${e.id} [${model}]`;
      }
      ok = false;
      return `DIRECTIVES_BAD directive ${e.id}: prompt does not mean what his words mean: ${v.problems.join("; ") || "CHANGED"} [${model}]`;
    }
    ok = false;
    return `DIRECTIVES_MEANING_FAILED ${e.id}: no reviewer answered (${tried.join(" | ")})`;
  };
  await Promise.all(
    Array.from({ length: Math.min(4, fresh.length) }, async () => {
      while (next < fresh.length) {
        const i = next++;
        results[i] = await one(fresh[i]!);
      }
    }),
  );
  mkdirSync(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(cache, null, 2)}\n`);
  return { lines: [...lines, ...results], ok };
};

// "Nh", "Nd" or an ISO time, back from now
export const sinceIso = (spec: string, now: number): string => {
  const m = /^(\d+)([hd])$/.exec(spec.trim());
  if (m) return new Date(now - Number(m[1]) * (m[2] === "h" ? 3_600_000 : 86_400_000)).toISOString();
  const t = Date.parse(spec);
  if (Number.isNaN(t)) throw new Error(`--since ${spec}: give Nh, Nd or an ISO time`);
  return new Date(t).toISOString();
};

export type AuditResult = { readonly gaps: readonly Gap[]; readonly lines: readonly string[]; readonly lanes: number };

// The lanes opened since `since` and the owner's messages since then against the ledger. No gap: one DIRECTIVE_AUDIT_OK
// line on stdout and nothing else (quiet). Gaps: each line in the watch log and one [DIRECTIVE_AUDIT] summary typed to the
// lead. dryRun: the lines only.
export const runDirectiveAudit = async (deps: FlowDeps, opts: { readonly since: string; readonly inbox: string; readonly owner: string; readonly dryRun?: boolean }): Promise<AuditResult> => {
  const ledger = launchLedger(deps);
  const lanes = (await deps.registry.list()).filter((l) => l.openedAt >= opts.since).sort((a, b) => a.openedAt.localeCompare(b.openedAt));
  const blocks = await blockTexts();
  const gaps: Gap[] = [];
  for (const l of lanes) gaps.push(...(await laneDirectiveGaps(deps, l, ledger, blocks)));
  gaps.push(...unledgered(await readBrief(opts.inbox), ledger, opts.owner, opts.since, process.env.DORI_DISCORD_GUILD?.trim() ?? ""));
  if (!gaps.length) return { gaps, lanes: lanes.length, lines: [`DIRECTIVE_AUDIT_OK since ${opts.since}: ${lanes.length} lanes and the owner's messages read against ${ledger.entries.length} directives, no gap`] };
  const lines = gaps.map((g) => g.line);
  if (opts.dryRun) return { gaps, lanes: lanes.length, lines };
  for (const line of lines) watchLog(deps.config.watchLog, deps.clock, { source: "directive-audit", line });
  const short = gaps.slice(0, 4).map((g) => (g.lane === "-" ? `unledgered ${g.id}` : `${g.lane} ${g.id}`)).join(", ");
  const summary = `[DIRECTIVE_AUDIT] ${gaps.length} directive gaps since ${opts.since}: ${short}${gaps.length > 4 ? ", ..." : ""}. Full list: dori directive-audit --since ${opts.since} --dry-run`;
  const pane = deps.config.leadPane;
  const sent = pane ? await sendVerified(deps.run, deps.clock, deps.config, pane, summary) : false;
  const tail = sent ? `DIRECTIVE_AUDIT_SENT ${pane}` : `DIRECTIVE_AUDIT_NOT_SENT ${pane || "(no leadPane)"}: the summary did not reach the lead; the gaps are in the watch log`;
  watchLog(deps.config.watchLog, deps.clock, { source: "directive-audit", line: tail });
  return { gaps, lanes: lanes.length, lines: [...lines, tail] };
};
