// dori handover: move the lead to a new agent session without losing work, monitors or notifications.
// Order: write the note -> open the new session -> point leadPane, lanes and cards at it -> check that its monitors run and
// that a [REPORT] and an inbox event reach it -> only then close the old session. A failed check moves everything back.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { aoeSessions, captureTmux, closeAoeSession, inputLine, laneEnv, openAoeSession, sessionFor } from "./aoe.ts";
import type { HandoverWatcher } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { awaitPrompt } from "./launch.ts";
import { type Question, QuestionStore } from "./messenger/discord-cards.ts";
import { sendVerified } from "./panes.ts";
import { type Lane, statusOf } from "./registry.ts";
import { iso } from "./run.ts";
import { sessionDirFor } from "./session-id.ts";
import { appendRollover, approvalProblem, clearQuiet, COMMITTED, decidedBy, LEAD_PREFIX, lastProposal, readRollovers, reportToOwner, type Signals, sessionSignals, setQuiet, type Step } from "./rollover.ts";
import { watchLog } from "./watch-log.ts";

export type HandoverDeps = FlowDeps & {
  readonly configPath: string;
  readonly envPath: string;
  readonly cardDir: string;
  readonly inbox: string;
  readonly home: string;
  // the omo session id of the agent running in a pane ("" when it cannot be told)
  readonly sessionOf: (pane: string, cwd: string) => Promise<string>;
  // leadPane as a freshly started dori process reads it (config file plus DORI_LEAD_PANE)
  readonly routedPane: () => Promise<string>;
  // DORI_LEAD_PANE as this process got it: it overrides the config file, so a handover cannot move it
  readonly envLeadPane: string;
  readonly alive: (pid: number) => boolean;
  // the path with symlinks resolved (the path itself when it cannot be resolved)
  readonly realpath: (path: string) => string;
  readonly timers: () => Promise<string[]>;
  // restart a user unit; a reason when it failed
  readonly restart: (unit: string) => Promise<string | undefined>;
  readonly nonce: () => string;
  readonly print: (line: string) => void;
  // posts the owner's after-the-fact note of a rollover the lead decided and returns its message id (rollover.ts reportToOwner)
  readonly reportOwner?: (thread: string | null, text: string) => Promise<string>;
};

export type HandoverOptions = {
  // the approval: lead:<reason and signal>, the owner's answered card Qn, a message link or their words (rollover.ts approvalProblem); --dry-run needs none
  readonly approvedBy?: string;
  readonly title?: string;
  readonly model?: string;
  readonly note?: string;
  readonly keepOld?: boolean;
  readonly dryRun?: boolean;
  readonly noMonitors?: boolean;
  readonly verifyMin?: number;
};

export type MonitorSpec = { readonly description: string; readonly command?: string; readonly filter?: string; readonly path?: string; readonly event?: string; readonly persistent: boolean };

type ManifestEntry = {
  readonly description?: string;
  readonly command?: string;
  readonly filter?: string;
  readonly path?: string;
  readonly event?: string;
  readonly persistent?: boolean;
  readonly suspended?: boolean;
  // omo writes null for a monitor that is not persistent: it has no expiry
  readonly expiresAt?: number | null;
  readonly runtime?: { readonly pid?: number };
};

type Target = { readonly pane: string; readonly aoeId: string; readonly session: string };

export type HandoverFacts = {
  readonly from: Target & { readonly title: string; readonly cwd: string };
  // where the new session opens: handover.cwd, else the old lead's path with symlinks resolved
  readonly cwd: string;
  readonly lanes: readonly Lane[];
  readonly monitors: readonly MonitorSpec[];
  readonly watchers: readonly HandoverWatcher[];
  readonly cards: readonly Question[];
  readonly todos: readonly string[];
  readonly goal?: string;
  readonly timers: readonly string[];
  readonly leadNote: string;
};

const POLL_MS = 5_000;
export const PROBE = "HANDOVER_PROBE";

// omo keeps each session's monitors in <session dir>/extensions/terminal/<session id>.json
export const manifestPath = (sessionsDir: string, cwd: string, session: string): string => join(sessionDirFor(sessionsDir, cwd), "extensions", "terminal", `${session}.json`);

export const readManifest = (file: string): ManifestEntry[] => {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { monitors?: ManifestEntry[] };
    return Array.isArray(parsed.monitors) ? parsed.monitors : [];
  } catch {
    return [];
  }
};

const spec = (e: ManifestEntry): MonitorSpec => ({
  description: e.description ?? "",
  ...(e.command ? { command: e.command } : {}),
  ...(e.filter ? { filter: e.filter } : {}),
  ...(e.path ? { path: e.path } : {}),
  ...(e.event ? { event: e.event } : {}),
  persistent: !!e.persistent,
});

const running = (e: ManifestEntry, now: number): boolean => !e.suspended && (e.expiresAt == null || e.expiresAt > now) && !!(e.command || e.path);

// Every watch the old session still runs, persistent or not: the new session must run each one. A command monitor whose
// recorded process is gone has ended and is left out.
export const liveMonitors = (entries: readonly ManifestEntry[], now: number, alive: (pid: number) => boolean): MonitorSpec[] =>
  entries.filter((e) => running(e, now) && (!!e.path || e.runtime?.pid === undefined || alive(e.runtime.pid))).map(spec);

const fillTarget = (argv: readonly string[], target: { readonly pane: string; readonly session: string }): string[] =>
  argv.map((a) => a.replaceAll("{pane}", target.pane).replaceAll("{session}", target.session));

// A configured watcher runs when its check command exits 0; the names (with the failed command) of those that do not.
export const missingWatchers = async (deps: Pick<HandoverDeps, "run">, watchers: readonly HandoverWatcher[], target: { readonly pane: string; readonly session: string }): Promise<string[]> => {
  const out: string[] = [];
  for (const w of watchers) {
    const argv = fillTarget(w.check, target);
    const r = await deps.run(argv);
    if (r.code !== 0) out.push(`${w.name} (${JSON.stringify(argv)} exit ${r.code}${r.err.trim() ? `: ${r.err.trim().slice(0, 120)}` : ""})`);
  }
  return out;
};

const norm = (text: string, home: string): string => text.replace(/(^|[\s=:'"])~\//g, `$1${home}/`).replace(/\s+/g, " ").trim();

// A monitor counts as re-armed when the new session runs a persistent watch with the same command (or path, or
// description), whose process is alive.
export const missingMonitors = (wanted: readonly MonitorSpec[], entries: readonly ManifestEntry[], alive: (pid: number) => boolean, home: string, now: number): string[] => {
  const live = entries.filter((e) => e.persistent && running(e, now) && (e.path || (e.runtime?.pid !== undefined && alive(e.runtime.pid))));
  return wanted
    .filter((m) => !live.some((e) =>
      // the same watch, not just the same name: the command (and its filter) or the path; the description only for a monitor that has neither
      m.command ? !!e.command && norm(m.command, home) === norm(e.command, home) && (!m.filter || e.filter === m.filter)
        : m.path ? !!e.path && norm(m.path, home) === norm(e.path, home)
        : !!m.description && e.description === m.description))
    .map((m) => m.description || m.command || m.path || "?");
};

const sessionFile = (dir: string, session: string): string | undefined => {
  try {
    const name = readdirSync(dir).find((n) => n.endsWith(`_${session}.jsonl`));
    return name ? join(dir, name) : undefined;
  } catch {
    return undefined;
  }
};

export const openTodos = (sessionDir: string, session: string): string[] => {
  const file = sessionFile(sessionDir, session);
  if (!file) return [];
  const last = readFileSync(file, "utf8").split("\n").findLast((l) => l.includes('"senpi.todo-state"'));
  if (!last) return [];
  try {
    const data = (JSON.parse(last) as { data?: { phases?: { name?: string; tasks?: { content?: string; status?: string }[] }[] } }).data;
    return (data?.phases ?? []).flatMap((p) => (p.tasks ?? []).filter((t) => t.status !== "completed" && t.status !== "abandoned").map((t) => `${p.name ?? "-"}: ${t.content ?? ""} (${t.status ?? "pending"})`));
  } catch {
    return [];
  }
};

export const openGoal = (sessionDir: string, session: string): string | undefined => {
  try {
    const goal = (JSON.parse(readFileSync(join(sessionDir, "extensions", "goal", `${session}.json`), "utf8")) as { goal?: { objective?: string; status?: string } }).goal;
    return goal?.objective && goal.status !== "complete" ? `${goal.objective} (${goal.status ?? "active"})` : undefined;
  } catch {
    return undefined;
  }
};

const cell = (text: string): string => text.replace(/\s*\|\s*/g, " / ").replace(/\s*[\r\n]+\s*/g, " ").slice(0, 160);
const monitorLine = (m: MonitorSpec): string =>
  `- ${m.description || "(no description)"}: ${m.command ? `command ${JSON.stringify(m.command)}${m.filter ? ` filter ${JSON.stringify(m.filter)}` : ""}` : `path ${JSON.stringify(m.path)}${m.event ? ` event ${m.event}` : ""}`}${m.persistent ? "" : " (was not persistent in the old session; arm it as persistent)"}`;
const watcherLine = (w: HandoverWatcher): string => `- ${w.name}: check ${JSON.stringify(w.check)}${w.arm ? `; to start it: ${w.arm}` : "; runs outside omo, nothing to arm"}`;

export const renderNote = (f: HandoverFacts, at: string): string => [
  `# Dori handover ${at}`,
  "",
  `From ${f.from.pane} (aoe ${f.from.aoeId}, omo session ${f.from.session || "unknown"}, cwd ${f.from.cwd}). You are the new lead session${f.cwd === f.from.cwd ? "" : `, opened in ${f.cwd}`}: dori handover points leadPane, the open lanes and the open question cards at you.`,
  "",
  "## Do this first",
  "1. Arm every monitor under Monitors again as a persistent monitor, with the same command and filter. Arm each one once. Start each watcher under Watchers that says how. The handover checks that the monitors run in this session and runs each watcher's check.",
  `2. A line with ${PROBE} <id>, typed into this session or arriving as an inbox event, is a check of this handover: run the dori handover ack command the line gives (with its --state) and nothing else.`,
  `3. Read the rest, but until a [LEAD] ${COMMITTED} line arrives answer no one, act on no event and change nothing: the handover can still roll back. The old session stays quiet meanwhile and is closed once the checks pass.`,
  `4. After ${COMMITTED}, carry on: open lanes, owner questions, todos, timers and the old lead's notes.`,
  "",
  `## Monitors (${f.monitors.length})`,
  ...(f.monitors.length ? f.monitors.map(monitorLine) : ["none"]),
  "",
  `## Watchers (${f.watchers.length}, from handover.watchers)`,
  ...(f.watchers.length ? f.watchers.map(watcherLine) : ["none"]),
  "",
  `## Open lanes (${f.lanes.length})`,
  ...(f.lanes.length
    ? ["| key | status | pane | thread | last report |", "|---|---|---|---|---|", ...f.lanes.map((l) => `| ${l.key} | ${statusOf(l)} | ${l.pane ?? "-"} | ${l.thread} | ${cell(l.lastReport ?? "-")} |`)]
    : ["none"]),
  "",
  `## Open owner questions (${f.cards.length})`,
  ...(f.cards.length ? f.cards.map((q) => `- ${q.id}: ${cell(q.text)} (options: ${q.options.join(" / ")}; thread ${q.thread ?? "-"})`) : ["none"]),
  "",
  "## Todos left in the old session",
  ...(f.todos.length ? f.todos.map((t) => `- ${t}`) : ["none"]),
  ...(f.goal ? ["", "## Goal of the old session", f.goal] : []),
  "",
  "## Timers and reminders",
  ...(f.timers.length ? f.timers.map((t) => `- ${t}`) : ["none"]),
  "",
  "## The old lead's notes",
  f.leadNote.trim() || "(none: dori handover --note FILE adds the old lead's own notes here)",
  "",
].join("\n");

// The lanes' footer, their [LEAD] message and the config text all name the lead's pane; moving it is one function, so a
// rollback is the same call with the two sides swapped.
export const pointLead = async (deps: HandoverDeps, from: Target, to: Target, stamp: string): Promise<string[]> => {
  const out: string[] = [];
  const at = iso(deps.clock);
  const backup = (path: string) => {
    const copy = `${path}.bak-handover-${stamp}`;
    if (!existsSync(copy)) writeFileSync(copy, readFileSync(path));
  };
  const raw = existsSync(deps.configPath) ? (JSON.parse(readFileSync(deps.configPath, "utf8")) as Record<string, unknown> & { update?: Record<string, unknown> }) : {};
  if (existsSync(deps.configPath)) backup(deps.configPath);
  raw.leadPane = to.pane;
  if (raw.update?.alertPane === from.pane) raw.update.alertPane = to.pane;
  writeFileSync(deps.configPath, `${JSON.stringify(raw, null, 2)}\n`);
  out.push(`HANDOVER_CONFIG leadPane ${from.pane} -> ${to.pane} in ${deps.configPath}`);
  if (existsSync(deps.envPath)) {
    const text = readFileSync(deps.envPath, "utf8");
    // a line the file lacks is added, so the listener that reads dori.env learns the new lead too
    const set = (body: string, key: string, value: string): string => {
      const line = new RegExp(`^${key}=.*$`, "m");
      return line.test(body) ? body.replace(line, `${key}=${value}`) : `${body}${body && !body.endsWith("\n") ? "\n" : ""}${key}=${value}\n`;
    };
    const tmux = set(text, "DORI_LEAD_TMUX", to.pane);
    const next = to.aoeId ? set(tmux, "DORI_LEAD_AOE_ID", to.aoeId) : tmux;
    if (next !== text) {
      backup(deps.envPath);
      writeFileSync(deps.envPath, next);
      out.push(`HANDOVER_ENV DORI_LEAD_TMUX/DORI_LEAD_AOE_ID -> ${to.pane}/${to.aoeId || "-"} in ${deps.envPath}`);
    }
  }
  for (const lane of await deps.registry.open()) {
    let brief = "missing";
    if (existsSync(lane.brief)) {
      const text = readFileSync(lane.brief, "utf8");
      brief = text.includes(from.pane) ? "rewritten" : "unchanged";
      if (brief === "rewritten") writeFileSync(lane.brief, text.split(from.pane).join(to.pane));
    }
    const fresh = (await deps.registry.read(lane.key)) ?? lane;
    await deps.registry.write({ ...fresh, history: [...(fresh.history ?? []), { at, status: statusOf(fresh), note: `lead moved ${from.pane} -> ${to.pane} (dori handover)` }] });
    const told = lane.pane
      ? await sendVerified(deps.run, deps.clock, deps.config, lane.pane, `[LEAD] The lead moved to tmux session ${to.pane}. Send every [REPORT] there from now on: ["dori","type","${to.pane}","--text","<report line>"]. Your brief's footer says the same now.`)
      : false;
    out.push(`HANDOVER_LANE ${lane.key} brief=${brief} told=${told ? "yes" : "no"}`);
  }
  const cards = new QuestionStore(deps.cardDir).retarget({ tmux: from.pane }, { tmux: to.pane });
  out.push(`HANDOVER_CARDS ${cards.length ? cards.join(",") : "none"} -> ${to.pane}`);
  return out;
};

export const ackFile = (stateDir: string, nonce: string): string => join(stateDir, "handover", "acks", `${nonce.replace(/[^\w-]/g, "")}.json`);

export const ackHandover = (stateDir: string, nonce: string, pane: string, at: string): string => {
  const file = ackFile(stateDir, nonce);
  mkdirSync(join(stateDir, "handover", "acks"), { recursive: true });
  writeFileSync(file, JSON.stringify({ nonce, pane, at }));
  return `HANDOVER_ACK ${nonce} pane=${pane || "-"}`;
};

const ackProblem = (stateDir: string, nonce: string, what: string, pane: string): string | undefined => {
  const file = ackFile(stateDir, nonce);
  if (!existsSync(file)) return `no ack for the ${what}`;
  const by = (JSON.parse(readFileSync(file, "utf8")) as { pane?: string }).pane ?? "";
  return by === pane ? undefined : `the ${what} was acked from ${by || "an unknown pane"}, not ${pane}`;
};

const verify = async (deps: HandoverDeps, facts: HandoverFacts, to: Target, verifyMin: number, emit: (line: string) => void): Promise<{ readonly reasons: string[]; readonly session: string }> => {
  const tries = Math.max(1, Math.ceil((verifyMin * 60_000) / POLL_MS));
  let i = 0;
  let session = "";
  if (facts.monitors.length || facts.watchers.length) {
    let missing = facts.monitors.map((m) => m.description);
    let down: string[] = facts.watchers.map((w) => w.name);
    for (; i < tries; i++) {
      session ||= await deps.sessionOf(to.pane, facts.cwd).catch(() => "");
      if (session && facts.monitors.length) missing = missingMonitors(facts.monitors, readManifest(manifestPath(deps.config.sessionsDir, facts.cwd, session)), deps.alive, deps.home, deps.clock.now());
      down = await missingWatchers(deps, facts.watchers, { pane: to.pane, session });
      if ((session || !facts.monitors.length) && !missing.length && !down.length) break;
      await deps.clock.sleep(POLL_MS);
    }
    if (facts.monitors.length && !session) return { reasons: [`the omo session of ${to.pane} was not found under ${facts.cwd}, so its monitors could not be checked`], session };
    const reasons = [...(missing.length ? [`monitors not running in ${to.pane}: ${missing.join(", ")}`] : []), ...(down.length ? [`watchers not running for ${to.pane}: ${down.join(", ")}`] : [])];
    if (reasons.length) return { reasons, session };
    if (facts.monitors.length) emit(`HANDOVER_MONITORS_OK ${facts.monitors.length} in ${to.pane} (session ${session})`);
    if (facts.watchers.length) emit(`HANDOVER_WATCHERS_OK ${facts.watchers.map((w) => w.name).join(",")} for ${to.pane}`);
  }
  const routed = await deps.routedPane();
  if (routed !== to.pane) return { reasons: [`lanes would still report to ${routed || "(no leadPane)"}, not ${to.pane}`], session };
  const report = deps.nonce();
  const inbox = deps.nonce();
  const ack = (id: string) => `dori handover ack ${id} --state ${deps.config.stateDir}`;
  const line = `[REPORT] handover-probe | milestone | ${PROBE} ${report}: run ${ack(report)}`;
  if (!(await sendVerified(deps.run, deps.clock, deps.config, routed, line))) return { reasons: [`the report probe did not reach ${routed}`], session };
  appendFileSync(deps.inbox, `${JSON.stringify({ ts: iso(deps.clock), id: `handover-${inbox}`, kind: "handover-probe", content: `${PROBE} ${inbox}: run ${ack(inbox)}` })}\n`);
  emit(`HANDOVER_PROBES_SENT report=${report} inbox=${inbox} (${deps.inbox})`);
  let problems: string[] = [];
  for (; i < tries; i++) {
    problems = [ackProblem(deps.config.stateDir, report, "report probe", to.pane), ackProblem(deps.config.stateDir, inbox, "inbox probe", to.pane)].filter((p): p is string => !!p);
    if (!problems.length) break;
    await deps.clock.sleep(POLL_MS);
  }
  return { reasons: problems, session };
};

export type HandoverResult = { readonly code: number; readonly note?: string; readonly to?: string };

// One handover at a time per state dir: two would each open a session and repoint the lead to their own.
export const takeLock = (file: string, alive: (pid: number) => boolean, at: string): string | undefined => {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid, at }), { flag: "wx" });
      return undefined;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const held = (() => {
      try {
        return JSON.parse(readFileSync(file, "utf8")) as { pid?: number; at?: string };
      } catch {
        return {};
      }
    })();
    if (held.pid && alive(held.pid)) return `another handover is running (pid ${held.pid}, started ${held.at ?? "?"}); ${file}`;
    rmSync(file, { force: true });
  }
  return `could not take the handover lock ${file}`;
};

type MoveContext = { readonly note: string; readonly stamp: string; readonly dir: string; readonly title: string; readonly model: string; readonly units: readonly string[]; readonly emit: (line: string) => void; readonly mark: (step: string, ok: boolean) => void };

export const handover = async (deps: HandoverDeps, opts: HandoverOptions = {}): Promise<HandoverResult> => {
  const { config } = deps;
  const at = iso(deps.clock);
  const stamp = at.replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const dir = join(config.stateDir, "handover");
  const emit = (line: string): void => {
    deps.print(line);
    if (!opts.dryRun) watchLog(config.watchLog, deps.clock, { source: "handover", line });
  };
  const refuse = (why: string): HandoverResult => {
    emit(`HANDOVER_REFUSED ${why}`);
    if (!opts.dryRun && opts.approvedBy?.trim()) appendRollover(config.stateDir, { kind: "rollover", who: "lead", at, key: "lead", from: config.leadPane, approvedBy: opts.approvedBy.trim(), signals: {}, steps: [], result: "refused", reasons: [why] });
    return { code: 2 };
  };
  if (config.backend !== "aoe") return refuse("dori handover needs backend aoe");
  if (!config.leadPane) return refuse("leadPane is not set");
  if (deps.envLeadPane) return refuse(`DORI_LEAD_PANE=${deps.envLeadPane} is set in the environment and overrides leadPane in ${deps.configPath}, so lanes would keep reporting there; remove it (also from any wrapper script) and keep the pane in the config file`);
  if (opts.note && !existsSync(opts.note)) return refuse(`note file not found: ${opts.note}`);
  const unapproved = opts.dryRun ? undefined : approvalProblem(opts.approvedBy, (id) => new QuestionStore(deps.cardDir).get(id), { on: config.handover.autoRolloverLead, key: "handover.autoRolloverLead" }, "lead", config.leadPane, readRollovers(config.stateDir), Boolean(deps.reportOwner));
  if (unapproved) return refuse(`the lead moves to a new session only with an approval: ${unapproved} (--dry-run needs none)`);
  const old = sessionFor(await aoeSessions(deps.run), config.leadPane);
  if (!old) return refuse(`no live aoe session for leadPane ${config.leadPane}`);
  const bad = config.handover.watchers.find((w) => !w.name || !Array.isArray(w.check) || !w.check.length);
  if (bad) return refuse(`handover.watchers entry ${JSON.stringify(bad)} needs a name and a check argv`);
  const session = await deps.sessionOf(config.leadPane, old.path).catch(() => "");
  const sessionDir = sessionDirFor(config.sessionsDir, old.path);
  const manifest = session ? manifestPath(config.sessionsDir, old.path, session) : "";
  const entries = manifest ? readManifest(manifest) : [];
  const now = deps.clock.now();
  const leadScreen = await captureTmux(deps.run, config.leadPane);
  const status = leadScreen.split("\n").slice(leadScreen.split("\n").findLastIndex((l) => l === inputLine(leadScreen)) + 1).join("\n");
  const pct = /\b\d+(?:\.\d+)?[KMG]?\/\d+(?:\.\d+)?[KMG]?\s+\((\d+(?:\.\d+)?)%\)/.exec(status)?.[1];
  const signals: Signals = { ...(pct ? { contextPct: Number(pct) } : {}), ...sessionSignals(sessionDir, session, now) };
  const real = deps.realpath(old.path);
  const cwd = config.handover.cwd || real;
  if (real !== old.path) emit(`HANDOVER_CWD_SYMLINK the old lead runs from ${old.path}, a symlink to ${real}; the new session opens in ${cwd}${config.handover.cwd ? " (handover.cwd)" : " (set handover.cwd to choose another)"}`);
  const facts: HandoverFacts = {
    from: { pane: config.leadPane, aoeId: old.id, session, title: old.title, cwd: old.path },
    cwd,
    lanes: await deps.registry.open(),
    monitors: liveMonitors(entries, now, deps.alive),
    watchers: config.handover.watchers,
    cards: new QuestionStore(deps.cardDir).all().filter((q) => q.status === "open"),
    todos: session ? openTodos(sessionDir, session) : [],
    goal: session ? openGoal(sessionDir, session) : undefined,
    timers: await deps.timers().catch(() => []),
    leadNote: opts.note ? readFileSync(opts.note, "utf8") : "",
  };
  const down = await missingWatchers(deps, facts.watchers, { pane: config.leadPane, session });
  if (down.length) return refuse(`configured watchers not running for ${config.leadPane}: ${down.join(", ")}; start them or fix handover.watchers before the handover`);
  if (!facts.monitors.length && !facts.watchers.length && !opts.noMonitors) {
    const where = session ? `in ${manifest}` : `(its omo session could not be told from the process under ${config.leadPane})`;
    return refuse(`no running monitor found for ${config.leadPane} ${where}; arm them first, list outside watchers in handover.watchers, or pass --no-monitors`);
  }
  mkdirSync(dir, { recursive: true });
  const note = join(dir, `${stamp}.md`);
  writeFileSync(note, renderNote(facts, at));
  writeFileSync(join(dir, `${stamp}.json`), JSON.stringify(facts, null, 1));
  emit(`HANDOVER_NOTE ${note}: ${facts.lanes.length} lanes, ${facts.monitors.length} monitors, ${facts.watchers.length} watchers, ${facts.cards.length} open questions, ${facts.todos.length} todos, ${facts.timers.length} timers${opts.note ? "" : "; HANDOVER_NO_LEAD_NOTE (pass --note FILE with your own notes)"}`);
  const units = config.handover.services.length ? config.handover.services : config.update.services.map((s) => s.unit);
  const model = opts.model || config.handover.model || config.defaultModel;
  const title = opts.title || config.handover.title || `${old.title.replace(/-\d{8}$/, "")}-${stamp.slice(4, 8)}${stamp.slice(9, 13)}`;
  if (opts.dryRun) {
    deps.print(`HANDOVER_DRY_RUN would open aoe session "${title}" in ${cwd} (${model}), point leadPane and ${facts.lanes.length} lanes at it, restart ${units.join(",") || "no units"}, check ${facts.monitors.length} monitors (${facts.monitors.map((m) => m.description || m.command || m.path).join(", ") || "none"}), ${facts.watchers.length} watchers (${facts.watchers.map((w) => w.name).join(", ") || "none"}) and two probes within ${opts.verifyMin ?? config.handover.verifyMin} min, then ${opts.keepOld ? "keep" : "close"} ${config.leadPane}`);
    return { code: 0, note };
  }
  const lockFile = join(dir, "lock");
  const busy = takeLock(lockFile, deps.alive, at);
  if (busy) return refuse(busy);
  const steps: Step[] = [];
  let last = deps.clock.now();
  const mark = (step: string, ok: boolean) => {
    const t = deps.clock.now();
    steps.push({ step, ms: t - last, ok });
    last = t;
  };
  let r: HandoverResult = { code: 3, note };
  try {
    r = await moveLead(deps, opts, facts, { note, stamp, dir, title, model, units, emit, mark });
    return r;
  } finally {
    rmSync(lockFile, { force: true });
    // the old lead may talk again once it is closed or stays the lead; with --keep-old it stays quiet until the mark expires
    // (and when the close failed: it is still open but no longer the lead)
    if (!(r.code === 1 || (r.code === 0 && opts.keepOld))) clearQuiet(config.stateDir, config.leadPane);
    const proposal = lastProposal(readRollovers(config.stateDir), "lead");
    const ref = opts.approvedBy?.trim() ?? "";
    const by = ref ? decidedBy(ref) : undefined;
    const reason = by === "lead" ? ref.slice(LEAD_PREFIX.length).trim() : undefined;
    const ownerReport = by === "lead" && r.to && r.code !== 3 ? await reportToOwner(deps, "lead", null, { who: "the lead", from: config.leadPane, to: r.to, reason: reason ?? "" }, emit) : undefined;
    appendRollover(config.stateDir, {
      kind: "rollover", who: "lead", at, key: "lead", from: config.leadPane, ...(r.to ? { to: r.to } : {}), ...(ref ? { approvedBy: ref } : {}),
      ...(by ? { decidedBy: by } : {}), ...(reason ? { reason } : {}), ...(ownerReport ? { ownerReport } : {}),
      ...(proposal ? { proposedAt: proposal.at, approvalMin: Math.round((Date.parse(at) - Date.parse(proposal.at)) / 6_000) / 10 } : {}),
      signals, steps, result: r.code === 0 ? (opts.keepOld ? "done-kept-old" : "done") : r.code === 1 ? "done-close-failed" : "rolled-back", reasons: steps.filter((st) => !st.ok).map((st) => st.step),
    });
  }
};

const moveLead = async (deps: HandoverDeps, opts: HandoverOptions, facts: HandoverFacts, ctx: MoveContext): Promise<HandoverResult> => {
  const { config } = deps;
  const { note, stamp, dir, title, model, units, emit, mark } = ctx;
  const tell = (pane: string, text: string) => sendVerified(deps.run, deps.clock, config, pane, text).catch(() => false);
  let pane: string;
  try {
    // the lead is no lane: it never starts with launchEnv, even when the handover runs from a lane's environment
    pane = await openAoeSession(deps.run, deps.clock, { title, cwd: facts.cwd, tool: config.agentCommand[0] ?? "omo", model, env: laneEnv(config.launchEnv, true) });
    mark("open", true);
  } catch (e) {
    mark("open", false);
    emit(`HANDOVER_FAIL could not open the new session: ${e instanceof Error ? e.message : String(e)}; nothing moved, ${config.leadPane} stays the lead`);
    return { code: 3, note };
  }
  const startup = await awaitPrompt(deps, pane);
  mark("startup", !startup);
  if (startup) {
    emit(`HANDOVER_FAIL new session ${pane}: ${startup}; nothing moved, ${config.leadPane} stays the lead`);
    return { code: 3, note, to: pane };
  }
  setQuiet(config.stateDir, config.leadPane, deps.clock.now() + ((opts.verifyMin ?? config.handover.verifyMin) + 10) * 60_000, `the handover of the lead to ${pane} is running`);
  await tell(config.leadPane, `[LEAD] Handover to ${pane} started (note ${note}). Stay quiet now: do not answer the owner or act on inbox, lane or session events, and ignore ${PROBE} lines. If the handover fails you are told and stay the lead.`);
  if (!(await sendVerified(deps.run, deps.clock, config, pane, `${config.handover.prompt}. Read the handover note at ${note} in full and do what it says, starting with its first section.`))) {
    await tell(config.leadPane, `[LEAD] Handover to ${pane} failed before anything moved: its first message did not register. You stay the lead.`);
    emit(`HANDOVER_FAIL the first message did not register in ${pane}; nothing moved, ${config.leadPane} stays the lead`);
    return { code: 3, note, to: pane };
  }
  const to: Target = { pane, aoeId: sessionFor(await aoeSessions(deps.run), pane)?.id ?? "", session: "" };
  emit(`HANDOVER_STARTED ${config.leadPane} -> ${pane}`);
  const restartAll = async (): Promise<string[]> => {
    const failed: string[] = [];
    for (const unit of units) {
      const why = await deps.restart(unit);
      emit(why ? `HANDOVER_RESTART_FAIL ${unit} ${why}` : `HANDOVER_RESTARTED ${unit}`);
      if (why) failed.push(`restart of ${unit} failed: ${why}`);
    }
    return failed;
  };
  for (const line of await pointLead(deps, facts.from, to, stamp)) emit(line);
  const restartFailures = await restartAll();
  mark("repoint", !restartFailures.length);
  const checked = restartFailures.length ? { reasons: restartFailures, session: "" } : await verify(deps, facts, to, opts.verifyMin ?? config.handover.verifyMin, emit);
  if (!restartFailures.length) mark("verify", !checked.reasons.length);
  const record = (result: string, reasons: readonly string[]) => writeFileSync(join(dir, `${stamp}.result.json`), JSON.stringify({ at: iso(deps.clock), from: facts.from, to: { ...to, session: checked.session }, note, result, reasons }, null, 1));
  if (checked.reasons.length) {
    emit(`HANDOVER_VERIFY_FAIL ${pane}: ${checked.reasons.join("; ")}`);
    for (const line of await pointLead(deps, to, facts.from, stamp)) emit(line);
    await restartAll();
    await tell(config.leadPane, `[LEAD] Handover to ${pane} failed (${checked.reasons.join("; ")}). You stay the lead: answer the owner and handle events again.`);
    await tell(pane, `[LEAD] HANDOVER_ROLLED_BACK: the handover failed (${checked.reasons.join("; ")}); ${config.leadPane} stays the lead. You are not the lead: do nothing more.`);
    emit(`HANDOVER_ROLLED_BACK ${config.leadPane} stays the lead; ${pane} is left open to look at (aoe rm it when done)`);
    record("rolled-back", checked.reasons);
    return { code: 3, note, to: pane };
  }
  if (facts.from.session && checked.session) new QuestionStore(deps.cardDir).retarget({ session: facts.from.session }, { session: checked.session });
  if (opts.keepOld) {
    await tell(config.leadPane, `[LEAD] Handover to ${pane} is done and checked. You are no longer the lead; stay idle until the lead closes you.`);
    await tell(pane, `[LEAD] ${COMMITTED}: the handover is checked and ${config.leadPane} stays open but idle; you are the lead now. Go on with step 4 of the note.`);
    emit(`HANDOVER_DONE ${config.leadPane} -> ${pane}; old session kept (--keep-old)`);
    record("done-kept-old", []);
    return { code: 0, note, to: pane };
  }
  emit(`HANDOVER_DONE ${config.leadPane} -> ${pane}; closing ${config.leadPane}`);
  record("done", []);
  const closed = await closeAoeSession(deps.run, config.leadPane);
  const ok = closed.includes("stopped and trashed");
  mark("close", ok);
  emit(ok ? `HANDOVER_CLOSED ${closed}` : `HANDOVER_CLOSE_FAIL ${closed}`);
  await tell(pane, `[LEAD] ${COMMITTED}: the handover is checked and the old session ${ok ? "is closed" : `${config.leadPane} did not close but stays idle`}; you are the lead now. Go on with step 4 of the note.`);
  emit(`${COMMITTED} lead ${pane}`);
  return { code: ok ? 0 : 1, note, to: pane };
};
