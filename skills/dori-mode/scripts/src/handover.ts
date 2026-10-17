// dori handover: move the lead to a new agent session without losing work, monitors or notifications.
// Order: write the note -> open the new session -> point leadPane, lanes and cards at it -> check that its monitors run and
// that a [REPORT] and an inbox event reach it -> only then close the old session. A failed check moves everything back.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { aoeSessions, captureTmux, closeAoeSession, inputLine, laneEnv, openAoeSession, sessionFor } from "./aoe.ts";
import { fill, type HandoverWatcher } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { type FreezeDeps, type FrozenRecord, freezePane, writeFrozen } from "./frozen.ts";
import { pointInstanceAlerts } from "./handover-alerts.ts";
import { awaitPrompt } from "./launch.ts";
import { type Question, QuestionStore } from "./messenger/discord-cards.ts";
import { sendVerified } from "./panes.ts";
import { type Lane, statusOf } from "./registry.ts";
import { iso } from "./run.ts";
import { sessionDirFor } from "./session-id.ts";
import { bulletsIn, covered, fillGaps, flat, type Missing, missingHeadings, quoted, quotesIn, ROUND_TRIES, section, words } from "./restatement.ts";
import { appendRollover, approvalProblem, autoReason, clearQuiet, COMMITTED, decidedBy, inboxMessages, LEAD_PREFIX, lastProposal, readRollovers, reportToOwner, type Signals, sessionSignals, setQuiet, type Step, type Supplement } from "./rollover.ts";
import { watchLog } from "./watch-log.ts";

export type HandoverDeps = FlowDeps & Pick<FreezeDeps, "procs" | "signal"> & {
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
  // the owner's ids in the inbox (DORI_DISCORD_OWNER, DORI_KAKAO_OWNER_ID): their recent messages go into the note and the
  // new lead's restatement is checked for each
  readonly ownerIds?: readonly string[];
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
  readonly ownerWords: readonly OwnerWord[];
  // the old lead's conversation log, quoted by the supplements
  readonly oldLog?: string;
};

export type OwnerWord = { readonly at: string; readonly where: string; readonly text: string };

// The summary the old lead writes before it is replaced (dori handover --note FILE; dori handover --template prints the
// headings): what only its conversation knows.
export const LEAD_SUMMARY_HEADINGS = ["Owner's words and constraints", "Decisions and why", "Promised follow-ups", "In progress", "Next step"] as const;
export const LEAD_SUMMARY_TEMPLATE = [
  "## Owner's words and constraints",
  "(every instruction and constraint from the owner that still holds, and what he asked last and is waiting for, quoted exactly in \"double quotes\", newest last, with the message link when you have it)",
  "## Decisions and why",
  "(each decision made in this conversation and what it rests on, one bullet each)",
  "## Promised follow-ups",
  "(each thing you told the owner you would do or report, and when, one bullet each)",
  "## In progress",
  "(what is half done: lanes you were about to launch, steer or close, answers you were writing, checks you were running)",
  "## Next step",
  "(the exact next action)",
  "",
].join("\n");
// The headings of the new lead's restatement, written before it is committed.
export const LEAD_UNDERSTOOD_HEADINGS = ["Goal", "Owner's words", "Open lanes", "Open work", "Open cards", "Timers", "Promised follow-ups", "Decisions", "Next step", "Questions"] as const;
// the owner's messages the note carries: those of the last OWNER_HOURS, at most OWNER_MAX, newest last
const OWNER_HOURS = 24;
const OWNER_MAX = 8;

export const recentOwnerWords = (inbox: string, ids: readonly string[], now: number): OwnerWord[] => {
  if (!ids.length || !existsSync(inbox)) return [];
  const out: OwnerWord[] = [];
  for (const line of readFileSync(inbox, "utf8").split("\n")) {
    let row: { ts?: string; author_id?: string; content?: string; transcript?: unknown; scope?: string; channel_id?: string; room?: string; id?: string };
    try {
      row = JSON.parse(line) as typeof row;
    } catch {
      continue;
    }
    const text = (row.content?.trim() || (typeof row.transcript === "string" ? row.transcript.trim() : "")).replace(/\s+/g, " ");
    const at = Date.parse(row.ts ?? "");
    if (!text || !row.author_id || !ids.includes(row.author_id) || !(at <= now && now - at <= OWNER_HOURS * 3_600_000)) continue;
    out.push({ at: row.ts ?? "", where: `${row.scope ?? "?"} ${row.room ?? row.channel_id ?? "-"}, message ${row.id ?? "-"}`, text });
  }
  return out.slice(-OWNER_MAX);
};

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const named = (text: string, name: string): boolean => new RegExp(`(^|[^\\w-])${escapeRe(name)}($|[^\\w-])`, "i").test(text);
const timerUnit = (line: string): string => /(\S+\.timer)\b/.exec(line)?.[1] ?? line;
const todoText = (todo: string): string => todo.replace(/^[^:]*:\s*/, "").replace(/\s*\((?:pending|in_progress)\)$/, "");

// What the new lead's restatement left out, measured against the handover's own records (open lanes, open cards, timers,
// todos, the old session's goal, the owner's recent messages in the inbox: all kept apart from any summary) and against
// the old lead's summary (the owner's quoted words, decisions, promised follow-ups). An open lane, card or timer counts
// only under its own heading.
export const missingLeadFrom = (text: string, facts: HandoverFacts): Missing[] => {
  if (!text.trim()) return [{ kind: "restatement", text: "the restatement file is missing or empty", under: "", source: "the handover" }];
  const all = flat(text);
  const out: Missing[] = missingHeadings(text, LEAD_UNDERSTOOD_HEADINGS).map((h) => ({ kind: "heading", text: `## ${h}`, under: h, source: "the restatement format" }));
  const lanes = section(text, "Open lanes");
  for (const l of facts.lanes) if (!named(lanes, l.key)) out.push({ kind: "open lane", text: l.key, under: "Open lanes", source: `the lane registry: ${statusOf(l)}, pane ${l.pane ?? "-"}, thread ${l.thread}, last report ${cell(l.lastReport ?? "-")}` });
  const cards = section(text, "Open cards");
  for (const q of facts.cards) if (!named(cards, q.id)) out.push({ kind: "open card", text: q.id, under: "Open cards", source: `the open question cards: "${cell(q.text)}" (options: ${q.options.join(" / ")}; thread ${q.thread ?? "-"}), waiting for the owner's answer` });
  const timers = flat(section(text, "Timers"));
  for (const t of facts.timers) if (!timers.includes(flat(timerUnit(t)))) out.push({ kind: "timer", text: timerUnit(t), under: "Timers", source: `systemctl --user list-timers: ${t}` });
  const work = flat(section(text, "Open work"));
  for (const t of facts.todos.map(todoText)) if (!(words(t).length >= 3 ? covered(work, t) : quoted(work, t))) out.push({ kind: "open work", text: t, under: "Open work", source: "the old session's todo list", byWords: true });
  const goal = facts.goal?.replace(/\s*\((?:active|paused|blocked|[a-z_]+)\)$/, "").trim() ?? "";
  if (goal && !quoted(all, goal)) out.push({ kind: "goal", text: goal, under: "Goal", source: "the old session's goal" });
  for (const w of facts.ownerWords) if (flat(w.text).length >= 6 && !quoted(all, w.text)) out.push({ kind: "owner's words", text: w.text, under: "Owner's words", source: `the owner's message at ${w.at} (${w.where}), from the inbox` });
  for (const q of quotesIn(section(facts.leadNote, "Owner's words and constraints"))) if (!quoted(all, q) && !out.some((m) => flat(m.text) === flat(q))) out.push({ kind: "owner's words", text: q, under: "Owner's words", source: "the old lead's summary, Owner's words and constraints" });
  for (const d of bulletsIn(facts.leadNote, "Decisions and why")) if (!covered(all, d)) out.push({ kind: "decision", text: d, under: "Decisions", source: "the old lead's summary, Decisions and why", byWords: true });
  for (const d of bulletsIn(facts.leadNote, "Promised follow-ups")) if (!covered(all, d)) out.push({ kind: "promised follow-up", text: d, under: "Promised follow-ups", source: "the old lead's summary, Promised follow-ups", byWords: true });
  return out;
};

const POLL_MS = 5_000;
export const PROBE = "HANDOVER_PROBE";
export const UNDERSTAND = "HANDOVER_UNDERSTAND";

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
  `3. A [LEAD] ${UNDERSTAND} <id> line asks what you understood. Read this whole note first, then write it to the file the line names, under the headings ${LEAD_UNDERSTOOD_HEADINGS.map((h) => `## ${h}`).join(", ")}: under Goal the old session's goal quoted; under Owner's words each of the owner's recent messages and each quote in the old lead's notes, quoted exactly; under Open lanes every lane key of the table with what it waits on; under Open work each todo; under Open cards each card id with its question; under Timers each timer's unit name; under Promised follow-ups what the old lead promised the owner; under Questions only what neither this note nor the old log answers, or none. Then run the ack command the line gives. A [LEAD] HANDOVER_SUPPLEMENT <id> line names a file with what your restatement left out and the old log lines behind it: add those items to the same file, keep the rest, and run the ack command it gives.`,
  `4. Until a [LEAD] ${COMMITTED} line arrives answer no one, act on no event and change nothing besides that file: the handover can still roll back. The old session stays quiet meanwhile and is closed once the checks pass.`,
  `5. After ${COMMITTED}, carry on: open lanes, owner questions, todos, timers, promised follow-ups and the old lead's notes; answer the owner where his last messages left off.`,
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
  `## The owner's recent messages (${f.ownerWords.length}, last ${OWNER_HOURS} h, newest last)`,
  ...(f.ownerWords.length ? f.ownerWords.map((w) => `- ${w.at} (${w.where}): "${w.text}"`) : ["none"]),
  "",
  "## The old lead's notes",
  f.leadNote.trim() || "(none: the old lead wrote no summary (dori handover --template prints its headings, dori handover --note FILE adds it); read the old conversation below before you act on a guess)",
  "",
  "## The old conversation",
  f.oldLog ? `Its full log is ${f.oldLog} (JSONL; it stays on disk after the old session closes). When this note leaves something out, search it (the owner's words, a lane key, a card id) before you ask.` : "Its log was not found.",
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
  out.push(...pointInstanceAlerts(deps, { from: from.pane, to: to.pane, stamp }));
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

export const ackedBy = (stateDir: string, id: string): string | undefined => {
  try {
    return (JSON.parse(readFileSync(ackFile(stateDir, id), "utf8")) as { pane?: string }).pane ?? "";
  } catch {
    return undefined;
  }
};

const ackProblem = (stateDir: string, nonce: string, what: string, pane: string): string | undefined => {
  const file = ackFile(stateDir, nonce);
  if (!existsSync(file)) return `no ack for the ${what}`;
  const by = (JSON.parse(readFileSync(file, "utf8")) as { pane?: string }).pane ?? "";
  return by === pane ? undefined : `the ${what} was acked from ${by || "an unknown pane"}, not ${pane}`;
};

type Checked = { readonly reasons: string[]; readonly session: string; readonly supplements?: readonly Supplement[] };

const verify = async (deps: HandoverDeps, facts: HandoverFacts, to: Target, verifyMin: number, understood: string, emit: (line: string) => void): Promise<Checked> => {
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
  appendFileSync(deps.inbox, `${JSON.stringify({ ts: iso(deps.clock), id: `handover-${inbox}`, scope: "channel", kind: "handover-probe", content: `${PROBE} ${inbox}: run ${ack(inbox)}` })}\n`);
  emit(`HANDOVER_PROBES_SENT report=${report} inbox=${inbox} (${deps.inbox})`);
  let problems: string[] = [];
  for (; i < tries; i++) {
    problems = [ackProblem(deps.config.stateDir, report, "report probe", to.pane), ackProblem(deps.config.stateDir, inbox, "inbox probe", to.pane)].filter((p): p is string => !!p);
    if (!problems.length) break;
    await deps.clock.sleep(POLL_MS);
  }
  if (problems.length) return { reasons: problems, session };
  // the new lead says what it understood before the old one is gone: a gap is filled in from the records and the old
  // log for supplementRounds rounds, and only a gap that outlasts them rolls the move back
  const id = deps.nonce();
  if (!(await sendVerified(deps.run, deps.clock, deps.config, to.pane, `[LEAD] ${UNDERSTAND} ${id}: write what you understood to ${understood} (${LEAD_UNDERSTOOD_HEADINGS.map((h) => `## ${h}`).join(", ")}) as step 3 of the handover note says, then run ${ack(id)} and nothing else for this line.`)))
    return { reasons: [`the restatement request did not reach ${to.pane}`], session };
  emit(`${UNDERSTAND}_SENT ${id} -> ${to.pane}`);
  let by: string | undefined;
  for (let j = 0; j < Math.max(tries - i, ROUND_TRIES) && by === undefined; j++) {
    await deps.clock.sleep(POLL_MS);
    by = ackedBy(deps.config.stateDir, id);
  }
  if (by === undefined) return { reasons: [`no ack for the restatement request ${id}`], session };
  if (by !== to.pane) return { reasons: [`the restatement request was acked from ${by || "an unknown pane"}, not ${to.pane}`], session };
  const gaps = await fillGaps({ clock: deps.clock, stateDir: deps.config.stateDir, nonce: deps.nonce, tell: (pane, text) => sendVerified(deps.run, deps.clock, deps.config, pane, text).catch(() => false), ackedBy: (x) => ackedBy(deps.config.stateDir, x) },
    { who: "lead", pane: to.pane, understood, headings: LEAD_UNDERSTOOD_HEADINGS, rounds: deps.config.handover.supplementRounds, oldLog: facts.oldLog, check: (text) => missingLeadFrom(text, facts), emit });
  if (gaps.reasons.length) return { reasons: gaps.reasons, session, supplements: gaps.supplements };
  const asks = section(gaps.text, "Questions");
  if (asks && !/^none\.?$/i.test(asks)) emit(`HANDOVER_QUESTIONS lead: ${asks.replace(/\s+/g, " ").slice(0, 400)} (the old log is ${facts.oldLog ?? "not found"})`);
  return { reasons: [], session, supplements: gaps.supplements };
};

export type HandoverResult = { readonly code: number; readonly note?: string; readonly to?: string };

// One handover at a time per state dir: two would each open a session and repoint the lead to their own.
export const takeLock = (file: string, alive: (pid: number) => boolean, at: string, what = "handover"): string | undefined => {
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
    if (held.pid && alive(held.pid)) return `another ${what} is running (pid ${held.pid}, started ${held.at ?? "?"}); ${file}`;
    rmSync(file, { force: true });
  }
  return `could not take the ${what} lock ${file}`;
};

type MoveContext = { readonly note: string; readonly stamp: string; readonly dir: string; readonly title: string; readonly model: string; readonly units: readonly string[]; readonly emit: (line: string) => void; readonly mark: (step: string, ok: boolean) => void; readonly supplements: Supplement[]; frozen?: FrozenRecord };

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
  const lacking = opts.note ? missingHeadings(readFileSync(opts.note, "utf8"), LEAD_SUMMARY_HEADINGS) : [];
  if (lacking.length) return refuse(`the old lead's summary ${opts.note} lacks ${lacking.map((h) => `## ${h}`).join(", ")} (dori handover --template prints the headings)`);
  const unapproved = opts.dryRun ? undefined : approvalProblem(opts.approvedBy, (id) => new QuestionStore(deps.cardDir).get(id), { on: config.handover.autoRolloverLead, key: "handover.autoRolloverLead" }, "lead", config.leadPane, readRollovers(config.stateDir), Boolean(deps.reportOwner), inboxMessages(deps.inbox, deps.ownerIds ?? []));
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
    ownerWords: recentOwnerWords(deps.inbox, deps.ownerIds ?? [], now),
    ...(session && sessionFile(sessionDir, session) ? { oldLog: sessionFile(sessionDir, session) } : {}),
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
  emit(`HANDOVER_NOTE ${note}: ${facts.lanes.length} lanes, ${facts.monitors.length} monitors, ${facts.watchers.length} watchers, ${facts.cards.length} open questions, ${facts.todos.length} todos, ${facts.timers.length} timers, ${facts.ownerWords.length} owner messages, old log ${facts.oldLog ? "yes" : "no"}${opts.note ? "" : "; HANDOVER_NO_LEAD_NOTE (pass --note FILE with your summary, dori handover --template)"}`);
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
  const supplements: Supplement[] = [];
  const ctx: MoveContext = { note, stamp, dir, title, model, units, emit, mark, supplements };
  try {
    r = await moveLead(deps, opts, facts, ctx);
    return r;
  } finally {
    rmSync(lockFile, { force: true });
    // the old lead may talk again once it is closed or stays the lead; with --keep-old it stays quiet until the mark expires
    // (and when the close failed: it is still open but no longer the lead)
    if (!(r.code === 1 || (r.code === 0 && opts.keepOld))) clearQuiet(config.stateDir, config.leadPane);
    const proposal = lastProposal(readRollovers(config.stateDir), "lead");
    const ref = opts.approvedBy?.trim() ?? "";
    const by = ref ? decidedBy(ref) : undefined;
    const reason = by === "lead" ? ref.slice(LEAD_PREFIX.length).trim() : by === "auto" ? autoReason("lead", signals, config.handover) : undefined;
    const frozen = ctx.frozen ? fill([config.handover.frozenText], { from: ctx.frozen.pane, n: String(ctx.frozen.pids.length), hours: ctx.frozen.closeAt ? String(config.handover.frozenCloseH) : "-" })[0] : undefined;
    const ownerReport = (by === "lead" || by === "auto") && r.to && r.code !== 3 ? await reportToOwner(deps, "lead", null, { who: "the lead", from: config.leadPane, to: r.to, reason: reason ?? "" }, emit, frozen) : undefined;
    appendRollover(config.stateDir, {
      kind: "rollover", who: "lead", at, key: "lead", from: config.leadPane, ...(r.to ? { to: r.to } : {}), ...(ref ? { approvedBy: ref } : {}),
      ...(by ? { decidedBy: by } : {}), ...(reason ? { reason } : {}), ...(ownerReport ? { ownerReport } : {}),
      ...(proposal ? { proposedAt: proposal.at, approvalMin: Math.round((Date.parse(at) - Date.parse(proposal.at)) / 6_000) / 10 } : {}),
      signals, steps, result: r.code === 0 ? (ctx.frozen ? "done-frozen" : opts.keepOld ? "done-kept-old" : "done") : r.code === 1 ? "done-close-failed" : "rolled-back", reasons: steps.filter((st) => !st.ok).map((st) => st.step),
      ...(ctx.frozen ? { frozen: { pids: ctx.frozen.pids.length, closeAt: ctx.frozen.closeAt ?? null } } : {}),
      ...(supplements.length ? { supplementRounds: supplements.length, supplements } : {}),
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
  const checked: Checked = restartFailures.length ? { reasons: restartFailures, session: "" } : await verify(deps, facts, to, opts.verifyMin ?? config.handover.verifyMin, join(dir, `${stamp}.understood.md`), emit);
  ctx.supplements.push(...(checked.supplements ?? []));
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
  // committed: the old lead is frozen, not closed, so it spends no tokens and does nothing while its pane and log stay.
  // A rolled-back move never gets here, and before this point it was only told to stay quiet.
  const ice = await freezePane(deps, config.leadPane, process.pid).catch((e: unknown) => ({ pids: [] as number[], agentPid: undefined, why: e instanceof Error ? e.message : String(e) }));
  mark("freeze", !!ice.agentPid);
  if (ice.agentPid) {
    const h = config.handover.frozenCloseH;
    const closeAt = !opts.keepOld && h > 0 ? new Date(deps.clock.now() + h * 3_600_000).toISOString() : undefined;
    const rec: FrozenRecord = { pane: config.leadPane, aoeId: facts.from.aoeId, at: iso(deps.clock), agentPid: ice.agentPid, pids: ice.pids, ...(closeAt ? { closeAt } : {}), to: pane, ...(facts.from.session ? { session: facts.from.session } : {}), ...(facts.oldLog ? { oldLog: facts.oldLog } : {}) };
    writeFrozen(config.stateDir, rec);
    ctx.frozen = rec;
    emit(`HANDOVER_OLD_FROZEN ${config.leadPane} agent ${ice.agentPid}: ${ice.pids.length} processes stopped (${ice.pids.join(",")}); ${closeAt ? `closes at ${closeAt} (handover.frozenCloseH ${h})` : "kept until closed by hand"}; dori handover thaw ${config.leadPane} resumes it; log ${facts.oldLog ?? "-"}`);
    emit(`HANDOVER_DONE ${config.leadPane} -> ${pane}; old session frozen`);
    record("done-frozen", []);
    await tell(pane, `[LEAD] ${COMMITTED}: the handover is checked and the old session ${config.leadPane} is frozen (its processes are stopped, its log stays); you are the lead now. Go on with step 5 of the note.`);
    emit(`${COMMITTED} lead ${pane}`);
    return { code: 0, note, to: pane };
  }
  emit(`HANDOVER_FREEZE_FAIL ${config.leadPane}: ${ice.why ?? "nothing stopped"}${ice.pids.length ? ` (stopped ${ice.pids.join(",")}, resumed)` : ""}; ${opts.keepOld ? "it stays open, told to stay idle" : "closing it instead"}`);
  for (const p of [...ice.pids].reverse()) deps.signal(p, "SIGCONT");
  if (opts.keepOld) {
    await tell(config.leadPane, `[LEAD] Handover to ${pane} is done and checked. You are no longer the lead; stay idle until the lead closes you.`);
    await tell(pane, `[LEAD] ${COMMITTED}: the handover is checked and ${config.leadPane} stays open but idle; you are the lead now. Go on with step 5 of the note.`);
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
  await tell(pane, `[LEAD] ${COMMITTED}: the handover is checked and the old session ${ok ? "is closed" : `${config.leadPane} did not close but stays idle`}; you are the lead now. Go on with step 5 of the note.`);
  emit(`${COMMITTED} lead ${pane}`);
  return { code: ok ? 0 : 1, note, to: pane };
};
