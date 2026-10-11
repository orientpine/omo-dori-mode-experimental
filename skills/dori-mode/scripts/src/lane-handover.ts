// dori handover --lane <key>: move a lane whose conversation grew long to a new agent session.
// Order: refuse while work would die with the old session (a local chain, a running turn, an open question) unless the
// lane marked a safe point (dori handover ready) -> write the note -> open the new session in the same real path with the
// lane's model and thinking level -> point the registry and the question cards at it -> check its status line, its
// monitors and a [LEAD] probe ack -> only then close the old session. A failed check moves everything back and closes
// the new session; the old one stays the lane. Detached jobs (outside the pane's process tree) are listed, never touched.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { aoeSessions, BUSY_MARK, captureTmux, closeAoeSession, inputLine, openAoeSession, QUESTION_MARK, sessionFor, tmuxPanePid } from "./aoe.ts";
import type { FlowDeps } from "./done-flow.ts";
import { ackFile, liveMonitors, manifestPath, type MonitorSpec, missingMonitors, openGoal, openTodos, PROBE, readManifest, takeLock } from "./handover.ts";
import { awaitPrompt } from "./launch.ts";
import { QuestionStore } from "./messenger/discord-cards.ts";
import { sendVerified } from "./panes.ts";
import { type Lane, statusOf } from "./registry.ts";
import { iso } from "./run.ts";
import { AGENT, descendants, type Proc, sessionDirFor } from "./session-id.ts";
import { appendRollover, approvalProblem, clearQuiet, COMMITTED, lastProposal, readRollovers, repeatsOf, type Signals, sessionSignals, setQuiet, type Step } from "./rollover.ts";
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
  // the path with symlinks resolved (the path itself when it cannot be resolved)
  readonly realpath: (path: string) => string;
  readonly nonce: () => string;
  readonly print: (line: string) => void;
};

export type LaneHandoverOptions = {
  // the owner's approval: an answered card Qn, a message link or their words (rollover.ts approvalProblem); --dry-run needs none
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
};

// Written once the new session exists and removed when the run ends either way: a run killed in between (crash, reboot,
// SIGKILL) leaves it behind, and the next dori handover --lane for that lane repairs the state from it first.
export type Pending = { readonly key: string; readonly pid: number; readonly at: string; readonly from: string; readonly to: string; readonly note: string; readonly chains?: readonly Job[] };

const POLL_MS = 5_000;
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
  const chains = table
    .filter((p) => p.ppid === agent.pid && !INFRA.test(p.cmd) && !monitorPids.includes(p.pid) && !exclude.has(p.pid))
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
  if (noteFile && !existsSync(noteFile)) return { code: 2, line: `HANDOVER_READY_REFUSED ${lane.key}: note file not found: ${noteFile}` };
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
  `2. A [LEAD] line with ${PROBE} <id> is a check of this handover: run the dori handover ack command it gives (with its --state) and nothing else for that line.`,
  `3. Read your brief ${f.lane.brief} in full. It still holds: same Done, same footer, and reports still go to the lead.`,
  `4. Until a [LEAD] ${COMMITTED} line arrives, do nothing else: change no file, start no process, post nothing. Until then the handover can still roll back and close this session.`,
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
  "## The lane's notes",
  f.laneNote.trim() || "(none: the old session can leave notes with dori handover ready --note FILE, the lead with --note FILE)",
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
  const unapproved = opts.dryRun ? undefined : approvalProblem(opts.approvedBy, (id) => new QuestionStore(deps.cardDir).get(id), config.handover.autoRolloverLanes, key, lane.pane ?? "", readRollovers(config.stateDir));
  if (unapproved) return refuse(`a lane moves to a new session only with the owner's approval: ${unapproved} (--dry-run needs none)`);
  const old = sessionFor(await aoeSessions(deps.run), lane.pane);
  if (!old) return refuse(`no live aoe session for pane ${lane.pane}`);
  const { session, entries, pids: monitorPids } = await monitorPidsOf(deps, lane.pane, old.path);
  const now = deps.clock.now();
  const monitors = liveMonitors(entries, now, deps.alive);
  const table = await deps.procs();
  const shell = await tmuxPanePid(deps.run, lane.pane);
  const { agent, chains, tree } = localChains(table, shell, monitorPids);
  if (!agent) return refuse(`no omo agent process under pane ${lane.pane} (shell pid ${shell || "?"})`);
  const detached = detachedJobs(table, tree, session, old.id, deps.envOf);
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
    ...(!ready && screen.includes(BUSY_MARK) ? ["a turn is running (esc to interrupt on screen)"] : []),
    ...(!ready && QUESTION_MARK.test(screen) ? ["a question is open in the pane"] : []),
  ];
  const blocked = blockers.length > 0 && !opts.force;
  const blockedWhy = `${blockers.join("; ")}. Ask the lane to reach a safe point and run dori handover ready ${key} [--note FILE] in its own pane, or pass --force`;
  // a dry run still writes the note, so a rollover proposal can show it with what blocks the move
  if (blocked && !opts.dryRun) return refuse(blockedWhy);
  if (blocked) emit(`HANDOVER_REFUSED ${key}: ${blockedWhy}`);
  else if (blockers.length) emit(`HANDOVER_FORCED ${key}: ${blockers.join("; ")}`);
  const real = deps.realpath(old.path);
  if (real !== old.path) emit(`HANDOVER_CWD_SYMLINK ${key}: the lane runs from ${old.path}, a symlink to ${real}; the new session opens in ${real}`);
  const sessionDir = sessionDirFor(config.sessionsDir, old.path);
  const repeats = repeatsOf(lane);
  const signals: Signals = { ...(shown.contextPct !== undefined ? { contextPct: shown.contextPct } : {}), ...sessionSignals(sessionDir, session, now), ...(repeats ? { repeats } : {}) };
  const laneNote = [ready?.note ?? "", opts.note ? readFileSync(opts.note, "utf8") : ""].filter((t) => t.trim()).join("\n\n");
  const facts: LaneFacts = {
    lane, from: { pane: lane.pane, aoeId: old.id, session, title: old.title, cwd: old.path }, cwd: real, model: splitModel(model).base, thinking, ...(shown.contextPct !== undefined ? { contextPct: shown.contextPct } : {}), ...(shown.account ? { account: shown.account } : {}),
    monitors, todos: session ? openTodos(sessionDir, session) : [], goal: session ? openGoal(sessionDir, session) : undefined, chains, detached, ...(ready ? { ready } : {}), laneNote, signals, ...(opts.approvedBy?.trim() ? { approvedBy: opts.approvedBy.trim() } : {}),
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
    const r = await moveLane(deps, opts, facts, { note, title, emit, steps, mark, accounts });
    const proposal = lastProposal(readRollovers(config.stateDir), key);
    const result = r.code === 0 ? (opts.keepOld ? "done-kept-old" : "done") : r.code === 1 ? "done-close-failed" : "rolled-back";
    appendRollover(config.stateDir, {
      kind: "rollover", who: "lane", at, key, from: lane.pane, ...(r.to ? { to: r.to } : {}), ...(facts.approvedBy ? { approvedBy: facts.approvedBy } : {}),
      ...(proposal ? { proposedAt: proposal.at, approvalMin: Math.round((Date.parse(at) - Date.parse(proposal.at)) / 6_000) / 10 } : {}),
      signals: facts.signals, steps, result, reasons: steps.filter((st) => !st.ok).map((st) => st.step), accounts: { from: facts.account ?? "", to: accounts.to ?? "" },
    });
    return r;
  } finally {
    rmSync(lockFile, { force: true });
  }
};

type Check = { readonly reasons: string[]; readonly session: string; readonly account?: string };

const verifyLane = async (deps: LaneHandoverDeps, facts: LaneFacts, pane: string, verifyMin: number, emit: (line: string) => void): Promise<Check> => {
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
  if (!(await sendVerified(deps.run, deps.clock, deps.config, pane, `[LEAD] ${PROBE} ${id}: run dori handover ack ${id} --state ${deps.config.stateDir} and nothing else for this line.`))) return { reasons: [`the probe did not reach ${pane}`], session };
  emit(`HANDOVER_PROBE_SENT ${id} -> ${pane}`);
  let by: string | undefined;
  for (; i < tries; i++) {
    by = ackedBy(deps.config.stateDir, id);
    if (by !== undefined) break;
    await deps.clock.sleep(POLL_MS);
  }
  if (by === undefined) return { reasons: [`no ack for the probe ${id}`], session };
  if (by !== pane) return { reasons: [`the probe was acked from ${by || "an unknown pane"}, not ${pane}`], session };
  return { reasons: [], session, ...(shown.account ? { account: shown.account } : {}) };
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

type MoveContext = { readonly note: string; readonly title: string; readonly emit: (line: string) => void; readonly steps: Step[]; readonly mark: (step: string, ok: boolean) => void; readonly accounts: { to?: string } };

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
    await pointLane(deps, p.key, p.to, p.from, `pane back to ${p.from}: interrupted handover repaired`, emit);
    const closed = newAlive ? await closeAoeSession(deps.run, p.to) : `${p.to} already gone`;
    await tell(deps, p.from, `[LEAD] The handover of ${p.key} was stopped before it finished. You stay the ${p.key} lane: carry on where you were.`);
    emit(`HANDOVER_RECOVERED ${p.key} back on ${p.from}; new session: ${closed}`);
  } else if (newAlive) {
    await pointLane(deps, p.key, p.from, p.to, `pane kept on ${p.to}: interrupted handover repaired, the old session is gone`, emit);
    await tell(deps, p.to, `[LEAD] ${COMMITTED}: the handover was interrupted after the old session ${p.from} closed; you are the ${p.key} lane now. Go on with step 5 of the note ${p.note}.`);
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
    pane = await openAoeSession(deps.run, deps.clock, { title, cwd: facts.cwd, tool: config.agentCommand[0] ?? "omo", model: facts.model, ...(facts.thinking ? { thinking: facts.thinking } : {}) });
    ctx.mark("open", true);
  } catch (e) {
    ctx.mark("open", false);
    emit(`HANDOVER_FAIL ${lane.key}: could not open the new session: ${e instanceof Error ? e.message : String(e)}; nothing moved, ${from.pane} stays the lane`);
    return { code: 3, note };
  }
  const pending: Pending = { key: lane.key, pid: process.pid, at: iso(deps.clock), from: from.pane, to: pane, note, chains: facts.chains };
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
  const discard = async (why: string): Promise<LaneHandoverResult> => {
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
  setQuiet(config.stateDir, from.pane, deps.clock.now() + ((opts.verifyMin ?? config.handover.verifyMin) + 10) * 60_000, `the handover of ${lane.key} to ${pane} is running`);
  await tell(deps, from.pane, `[LEAD] Handover of ${lane.key} to ${pane} started (note ${note}). Stop here: start no new tool call, leave running processes alone, and ignore ${PROBE} lines. If it fails you are told and stay the lane.`);
  const first = await sendVerified(deps.run, deps.clock, config, pane, `${config.launchKeywords}. You are the ${lane.key} lane in a new session; the old session hands its work over to you. Read the handover note at ${note} in full and do what it says, starting with its first section.`);
  mark("first-message", first);
  if (!first) {
    emit(`HANDOVER_FAIL ${lane.key}: the first message did not register in ${pane}`);
    return discard("the first message did not register in the new session");
  }
  await pointLane(deps, lane.key, from.pane, pane, `pane moved ${from.pane} -> ${pane} (dori handover --lane; approved by ${facts.approvedBy ?? "-"})`, emit);
  emit(`HANDOVER_STARTED ${lane.key} ${from.pane} -> ${pane}`);
  const checked = await verifyLane(deps, facts, pane, opts.verifyMin ?? config.handover.verifyMin, emit);
  mark("verify", !checked.reasons.length);
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
    await tell(deps, from.pane, `[LEAD] Handover of ${lane.key} to ${pane} is done and checked. You are no longer the lane; stay idle until the lead closes you.`);
    await tell(deps, pane, `[LEAD] ${COMMITTED}: the handover is checked and the old session ${from.pane} stays open but idle; you are the ${lane.key} lane now. Go on with step 5 of the note.`);
    if (facts.chains.length) await tell(deps, pane, `[LEAD] HANDOVER_CHAINS_KEPT: the old session ${from.pane} stays open, so its local chains (${facts.chains.map((c) => c.pid).join(", ")}) still run. Do not start them again.`);
    emit(`HANDOVER_DONE ${lane.key} ${from.pane} -> ${pane}; old session kept (--keep-old)`);
    record("done-kept-old", []);
    return { code: 0, note, to: pane };
  }
  emit(`HANDOVER_DONE ${lane.key} ${from.pane} -> ${pane}; closing ${from.pane}`);
  record("done", []);
  const closed = await closeAoeSession(deps.run, from.pane);
  const ok = closed.includes("stopped and trashed");
  mark("close", ok);
  emit(ok ? `HANDOVER_CLOSED ${closed}` : `HANDOVER_CLOSE_FAIL ${closed}`);
  await tell(deps, pane, `[LEAD] ${COMMITTED}: the handover is checked and the old session ${ok ? "is closed" : `${from.pane} did not close but stays idle`}; you are the ${lane.key} lane now. Go on with step 5 of the note.`);
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
