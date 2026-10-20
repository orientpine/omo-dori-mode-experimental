import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { ChallengeError, checkReviewers } from "./challenge.ts";
import { fill, type OwnerSpeech, ownerSpeechOf } from "./config.ts";
import { literalNewlineProblem } from "./messenger/literal-newline.ts";
import type { FlowDeps } from "./done-flow.ts";
import type { Lane } from "./registry.ts";

// What the owner reads in a lane's work thread when the lane closes: a few plain lines on what changed, what is left and
// when it reaches where it is used, in the owner's language. The close posts it before the thread is marked done and
// archived, and a lane with a thread does not close without one (CLOSE_SUMMARY_MISSING): a close that only says "done,
// I'll sum it up for you" left the owner asking why he was not told (2026-10-19 23:53 KST "왜 안알려주고 닫아?").

export const MAX_SUMMARY = 700;

const HANGUL = /[\uac00-\ud7a3]/;

// Korean polite speech at the end of a sentence (~요, ~죠, ~니다, ~니까, ~십시오), nouns that end in 요 (필요, 중요, …) aside.
const POLITE_END = /(?:[\uac00-\ud7a3]요|죠|니다|니까|십시오)$/;
const NOUN_YO = /(?:필요|중요|주요|수요|개요|강요|소요|요요)$/;

// The first sentence of a text that ends in Korean polite speech, or undefined.
export const politeSentence = (text: string): string | undefined => {
  for (const raw of text.split(/(?<=[.!?…])\s+|\n+/)) {
    const s = raw.trim().replace(/\s*\([^()]*\)[^\uac00-\ud7a3]*$/, "").replace(/[^\uac00-\ud7a3]+$/, "");
    if (POLITE_END.test(s) && !NOUN_YO.test(s)) return raw.trim();
  }
  return undefined;
};

// Why a text is not fit for the owner's thread, or undefined when it is: the lane's notes for the lead (paths, commit
// hashes, report heads, backticks) are not what the owner reads, nor their polite speech when this Dori talks to him in
// 반말 (discord.ownerSpeech, "" follows discord.locale): the post goes out under this Dori's name.
export const plainSummaryProblem = (text: string, locale = "", speech: OwnerSpeech = ""): string | undefined => {
  const t = text.trim();
  if (!t) return "it is empty";
  if (t.length > MAX_SUMMARY) return `it is longer than ${MAX_SUMMARY} characters (${t.length})`;
  if (t.includes("`")) return "it has backticks";
  if (literalNewlineProblem(t)) return "it has a literal \\n and no real line break";
  if (/\[(REPORT|LEAD|DORI)\]/.test(t)) return "it is a report line for the lead, not words for the owner";
  if (/(^|[\s(])(~\/|\/home\/|\/Users\/|\/tmp\/|\/root\/)/.test(t)) return "it has a local path";
  if ((t.match(/\b[0-9a-f]{7,40}\b/g) ?? []).some((h) => /\d/.test(h) && /[a-f]/.test(h))) return "it has a commit hash";
  if (locale.toLowerCase().startsWith("ko") && !HANGUL.test(t)) return "it is not in Korean (discord.locale is ko)";
  const polite = ownerSpeechOf(locale, speech) === "casual" ? politeSentence(t) : undefined;
  if (polite) return `it is in 존댓말 ("${polite.slice(-40)}"), and this Dori talks to the owner in 반말 (discord.ownerSpeech casual): write it in 반말`;
  return undefined;
};

export const SUMMARY_SYSTEM = "You write the short message an assistant posts to its owner when a piece of work it ran for him is finished. You answer only with the message between the requested markers. You never invent facts that are not in the notes.";

const tail = (text: string, max: number): string => (text.length > max ? text.slice(-max) : text);

// The lane's own notes the summary is written from: its last report as the lead read it, its done claim, and the end of
// the REPORT.md next to its brief (the lanes' QA report).
export const summarySources = (lane: Lane): { readonly label: string; readonly text: string }[] => {
  const report = join(dirname(lane.brief), "REPORT.md");
  return [
    ...(lane.lastReport ? [{ label: "the lane's last report to the lead", text: lane.lastReport }] : []),
    ...(lane.claim?.evidence ? [{ label: "the lane's done claim (evidence)", text: lane.claim.evidence }] : []),
    ...(existsSync(report) ? [{ label: "the end of the lane's REPORT.md", text: tail(readFileSync(report, "utf8"), 6000) }] : []),
  ];
};

const speechLine = (locale: string, speech: OwnerSpeech): string => {
  const ko = locale.toLowerCase().startsWith("ko");
  if (ownerSpeechOf(locale, speech) === "polite") return `in polite, friendly speech${ko ? " (존댓말, ~요체)" : ""}`;
  return `in casual, friendly speech${ko ? " (반말, as to a close older brother; do not address him by any title; no ~요 or ~니다 endings)" : ""}`;
};

// The label of a lane's own summary that was refused as it is: the model rewrites it, keeping its facts.
export const GIVEN_LABEL = "the lane's own summary for the owner, refused as it is";

export const summaryPrompt = (lane: Lane, sources: readonly { readonly label: string; readonly text: string }[], locale: string, speech: OwnerSpeech = ""): string => [
  `A piece of work is finished: "${lane.title}"${lane.goal ? `, which the owner asked for in these words: "${lane.goal}"` : ""}. Write the message posted in the owner's work thread before it is closed.`,
  `Language: the owner's (locale ${locale || "en-US"}), ${speechLine(locale, speech)}.`,
  ...(sources.some((s) => s.label.startsWith(GIVEN_LABEL)) ? [`The notes are ${GIVEN_LABEL}: keep every fact in it, leave none out and add none, and change only what the rules here ask for (the speech, and what the owner does not read).`] : []),
  "Content, 2 to 5 short lines, plain words the owner uses, nothing else:",
  "1. what changed for him, the result first;",
  "2. what is left (say plainly when nothing is left);",
  "3. when and where it takes effect (on the nodes, the other assistants, a release), only if the notes say so.",
  "Leave out file paths, commit hashes, command names, report codes, test counts, backticks and the notes' abbreviations. Do not promise a later summary. Use only facts in the notes.",
  "Answer with the message between a line <<<SUMMARY and a line SUMMARY>>>.",
  "",
  ...sources.flatMap((s) => [`<<<NOTES: ${s.label}`, s.text, "NOTES>>>"]),
].join("\n");

export const parseSummary = (out: string): string | undefined => /<<<SUMMARY\s*\n([\s\S]*?)\n\s*SUMMARY>>>/.exec(out)?.[1]?.trim() || undefined;

export type OwnerSummary = { readonly text?: string; readonly source: string; readonly why?: string };

// The lane's own summary (dori claim-done --summary, dori close --summary) when it reads as plain words in the owner's
// speech; otherwise one a reviewer model writes from that refused summary alone (its facts kept), or without one from the lane's notes (autoSignals.ownerCheck.first, then reviewers.models, with ownerCheck's
// command and time limit), checked the same way; otherwise none, and why.
export const ownerSummary = async (deps: FlowDeps, lane: Lane, given: string | undefined, maxModels = 3): Promise<OwnerSummary> => {
  const { locale, ownerSpeech } = deps.config.discord;
  const problems: string[] = [];
  const refused: { readonly label: string; readonly text: string }[] = [];
  if (given?.trim()) {
    const p = plainSummaryProblem(given, locale, ownerSpeech);
    if (!p) return { text: given.trim(), source: "the lane" };
    problems.push(`the given summary: ${p}`);
    // its facts are the lane's own words for the owner: the model rewrites that text alone, so none is added or dropped
    refused.push({ label: `${GIVEN_LABEL} (${p})`, text: given.trim() });
  }
  const sources = refused.length ? refused : summarySources(lane);
  if (!sources.length) return { source: "none", why: [...problems, "no report, claim or REPORT.md to write one from"].join("; ") };
  const cfg = deps.config.autoSignals.ownerCheck;
  const first = cfg.first;
  const listed = (first ? [first, ...deps.config.reviewers.models.filter((m) => m !== first)] : [...deps.config.reviewers.models]).slice(0, maxModels);
  let checks: Awaited<ReturnType<typeof checkReviewers>> = [];
  try {
    checks = await checkReviewers(deps, listed);
  } catch (e) {
    if (!(e instanceof ChallengeError)) throw e;
    problems.push(e.message);
  }
  const prompt = summaryPrompt(lane, sources, locale, ownerSpeech);
  for (const c of checks) {
    if (!c.call) {
      problems.push(`${c.listed}: ${c.note}`);
      continue;
    }
    const r = await deps.run(fill(cfg.command, { model: c.call, prompt, system: SUMMARY_SYSTEM }), { timeoutMs: cfg.minutes * 60_000 });
    const text = r.code === 0 ? parseSummary(r.out) : undefined;
    const p = text === undefined ? (r.code !== 0 ? `exit ${r.code} ${r.err.split("\n").find((l) => l.trim())?.slice(0, 120) ?? ""}` : "no SUMMARY block") : plainSummaryProblem(text, locale, ownerSpeech);
    if (text !== undefined && !p) return { text, source: `model ${c.call}` };
    problems.push(`${c.call}: ${p}`);
  }
  return { source: "none", why: problems.join("; ") || "no reviewer model listed" };
};
