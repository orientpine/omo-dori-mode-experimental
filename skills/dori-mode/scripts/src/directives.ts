import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import type { DoriConfig } from "./config.ts";
import type { Lane } from "./registry.ts";

// The directive ledger: the owner's standing directives in machine-readable form, in two layers. The fork's
// references/directives.json holds the directives every Dori shares (no links, names or paths); a host's local file
// (config directives.local) holds the ones for that host and its repos, with links to the owner's messages. A local
// entry with the id of a fork entry overrides its fields (a link as source, a retirement). dori launch reads both:
// an inject directive in scope that the brief lacks goes in as written in the ledger (LAUNCH_DIRECTIVE_ADDED); a require
// directive the brief does not meet stops the launch (LAUNCH_DIRECTIVE_MISSING) unless the lead waives it with a reason;
// a lead directive is checked against what the lead did (dori directive-audit).

export const DIRECTIVE_MODES = ["inject", "require", "lead"] as const;
export type DirectiveMode = (typeof DIRECTIVE_MODES)[number];
// built-in blocks dori launch already places itself (the brief template's eight steps, the UI steps)
export const DIRECTIVE_BLOCKS = ["eight-steps", "ui-steps"] as const;
export type DirectiveBlock = (typeof DIRECTIVE_BLOCKS)[number];
// what a lead directive checks: the lane opened with a work thread; the owner's standing directives of the window are in the
// ledger; none: on record for the lead and owner-check, with no machine check
export const LEAD_CHECKS = ["thread", "ledger", "none"] as const;
export type LeadCheck = (typeof LEAD_CHECKS)[number];

export type DirectiveScope = {
  readonly all?: boolean;
  readonly ui?: boolean;
  readonly kinds?: readonly string[];
  readonly repos?: readonly string[];
  readonly keywords?: readonly string[];
};

export type Directive = {
  readonly id: string;
  // what the lead and the owner call it ("UI 7단계"); a mention of it in a brief is not a sign of that kind of work
  readonly name: string;
  // owner: the owner stated the directive himself and words is that sentence (typos corrected only), or the directive is a
  // block of his words (eight-steps, ui-steps); lead: a rule the lead set, words stays empty and trigger holds what the owner
  // said that led to it
  readonly by: "owner" | "lead";
  readonly words: string;
  readonly trigger?: string;
  // why the entry is owner or lead: the context of his message, one line
  readonly basis?: string;
  // how the directive reads as a rule, when the owner's words alone do not say it
  readonly rule?: string;
  readonly date: string;
  readonly source: string;
  readonly scope: DirectiveScope;
  readonly mode: DirectiveMode;
  readonly block?: DirectiveBlock;
  // require: regexes (multiline) the brief must all match
  readonly require?: readonly string[];
  readonly check?: LeadCheck;
  // a retired directive stays on record and applies to nothing: "<date>: <why>"
  readonly retired?: string;
  readonly layer: "common" | "local";
};

export type Ledger = {
  readonly entries: readonly Directive[];
  // kind name -> regex (case-insensitive); a brief is that kind of work at minHits hits or more
  readonly kinds: Readonly<Record<string, string>>;
  readonly minHits: number;
  // words that name a scope ("노드·GPU"), not work of that kind: left out like directive names
  readonly labels: readonly string[];
  // a regex for an owner message that sets a standing directive (dori directive-audit)
  readonly standing: string;
  // owner message ids the lead read and judged not a standing directive
  readonly reviewed: readonly string[];
  readonly files: readonly string[];
};

export class DirectiveError extends Error {}

export const COMMON_LEDGER = join(import.meta.dir, "../../references/directives.json");
export const DIRECTIVES_HEADING = "## 형 지침 (지침 장부에서 dori launch가 넣음)";

type RawLedger = { entries?: unknown[]; kinds?: Record<string, string>; minHits?: number; labels?: string[]; standing?: string; reviewed?: string[] };

const readLedger = (path: string): RawLedger => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RawLedger;
  } catch (e) {
    throw new DirectiveError(`directive ledger ${path} is not readable JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
};

// One ledger from the two layers. A local entry with a common id overrides that entry's fields; others are added.
export const loadLedger = (cfg: Pick<DoriConfig, "directives">): Ledger => {
  const files: string[] = [];
  const byId = new Map<string, Directive>();
  let kinds: Record<string, string> = {};
  let standing = "";
  let minHits = 3;
  const labels: string[] = [];
  const reviewed: string[] = [];
  for (const [layer, path] of [["common", cfg.directives.common], ["local", cfg.directives.local]] as const) {
    if (!path) continue;
    if (!existsSync(path)) throw new DirectiveError(`directive ledger ${path} (config directives.${layer}) does not exist`);
    const raw = readLedger(path);
    files.push(path);
    kinds = { ...kinds, ...raw.kinds };
    standing = raw.standing || standing;
    minHits = raw.minHits ?? minHits;
    labels.push(...(raw.labels ?? []));
    reviewed.push(...(raw.reviewed ?? []));
    for (const e of raw.entries ?? []) {
      const entry = e as Partial<Directive>;
      const prior = entry.id ? byId.get(entry.id) : undefined;
      byId.set(entry.id ?? "", { ...(prior ?? {}), ...entry, layer: prior ? prior.layer : layer } as Directive);
    }
  }
  return { entries: [...byId.values()], kinds, minHits, labels, standing, reviewed, files };
};

const compiles = (re: string): boolean => {
  try {
    new RegExp(re, "m");
    return true;
  } catch {
    return false;
  }
};

// Everything that would make the ledger mean something else than it says: checked at every launch and by dori directives check.
export const ledgerProblems = (ledger: Ledger): string[] => {
  const out: string[] = [];
  const kinds = new Set(Object.keys(ledger.kinds));
  for (const [k, re] of Object.entries(ledger.kinds)) if (!compiles(re)) out.push(`kind ${k}: pattern does not compile`);
  if (ledger.standing && !compiles(ledger.standing)) out.push("standing: pattern does not compile");
  for (const e of ledger.entries) {
    const at = `directive ${e.id || "(no id)"}`;
    if (!e.id || !/^[a-z0-9][a-z0-9-]*$/.test(e.id)) out.push(`${at}: id must be lowercase words with -`);
    if (!e.name) out.push(`${at}: no name`);
    if (e.by !== "owner" && e.by !== "lead") out.push(`${at}: by must be owner or lead`);
    if (e.by === "lead" && e.words) out.push(`${at}: a lead rule has no owner words (put what he said in trigger)`);
    if (e.by === "lead" && !e.rule) out.push(`${at}: a lead rule needs its rule`);
    if (!e.basis) out.push(`${at}: no basis (why it is the owner's directive or the lead's rule)`);
    if (!/^\d{4}-\d{2}-\d{2}/.test(e.date ?? "")) out.push(`${at}: date must start YYYY-MM-DD`);
    if (!e.source) out.push(`${at}: no source`);
    if (!DIRECTIVE_MODES.includes(e.mode)) out.push(`${at}: mode must be ${DIRECTIVE_MODES.join("|")}`);
    if (!e.scope || typeof e.scope !== "object") out.push(`${at}: no scope`);
    for (const k of e.scope?.kinds ?? []) if (!kinds.has(k)) out.push(`${at}: unknown kind ${k}`);
    for (const re of e.scope?.keywords ?? []) if (!compiles(re)) out.push(`${at}: keyword ${re} does not compile`);
    if (e.mode === "inject" && !e.block && !e.words && !e.rule) out.push(`${at}: an inject directive needs words, a rule or a block`);
    if (e.block && !DIRECTIVE_BLOCKS.includes(e.block)) out.push(`${at}: block must be ${DIRECTIVE_BLOCKS.join("|")}`);
    if (e.mode === "require" && !e.require?.length) out.push(`${at}: a require directive needs require patterns`);
    for (const re of e.require ?? []) if (!compiles(re)) out.push(`${at}: require ${re} does not compile`);
    if (e.mode === "lead" && !LEAD_CHECKS.includes(e.check as LeadCheck)) out.push(`${at}: a lead directive needs check ${LEAD_CHECKS.join("|")}`);
  }
  return out;
};

export const checkedLedger = (cfg: Pick<DoriConfig, "directives">): Ledger => {
  const ledger = loadLedger(cfg);
  const problems = ledgerProblems(ledger);
  if (problems.length) throw new DirectiveError(`directive ledger has problems: ${problems.join("; ")}`);
  return ledger;
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The lead's text of a brief: what dori launch appended (past signals, tree, footer) and the ledger block it put in are cut.
export const leadText = (brief: string): string => {
  const own = brief.split(/\n## (?:Past signals|Hypothesis tree|Lane footer) \(written by dori launch\)/)[0] ?? brief;
  const at = own.indexOf(DIRECTIVES_HEADING);
  if (at < 0) return own;
  const rest = own.slice(at + DIRECTIVES_HEADING.length);
  const next = rest.search(/\n## /);
  return own.slice(0, at) + (next < 0 ? "" : rest.slice(next));
};

// The text that says what kind of work a brief is: the lead's text without quoted words (the owner's or anyone's) and
// without the names of directives. A brief about a directive ("UI 7단계", "이 PC 학습 금지") is not that kind of work.
export const scopeText = (brief: string, ledger: Pick<Ledger, "entries"> & Partial<Pick<Ledger, "labels">>): string => {
  let text = leadText(brief);
  // names first: a name may hold quote marks (승인 표 "코드에 있음" 열)
  const names = [...ledger.entries.map((e) => e.name), ...(ledger.labels ?? [])].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const name of names) text = text.replace(new RegExp(escapeRe(name), "gi"), " ");
  return text.replace(/"[^"\n]*"|“[^”]*”|‘[^’]*’|「[^」]*」|`[^`\n]*`/g, " ");
};

// Words that mark UI work. 화면 alone is not enough (a terminal screen, the template's "실제 화면·호출·출력"), and a word
// inside a hyphenated name (a lane key such as cytoplasm-pm-dashboard) does not count.
const UI_WORD = /(?<![\w-])(?:UI|UX|dashboard|front-?end|web ?page)(?![\w-])|대시보드|프론트엔드|디자인|웹 ?페이지|화면(?!·호출)/gi;

// UI work: two UI words, one of them not 화면
export const uiHits = (text: string): string[] => {
  const hits = [...text.matchAll(UI_WORD)].map((m) => m[0]);
  return hits.length < 2 || hits.every((h) => h === "화면") ? [] : hits;
};

export type ScopeContext = {
  readonly ui: boolean;
  // ui came from the brief's words, not from --ui
  readonly uiFromText: readonly string[];
  readonly kinds: Readonly<Record<string, readonly string[]>>;
  readonly repo: string;
  readonly text: string;
};

// The repo a lane works in: the name of its origin remote, else the directory's name.
export const repoName = (remote: string, cwd: string): string => basename(remote.trim().replace(/\.git$/, "")) || basename(cwd);

export const scopeContext = (brief: string, ledger: Ledger, opts: { readonly ui?: boolean; readonly repo: string }): ScopeContext => {
  const text = scopeText(brief, ledger);
  const kinds: Record<string, string[]> = {};
  for (const [k, re] of Object.entries(ledger.kinds)) {
    const hits = [...text.matchAll(new RegExp(re, "gi"))].map((m) => m[0]);
    if (hits.length >= ledger.minHits) kinds[k] = hits;
  }
  const fromText = opts.ui ? [] : uiHits(text);
  return { ui: Boolean(opts.ui) || fromText.length > 0, uiFromText: fromText, kinds, repo: opts.repo, text };
};

// Why a directive is in scope, or undefined when it is not.
export const appliesWhy = (e: Directive, ctx: ScopeContext): string | undefined => {
  if (e.retired) return undefined;
  const s = e.scope;
  if (s.all) return "all lanes";
  if (s.ui && ctx.ui) return ctx.uiFromText.length ? `UI work (${[...new Set(ctx.uiFromText)].slice(0, 3).join(", ")})` : "--ui";
  for (const k of s.kinds ?? []) if (ctx.kinds[k]) return `${k} work (${[...new Set(ctx.kinds[k])].slice(0, 3).join(", ")})`;
  if (s.repos?.includes(ctx.repo)) return `repo ${ctx.repo}`;
  for (const re of s.keywords ?? []) {
    const m = new RegExp(re, "i").exec(ctx.text);
    if (m) return `keyword ${m[0]}`;
  }
  return undefined;
};

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

// The text dori launch puts in for an inject directive, and what shows it is already in a brief.
// The owner's directive goes in as his words only, byte for byte, under a one-line tag: no summary, no rule, no context. A
// lead rule goes in as the lead's rule only. An owner decision on record without his sentence says so in its tag. The
// trigger and the basis stay in the ledger and its table.
export const directiveTag = (e: Directive): string =>
  e.by === "lead" ? `[리드 규칙 ${e.id}]` : e.words ? `[형 지침 ${e.id}, ${e.date}]` : `[형 결정 ${e.id}, ${e.date}, 원문 없음: 리드 기록]`;
export const directiveText = (e: Directive): string => `${directiveTag(e)}\n${e.by === "owner" && e.words ? e.words : (e.rule ?? "")}`;
export const hasDirective = (brief: string, e: Directive): boolean => {
  const b = squash(brief);
  const own = e.by === "owner" && e.words ? e.words : (e.rule ?? "");
  // [지침 <id>]: the tag of briefs launched before #72
  return b.includes(squash(directiveTag(e))) || b.includes(`[지침 ${e.id}]`) || (Boolean(own) && b.includes(squash(own)));
};
export const requireMissing = (brief: string, e: Directive): string[] => (e.require ?? []).filter((re) => !new RegExp(re, "m").test(leadText(brief)));

export type Waiver = { readonly id: string; readonly reason: string; readonly at: string };

export type DirectivePlan = {
  // inject directives to add as text (the built-in blocks are placed by launch itself)
  readonly add: readonly { readonly e: Directive; readonly why: string }[];
  // built-in blocks in scope (eight-steps always, ui-steps for UI work)
  readonly blocks: readonly DirectiveBlock[];
  readonly missing: readonly { readonly e: Directive; readonly patterns: readonly string[]; readonly why: string }[];
  readonly waived: readonly { readonly e: Directive; readonly reason: string }[];
  readonly applied: readonly string[];
};

// What the ledger asks of this brief: inject directives in scope it lacks, require directives it does not meet; waived ids
// are left out (a waiver of an id not in the ledger is refused: a typo would let a directive through).
export const planDirectives = (brief: string, ledger: Ledger, ctx: ScopeContext, waive: Readonly<Record<string, string>> = {}): DirectivePlan => {
  const ids = new Set(ledger.entries.map((e) => e.id));
  const unknown = Object.keys(waive).filter((id) => !ids.has(id));
  if (unknown.length) throw new DirectiveError(`--waive ${unknown.join(", ")}: no such directive in the ledger (dori directives lists them)`);
  const add: { e: Directive; why: string }[] = [];
  const blocks: DirectiveBlock[] = [];
  const missing: { e: Directive; patterns: string[]; why: string }[] = [];
  const waived: { e: Directive; reason: string }[] = [];
  const applied: string[] = [];
  for (const e of ledger.entries) {
    if (e.mode === "lead") continue;
    const why = appliesWhy(e, ctx);
    if (!why) continue;
    const reason = waive[e.id];
    if (reason !== undefined) {
      waived.push({ e, reason });
      continue;
    }
    applied.push(e.id);
    if (e.mode === "inject" && e.block) blocks.push(e.block);
    else if (e.mode === "inject" && !hasDirective(brief, e)) add.push({ e, why });
    else if (e.mode === "require") {
      const patterns = requireMissing(brief, e);
      if (patterns.length) missing.push({ e, patterns, why });
    }
  }
  return { add, blocks, missing, waived, applied };
};

// The lead's text with the added directives at its end, under one heading (added to the heading already there on a relaunch).
export const withDirectives = (lead: string, add: DirectivePlan["add"]): string => {
  if (!add.length) return lead;
  const body = add.map(({ e }) => directiveText(e)).join("\n\n");
  return lead.includes(DIRECTIVES_HEADING) ? `${lead}\n\n${body}` : `${lead}\n\n${DIRECTIVES_HEADING}\n\n${body}`;
};

export const addedLine = (key: string, plan: DirectivePlan): string | undefined =>
  plan.add.length ? `LAUNCH_DIRECTIVE_ADDED ${key}: ${plan.add.map(({ e, why }) => `${e.id} (${why})`).join(", ")} from the directive ledger, as written there` : undefined;
export const missingLines = (key: string, plan: DirectivePlan): string[] =>
  plan.missing.map(({ e, patterns, why }) => `LAUNCH_DIRECTIVE_MISSING ${key} ${e.id}: ${e.name} applies (${why}) and the brief does not have it (${patterns.map((p) => `/${p}/`).join(", ")}); write it in, or launch with --waive ${e.id} "<reason>"`);
export const waivedLines = (key: string, plan: DirectivePlan): string[] => plan.waived.map(({ e, reason }) => `LAUNCH_DIRECTIVE_WAIVED ${key} ${e.id}: ${e.name} left out on the lead's word: ${reason}`);

// --- after the launch: owner-check and the daily audit ---

export type Gap = { readonly lane: string; readonly id: string; readonly line: string };

// A launched lane's brief against the ledger now: inject directives in scope it lacks, require directives it fails,
// minus the waivers on record. The built-in blocks count when their first line is in the brief.
export const briefGaps = (lane: Pick<Lane, "key" | "directives" | "ui">, brief: string, ledger: Ledger, repo: string, blockLines: Readonly<Record<DirectiveBlock, string>>): Gap[] => {
  const ctx = scopeContext(brief, ledger, { ui: lane.ui, repo });
  const waived = new Set((lane.directives?.waived ?? []).map((w) => w.id));
  const out: Gap[] = [];
  for (const e of ledger.entries) {
    if (e.mode === "lead" || waived.has(e.id)) continue;
    const why = appliesWhy(e, ctx);
    if (!why) continue;
    const lacks = e.block ? !squash(brief).includes(squash(blockLines[e.block])) : e.mode === "inject" ? !hasDirective(brief, e) : requireMissing(brief, e).length > 0;
    if (lacks) out.push({ lane: lane.key, id: e.id, line: `DIRECTIVE_GAP ${lane.key} ${e.id}: ${e.name} applies (${why}) and is not in the brief` });
  }
  return out;
};

export const leadGaps = (lane: Pick<Lane, "key" | "thread" | "directives">, ledger: Ledger): Gap[] => {
  const waived = new Set((lane.directives?.waived ?? []).map((w) => w.id));
  return ledger.entries
    .filter((e) => e.mode === "lead" && !e.retired && !waived.has(e.id) && e.check === "thread" && (!lane.thread || lane.thread === "none"))
    .map((e) => ({ lane: lane.key, id: e.id, line: `DIRECTIVE_LEAD ${lane.key} ${e.id}: ${e.name}: the lane was launched without a work thread (--thread)` }));
};

type InboxRow = { ts?: string; id?: string; kind?: string; channel_id?: string; guild_id?: string; author_id?: string; content?: string; transcript?: string | null };

// The owner's messages of the window that read like a standing directive and that no ledger entry cites as its source
// (by message id) and the lead has not marked reviewed.
export const unledgered = (inbox: string, ledger: Ledger, owner: string, since: string, guild = ""): Gap[] => {
  if (!ledger.standing || !owner || !ledger.entries.some((e) => e.mode === "lead" && e.check === "ledger" && !e.retired)) return [];
  const standing = new RegExp(ledger.standing, "i");
  const cited = ledger.entries.map((e) => e.source).join("\n");
  const out: Gap[] = [];
  for (const line of inbox.split("\n")) {
    if (!line.trim()) continue;
    let e: InboxRow;
    try {
      e = JSON.parse(line) as InboxRow;
    } catch {
      continue;
    }
    const ms = Date.parse((e.ts ?? "").replace(/(\.\d{3})\d+/, "$1"));
    if (e.kind || e.author_id !== owner || !e.id || Number.isNaN(ms) || new Date(ms).toISOString() < since) continue;
    const text = (e.transcript || e.content || "").trim();
    if (!standing.test(text) || cited.includes(e.id) || ledger.reviewed.includes(e.id)) continue;
    const g = e.guild_id || guild;
    const ref = g && e.channel_id ? `https://discord.com/channels/${g}/${e.channel_id}/${e.id}` : `${e.channel_id ?? "?"}/${e.id}`;
    out.push({ lane: "-", id: e.id, line: `DIRECTIVE_UNLEDGERED ${ref} "${text.replace(/\s+/g, " ").slice(0, 160)}": reads like a standing directive and no ledger entry cites it; add it to the ledger (owner's words, link) or list its id under reviewed` });
  }
  return out;
};

// The ledger as one table for the owner.
export const ledgerTable = (ledger: Ledger): string => {
  const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
  const scope = (s: DirectiveScope) => [s.all ? "모든 lane" : "", s.ui ? "UI" : "", ...(s.kinds ?? []), ...(s.repos ?? []).map((r) => `저장소 ${r}`), ...(s.keywords ?? []).map((k) => `낱말 /${k}/`)].filter(Boolean).join(", ");
  const how = (e: Directive) => (e.mode === "inject" ? (e.block ? `주입(${e.block})` : "주입") : e.mode === "require" ? "브리프 확인(없으면 멈춤)" : e.check === "none" ? "리드 행동(기계 확인 없음, owner-check가 읽음)" : `리드 행동 확인(${e.check})`);
  const words = (e: Directive) => (e.words ? `"${e.words}"` : e.block ? `(블록 원문: ${e.block === "eight-steps" ? "references/sessions.md 1. 조사 … 8. 보고" : "references/ui-work.md [UI 지침] 1)…7)"})` : e.by === "lead" ? "-" : "(원문 없음)");
  return [
    "| id | 이름 | 누가 | 판단 근거 | 형 원문(지침 문장) | 계기가 된 형 말 | 규칙 | 날짜 | 출처 | 적용 범위 | 강제 방식 | 층 | 폐기 |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...ledger.entries.map((e) => `| ${e.id} | ${cell(e.name)} | ${e.by === "lead" ? "리드 규칙" : "형 지침"} | ${cell(e.basis ?? "")} | ${cell(words(e))} | ${cell(e.trigger ? `"${e.trigger}"` : "")} | ${cell(e.rule ?? "")} | ${e.date} | ${cell(e.source)} | ${cell(scope(e.scope))} | ${how(e)} | ${e.layer === "common" ? "포크" : "로컬"} | ${cell(e.retired ?? "")} |`),
  ].join("\n");
};
