// dori handover --lane <key>: move a lane whose conversation grew long to a new agent session.
// Order: refuse while work would die with the old session (a local chain, a running turn, an open question) unless the
// lane marked a safe point (dori handover ready) -> write the note -> open the new session in the same real path with the
// lane's model and thinking level -> point the registry and the question cards at it -> check its status line, its
// monitors and a [LEAD] probe ack -> only then close the old session. A failed check moves everything back and closes
// the new session; the old one stays the lane. Detached jobs (outside the pane's process tree) are listed, never touched.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { aoeSessions, BUSY_MARK, captureTmux, closeAoeSession, envMismatch, inputLine, laneEnv, openAoeSession, QUESTION_MARK, sessionFor, tmuxPanePid } from "./aoe.ts";
import type { FlowDeps } from "./done-flow.ts";
import { ackFile, liveMonitors, manifestPath, type MonitorSpec, missingMonitors, openGoal, openTodos, PROBE, readManifest, takeLock } from "./handover.ts";
import { awaitPrompt } from "./launch.ts";
import { QuestionStore } from "./messenger/discord-cards.ts";
import { sendVerified } from "./panes.ts";
import { type Lane, statusOf } from "./registry.ts";
import { iso } from "./run.ts";
import { AGENT, descendants, type Proc, sessionDirFor } from "./session-id.ts";
import { appendRollover, approvalProblem, autoReason, clearQuiet, COMMITTED, decidedBy, LEAD_PREFIX, lastProposal, readRollovers, reportToOwner, sessionFixes, type Signals, sessionSignals, setQuiet, type Step, type Supplement } from "./rollover.ts";
import { stuckTop } from "./explore.ts";
import { watchLog } from "./watch-log.ts";

export type LaneHandoverDeps = FlowDeps & {
  readonly cardDir: string;
  readonly home: string;
  // the omo session id of the agent running in a pane ("" when it cannot be told)
  readonly sessionOf: (pane: string, cwd: string) => Promise<string>;
  readonly procs: () => Promise<Proc[]>;
  // a process's environment as NAME=value lines ("" when it cannot be read)
  readonly envOf: (pid: number) => string;
  readonly alive: (pid: number) => boolean;
  // stops or resumes a process (the old agent is frozen while it is replaced); false when the signal could not be sent
  readonly signal: (pid: number, sig: "SIGSTOP" | "SIGCONT") => boolean;
  // the path with symlinks resolved (the path itself when it cannot be resolved)
  readonly realpath: (path: string) => string;
  readonly nonce: () => string;
  readonly print: (line: string) => void;
  // posts the owner's after-the-fact note of a rollover the lead decided (in the lane's discord thread, else the owner's
  // channel) and returns its message id; absent when no messenger is set up, and then a lead: approval is refused
  readonly reportOwner?: (thread: string | null, text: string) => Promise<string>;
};

export type LaneHandoverOptions = {
  // the approval: lead:<reason and signal>, the owner's answered card Qn, a message link or their words (rollover.ts approvalProblem); --dry-run needs none
  readonly approvedBy?: string;
  readonly note?: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly force?: boolean;
  readonly keepOld?: boolean;
  readonly dryRun?: boolean;
  readonly verifyMin?: number;
};

export type LaneHandoverResult = { readonly code: number; readonly note?: string; readonly to?: string };

// What the lane confirmed with dori handover ready: the local chains it accepts losing, and its own notes.
export type ReadyMark = { readonly key: string; readonly pane: string; readonly at: string; readonly chains: readonly number[]; readonly note?: string };

export type StatusLine = { readonly model?: string; readonly thinking?: string; readonly contextPct?: number; readonly account?: string };

// pids: the chain and every process under it, so a grandchild that outlives its parent still counts as the chain running
type Job = { readonly pid: number; readonly cmd: string; readonly pids?: readonly number[] };

export type LaneFacts = {
  readonly lane: Lane;
  readonly from: { readonly pane: string; readonly aoeId: string; readonly session: string; readonly title: string; readonly cwd: string };
  readonly cwd: string;
  readonly model: string;
  readonly thinking?: string;
  readonly contextPct?: number;
  readonly account?: string;
  readonly monitors: readonly MonitorSpec[];
  readonly todos: readonly string[];
  readonly goal?: string;
  readonly chains: readonly Job[];
  readonly detached: readonly Job[];
  readonly ready?: ReadyMark;
  readonly laneNote: string;
  readonly approvedBy?: string;
  readonly signals: Signals;
  // the old agent's process (frozen during the switch) and the old conversation's log file
  readonly agentPid?: number;
  readonly oldLog?: string;
};

// The headings of the conversation summary the old session writes at its safe point (dori handover ready --note FILE):
// what only its conversation knows. The new session reads it; dori handover ready --template prints them.
export const SUMMARY_HEADINGS = ["Owner's words and constraints", "Decisions and why", "Ruled out", "In progress", "Next step"] as const;
export const SUMMARY_TEMPLATE = [
  "## Owner's words and constraints",
  "(every instruction and constraint from the owner or the lead that still holds, how the work must be done included, quoted exactly in \"double quotes\", newest last, with the message link when you have it; summaries lose these first)",
  "## Decisions and why",
  "(each decision made in this conversation and the evidence it rests on)",
  "## Ruled out",
  "(approaches, hypotheses and fixes already tried and rejected, with the result that rejected each; the new session must not try them again without a new reason)",
  "## In progress",
  "(what is half done: files touched, commands and tests run with their results (verified apart from only attempted), runs going, results awaited, and the judgment you were forming)",
  "## Next step",
  "(the exact next action, and the check that tells it worked)",
  "",
].join("\n");
// The headings the new session's restatement needs (written before it acks the probe).
export const UNDERSTOOD_HEADINGS = ["Goal", "Owner's words", "Decisions", "Next step", "Ruled out", "Questions"] as const;

const missingHeadings = (text: string, headings: readonly string[]): string[] => headings.filter((h) => !new RegExp(`^##\\s+${escape(h)}\\s*$`, "mi").test(text));

const section = (text: string, heading: string): string => {
  const m = new RegExp(`^##\\s+${escape(heading)}\\s*$([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, "mi").exec(text);
  return m?.[1]?.trim() ?? "";
};

// What the new session's restatement left out, measured against what the handover holds: the fix ledger and the lane's
// goal (independent of the summary), and the owner's quoted words and the decisions of the old session's summary.
export type Missing = { readonly kind: "restatement" | "heading" | "tried fix" | "owner goal" | "owner's words" | "decision"; readonly text: string; readonly under: string; readonly source: string };

// an escaped quote (\") counts as a plain one on both sides, so a quote inside a quote stays one line
const flat = (s: string): string => s.replace(/\\"/g, '"').replace(/\s+/g, " ").trim().toLowerCase();
const QUOTE = /"((?:[^"\\\n]|\\.){6,})"|“([^”\n]{6,})”|「([^」\n]{6,})」/g;
const quotesIn = (text: string): string[] => [...new Set([...text.matchAll(QUOTE)].map((m) => (m[1] ?? m[2] ?? m[3] ?? "").replace(/\\"/g, '"').trim()).filter(Boolean))];
const words = (s: string): string[] => [...new Set(s.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]{3,}/gu) ?? [])];
// a decision bullet without its "Why: ..." tail; one with fewer than 3 words is too short to check
const decisionsIn = (summary: string): string[] =>
  section(summary, "Decisions and why").split("\n").map((l) => /^\s*[-*]\s+(.*)$/.exec(l)?.[1]?.split(/\s+why:|\s+because\s/i)[0]?.trim() ?? "").filter((d) => words(d).length >= 3);

export const missingFrom = (text: string, facts: LaneFacts): Missing[] => {
  if (!text.trim()) return [{ kind: "restatement", text: "the restatement file is missing or empty", under: "", source: "the probe" }];
  const all = flat(text);
  const ruled = flat(section(text, "Ruled out"));
  // a long quote counts when its first 80 characters are there
  const has = (s: string) => all.includes(flat(s).slice(0, 80));
  const goal = facts.lane.goal?.trim() ?? "";
  const out: Missing[] = missingHeadings(text, UNDERSTOOD_HEADINGS).map((h) => ({ kind: "heading", text: `## ${h}`, under: h, source: "the restatement format" }));
  for (const h of new Set(sessionFixes(facts.lane).map((x) => x.hypothesis))) if (!ruled.includes(flat(h))) out.push({ kind: "tried fix", text: h, under: "Ruled out", source: "the fix ledger (dori fix-attempt), kept apart from the summary" });
  if (goal && !has(goal)) out.push({ kind: "owner goal", text: goal, under: "Goal", source: "the lane's registry entry (the owner's words at launch)" });
  for (const q of quotesIn(section(facts.laneNote, "Owner's words and constraints"))) if (!has(q) && flat(q) !== flat(goal)) out.push({ kind: "owner's words", text: q, under: "Owner's words", source: "the old session's summary, Owner's words and constraints" });
  for (const d of decisionsIn(facts.laneNote)) {
    const ws = words(d);
    if (ws.filter((x) => all.includes(x)).length * 2 < ws.length) out.push({ kind: "decision", text: d, under: "Decisions", source: "the old session's summary, Decisions and why" });
  }
  return out;
};

const stringsOf = (v: unknown, out: string[] = []): string[] => {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringsOf(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) stringsOf(x, out);
  return out;
};

// The old conversation's lines behind a left-out item (the owner's messages first): the supplement quotes them, so the
// new session gets the source, not only the old session's summary of it.
export const evidenceFor = (log: string | undefined, item: Missing, max = 2): string[] => {
  if (!log || !existsSync(log) || item.kind === "restatement" || item.kind === "heading") return [];
  const ws = item.kind === "decision" ? words(item.text) : [];
  const needle = (item.kind === "decision" ? [...ws].sort((a, b) => b.length - a.length)[0] ?? "" : item.text.slice(0, 60)).toLowerCase();
  if (!needle) return [];
  const raw = JSON.stringify(needle).slice(1, -1);
  const hits: { line: number; role: string; text: string }[] = [];
  readFileSync(log, "utf8").split("\n").forEach((line, i) => {
    if (!line.toLowerCase().includes(raw)) return;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    const s = stringsOf(obj).find((x) => (ws.length ? ws.filter((w) => x.toLowerCase().includes(w)).length * 2 >= ws.length : x.toLowerCase().includes(needle)));
    if (!s) return;
    const at = Math.max(0, s.toLowerCase().indexOf(needle));
    const a = Math.max(0, at - 100);
    const b = at + needle.length + 100;
    const o = obj as { message?: { role?: string }; type?: string };
    hits.push({ line: i + 1, role: o.message?.role ?? o.type ?? "?", text: `${a ? "…" : ""}${s.slice(a, b).replace(/\s+/g, " ").trim()}${b < s.length ? "…" : ""}` });
  });
  return [...hits.filter((h) => h.role === "user"), ...hits.filter((h) => h.role !== "user")].slice(0, max).map((h) => `old log line ${h.line} (${h.role}): "${h.text}"`);
};

const renderSupplement = (key: string, round: number, rounds: number, items: readonly Missing[], evidence: readonly string[][], understood: string, ack: string): string =>
  [
    `# Supplement ${round}/${rounds} for the ${key} handover`,
    "",
    `Your restatement ${understood} left out what follows. It comes from the handover's own records and the old session's summary; the log lines are quoted from the old conversation (frozen, still on disk). Add each item to ${understood} under the heading named (the owner's words quoted exactly), keep the rest, then run: ${ack}`,
    "",
    ...items.flatMap((it, i) => [
      `## ${i + 1}. ${it.kind}: ${it.text}`,
      `Source: ${it.source}. Goes under: ${it.under ? `## ${it.under}` : `the whole file, with the headings ${UNDERSTOOD_HEADINGS.map((h) => `## ${h}`).join(", ")}`}.`,
      ...(evidence[i]?.length ? ["Evidence:", ...(evidence[i] ?? []).map((e) => `- ${e}`)] : ["Evidence: no matching line in the old log."]),
      "",
    ]),
  ].join("\n");

const logOf = (dir: string, session: string): string | undefined => {
  if (!session) return undefined;
  try {
    const name = readdirSync(dir).find((n) => n.endsWith(`_${session}.jsonl`));
    return name ? join(dir, name) : undefined;
  } catch {
    return undefined;
  }
};

// Written once the new session exists and removed when the run ends either way: a run killed in between (crash, reboot,
// SIGKILL) leaves it behind, and the next dori handover --lane for that lane repairs the state from it first.
export type Pending = { readonly key: string; readonly pid: number; readonly at: string; readonly from: string; readonly to: string; readonly note: string; readonly chains?: readonly Job[]; readonly agentPid?: number };

const POLL_MS = 5_000;
// how long the new session gets to answer one supplement round (polls of POLL_MS)
const ROUND_TRIES = 36;
const THINKING = /^(.*):(off|minimal|low|medium|high|xhigh|max)$/;
// processes every omo session runs besides the work: MCP servers, the subagent RPC host, the provider's own CLI
const INFRA = /\bmcp\b|--internal-rpc-host-supervisor|--mode rpc|claude-agent-sdk/;
const CONTEXT = /\b\d+(?:\.\d+)?[KMG]?\/\d+(?:\.\d+)?[KMG]?\s+\((\d+(?:\.\d+)?)%\)/;

export const splitModel = (model: string): { readonly base: string; readonly thinking?: string } => {
  const m = THINKING.exec(model);
  return m?.[1] && m[2] ? { base: m[1], thinking: m[2] } : { base: model };
};

const modelId = (model: string): string => splitModel(model).base.split("/").pop() ?? model;
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// omo's status line sits below the ❯ input line: "... 90K/1M (9.0%) ... claude-opus-5-5 • effort high" (or "claude-opus-5-5:high").
export const statusLine = (screen: string, model: string): StatusLine => {
  const lines = screen.split("\n");
  const at = lines.findLastIndex((l) => l === inputLine(screen));
  const tail = (at >= 0 ? lines.slice(at + 1) : lines.slice(-6)).join("\n");
  const id = modelId(model);
  const named = new RegExp(`(?:^|[\\s(/])${escape(id)}(?::(\\w+))?(?=\\s|$)`, "m").exec(tail);
  const effort = /\beffort (\w+)/.exec(tail);
  const pct = CONTEXT.exec(tail);
  const thinking = named?.[1] ?? effort?.[1];
  // the subscription account the session runs on: "(provider@account)" or the usage row "Claude·account"
  const account = (/@([\w.-]+)\)/.exec(tail) ?? /Claude·(\S+)/.exec(tail))?.[1];
  return { ...(named ? { model: id } : {}), ...(thinking ? { thinking } : {}), ...(pct?.[1] ? { contextPct: Number(pct[1]) } : {}), ...(account ? { account } : {}) };
};

// The work the old session's agent runs that dies with it: every child process of the agent except omo's own helpers
// and its monitors (those are re-armed in the new session). exclude: pids that must not count (the caller's own chain).
export const localChains = (table: readonly Proc[], shellPid: number, monitorPids: readonly number[], exclude: ReadonlySet<number> = new Set()): { readonly agent?: Proc; readonly chains: Job[]; readonly tree: Set<number> } => {
  const tree = descendants(table, shellPid);
  const agent = tree.find((p) => AGENT.test(p.cmd) && !/\bmcp\b/.test(p.cmd));
  const ids = new Set([shellPid, ...tree.map((p) => p.pid)]);
  if (!agent) return { chains: [], tree: ids };
  // the agent's children, and jobs started from the pane's shell itself (they die with the pane too)
  const chains = table
    .filter((p) => (p.ppid === agent.pid || (p.ppid === shellPid && p.pid !== agent.pid)) && !INFRA.test(p.cmd) && !monitorPids.includes(p.pid) && !exclude.has(p.pid))
    .map((p) => ({ pid: p.pid, cmd: p.cmd, pids: [p.pid, ...descendants(table, p.pid).map((d) => d.pid)] }));
  return { agent, chains, tree: ids };
};

// Jobs the lane started that left its pane's process tree (setsid, nohup, systemd-run): their environment still names
// the lane's omo session or aoe session. They survive the old session and are only listed.
export const detachedJobs = (table: readonly Proc[], tree: ReadonlySet<number>, session: string, aoeId: string, envOf: (pid: number) => string): Job[] => {
  const marks = [...(session ? [`PI_SESSION_ID=${session}`] : []), ...(aoeId ? [`/${aoeId}/session_id`] : [])];
  if (!marks.length) return [];
  return table.filter((p) => !tree.has(p.pid) && p.pid !== process.pid).flatMap((p) => {
    const env = envOf(p.pid);
    return env && marks.some((m) => env.split("\n").some((line) => line === m || line.endsWith(m))) ? [{ pid: p.pid, cmd: p.cmd }] : [];
  });
};

// Jobs an earlier handover of the lane listed (detached, or chains that outlived their session) that still run: their
// environment names an older session, so detachedJobs alone would lose them from one handover to the next.
const carried = (dir: string, key: string, alive: (pid: number) => boolean, known: ReadonlySet<number>): Job[] => {
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((n) => new RegExp(`^${escape(key)}-\\d{8}-\\d{6}\\.json$`).test(n)).sort();
  } catch {
    return [];
  }
  const last = files.at(-1);
  const prev = last ? readJson<{ readonly detached?: Job[]; readonly chains?: Job[] }>(join(dir, last)) : undefined;
  return [...(prev?.detached ?? []), ...(prev?.chains ?? [])].filter((j) => alive(j.pid) && !known.has(j.pid)).map((j) => ({ pid: j.pid, cmd: j.cmd }));
};

const ancestors = (table: readonly Proc[], pid: number): Set<number> => {
  const byPid = new Map(table.map((p) => [p.pid, p]));
  const out = new Set<number>();
  for (let p = byPid.get(pid); p && !out.has(p.pid); p = byPid.get(p.ppid)) out.add(p.pid);
  return out;
};

export const readyFile = (stateDir: string, key: string): string => join(stateDir, "handover", "lanes", `${key}.ready.json`);
export const pendingFile = (stateDir: string, key: string): string => join(stateDir, "handover", "lanes", `${key}.pending.json`);

// The pids of the monitors omo runs for the session in a pane (they are re-armed, not lost).
const monitorPidsOf = async (deps: LaneHandoverDeps, pane: string, cwd: string): Promise<{ readonly session: string; readonly entries: ReturnType<typeof readManifest>; readonly pids: number[] }> => {
  const session = await deps.sessionOf(pane, cwd).catch(() => "");
  const entries = session ? readManifest(manifestPath(deps.config.sessionsDir, cwd, session)) : [];
  return { session, entries, pids: entries.flatMap((e) => (e.runtime?.pid !== undefined ? [e.runtime.pid] : [])) };
};

const readJson = <T>(file: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
};
const readReady = (stateDir: string, key: string): ReadyMark | undefined => readJson<ReadyMark>(readyFile(stateDir, key));
const readPending = (stateDir: string, key: string): Pending | undefined => readJson<Pending>(pendingFile(stateDir, key));

// dori handover ready, run by the lane in its own pane at a safe point: records the local chains it accepts losing (the
// chain running this command is left out) and the lane's own notes for the new session.
export const markReady = async (deps: LaneHandoverDeps, lane: Lane, here: string, self: number, noteFile?: string): Promise<{ readonly code: number; readonly line: string }> => {
  if (!lane.pane || here !== lane.pane) return { code: 2, line: `HANDOVER_READY_REFUSED ${lane.key}: run it inside the lane's own pane ${lane.pane ?? "(none)"}, not ${here || "outside tmux"}` };
  if (!noteFile) return { code: 2, line: `HANDOVER_READY_REFUSED ${lane.key}: write the conversation summary first (dori handover ready --template prints its headings), then dori handover ready ${lane.key} --note FILE` };
  if (!existsSync(noteFile)) return { code: 2, line: `HANDOVER_READY_REFUSED ${lane.key}: note file not found: ${noteFile}` };
  const lacking = missingHeadings(readFileSync(noteFile, "utf8"), SUMMARY_HEADINGS);
  if (lacking.length) return { code: 2, line: `HANDOVER_READY_REFUSED ${lane.key}: the summary ${noteFile} lacks ${lacking.map((h) => `## ${h}`).join(", ")} (dori handover ready --template)` };
  const old = sessionFor(await aoeSessions(deps.run), lane.pane);
  const { pids } = await monitorPidsOf(deps, lane.pane, old?.path ?? lane.cwd ?? deps.config.defaultCwd);
  const table = await deps.procs();
  const shell = await tmuxPanePid(deps.run, lane.pane);
  // The chain that runs this command is covered too: a shell that ends right after, or omo's eval kernel, which stays
  // alive while the lane idles and would otherwise block the move the lane just declared safe.
  const all = localChains(table, shell, pids).chains;
  const runner = all.filter((c) => ancestors(table, self).has(c.pid));
  const chains = all.filter((c) => !runner.includes(c));
  const mark: ReadyMark = { key: lane.key, pane: lane.pane, at: iso(deps.clock), chains: all.map((c) => c.pid), ...(noteFile ? { note: readFileSync(noteFile, "utf8") } : {}) };
  mkdirSync(join(deps.config.stateDir, "handover", "lanes"), { recursive: true });
  writeFileSync(readyFile(deps.config.stateDir, lane.key), JSON.stringify(mark, null, 1));
  const list = chains.map((c) => `${c.pid} ${c.cmd.slice(0, 80)}`).join("; ");
  return { code: 0, line: `HANDOVER_READY ${lane.key} pane=${lane.pane} chains=${chains.length}${list ? ` (${list}; these end when the old session closes)` : ""}${runner.length ? ` runner=${runner.map((c) => c.pid).join(",")} (runs this command; covered too)` : ""} note=${noteFile ? "yes" : "no"}; valid ${deps.config.handover.readyMin} min. Tell the lead, then end your turn.` };
};

const job = (j: Job): string => `- ${j.pid}: \`${j.cmd.slice(0, 200).replace(/`/g, "'")}\``;
const monitorLine = (m: MonitorSpec): string =>
  `- ${m.description || "(no description)"}: ${m.command ? `command ${JSON.stringify(m.command)}${m.filter ? ` filter ${JSON.stringify(m.filter)}` : ""}` : `path ${JSON.stringify(m.path)}${m.event ? ` event ${m.event}` : ""}`}${m.persistent ? "" : " (was not persistent in the old session; arm it as persistent)"}`;

export const renderLaneNote = (f: LaneFacts, at: string, stateDir: string): string => [
  `# Lane handover ${f.lane.key} ${at}`,
  "",
  `You are the ${f.lane.key} lane, in a new session. The old one (${f.from.pane}, aoe ${f.from.aoeId}, omo session ${f.from.session || "unknown"}) ran out of room; dori handover --lane points the lane's registry entry at you. The old conversation does not come with you: this note and your brief are all you know.`,
  "",
  "## Do this first",
  "1. Arm every monitor under Monitors again as a persistent monitor, with the same command and filter. Arm each one once.",
  `2. A [LEAD] line with ${PROBE} <id> is a check of this handover. Before you answer it, read this whole note and your brief, then write what you understood to the file the line names, under the headings ${UNDERSTOOD_HEADINGS.map((h) => `## ${h}`).join(", ")} (under Goal and Owner's words, the owner's goal and words quoted exactly as the note gives them; under Questions, only what neither the note nor the old log answers after you searched it, or none). Then run the dori handover ack command it gives (with its --state) and nothing else for that line. A [LEAD] HANDOVER_SUPPLEMENT <id> line names a file with what your restatement left out and the old log lines behind it: add those items to the same file, keep the rest, and run the ack command it gives.`,
  `3. Read your brief ${f.lane.brief} in full. It still holds: same Done, same footer, and reports still go to the lead.`,
  `4. Until a [LEAD] ${COMMITTED} line arrives, do nothing else: change no file, start no process besides the monitors of step 1, post nothing. Until then the handover can still roll back and close this session.`,
  `5. After ${COMMITTED}: ${f.goal ? "register the goal under Goal again with your goal tool, same objective, and rebuild the todo list from Todos." : "rebuild the todo list from Todos."} Then continue the work from where Last reports and the lane's notes leave it.`,
  "",
  "## Lane",
  `- Key ${f.lane.key}: ${f.lane.title}. Work thread: ${f.lane.thread}.`,
  `- Brief: ${f.lane.brief}`,
  `- Done: ${f.lane.done}`,
  ...(f.lane.goal ? [`- Owner goal (owner words): "${f.lane.goal}"`] : []),
  `- Model ${f.model}${f.thinking ? `, thinking ${f.thinking}` : ""}; cwd ${f.cwd}${f.cwd === f.from.cwd ? "" : ` (the old session ran from ${f.from.cwd})`}.`,
  ...(f.approvedBy ? [`- Moved with the owner's approval: ${f.approvedBy}`] : []),
  "",
  `## Monitors (${f.monitors.length})`,
  ...(f.monitors.length ? f.monitors.map(monitorLine) : ["none"]),
  "",
  ...(f.goal ? ["## Goal", f.goal, ""] : []),
  "## Todos",
  ...(f.todos.length ? f.todos.map((t) => `- ${t}`) : ["none"]),
  "",
  `## Local chains of the old session (${f.chains.length})`,
  ...(f.chains.length ? ["Do NOT start these again now: they still run under the old session until it closes, and a second copy would run the same work twice (duplicate node jobs, results written over). Once the old session is closed and these pids are gone, a [LEAD] HANDOVER_CHAINS_ENDED line tells you; then restart only what is still needed, from its checkpoint or progress files, skipping steps that already finished.", ...f.chains.map(job)] : ["none"]),
  "",
  `## Detached jobs (${f.detached.length})`,
  ...(f.detached.length ? ["They run outside the old session and keep running; the handover does not touch them. Check on them, do not start them twice.", ...f.detached.map(job)] : ["none"]),
  "",
  "## Last reports",
  `- Last report: ${f.lane.lastReport ?? "none"}`,
  ...(f.lane.direction ? [`- Direction (intent-check ${f.lane.direction.at}): ${f.lane.direction.text}${f.lane.direction.next ? `; next: ${f.lane.direction.next}` : ""}`] : []),
  ...(f.lane.history ?? []).slice(-3).map((h) => `- ${h.at} ${h.status}: ${h.note}`),
  "",
  "## Conversation summary (written by the old session)",
  f.laneNote.trim() || "(none: the old session did not write one with dori handover ready --note FILE; read the old conversation below before you act on a guess)",
  "",
  `## Fix attempts in the old session (${sessionFixes(f.lane).length})`,
  ...(sessionFixes(f.lane).length
    ? ["Already tried; do not try one again without a new reason, and at the 3rd of one same fix change the hypothesis instead.", ...sessionFixes(f.lane).map((x) => `- ${x.at} ${x.metric} / ${x.hypothesis} (${x.via}${x.improved ? ", the one before it moved the metric" : ""})`)]
    : ["none"]),
  "",
  "## The old conversation",
  f.oldLog ? `Its full log is ${f.oldLog} (JSONL; it stays on disk after the old session closes). When this note leaves something out, search it (the owner's words, a file name, an error) before you ask.` : "Its log was not found.",
  "",
  `State dir for acks: ${stateDir}`,
  "",
].join("\n");

const ackedBy = (stateDir: string, id: string): string | undefined => {
  try {
    return (JSON.parse(readFileSync(ackFile(stateDir, id), "utf8")) as { pane?: string }).pane ?? "";
  } catch {
    return undefined;
  }
};

const titleFor = (old: string, stamp: string): string => `${old.replace(/-\d{8}$/, "")}-${stamp.slice(4, 8)}${stamp.slice(9, 13)}`;

export const laneHandover = async (deps: LaneHandoverDeps, key: string, here: string, opts: LaneHandoverOptions = {}): Promise<LaneHandoverResult> => {
  const { config } = deps;
  const at = iso(deps.clock);
  const stamp = at.replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const dir = join(config.stateDir, "handover", "lanes");
  const emit = (line: string): void => {
    deps.print(line);
    if (!opts.dryRun) watchLog(config.watchLog, deps.clock, { source: "handover", line });
  };
  let fromPane = "";
  const refuse = (why: string): LaneHandoverResult => {
    emit(`HANDOVER_REFUSED ${key}: ${why}`);
    if (!opts.dryRun && opts.approvedBy?.trim()) appendRollover(config.stateDir, { kind: "rollover", who: "lane", at, key, from: fromPane, approvedBy: opts.approvedBy.trim(), signals: {}, steps: [], result: "refused", reasons: [why] });
    return { code: 2 };
  };
  if (config.backend !== "aoe") return refuse("dori handover --lane needs backend aoe");
  const lane = await deps.registry.read(key);
  if (!lane) return refuse("no such lane");
  if (statusOf(lane) === "closed") return refuse("the lane is closed");
  if (!lane.pane) return refuse("the lane has no pane");
  fromPane = lane.pane;
  if (here === lane.pane) return refuse(`run it from the lead, not from the lane's own pane; the lane marks a safe point with dori handover ready ${key} and tells the lead`);
  if (opts.note && !existsSync(opts.note)) return refuse(`note file not found: ${opts.note}`);
  const pending = readPending(config.stateDir, key);
  if (pending) {
    if (pending.pid !== process.pid && deps.alive(pending.pid)) return refuse(`another handover of ${key} is running (pid ${pending.pid}, started ${pending.at})`);
    if (opts.dryRun) return refuse(`an interrupted handover (${pending.from} -> ${pending.to}, ${pending.at}) left ${pendingFile(config.stateDir, key)}; run without --dry-run to repair it first`);
    emit(`HANDOVER_INTERRUPTED ${key}: the run from ${pending.at} (pid ${pending.pid}) ended between opening ${pending.to} and finishing; repairing`);
    await recover(deps, pending, emit);
    return { code: 3 };
  }
  const unapproved = opts.dryRun ? undefined : approvalProblem(opts.approvedBy, (id) => new QuestionStore(deps.cardDir).get(id), { on: config.handover.autoRolloverLanes, key: "handover.autoRolloverLanes" }, key, lane.pane ?? "", readRollovers(config.stateDir), Boolean(deps.reportOwner));
  if (unapproved) return refuse(`a lane moves to a new session only with an approval: ${unapproved} (--dry-run needs none)`);
  const old = sessionFor(await aoeSessions(deps.run), lane.pane);
  if (!old) return refuse(`no live aoe session for pane ${lane.pane}`);
  const real = deps.realpath(old.path);
  // omo may keep the session under the path aoe shows or under the real one (a symlinked cwd): use whichever names the session
  let base = old.path;
  let found = await monitorPidsOf(deps, lane.pane, base);
  if (!found.session && real !== old.path) {
    const byReal = await monitorPidsOf(deps, lane.pane, real);
    if (byReal.session) [base, found] = [real, byReal];
  }
  const { session, entries, pids: monitorPids } = found;
  if (!session) emit(`HANDOVER_SESSION_UNSEEN ${key}: the omo session of ${lane.pane} was not found under ${old.path}${real !== old.path ? ` or ${real}` : ""}; the note has no monitors, todos, goal or old log`);
  const now = deps.clock.now();
  const monitors = liveMonitors(entries, now, deps.alive);
  const table = await deps.procs();
  const shell = await tmuxPanePid(deps.run, lane.pane);
  const { agent, chains, tree } = localChains(table, shell, monitorPids);
  if (!agent) return refuse(`no omo agent process under pane ${lane.pane} (shell pid ${shell || "?"})`);
  const marked = detachedJobs(table, tree, session, old.id, deps.envOf);
  const detached = [...marked, ...carried(dir, key, deps.alive, new Set([...marked.map((d) => d.pid), ...chains.flatMap((c) => c.pids ?? [c.pid]), ...monitorPids]))];
  const model = opts.model || lane.model || config.defaultModel;
  const screen = await captureTmux(deps.run, lane.pane);
  const shown = statusLine(screen, model);
  // the level the lane runs at now (its status line), else the one it was launched with
  const thinking = opts.thinking || shown.thinking || splitModel(model).thinking;
  if (!shown.model) emit(`HANDOVER_MODEL_UNSEEN ${key}: the status line of ${lane.pane} does not name ${modelId(model)}; the new session gets ${model} anyway`);
  const mark = readReady(config.stateDir, key);
  const ready = mark && mark.pane === lane.pane && now - Date.parse(mark.at) <= config.handover.readyMin * 60_000 ? mark : undefined;
  if (mark && !ready) emit(`HANDOVER_READY_STALE ${key}: the ready mark from ${mark.at} (pane ${mark.pane}) is older than ${config.handover.readyMin} min or from another pane; ignored`);
  const uncovered = chains.filter((c) => !ready?.chains.includes(c.pid));
  const blockers = [
    ...(uncovered.length ? [`${uncovered.length} local chain(s) would die: ${uncovered.map((c) => `${c.pid} ${c.cmd.slice(0, 80)}`).join("; ")}`] : []),
    // a ready mark covers chains only: a turn that started after it (a nudge, a message) still blocks
    ...(screen.includes(BUSY_MARK) ? ["a turn is running (esc to interrupt on screen)"] : []),
    ...(QUESTION_MARK.test(screen) ? ["a question is open in the pane"] : []),
  ];
  const blocked = blockers.length > 0 && !opts.force;
  const blockedWhy = `${blockers.join("; ")}. Ask the lane to reach a safe point and write its conversation summary and run dori handover ready ${key} --note FILE in its own pane, or pass --force`;
  // a dry run still writes the note, so a rollover proposal can show it with what blocks the move
  if (blocked && !opts.dryRun) return refuse(blockedWhy);
  if (blocked) emit(`HANDOVER_REFUSED ${key}: ${blockedWhy}`);
  else if (blockers.length) emit(`HANDOVER_FORCED ${key}: ${blockers.join("; ")}`);
  if (real !== old.path) emit(`HANDOVER_CWD_SYMLINK ${key}: the lane runs from ${old.path}, a symlink to ${real}; the new session opens in ${real}`);
  const sessionDir = sessionDirFor(config.sessionsDir, base);
  const stuck = stuckTop(lane);
  const signals: Signals = { ...(shown.contextPct !== undefined ? { contextPct: shown.contextPct } : {}), ...sessionSignals(sessionDir, session, now), ...(stuck ? { stuck } : {}) };
  const laneNote = [ready?.note ?? "", opts.note ? readFileSync(opts.note, "utf8") : ""].filter((t) => t.trim()).join("\n\n");
  const facts: LaneFacts = {
    lane, from: { pane: lane.pane, aoeId: old.id, session, title: old.title, cwd: old.path }, cwd: real, model: splitModel(model).base, thinking, ...(shown.contextPct !== undefined ? { contextPct: shown.contextPct } : {}), ...(shown.account ? { account: shown.account } : {}),
    monitors, todos: session ? openTodos(sessionDir, session) : [], goal: session ? openGoal(sessionDir, session) : undefined, chains, detached, ...(ready ? { ready } : {}), laneNote, signals, ...(opts.approvedBy?.trim() ? { approvedBy: opts.approvedBy.trim() } : {}),
    agentPid: agent.pid, ...(logOf(sessionDir, session) ? { oldLog: logOf(sessionDir, session) } : {}),
  };
  mkdirSync(dir, { recursive: true });
  const note = join(dir, `${key}-${stamp}.md`);
  writeFileSync(note, renderLaneNote(facts, at, config.stateDir));
  writeFileSync(join(dir, `${key}-${stamp}.json`), JSON.stringify(facts, null, 1));
  emit(`HANDOVER_NOTE ${note}: ${monitors.length} monitors, ${facts.todos.length} todos, goal ${facts.goal ? "yes" : "no"}, ${chains.length} local chains, ${detached.length} detached jobs, context ${shown.contextPct ?? "?"}%, compactions ${signals.compactions ?? "?"}, age ${signals.ageH ?? "?"} h, ready ${ready ? ready.at : "no"}`);
  const title = titleFor(old.title, stamp);
  if (opts.dryRun) {
    if (blocked) return { code: 2, note };
    deps.print(`HANDOVER_DRY_RUN ${key} would open aoe session "${title}" in ${real} (--model ${facts.model}${thinking ? ` --thinking ${thinking}` : ""}), point the lane at it, check the status line, ${monitors.length} monitors (${monitors.map((m) => m.description || m.command || m.path).join(", ") || "none"}) and a probe within ${opts.verifyMin ?? config.handover.verifyMin} min, then ${opts.keepOld ? "keep" : "close"} ${lane.pane}; detached jobs left alone: ${detached.map((d) => d.pid).join(",") || "none"}`);
    return { code: 0, note };
  }
  const lockFile = join(dir, `${key}.lock`);
  const busy = takeLock(lockFile, deps.alive, at);
  if (busy) return refuse(busy);
  try {
    const steps: Step[] = [];
    let last = deps.clock.now();
    const mark = (step: string, ok: boolean) => {
      const t = deps.clock.now();
      steps.push({ step, ms: t - last, ok });
      last = t;
    };
    const accounts: { to?: string } = {};
    const supplements: Supplement[] = [];
    const r = await moveLane(deps, opts, facts, { note, title, emit, steps, mark, accounts, supplements });
    const proposal = lastProposal(readRollovers(config.stateDir), key);
    const result = r.code === 0 ? (opts.keepOld ? "done-kept-old" : "done") : r.code === 1 ? "done-close-failed" : "rolled-back";
    const by = facts.approvedBy ? decidedBy(facts.approvedBy) : undefined;
    const reason = by === "lead" ? (facts.approvedBy ?? "").slice(LEAD_PREFIX.length).trim() : by === "auto" ? autoReason("lane", facts.signals, config.handover) : undefined;
    const ownerReport = (by === "lead" || by === "auto") && r.to && r.code !== 3 ? await reportToOwner(deps, key, lane.thread.startsWith("discord:") ? lane.thread.slice("discord:".length) : null, { who: `lane ${key} (${lane.title})`, from: lane.pane, to: r.to, reason: reason ?? "" }, emit) : undefined;
    appendRollover(config.stateDir, {
      kind: "rollover", who: "lane", at, key, from: lane.pane, ...(r.to ? { to: r.to } : {}), ...(facts.approvedBy ? { approvedBy: facts.approvedBy } : {}),
      ...(by ? { decidedBy: by } : {}), ...(reason ? { reason } : {}), ...(ownerReport ? { ownerReport } : {}),
      ...(proposal ? { proposedAt: proposal.at, approvalMin: Math.round((Date.parse(at) - Date.parse(proposal.at)) / 6_000) / 10 } : {}),
      signals: facts.signals, steps, result, reasons: steps.filter((st) => !st.ok).map((st) => st.step), accounts: { from: facts.account ?? "", to: accounts.to ?? "" },
      ...(supplements.length ? { supplementRounds: supplements.length, supplements } : {}),
    });
    return r;
  } finally {
    rmSync(lockFile, { force: true });
  }
};

type Check = { readonly reasons: string[]; readonly session: string; readonly account?: string; readonly supplements?: readonly Supplement[] };

const readText = (file: string): string => (existsSync(file) ? readFileSync(file, "utf8") : "");

const verifyLane = async (deps: LaneHandoverDeps, facts: LaneFacts, pane: string, verifyMin: number, understood: string, emit: (line: string) => void): Promise<Check> => {
  const tries = Math.max(1, Math.ceil((verifyMin * 60_000) / POLL_MS));
  let i = 0;
  let session = "";
  let shown: StatusLine = {};
  let missing = facts.monitors.map((m) => m.description || m.command || m.path || "?");
  const settled = () => shown.model && (!facts.thinking || shown.thinking === facts.thinking) && !missing.length && (session || !facts.monitors.length);
  for (; i < tries; i++) {
    shown = statusLine(await captureTmux(deps.run, pane), facts.model);
    session ||= await deps.sessionOf(pane, facts.cwd).catch(() => "");
    if (session && facts.monitors.length) missing = missingMonitors(facts.monitors, readManifest(manifestPath(deps.config.sessionsDir, facts.cwd, session)), deps.alive, deps.home, deps.clock.now());
    if (settled()) break;
    await deps.clock.sleep(POLL_MS);
  }
  const reasons = [
    ...(!shown.model ? [`the status line of ${pane} does not show ${modelId(facts.model)}`] : []),
    ...(shown.model && facts.thinking && shown.thinking !== facts.thinking ? [`${pane} runs at thinking ${shown.thinking ?? "unknown"}, not ${facts.thinking}`] : []),
    ...(facts.monitors.length && !session ? [`the omo session of ${pane} was not found under ${facts.cwd}, so its monitors could not be checked`] : []),
    ...(session && missing.length ? [`monitors not running in ${pane}: ${missing.join(", ")}`] : []),
  ];
  if (reasons.length) return { reasons, session, ...(shown.account ? { account: shown.account } : {}) };
  emit(`HANDOVER_STATUS_OK ${pane} ${shown.model}${shown.thinking ? ` thinking ${shown.thinking}` : ""}`);
  if (facts.monitors.length) emit(`HANDOVER_MONITORS_OK ${facts.monitors.length} in ${pane} (session ${session})`);
  const id = deps.nonce();
  if (!(await sendVerified(deps.run, deps.clock, deps.config, pane, `[LEAD] ${PROBE} ${id}: write what you understood to ${understood} (${UNDERSTOOD_HEADINGS.map((h) => `## ${h}`).join(", ")}), then run dori handover ack ${id} --state ${deps.config.stateDir} and nothing else for this line.`))) return { reasons: [`the probe did not reach ${pane}`], session };
  emit(`HANDOVER_PROBE_SENT ${id} -> ${pane}`);
  let by: string | undefined;
  for (; i < tries; i++) {
    by = ackedBy(deps.config.stateDir, id);
    if (by !== undefined) break;
    await deps.clock.sleep(POLL_MS);
  }
  if (by === undefined) return { reasons: [`no ack for the probe ${id}`], session };
  if (by !== pane) return { reasons: [`the probe was acked from ${by || "an unknown pane"}, not ${pane}`], session };
  // the new session says what it understood: a gap shows before the old session is gone. A gap is filled in, not rolled
  // back: the left-out items go to it with the old log lines behind them and it restates; only a gap that outlasts the
  // supplement rounds rolls back (it no longer takes in what it is given)
  const key = facts.lane.key;
  const rounds = deps.config.handover.supplementRounds;
  const supplements: Supplement[] = [];
  let text = readText(understood);
  let left = missingFrom(text, facts);
  const fmt = (items: readonly Missing[]) => items.map((it) => `${it.kind}: ${it.text.replace(/\s+/g, " ").slice(0, 80)}`).join("; ");
  for (let round = 1; round <= rounds && left.length; round++) {
    const evidence = left.map((it) => evidenceFor(facts.oldLog, it));
    const sid = deps.nonce();
    const file = understood.replace(/\.understood\.md$/, `.supplement-${round}.md`);
    const ack = `dori handover ack ${sid} --state ${deps.config.stateDir}`;
    writeFileSync(file, renderSupplement(key, round, rounds, left, evidence, understood, ack));
    supplements.push({ round, items: left.map((it) => ({ kind: it.kind, text: it.text })), evidence: evidence.flat().length, file });
    emit(`HANDOVER_SUPPLEMENT ${key} round ${round}/${rounds}: ${left.length} left out (${fmt(left)}); ${file}`);
    if (!(await tell(deps, pane, `[LEAD] HANDOVER_SUPPLEMENT ${sid} (round ${round}/${rounds}): your restatement left out ${left.length} item(s). Read ${file}, add them to ${understood}, then run ${ack} and nothing else for this line.`)))
      return { reasons: [`the supplement ${sid} did not reach ${pane}`], session, supplements };
    let acked: string | undefined;
    for (let j = 0; j < ROUND_TRIES && acked === undefined; j++) {
      await deps.clock.sleep(POLL_MS);
      acked = ackedBy(deps.config.stateDir, sid);
    }
    if (acked !== pane) return { reasons: [acked === undefined ? `no ack for the supplement ${sid}` : `the supplement ${sid} was acked from ${acked || "an unknown pane"}, not ${pane}`], session, supplements };
    text = readText(understood);
    left = missingFrom(text, facts);
  }
  if (left.length) return { reasons: [`the new session's restatement ${understood} still leaves out after ${supplements.length} supplement round(s): ${fmt(left)}`], session, supplements };
  if (supplements.length) emit(`HANDOVER_SUPPLEMENT_OK ${key} after ${supplements.length} round(s)`);
  emit(`HANDOVER_UNDERSTOOD ${understood}`);
  const asks = section(text, "Questions");
  if (asks && !/^none\.?$/i.test(asks)) emit(`HANDOVER_QUESTIONS ${facts.lane.key}: ${asks.replace(/\s+/g, " ").slice(0, 400)} (the lead answers them in the new pane; the old log is ${facts.oldLog ?? "not found"})`);
  return { reasons: [], session, supplements, ...(shown.account ? { account: shown.account } : {}) };
};

// Only once the old session's local chains are gone may the new session restart them: two copies of one chain would run
// the same work twice. A chain that outlives the close (it left the session's process group) is reported, not restarted.
const running = (deps: LaneHandoverDeps, c: Job): boolean => (c.pids ?? [c.pid]).some((pid) => deps.alive(pid));

const chainsEnded = async (deps: LaneHandoverDeps, key: string, chains: readonly Job[], pane: string, emit: (line: string) => void): Promise<void> => {
  let alive = chains.filter((c) => running(deps, c));
  for (let i = 0; i < 6 && alive.length; i++) {
    await deps.clock.sleep(POLL_MS);
    alive = alive.filter((c) => running(deps, c));
  }
  const ended = chains.filter((c) => !alive.includes(c));
  if (ended.length) {
    await tell(deps, pane, `[LEAD] HANDOVER_CHAINS_ENDED: the old session is closed and its local chains ended (${ended.map((c) => `${c.pid} ${c.cmd.slice(0, 60)}`).join("; ")}). Restart only what is still needed, from its checkpoint or progress files, and skip steps that already finished.`);
    emit(`HANDOVER_CHAINS_ENDED ${key} ${ended.map((c) => c.pid).join(",")}; the new session may restart them`);
  }
  if (alive.length) {
    await tell(deps, pane, `[LEAD] HANDOVER_CHAIN_SURVIVED: these local chains of the old session still run after it closed: ${alive.map((c) => `${c.pid} ${c.cmd.slice(0, 60)}`).join("; ")}. Do not start them again; watch them instead.`);
    emit(`HANDOVER_CHAIN_SURVIVED ${key} ${alive.map((c) => c.pid).join(",")}; the new session was told not to restart them`);
  }
};

type MoveContext = { readonly note: string; readonly title: string; readonly emit: (line: string) => void; readonly steps: Step[]; readonly mark: (step: string, ok: boolean) => void; readonly accounts: { to?: string }; readonly supplements: Supplement[] };

const tell = (deps: LaneHandoverDeps, pane: string, text: string) => sendVerified(deps.run, deps.clock, deps.config, pane, text).catch(() => false);

// The registry entry and the open question cards of the lane follow its pane.
const pointLane = async (deps: LaneHandoverDeps, key: string, from: string, to: string, why: string, emit: (line: string) => void): Promise<void> => {
  const fresh = await deps.registry.read(key);
  if (fresh && fresh.pane !== to) await deps.registry.write({ ...fresh, pane: to, history: [...(fresh.history ?? []), { at: iso(deps.clock), status: statusOf(fresh), note: why }] });
  const cards = new QuestionStore(deps.cardDir).retarget({ tmux: from }, { tmux: to });
  emit(`HANDOVER_LANE ${key} pane -> ${to}; cards ${cards.length ? cards.join(",") : "none"}`);
};

// Repairs what an interrupted run left: while the old session lives it stays the lane and the new one is closed; when
// only the new one lives (the old was already closed) the lane stays on the new one.
export const recover = async (deps: LaneHandoverDeps, p: Pending, emit: (line: string) => void): Promise<void> => {
  const sessions = await aoeSessions(deps.run);
  const oldAlive = !!sessionFor(sessions, p.from);
  const newAlive = !!sessionFor(sessions, p.to);
  if (oldAlive) {
    if (p.agentPid) deps.signal(p.agentPid, "SIGCONT");
    await pointLane(deps, p.key, p.to, p.from, `pane back to ${p.from}: interrupted handover repaired`, emit);
    const closed = newAlive ? await closeAoeSession(deps.run, p.to) : `${p.to} already gone`;
    await tell(deps, p.from, `[LEAD] The handover of ${p.key} was stopped before it finished. You stay the ${p.key} lane: carry on where you were.`);
    emit(`HANDOVER_RECOVERED ${p.key} back on ${p.from}; new session: ${closed}`);
  } else if (newAlive) {
    await pointLane(deps, p.key, p.from, p.to, `pane kept on ${p.to}: interrupted handover repaired, the old session is gone`, emit);
    await tell(deps, p.to, `[LEAD] ${COMMITTED}: the handover was interrupted after the old session ${p.from} closed; you are the ${p.key} lane now. ${deps.config.launchKeywords}: go on with step 5 of the note ${p.note}.`);
    emit(`HANDOVER_RECOVERED ${p.key} kept on ${p.to}: the old session ${p.from} is gone`);
    if (p.chains?.length) await chainsEnded(deps, p.key, p.chains, p.to, emit);
  } else {
    emit(`HANDOVER_RECOVERED ${p.key}: neither ${p.from} nor ${p.to} is alive (a reboot?); the registry is left as it is, dori sync and dead-panes show the lane`);
  }
  rmSync(pendingFile(deps.config.stateDir, p.key), { force: true });
  clearQuiet(deps.config.stateDir, p.from);
};

const moveLane = async (deps: LaneHandoverDeps, opts: LaneHandoverOptions, facts: LaneFacts, ctx: MoveContext): Promise<LaneHandoverResult> => {
  const { config } = deps;
  const { note, title, emit } = ctx;
  const { lane, from } = facts;
  let pane: string;
  try {
    pane = await openAoeSession(deps.run, deps.clock, { title, cwd: facts.cwd, tool: config.agentCommand[0] ?? "omo", model: facts.model, ...(facts.thinking ? { thinking: facts.thinking } : {}), env: laneEnv(config.launchEnv, lane.useGpu) });
    ctx.mark("open", true);
  } catch (e) {
    ctx.mark("open", false);
    emit(`HANDOVER_FAIL ${lane.key}: could not open the new session: ${e instanceof Error ? e.message : String(e)}; nothing moved, ${from.pane} stays the lane`);
    return { code: 3, note };
  }
  const pending: Pending = { key: lane.key, pid: process.pid, at: iso(deps.clock), from: from.pane, to: pane, note, chains: facts.chains, ...(facts.agentPid ? { agentPid: facts.agentPid } : {}) };
  writeFileSync(pendingFile(config.stateDir, lane.key), JSON.stringify(pending, null, 1));
  // the old pane stays quiet when it is still open after a finished move (--keep-old, or the close failed); the mark expires
  let keepQuiet = false;
  try {
    const r = await finishMove(deps, opts, facts, ctx, pane);
    keepQuiet = r.code === 1 || (r.code === 0 && !!opts.keepOld);
    return r;
  } catch (e) {
    ctx.mark("error", false);
    emit(`HANDOVER_FAIL ${lane.key}: ${e instanceof Error ? e.message : String(e)}; repairing`);
    await recover(deps, pending, emit);
    return { code: 3, note, to: pane };
  } finally {
    rmSync(pendingFile(config.stateDir, lane.key), { force: true });
    if (!keepQuiet) clearQuiet(config.stateDir, from.pane);
  }
};

const finishMove = async (deps: LaneHandoverDeps, opts: LaneHandoverOptions, facts: LaneFacts, ctx: MoveContext, pane: string): Promise<LaneHandoverResult> => {
  const { config } = deps;
  const { note, emit, mark } = ctx;
  const { lane, from } = facts;
  const record = (result: string, reasons: readonly string[]) =>
    writeFileSync(note.replace(/\.md$/, ".result.json"), JSON.stringify({ at: iso(deps.clock), key: lane.key, from, to: pane, note, approvedBy: facts.approvedBy, signals: facts.signals, result, reasons }, null, 1));
  let frozen = false;
  const thaw = (): void => {
    if (frozen && facts.agentPid) emit(deps.signal(facts.agentPid, "SIGCONT") ? `HANDOVER_THAWED ${lane.key} agent ${facts.agentPid}` : `HANDOVER_THAW_FAIL ${lane.key} agent ${facts.agentPid}`);
    frozen = false;
  };
  const discard = async (why: string): Promise<LaneHandoverResult> => {
    thaw();
    const closed = await closeAoeSession(deps.run, pane);
    await tell(deps, from.pane, `[LEAD] Handover of ${lane.key} failed (${why}). You stay the ${lane.key} lane: carry on where you were.`);
    emit(`HANDOVER_ROLLED_BACK ${lane.key}: ${from.pane} stays the lane; new session ${pane}: ${closed}`);
    record("rolled-back", [why]);
    return { code: 3, note, to: pane };
  };
  const startup = await awaitPrompt(deps, pane);
  mark("startup", !startup);
  if (startup) {
    emit(`HANDOVER_FAIL ${lane.key}: new session ${pane}: ${startup}`);
    return discard(`the new session did not start: ${startup}`);
  }
  const off = await envMismatch(deps.run, pane, laneEnv(config.launchEnv, lane.useGpu));
  if (off.length) {
    emit(`HANDOVER_FAIL ${lane.key}: new session ${pane} lacks launchEnv: ${off.join(", ")}`);
    return discard(`the new session did not get launchEnv: ${off.join(", ")}`);
  }
  setQuiet(config.stateDir, from.pane, deps.clock.now() + ((opts.verifyMin ?? config.handover.verifyMin) + 10) * 60_000, `the handover of ${lane.key} to ${pane} is running`);
  await tell(deps, from.pane, `[LEAD] Handover of ${lane.key} to ${pane} started (note ${note}). Stop here: start no new tool call, leave running processes alone, and ignore ${PROBE} lines. If it fails you are told and stay the lane.`);
  // frozen, the old agent cannot answer, report or start a second copy of the work while both sessions live
  if (facts.agentPid) {
    frozen = deps.signal(facts.agentPid, "SIGSTOP");
    emit(frozen ? `HANDOVER_FROZEN ${lane.key} agent ${facts.agentPid} in ${from.pane}` : `HANDOVER_FREEZE_FAIL ${lane.key} agent ${facts.agentPid}: it stays told and quiet only`);
  }
  // no work keyword here: the new session only arms monitors and answers the probe until it is committed
  const first = await sendVerified(deps.run, deps.clock, config, pane, `You are the ${lane.key} lane in a new session; the old session hands its work over to you. Read the handover note at ${note} in full and do steps 1 to 4 of its first section; start the work only when a [LEAD] ${COMMITTED} line tells you to.`);
  mark("first-message", first);
  if (!first) {
    emit(`HANDOVER_FAIL ${lane.key}: the first message did not register in ${pane}`);
    return discard("the first message did not register in the new session");
  }
  await pointLane(deps, lane.key, from.pane, pane, `pane moved ${from.pane} -> ${pane} (dori handover --lane; approved by ${facts.approvedBy ?? "-"})`, emit);
  emit(`HANDOVER_STARTED ${lane.key} ${from.pane} -> ${pane}`);
  const checked = await verifyLane(deps, facts, pane, opts.verifyMin ?? config.handover.verifyMin, note.replace(/\.md$/, ".understood.md"), emit);
  ctx.supplements.push(...(checked.supplements ?? []));
  mark("verify", !checked.reasons.length);
  if (checked.reasons.length && !sessionFor(await aoeSessions(deps.run), from.pane)) {
    // nothing to go back to: the old session ended during the checks, so the new one stays the lane
    emit(`HANDOVER_OLD_GONE ${lane.key}: ${from.pane} ended during the checks (${checked.reasons.join("; ")}); the lane stays on ${pane}`);
    await tell(deps, pane, `[LEAD] ${COMMITTED}: the old session ended during the checks, so you are the ${lane.key} lane now although a check failed (${checked.reasons.join("; ")}); tell the lead what you see. ${config.launchKeywords}: go on with step 5 of the note.`);
    record("kept-new-old-gone", checked.reasons);
    if (facts.chains.length) await chainsEnded(deps, lane.key, facts.chains, pane, emit);
    return { code: 1, note, to: pane };
  }
  if (checked.reasons.length) {
    emit(`HANDOVER_VERIFY_FAIL ${lane.key} ${pane}: ${checked.reasons.join("; ")}`);
    await pointLane(deps, lane.key, pane, from.pane, `pane moved back to ${from.pane}: handover check failed`, emit);
    return discard(checked.reasons.join("; "));
  }
  if (facts.account && checked.account && facts.account !== checked.account) emit(`HANDOVER_ACCOUNT ${lane.key} ${facts.account} -> ${checked.account} (the account pool chose it for the new session)`);
  ctx.accounts.to = checked.account;
  await deps.registry.patch(lane.key, { session: checked.session, sessionVia: "handover" });
  rmSync(readyFile(config.stateDir, lane.key), { force: true });
  if (opts.keepOld) {
    thaw();
    await tell(deps, from.pane, `[LEAD] Handover of ${lane.key} to ${pane} is done and checked. You are no longer the lane; stay idle until the lead closes you.`);
    await tell(deps, pane, `[LEAD] ${COMMITTED}: the handover is checked and the old session ${from.pane} stays open but idle; you are the ${lane.key} lane now. ${config.launchKeywords}: go on with step 5 of the note.`);
    if (facts.chains.length) await tell(deps, pane, `[LEAD] HANDOVER_CHAINS_KEPT: the old session ${from.pane} stays open, so its local chains (${facts.chains.map((c) => c.pid).join(", ")}) still run. Do not start them again.`);
    emit(`HANDOVER_DONE ${lane.key} ${from.pane} -> ${pane}; old session kept (--keep-old)`);
    record("done-kept-old", []);
    return { code: 0, note, to: pane };
  }
  emit(`HANDOVER_DONE ${lane.key} ${from.pane} -> ${pane}; closing ${from.pane}`);
  record("done", []);
  // resumed only to be closed: a stopped process does not act on the hangup
  thaw();
  const closed = await closeAoeSession(deps.run, from.pane);
  const ok = closed.includes("stopped and trashed");
  mark("close", ok);
  emit(ok ? `HANDOVER_CLOSED ${closed}` : `HANDOVER_CLOSE_FAIL ${closed}`);
  await tell(deps, pane, `[LEAD] ${COMMITTED}: the handover is checked and the old session ${ok ? "is closed" : `${from.pane} did not close but stays idle`}; you are the ${lane.key} lane now. ${config.launchKeywords}: go on with step 5 of the note.`);
  emit(`${COMMITTED} ${lane.key} ${pane}`);
  if (facts.chains.length) await chainsEnded(deps, lane.key, facts.chains, pane, emit);
  if (facts.detached.length) emit(`HANDOVER_DETACHED_ALIVE ${facts.detached.filter((d) => deps.alive(d.pid)).length}/${facts.detached.length} (${facts.detached.map((d) => d.pid).join(",")})`);
  return { code: ok ? 0 : 1, note, to: pane };
};

// The length signals of the session in any pane (a lane's or the lead's): context use from its status line, compactions
// and age from its session log.
export const paneSignals = async (deps: LaneHandoverDeps, pane: string, model: string): Promise<Signals> => {
  const s = sessionFor(await aoeSessions(deps.run), pane);
  const shown = statusLine(await captureTmux(deps.run, pane), model);
  const session = s ? await deps.sessionOf(pane, s.path).catch(() => "") : "";
  return { ...(shown.contextPct !== undefined ? { contextPct: shown.contextPct } : {}), ...(s ? sessionSignals(sessionDirFor(deps.config.sessionsDir, s.path), session, deps.clock.now()) : {}) };
};
