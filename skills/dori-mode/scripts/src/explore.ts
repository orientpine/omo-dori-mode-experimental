import { mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { type DoriConfig, type Explore, expandHome, fill } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { tagsOf } from "./lane-signals.ts";
import { sendVerified } from "./panes.ts";
import type { FixAttempt, Lane } from "./registry.ts";
import { iso } from "./run.ts";
import { normFix } from "./same-fix.ts";
import { sessionDirFor } from "./session-id.ts";
import { watchLog } from "./watch-log.ts";

// The hypothesis tree: what one area of work (a repo, or a topic tag) tried, which hypotheses are open, which a test
// falsified or supported, which directions nobody tried yet, and which external searches are due. One JSON file per area
// under <stateDir>/trees, fed by dori fix-attempt and dori fork-explore, edited with dori tree, and attached in compact
// form to every brief dori launch writes for that area.

export type NodeKind = "hypothesis" | "direction" | "tried" | "finding" | "research";
export type NodeStatus = "open" | "falsified" | "supported" | "closed";
export type TreeNode = {
  readonly id: string;
  readonly kind: NodeKind;
  readonly status: NodeStatus;
  readonly text: string;
  readonly test?: string;
  readonly result?: string;
  readonly metric?: string;
  readonly lane?: string;
  readonly at: string;
  readonly updatedAt: string;
  readonly source: string;
};
export type Tree = { readonly area: string; readonly nodes: readonly TreeNode[] };
export type TreeArea = { readonly cwd?: string; readonly tag?: string };

export const NODE_KINDS: readonly NodeKind[] = ["hypothesis", "direction", "tried", "finding", "research"];
const PREFIX: Record<NodeKind, string> = { hypothesis: "H", direction: "D", tried: "T", finding: "F", research: "R" };

export class TreeError extends Error {}

export const areaName = (a: TreeArea): string => (a.cwd ? `cwd ${a.cwd}` : `tag ${a.tag ?? "?"}`);

// A lane's tree is its repo's when it works outside the default cwd, else its first tag's (the key's first word).
export const laneArea = (lane: Pick<Lane, "key" | "tags" | "cwd">, config: Pick<DoriConfig, "defaultCwd">): TreeArea => {
  const cwd = lane.cwd ? resolve(expandHome(lane.cwd)) : "";
  return cwd && cwd !== resolve(config.defaultCwd) ? { cwd } : { tag: tagsOf(lane)[0] ?? lane.key };
};

export const treeFile = (stateDir: string, a: TreeArea): string =>
  join(stateDir, "trees", a.cwd ? `cwd${resolve(a.cwd).replace(/[^A-Za-z0-9._]+/g, "-")}.json` : `tag-${(a.tag ?? "").replace(/[^A-Za-z0-9._-]+/g, "-")}.json`);

export const loadTree = async (stateDir: string, a: TreeArea): Promise<Tree> => {
  const f = Bun.file(treeFile(stateDir, a));
  return (await f.exists()) ? ((await f.json()) as Tree) : { area: areaName(a), nodes: [] };
};

// temp file + rename, like the registry, so a reader never sees half a tree
export const saveTree = async (stateDir: string, a: TreeArea, tree: Tree): Promise<void> => {
  const path = treeFile(stateDir, a);
  mkdirSync(join(stateDir, "trees"), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await Bun.write(tmp, JSON.stringify(tree, null, 1));
  renameSync(tmp, path);
};

export type NodeInput = { readonly kind: NodeKind; readonly text: string; readonly test?: string; readonly metric?: string; readonly lane?: string; readonly source: string; readonly status?: NodeStatus; readonly result?: string };

// Adds a node, or returns the same node when one of that kind already says the same thing (a test it lacked is filled in).
export const addNode = (tree: Tree, input: NodeInput, at: string): { readonly tree: Tree; readonly node: TreeNode; readonly added: boolean } => {
  const text = input.text.replace(/\s+/g, " ").trim();
  if (!text) throw new TreeError("a tree entry needs text");
  const same = input.kind !== "tried" ? tree.nodes.find((n) => n.kind === input.kind && normFix(n.text) === normFix(text)) : undefined;
  if (same) {
    const node: TreeNode = { ...same, ...(input.test && !same.test ? { test: input.test } : {}), ...(input.metric && !same.metric ? { metric: input.metric } : {}), updatedAt: at };
    return { tree: { ...tree, nodes: tree.nodes.map((n) => (n.id === same.id ? node : n)) }, node, added: false };
  }
  const n = tree.nodes.filter((x) => x.kind === input.kind).length + 1;
  const node: TreeNode = {
    id: `${PREFIX[input.kind]}${n}`,
    kind: input.kind,
    status: input.status ?? "open",
    text,
    ...(input.test ? { test: input.test.trim() } : {}),
    ...(input.result ? { result: input.result.trim() } : {}),
    ...(input.metric ? { metric: input.metric } : {}),
    ...(input.lane ? { lane: input.lane } : {}),
    at,
    updatedAt: at,
    source: input.source,
  };
  return { tree: { ...tree, nodes: [...tree.nodes, node] }, node, added: true };
};

export const setStatus = (tree: Tree, id: string, status: NodeStatus, result: string | undefined, at: string): { readonly tree: Tree; readonly node: TreeNode } => {
  const found = tree.nodes.find((n) => n.id.toLowerCase() === id.toLowerCase());
  if (!found) throw new TreeError(`no entry ${id} in the tree of ${tree.area}`);
  const node: TreeNode = { ...found, status, ...(result?.trim() ? { result: result.trim() } : {}), updatedAt: at };
  return { tree: { ...tree, nodes: tree.nodes.map((n) => (n.id === found.id ? node : n)) }, node };
};

const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const describe = (n: TreeNode, width: number): string =>
  `${n.id} ${clip(n.text, width)}${n.test ? ` (test: ${clip(n.test, width)})` : ""}${n.result ? ` -> ${clip(n.result, width)}` : ""}${n.metric ? ` [${clip(n.metric, 40)}]` : ""}${n.lane ? ` {${n.lane}}` : ""}`;

const groups = (tree: Tree): [string, TreeNode[]][] => {
  const of = (kind: NodeKind, status?: NodeStatus) => tree.nodes.filter((n) => n.kind === kind && (status === undefined || n.status === status));
  return [
    ["Open hypotheses", of("hypothesis", "open")],
    ["Supported", of("hypothesis", "supported")],
    ["Falsified (do not retry)", of("hypothesis", "falsified")],
    ["Untried directions", of("direction", "open")],
    ["Research due", of("research", "open")],
    ["Findings", of("finding").filter((n) => n.status !== "closed")],
    ["Tried (newest first)", of("tried").slice().reverse()],
  ];
};

// dori tree: every entry, grouped, with closed ones listed last.
export const formatTree = (tree: Tree): string => {
  if (!tree.nodes.length) return `TREE ${tree.area}: empty. Add an entry with dori tree add --kind hypothesis --text "..." --test "...".`;
  const out = [`TREE ${tree.area}: ${tree.nodes.length} entries`];
  for (const [label, nodes] of groups(tree)) if (nodes.length) out.push(`${label}:`, ...nodes.map((n) => `  ${describe(n, 160)}`));
  const closed = tree.nodes.filter((n) => n.status === "closed" && n.kind !== "finding");
  if (closed.length) out.push("Closed:", ...closed.map((n) => `  ${describe(n, 160)}`));
  return out.join("\n");
};

// The compact form for a new brief: a few lines per group.
export const treeSection = (trees: readonly Tree[], limit: number, hint: string): string | undefined => {
  const shown = trees.filter((t) => t.nodes.some((n) => n.status !== "closed"));
  if (!shown.length) return undefined;
  const lines = [
    "",
    "## Hypothesis tree (written by dori launch)",
    `What this area already knows. Do not retry a falsified hypothesis; test an open one with its cheap experiment before patching; when stuck, add competing hypotheses before the next fix. ${hint} shows the whole tree; dori tree add|falsify|support|close edits it.`,
  ];
  for (const t of shown) {
    lines.push(`- ${t.area}:`);
    for (const [label, nodes] of groups(t)) {
      if (!nodes.length) continue;
      lines.push(`  - ${label}: ${nodes.slice(0, limit).map((n) => describe(n, 110)).join("; ")}${nodes.length > limit ? `; +${nodes.length - limit} more` : ""}`);
    }
  }
  return lines.join("\n");
};

export const updateTree = async (stateDir: string, a: TreeArea, change: (t: Tree) => Tree): Promise<Tree> => {
  const next = change(await loadTree(stateDir, a));
  await saveTree(stateDir, a, next);
  return next;
};

// ---- the stuck gate of dori fix-attempt ----

// Attempts on one metric, whatever the hypothesis, since the last attempt marked improved. A fix the lead asked for and
// the lane then reported is one attempt, as in fixCount.
export const metricAttempts = (fixes: readonly FixAttempt[], metric: string): number => {
  let n = 0;
  let askedByLead = false;
  for (const f of fixes) {
    if (f.metric !== metric) continue;
    if (f.improved) {
      n = 1;
      askedByLead = f.via === "lead";
    } else if (f.via === "report" && askedByLead) askedByLead = false;
    else {
      n++;
      askedByLead = f.via === "lead";
    }
  }
  return n;
};

// the stuck signal an attempt is: 0 below hypothesesFrom, 1 at the first attempt that needs hypotheses, and so on
export const stuckSignal = (attempt: number, cfg: Pick<Explore, "hypothesesFrom">): number => Math.max(0, attempt - cfg.hypothesesFrom + 1);

export type GateInput = { readonly hypotheses: readonly string[]; readonly tests: readonly string[]; readonly override?: string };
export type Gate = { readonly verdict: "ok" | "branch" | "override" | "required"; readonly attempt: number; readonly signal: number; readonly problem?: string };

// From the hypothesesFrom-th attempt on one metric with no improvement, a fix needs minHypotheses competing hypotheses,
// each with a cheap discriminating test, or an explicit override with a reason.
export const gateFix = (fixes: readonly FixAttempt[], next: FixAttempt, input: GateInput, cfg: Pick<Explore, "hypothesesFrom" | "minHypotheses">): Gate => {
  const attempt = metricAttempts([...fixes, next], next.metric);
  const signal = stuckSignal(attempt, cfg);
  if (!signal) return { verdict: "ok", attempt, signal };
  const hyps = input.hypotheses.map((h) => h.trim()).filter(Boolean);
  const tests = input.tests.map((t) => t.trim()).filter(Boolean);
  const distinct = new Set(hyps.map(normFix)).size;
  const problems = [
    ...(distinct < cfg.minHypotheses ? [`${distinct} competing hypothes${distinct === 1 ? "is" : "es"} given, at least ${cfg.minHypotheses} needed (--hypotheses, once per hypothesis)`] : []),
    ...(tests.length !== hyps.length ? [`${tests.length} --test for ${hyps.length} --hypotheses: give one cheap discriminating experiment per hypothesis, in the same order`] : []),
  ];
  if (!problems.length) return { verdict: "branch", attempt, signal };
  if (input.override?.trim()) return { verdict: "override", attempt, signal, problem: problems.join("; ") };
  return { verdict: "required", attempt, signal, problem: problems.join("; ") };
};

export const requiredMessage = (key: string, metric: string, g: Gate, cfg: Pick<Explore, "minHypotheses">): string =>
  `HYPOTHESES_REQUIRED ${key} attempt ${g.attempt} on "${metric}" with no improvement: ${g.problem}. Stop patching and branch: dori fix-attempt ${key} --metric "${metric}" --hypothesis "<the one you try now>" ${Array.from({ length: cfg.minHypotheses }, (_, i) => `--hypotheses "<H${i + 1}>" --test "<cheap test for H${i + 1}>"`).join(" ")}. A fix that moved the metric: add --improved. To go on without branching: --no-hypotheses "<reason>" (logged).`;

// An accepted branch: every hypothesis and its test go into the tree as open hypotheses, and the lead's log gets one line.
export const recordBranch = async (deps: FlowDeps, lane: Lane, metric: string, input: GateInput, g: Gate): Promise<string> => {
  const at = iso(deps.clock);
  const area = laneArea(lane, deps.config);
  let ids: string[] = [];
  await updateTree(deps.config.stateDir, area, (t) => {
    let tree = t;
    ids = input.hypotheses.map((h, i) => {
      const r = addNode(tree, { kind: "hypothesis", text: h, test: input.tests[i], metric, lane: lane.key, source: `fix-attempt ${g.attempt}` }, at);
      tree = r.tree;
      return r.node.id;
    });
    return tree;
  });
  const line = `STUCK_BRANCH ${lane.key} attempt ${g.attempt} on "${metric}": ${input.hypotheses.map((h, i) => `${ids[i]} ${clip(h, 60)} (test: ${clip(input.tests[i] ?? "", 60)})`).join(" | ")}; tree ${areaName(area)}`;
  watchLog(deps.config.watchLog, deps.clock, { source: "fix-attempt", line });
  return line;
};

export const recordOverride = (deps: FlowDeps, key: string, metric: string, g: Gate, reason: string): string => {
  const line = `HYPOTHESES_OVERRIDE ${key} attempt ${g.attempt} on "${metric}" without competing hypotheses (${g.problem}): ${reason}`;
  watchLog(deps.config.watchLog, deps.clock, { source: "fix-attempt", line });
  return line;
};

export const recordRefusal = (deps: FlowDeps, message: string): void => watchLog(deps.config.watchLog, deps.clock, { source: "fix-attempt", line: message });

// ---- after every recorded fix: tree feed, and the external-search step at the researchAt-th stuck signal ----

export const afterFix = async (deps: FlowDeps, lane: Lane, fixes: readonly FixAttempt[], attempt: FixAttempt): Promise<string[]> => {
  const cfg = deps.config.explore;
  const area = laneArea(lane, deps.config);
  const n = metricAttempts(fixes, attempt.metric);
  const signal = stuckSignal(n, cfg);
  const out: string[] = [];
  const due = signal === cfg.researchAt;
  const tree = await updateTree(deps.config.stateDir, area, (t) => {
    let tree = addNode(t, { kind: "tried", text: attempt.hypothesis, metric: attempt.metric, lane: lane.key, source: `${attempt.via} attempt ${n}` }, attempt.at).tree;
    if (due) tree = addNode(tree, { kind: "research", text: `external search on the symptom "${attempt.metric}" (stuck signal ${signal}, lane ${lane.key})`, metric: attempt.metric, lane: lane.key, source: "stuck signal" }, attempt.at).tree;
    return tree;
  });
  // a lane that reports its own second attempt without branching is the lead's to re-instruct
  if (attempt.via === "report" && signal === 1) {
    const line = `HYPOTHESES_REQUIRED ${lane.key} reported attempt ${n} on "${attempt.metric}" with no improvement and no competing hypotheses; re-instruct it with dori fix-attempt ${lane.key} --metric "${attempt.metric}" --hypotheses ... --test ...`;
    watchLog(deps.config.watchLog, deps.clock, { source: "fix-attempt", line });
    out.push(line);
  }
  if (due) {
    let line = `RESEARCH_DUE ${lane.key} stuck signal ${signal} on "${attempt.metric}": an external search on the exact symptom comes before the next patch (dori research-hint ${lane.key})`;
    if (cfg.sendResearchToLane && lane.pane) {
      const delivered = await sendResearch(deps, { ...lane, fixes }, tree, signal, attempt.metric);
      line += delivered ? " (ulw research sent to the lane)" : ` (the note did not reach pane ${lane.pane})`;
    }
    watchLog(deps.config.watchLog, deps.clock, { source: "fix-attempt", line });
    out.push(line);
  }
  return out;
};

// ---- dori research-hint ----

const STOP = new Set(["the", "a", "an", "of", "to", "and", "or", "in", "on", "for", "with", "is", "are", "not", "no", "from", "at", "by", "after", "before", "too", "fix", "lane"]);
const words = (s: string, n: number): string => s.toLowerCase().replace(/[^\p{L}\p{N}._ -]+/gu, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)).slice(0, n).join(" ");

// What the lane's records say about its stuck symptom: the failing metric, the hypotheses tried, falsified and open.
export const researchFacts = (lane: Lane, tree: Tree) => {
  const fixes = lane.fixes ?? [];
  const metric = fixes.at(-1)?.metric ?? tree.nodes.findLast((n) => n.metric)?.metric ?? "";
  const tried = [...new Set(fixes.filter((f) => f.metric === metric).map((f) => f.hypothesis))];
  const hyps = (status: NodeStatus) => tree.nodes.filter((n) => n.kind === "hypothesis" && n.status === status && (!metric || n.metric === metric));
  const domain = words(`${lane.title} ${lane.cwd ? basename(lane.cwd) : ""}`, 6);
  const symptom = words(metric, 8) || words(lane.lastReport ?? lane.title, 8);
  return { fixes, metric, tried, falsified: hyps("falsified"), open: hyps("open"), domain, symptom };
};

const lastReportText = (lane: Lane): string => (lane.lastReport ?? "").replace(/^\[REPORT\][^|]*\|[^|]*\|\s*/, "");

// A search plan built from the lane's records only: the failing metric, the hypotheses tried and falsified, the domain.
export const researchHint = (lane: Lane, tree: Tree): string[] => {
  const f = researchFacts(lane, tree);
  const { fixes, metric, tried, domain, symptom } = f;
  const falsified = f.falsified.map((n) => n.text);
  const open = f.open.map((n) => n.text);
  const top = open[0] ?? tried.at(-1) ?? "";
  const queries = [
    `"${symptom}" ${domain} (papers: arxiv, Semantic Scholar, Google Scholar)`,
    ...(top ? [`"${symptom}" ${words(top, 6)} (GitHub issues and discussions: site:github.com)`] : []),
    `${domain} ${symptom} "known issue" OR "failure mode" OR "collapse" (forums, blog post-mortems)`,
    ...(falsified.length ? [`${symptom} -"${words(falsified[0] ?? "", 4)}" other causes (what else explains it, now that this is ruled out)`] : []),
    `repositories solving ${domain} with ${symptom}: how their setup differs from ours`,
  ];
  return [
    `RESEARCH_HINT ${lane.key} on "${metric || "(no metric on record)"}": ${fixes.filter((f) => f.metric === metric).length} attempts, ${tried.length} hypotheses tried, ${falsified.length} falsified, ${open.length} open`,
    `Symptom: ${symptom || "(unknown)"}${lane.lastReport ? `; last report: ${clip(lastReportText(lane), 160)}` : ""}`,
    ...(tried.length ? [`Already tried: ${tried.map((t) => clip(t, 80)).join("; ")}`] : []),
    "Search (10-15 minutes, stop at the first source that names this exact symptom):",
    ...queries.map((q, i) => `  ${i + 1}. ${q}`),
    `Record each useful finding: dori tree add --lane ${lane.key} --kind finding --text "<source url>: <what it says, and which hypothesis it supports or rules out>"`,
    "Then turn the best finding into a hypothesis with a cheap test (dori tree add --kind hypothesis --test ...) and report what it changes about the next step.",
  ];
};

// ---- the external-search step, run through omo's ulw research ----

// Text typed into a pane stays one line, and sendVerified refuses backticks and $(.
const typeable = (s: string): string => s.replace(/\s+/g, " ").replace(/`/g, "'").replaceAll("$(", "$ (").trim();

// The research question for ulw research, from the lane's records: the exact symptom, what was tried, what a test ruled
// out (and how), what is still open, and what sources to look for.
export const researchQuestion = (lane: Lane, tree: Tree): string => {
  const f = researchFacts(lane, tree);
  const report = lastReportText(lane);
  const symptom = f.metric ? `"${f.metric}" does not improve` : `${clip(report || lane.title, 160)}`;
  const parts = [
    `Lane ${lane.key} (${clip(lane.title, 80)}${lane.cwd ? `, repo ${basename(lane.cwd)}` : ""}) is stuck. Exact symptom: ${symptom}${f.fixes.length ? ` after ${f.fixes.filter((x) => x.metric === f.metric).length} fix attempts` : ""}${report && f.metric ? `; last report: ${clip(report, 160)}` : ""}.`,
    ...(f.tried.length ? [`Tried: ${f.tried.map((t) => clip(t, 80)).join("; ")}.`] : []),
    ...(f.falsified.length ? [`Ruled out by a test: ${f.falsified.map((n) => `${clip(n.text, 80)}${n.result ? ` (${clip(n.result, 80)})` : ""}`).join("; ")}.`] : []),
    ...(f.open.length ? [`Still open: ${f.open.map((n) => clip(n.text, 80)).join("; ")}.`] : []),
    `Look for papers (arxiv, Semantic Scholar), GitHub issues and discussions, and repos that hit this exact symptom${f.domain ? ` in ${f.domain}` : ""}: what caused it there, what fixed it, and causes other than the ones ruled out.`,
  ];
  return typeable(parts.join(" "));
};

// explore.researchText with the question filled in; it starts with "ulw research " (loadConfig refuses a template that does not)
export const researchMessage = (cfg: Pick<Explore, "researchText">, lane: Lane, tree: Tree, signal: number, metric: string): string =>
  typeable(fill([cfg.researchText], { question: researchQuestion(lane, tree), n: String(signal), metric, key: lane.key })[0] ?? cfg.researchText);

// Types the ulw research text into the lane and records when, so researchCheck can find it in the lane's session log.
export const sendResearch = async (deps: FlowDeps, lane: Lane, tree: Tree, signal: number, metric: string): Promise<boolean> => {
  if (!lane.pane) return false;
  const text = researchMessage(deps.config.explore, lane, tree, signal, metric);
  const sentAt = deps.clock.now();
  const delivered = await sendVerified(deps.run, deps.clock, deps.config.backend, lane.pane, text);
  if (delivered) await deps.registry.patch(lane.key, { research: { at: new Date(sentAt).toISOString(), sentAt, probe: text.slice(0, 80), metric, signal } });
  return delivered;
};

// Markers of a started ulw research in an omo session log (jsonl), counted from `since` (ms) on:
// - seen: a user message whose text starts with the probe (the start of the text dori typed)
// - pointer: a {"type":"custom_message","customType":"omo-ulw-research:skill-pointer"} entry, or the pointer block
//   <omo-ulw-research-pointer> inside that user message (omo appends it there when the agent was busy)
// - read: an assistant tool call that really reads ulw-research/SKILL.md (skillRead), not one that only mentions it
// - readEarlier: the same read before `since`: a lane that already holds the skill may not read it again, and then
//   tends to answer without the skill's protocol (seen live on a second send in one session)
export const RESEARCH_POINTER = "omo-ulw-research:skill-pointer";
export const RESEARCH_SKILL = "ulw-research/SKILL.md";
export type ResearchStart = { readonly seen: boolean; readonly pointer: boolean; readonly read: boolean; readonly readEarlier: boolean };

// A read of the skill file, not a mention of it (a lane that records a finding quoting the path did not read it):
// - the read tool with that path, or
// - an eval/bash call whose code holds the file's path (/..., ~/..., ./..., ${dir}/...) as a whole string literal and
//   reads a file (Bun.file, readFile, ... or a shell cat, sed, head, ...), or runs such a shell command on the path.
// A bare "ulw-research/SKILL.md" in a string, or the path inside a sentence, is a mention.
const SKILL_PATH = /ulw-research\/SKILL\.md(?![\w.-])/;
const SKILL_LITERAL = /(["'`])(?:\/|~|\.|\$\{)[^"'`\s]*ulw-research\/SKILL\.md\1/;
const READ_API = /\b(?:Bun\.file|readFileSync|readFile|createReadStream|openSync|tool\.read)\s*\(/;
// a shell read command on an interpolated path (cat ${skill}); a bare `| tail -1` reads a pipe, not a file
const SHELL_VAR = /(?:^|[\n;&|(`"']|\$\()\s*(?:cat|sed|head|tail|less|more|bat|nl|awk)\b[^\n;&|`]*?\s["']?\$\{/;
const SHELL_READ = /(?:^|[\n;&|(`"']|\$\()\s*(?:cat|sed|head|tail|less|more|bat|nl|awk)\b[^\n;&|`]*?[\s"'][^\s"';&|`]*ulw-research\/SKILL\.md(?![\w.-])/;
export const skillRead = (name: string | undefined, args: unknown): boolean => {
  const a = (args ?? {}) as Record<string, unknown>;
  if (name?.toLowerCase() === "read") return [a.path, a.file_path, a.filePath].some((p) => typeof p === "string" && SKILL_PATH.test(p));
  const code = [a.code, a.command, a.cmd].find((c): c is string => typeof c === "string");
  if (!code) return false;
  return (SKILL_LITERAL.test(code) && (READ_API.test(code) || SHELL_VAR.test(code))) || SHELL_READ.test(code);
};

type LogEntry = { type?: string; customType?: string; timestamp?: string; message?: { role?: string; content?: unknown } };
const blocks = (content: unknown): { type?: string; text?: string; name?: string; arguments?: unknown }[] => (Array.isArray(content) ? content : typeof content === "string" ? [{ type: "text", text: content }] : []);

export const parseResearchStart = (jsonl: string, probe: string, since: number): ResearchStart => {
  let seen = false;
  let pointer = false;
  let read = false;
  let readEarlier = false;
  for (const line of jsonl.split("\n")) {
    let e: LogEntry;
    try {
      e = JSON.parse(line) as LogEntry;
    } catch {
      continue; // a blank line, or the last line while omo is still writing it
    }
    const after = Date.parse(e.timestamp ?? "") >= since;
    if (after && e.type === "custom_message" && e.customType === RESEARCH_POINTER) pointer = true;
    if (e.type !== "message") continue;
    for (const b of blocks(e.message?.content)) {
      const readsSkill = e.message?.role === "assistant" && b.type === "toolCall" && skillRead(b.name, b.arguments);
      if (!after) {
        readEarlier ||= readsSkill;
        continue;
      }
      if (e.message?.role === "user" && b.type === "text" && b.text?.startsWith(probe)) {
        seen = true;
        if (b.text.includes("<omo-ulw-research-pointer>")) pointer = true;
      }
      if (readsSkill) read = true;
    }
  }
  return { seen, pointer, read, readEarlier };
};

// The lane's session log is the one in its cwd's session directory, written since the send, that holds the typed text.
export const findResearchStart = (sessionsDir: string, cwd: string, probe: string, since: number): ResearchStart & { readonly file?: string } => {
  const dir = sessionDirFor(sessionsDir, cwd);
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return { seen: false, pointer: false, read: false, readEarlier: false };
  }
  // a file omo removed since the listing has no stat and is skipped
  const recent = names.map((n) => ({ file: join(dir, n), at: statSync(join(dir, n), { throwIfNoEntry: false })?.mtimeMs ?? 0 })).filter((f) => f.at >= since).sort((a, b) => b.at - a.at);
  for (const { file } of recent) {
    const r = parseResearchStart(readFileSync(file, "utf8"), probe, since);
    if (r.seen) return { ...r, file };
  }
  return { seen: false, pointer: false, read: false, readEarlier: false };
};

export type ResearchCheck = { readonly verdict: "started" | "not-started" | "pending" | "none"; readonly line: string };

// RESEARCH_STARTED once the lane's session log shows the skill pointer and a read of its SKILL.md; RESEARCH_NOT_STARTED
// when explore.researchVerifyMin passed without both. Either goes to the watch log once and is kept on the lane.
export const researchCheck = async (deps: FlowDeps, lane: Lane): Promise<ResearchCheck> => {
  const r = lane.research;
  if (!r) return { verdict: "none", line: `RESEARCH_NONE ${lane.key}: no ulw research text was sent to this lane (dori research-hint ${lane.key} --send)` };
  if (r.result) return { verdict: r.result, line: `RESEARCH_${r.result === "started" ? "STARTED" : "NOT_STARTED"} ${lane.key}: already decided for the text sent ${r.at}` };
  const cwd = expandHome(lane.cwd ?? deps.config.defaultCwd);
  const found = findResearchStart(deps.config.sessionsDir, cwd, r.probe, r.sentAt);
  const min = Math.round((deps.clock.now() - r.sentAt) / 60_000);
  const where = found.file ? ` (${basename(found.file)})` : ` (no session log in ${sessionDirFor(deps.config.sessionsDir, cwd)} holds it)`;
  let verdict: ResearchCheck["verdict"] = "pending";
  let line = `RESEARCH_PENDING ${lane.key} ${min} min after the ulw research text: seen=${found.seen} pointer=${found.pointer} skill-read=${found.read}${where}`;
  if (found.pointer && found.read) {
    verdict = "started";
    line = `RESEARCH_STARTED ${lane.key} stuck signal ${r.signal} on "${r.metric}": the session log shows the ${RESEARCH_POINTER} and a read of ${RESEARCH_SKILL}${where}`;
  } else if (deps.clock.now() - r.sentAt >= deps.config.explore.researchVerifyMin * 60_000) {
    verdict = "not-started";
    const missing = !found.seen
      ? "the typed text never reached the lane's session log"
      : !found.pointer
        ? `omo attached no ${RESEARCH_POINTER} (check the omo version and that the text starts with "ulw research ")`
        : found.readEarlier
          ? `the pointer came, but the lane did not read ${RESEARCH_SKILL} again (it read it earlier in this session) and may be answering without the skill's protocol; tell it to follow the ulw-research SKILL.md for this question`
          : `the pointer came but the lane did not read ${RESEARCH_SKILL}`;
    line = `RESEARCH_NOT_STARTED ${lane.key} ${min} min after the ulw research text: ${missing}${where}. Re-send with dori research-hint ${lane.key} --send, or tell the lane to read the ulw-research SKILL.md`;
  }
  if (verdict !== "pending") {
    watchLog(deps.config.watchLog, deps.clock, { source: "research", line });
    await deps.registry.patch(lane.key, { research: { ...r, result: verdict } });
  }
  return { verdict, line };
};

// ---- dori intent-check ----

const CJK = /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const INTENT_STOP = new Set([...STOP, "make", "into", "this", "that", "then", "run", "new", "get"]);

// Korean, Chinese or Japanese words as character pairs (particles stay attached to the stem); other words as their
// first four letters, a crude stem (dump, dumps, dumping and dumped all give "dump")
const terms = (s: string): Set<string> => {
  const out = new Set<string>();
  for (const w of s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ")) {
    if (!w || INTENT_STOP.has(w)) continue;
    if (CJK.test(w)) {
      if (w.length < 2) out.add(w);
      for (let i = 0; i + 2 <= w.length; i++) out.add(w.slice(i, i + 2));
    } else if (w.length >= 3) out.add(w.slice(0, 4));
  }
  return out;
};

// share of the goal's terms the direction also has: crude, but enough to flag a lane drifting away from the owner's words
export const overlap = (goal: string, direction: string): number => {
  const g = terms(goal);
  if (!g.size) return 0;
  const d = terms(direction);
  let hit = 0;
  for (const p of g) if (d.has(p)) hit++;
  return hit / g.size;
};

const NEXT = /(?:next(?: step)?|다음(?: 단계)?)\s*[:：=-]\s*([^|;\n]+)/i;

export type IntentView = { readonly goal?: string; readonly direction: string; readonly next: string; readonly score: number; readonly verdict: "INTENT_OK" | "INTENT_DRIFT" | "INTENT_NO_GOAL" };

export const intentView = (lane: Lane, tree: Tree, driftBelow: number): IntentView => {
  const report = (lane.lastReport ?? "").replace(/^\[REPORT\][^|]*\|[^|]*\|\s*/, "");
  const direction = lane.direction?.text ?? (report || lane.title);
  const openTest = tree.nodes.find((n) => n.kind === "hypothesis" && n.status === "open" && n.lane === lane.key && n.test);
  const next = lane.direction?.next ?? NEXT.exec(report)?.[1]?.trim() ?? (openTest ? `test ${openTest.id}: ${openTest.test}` : "(not stated; pass --next)");
  if (!lane.goal) return { direction, next, score: 0, verdict: "INTENT_NO_GOAL" };
  const score = overlap(lane.goal, `${direction} ${next}`);
  return { goal: lane.goal, direction, next, score, verdict: score < driftBelow ? "INTENT_DRIFT" : "INTENT_OK" };
};

export const formatIntent = (lane: Lane, v: IntentView): string[] => [
  `INTENT ${lane.key} (${lane.title})`,
  `Goal (owner words): ${v.goal ?? "(none recorded; set it with dori intent-check <key> --goal \"<the owner's words>\")"}`,
  `Direction now:      ${clip(v.direction, 300)}`,
  `Next step:          ${clip(v.next, 300)}`,
  v.verdict === "INTENT_OK"
    ? `INTENT_OK ${lane.key} overlap ${v.score.toFixed(2)}: the direction still names the goal; say in the report how this step serves it`
    : v.verdict === "INTENT_DRIFT"
      ? `INTENT_DRIFT ${lane.key} overlap ${v.score.toFixed(2)}: the current direction shares little with the owner's goal. Restate how this step serves the goal, change course, or ask the owner`
      : `INTENT_NO_GOAL ${lane.key}: no owner goal on record, so drift cannot be checked`,
];
