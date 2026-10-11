// dori handover: move the lead to a new agent session without losing work, monitors or notifications.
// Order: write the note -> open the new session -> point leadPane, lanes and cards at it -> check that its monitors run and
// that a [REPORT] and an inbox event reach it -> only then close the old session. A failed check moves everything back.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { aoeSessions, closeAoeSession, openAoeSession, sessionFor } from "./aoe.ts";
import type { FlowDeps } from "./done-flow.ts";
import { awaitPrompt } from "./launch.ts";
import { type Question, QuestionStore } from "./messenger/discord-cards.ts";
import { sendVerified } from "./panes.ts";
import { type Lane, statusOf } from "./registry.ts";
import { iso } from "./run.ts";
import { sessionDirFor } from "./session-id.ts";
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
  readonly alive: (pid: number) => boolean;
  readonly timers: () => Promise<string[]>;
  // restart a user unit; a reason when it failed
  readonly restart: (unit: string) => Promise<string | undefined>;
  readonly nonce: () => string;
  readonly print: (line: string) => void;
};

export type HandoverOptions = {
  readonly title?: string;
  readonly model?: string;
  readonly note?: string;
  readonly keepOld?: boolean;
  readonly dryRun?: boolean;
  readonly noMonitors?: boolean;
  readonly verifyMin?: number;
};

export type MonitorSpec = { readonly description: string; readonly command?: string; readonly filter?: string; readonly path?: string; readonly event?: string };

type ManifestEntry = {
  readonly description?: string;
  readonly command?: string;
  readonly filter?: string;
  readonly path?: string;
  readonly event?: string;
  readonly persistent?: boolean;
  readonly suspended?: boolean;
  readonly expiresAt?: number;
  readonly runtime?: { readonly pid?: number };
};

type Target = { readonly pane: string; readonly aoeId: string; readonly session: string };

export type HandoverFacts = {
  readonly from: Target & { readonly title: string; readonly cwd: string };
  readonly lanes: readonly Lane[];
  readonly monitors: readonly MonitorSpec[];
  readonly oneShots: readonly MonitorSpec[];
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
});

const running = (e: ManifestEntry, now: number): boolean => !e.suspended && (e.expiresAt === undefined || e.expiresAt > now) && !!(e.command || e.path);

// persistent: the standing watches the new session must run; otherwise the one-shot watches still running
export const liveMonitors = (entries: readonly ManifestEntry[], now: number, persistent: boolean): MonitorSpec[] =>
  entries.filter((e) => running(e, now) && !!e.persistent === persistent).map(spec);

const norm = (text: string, home: string): string => text.replace(/(^|[\s=:'"])~\//g, `$1${home}/`).replace(/\s+/g, " ").trim();

// A monitor counts as re-armed when the new session runs a persistent watch with the same command (or path, or
// description), whose process is alive.
export const missingMonitors = (wanted: readonly MonitorSpec[], entries: readonly ManifestEntry[], alive: (pid: number) => boolean, home: string, now: number): string[] => {
  const live = entries.filter((e) => e.persistent && running(e, now) && (e.path || (e.runtime?.pid !== undefined && alive(e.runtime.pid))));
  return wanted
    .filter((m) => !live.some((e) =>
      (m.command && e.command && norm(m.command, home) === norm(e.command, home)) ||
      (m.path && e.path && norm(m.path, home) === norm(e.path, home)) ||
      (m.description && e.description === m.description)))
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
  `- ${m.description || "(no description)"}: ${m.command ? `command ${JSON.stringify(m.command)}${m.filter ? ` filter ${JSON.stringify(m.filter)}` : ""}` : `path ${JSON.stringify(m.path)}${m.event ? ` event ${m.event}` : ""}`}`;

export const renderNote = (f: HandoverFacts, at: string): string => [
  `# Dori handover ${at}`,
  "",
  `From ${f.from.pane} (aoe ${f.from.aoeId}, omo session ${f.from.session || "unknown"}, cwd ${f.from.cwd}). You are the new lead session: dori handover points leadPane, the open lanes and the open question cards at you.`,
  "",
  "## Do this first",
  "1. Arm every monitor under Monitors again as a persistent monitor, with the same command and filter. Arm each one once. The handover checks that they run in this session.",
  `2. A line with ${PROBE} <id>, typed into this session or arriving as an inbox event, is a check of this handover: run dori handover ack <id> for it and nothing else.`,
  "3. Then read the rest and carry on: open lanes, owner questions, todos, timers and the old lead's notes. The old session stays quiet and is closed once the checks pass.",
  "",
  `## Monitors (${f.monitors.length})`,
  ...(f.monitors.length ? f.monitors.map(monitorLine) : ["none"]),
  ...(f.oneShots.length ? ["", "One-shot watches the old session still had (arm again only if still needed):", ...f.oneShots.map(monitorLine)] : []),
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
    const next = text
      .replace(/^DORI_LEAD_TMUX=.*$/m, `DORI_LEAD_TMUX=${to.pane}`)
      .replace(/^DORI_LEAD_AOE_ID=.*$/m, to.aoeId ? `DORI_LEAD_AOE_ID=${to.aoeId}` : "$&");
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
      ? await sendVerified(deps.run, deps.clock, deps.config.backend, lane.pane, `[LEAD] The lead moved to tmux session ${to.pane}. Send every [REPORT] there from now on: ["tmux","send-keys","-t","=${to.pane}:","-l","--","<report line>"], then ["tmux","send-keys","-t","=${to.pane}:","Enter"]. Your brief's footer says the same now.`)
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
  if (facts.monitors.length) {
    let missing = facts.monitors.map((m) => m.description);
    for (; i < tries; i++) {
      session ||= await deps.sessionOf(to.pane, facts.from.cwd).catch(() => "");
      if (session) {
        missing = missingMonitors(facts.monitors, readManifest(manifestPath(deps.config.sessionsDir, facts.from.cwd, session)), deps.alive, deps.home, deps.clock.now());
        if (!missing.length) break;
      }
      await deps.clock.sleep(POLL_MS);
    }
    if (!session) return { reasons: [`the omo session of ${to.pane} was not found, so its monitors could not be checked`], session };
    if (missing.length) return { reasons: [`monitors not running in ${to.pane}: ${missing.join(", ")}`], session };
    emit(`HANDOVER_MONITORS_OK ${facts.monitors.length} in ${to.pane} (session ${session})`);
  }
  const routed = await deps.routedPane();
  if (routed !== to.pane) return { reasons: [`lanes would still report to ${routed || "(no leadPane)"}, not ${to.pane}`], session };
  const report = deps.nonce();
  const inbox = deps.nonce();
  const line = `[REPORT] handover-probe | milestone | ${PROBE} ${report}: run dori handover ack ${report}`;
  if (!(await sendVerified(deps.run, deps.clock, deps.config.backend, routed, line))) return { reasons: [`the report probe did not reach ${routed}`], session };
  appendFileSync(deps.inbox, `${JSON.stringify({ ts: iso(deps.clock), id: `handover-${inbox}`, kind: "handover-probe", content: `${PROBE} ${inbox}: run dori handover ack ${inbox}` })}\n`);
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
    return { code: 2 };
  };
  if (config.backend !== "aoe") return refuse("dori handover needs backend aoe");
  if (!config.leadPane) return refuse("leadPane is not set");
  if (opts.note && !existsSync(opts.note)) return refuse(`note file not found: ${opts.note}`);
  const old = sessionFor(await aoeSessions(deps.run), config.leadPane);
  if (!old) return refuse(`no live aoe session for leadPane ${config.leadPane}`);
  const session = await deps.sessionOf(config.leadPane, old.path).catch(() => "");
  const sessionDir = sessionDirFor(config.sessionsDir, old.path);
  const entries = session ? readManifest(manifestPath(config.sessionsDir, old.path, session)) : [];
  const now = deps.clock.now();
  const facts: HandoverFacts = {
    from: { pane: config.leadPane, aoeId: old.id, session, title: old.title, cwd: old.path },
    lanes: await deps.registry.open(),
    monitors: liveMonitors(entries, now, true),
    oneShots: liveMonitors(entries, now, false),
    cards: new QuestionStore(deps.cardDir).all().filter((q) => q.status === "open"),
    todos: session ? openTodos(sessionDir, session) : [],
    goal: session ? openGoal(sessionDir, session) : undefined,
    timers: await deps.timers().catch(() => []),
    leadNote: opts.note ? readFileSync(opts.note, "utf8") : "",
  };
  if (!facts.monitors.length && !opts.noMonitors) return refuse(`no running persistent monitor found for ${config.leadPane} (omo session ${session || "unknown"}); arm them first, or pass --no-monitors`);
  mkdirSync(dir, { recursive: true });
  const note = join(dir, `${stamp}.md`);
  writeFileSync(note, renderNote(facts, at));
  writeFileSync(join(dir, `${stamp}.json`), JSON.stringify(facts, null, 1));
  emit(`HANDOVER_NOTE ${note}: ${facts.lanes.length} lanes, ${facts.monitors.length} monitors, ${facts.cards.length} open questions, ${facts.todos.length} todos, ${facts.timers.length} timers${opts.note ? "" : "; HANDOVER_NO_LEAD_NOTE (pass --note FILE with your own notes)"}`);
  const units = config.handover.services.length ? config.handover.services : config.update.services.map((s) => s.unit);
  const model = opts.model || config.handover.model || config.defaultModel;
  const title = opts.title || config.handover.title || `${old.title.replace(/-\d{8}$/, "")}-${stamp.slice(4, 8)}${stamp.slice(9, 13)}`;
  if (opts.dryRun) {
    deps.print(`HANDOVER_DRY_RUN would open aoe session "${title}" in ${old.path} (${model}), point leadPane and ${facts.lanes.length} lanes at it, restart ${units.join(",") || "no units"}, check ${facts.monitors.length} monitors and two probes within ${opts.verifyMin ?? config.handover.verifyMin} min, then ${opts.keepOld ? "keep" : "close"} ${config.leadPane}`);
    return { code: 0, note };
  }
  const tell = (pane: string, text: string) => sendVerified(deps.run, deps.clock, config.backend, pane, text).catch(() => false);
  let pane: string;
  try {
    pane = await openAoeSession(deps.run, deps.clock, { title, cwd: old.path, tool: config.agentCommand[0] ?? "omo", model });
  } catch (e) {
    emit(`HANDOVER_FAIL could not open the new session: ${e instanceof Error ? e.message : String(e)}; nothing moved, ${config.leadPane} stays the lead`);
    return { code: 3, note };
  }
  const startup = await awaitPrompt(deps, pane);
  if (startup) {
    emit(`HANDOVER_FAIL new session ${pane}: ${startup}; nothing moved, ${config.leadPane} stays the lead`);
    return { code: 3, note, to: pane };
  }
  await tell(config.leadPane, `[LEAD] Handover to ${pane} started (note ${note}). Stay quiet now: do not answer the owner or act on inbox, lane or session events, and ignore ${PROBE} lines. If the handover fails you are told and stay the lead.`);
  if (!(await sendVerified(deps.run, deps.clock, config.backend, pane, `${config.handover.prompt}. Read the handover note at ${note} in full and do what it says, starting with its first section.`))) {
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
  const checked = restartFailures.length ? { reasons: restartFailures, session: "" } : await verify(deps, facts, to, opts.verifyMin ?? config.handover.verifyMin, emit);
  const record = (result: string, reasons: readonly string[]) => writeFileSync(join(dir, `${stamp}.result.json`), JSON.stringify({ at: iso(deps.clock), from: facts.from, to: { ...to, session: checked.session }, note, result, reasons }, null, 1));
  if (checked.reasons.length) {
    emit(`HANDOVER_VERIFY_FAIL ${pane}: ${checked.reasons.join("; ")}`);
    for (const line of await pointLead(deps, to, facts.from, stamp)) emit(line);
    await restartAll();
    await tell(config.leadPane, `[LEAD] Handover to ${pane} failed (${checked.reasons.join("; ")}). You stay the lead: answer the owner and handle events again.`);
    emit(`HANDOVER_ROLLED_BACK ${config.leadPane} stays the lead; ${pane} is left open to look at (aoe rm it when done)`);
    record("rolled-back", checked.reasons);
    return { code: 3, note, to: pane };
  }
  if (facts.from.session && checked.session) new QuestionStore(deps.cardDir).retarget({ session: facts.from.session }, { session: checked.session });
  if (opts.keepOld) {
    await tell(config.leadPane, `[LEAD] Handover to ${pane} is done and checked. You are no longer the lead; stay idle until the lead closes you.`);
    emit(`HANDOVER_DONE ${config.leadPane} -> ${pane}; old session kept (--keep-old)`);
    record("done-kept-old", []);
    return { code: 0, note, to: pane };
  }
  emit(`HANDOVER_DONE ${config.leadPane} -> ${pane}; closing ${config.leadPane}`);
  record("done", []);
  const closed = await closeAoeSession(deps.run, config.leadPane);
  const ok = closed.includes("stopped and trashed");
  emit(ok ? `HANDOVER_CLOSED ${closed}` : `HANDOVER_CLOSE_FAIL ${closed}`);
  return { code: ok ? 0 : 1, note, to: pane };
};
