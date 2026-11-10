import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { liveSessions, sessionFor } from "./aoe.ts";
import { shellWords } from "./handover.ts";
import type { AoeSession } from "./aoe.ts";
import { sessionFile } from "./background.ts";
import type { FlowDeps } from "./done-flow.ts";
import type { Question } from "./messenger/discord-cards.ts";
import { sendVerified } from "./panes.ts";
import { iso } from "./run.ts";
import { procTable, SESSION_FILE } from "./session-id.ts";
import type { Proc } from "./session-id.ts";

// A card's answer reaches the session that asked only as one inbox row its monitor turns into an event. An event that
// arrives while omo compacts the session's context is lost (2026-10-19: Q305 answered 20:37:23Z during the lead's
// compaction 20:37:03-31Z never reached it, and the lead kept waiting). So the watch reads each card answered in the last
// MISSED_ANSWER_WINDOW_MS, at least MISSED_ANSWER_GRACE_MS ago, and looks in the transcript of the session that asked
// (the card's tmux, else the lead's pane) for that answer: the inbox row ("qid":"Qn" in a monitor event or a tool result)
// or this sweep's own line. Missing, and answered after that session started: the answer is typed into that pane once.
// Nothing goes to the owner's channel: CARD_ANSWER_REDELIVERED / _NOT_SUBMITTED / _GAVE_UP are watch log lines.
export const MISSED_ANSWER_GRACE_MS = 3 * 60_000;
export const MISSED_ANSWER_WINDOW_MS = 2 * 60 * 60_000;
const MAX_TRIES = 3;

type Marks = Record<string, { readonly at: string; readonly tries: number; readonly sent: boolean }>;
const marksPath = (deps: FlowDeps): string => join(deps.config.stateDir, "answers-redelivered.json");
const readMarks = (deps: FlowDeps): Marks => {
  const path = marksPath(deps);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Marks;
  } catch {
    return {};
  }
};

export const answerLine = (q: Question): string =>
  `[DORI] ANSWER ${q.id} (${q.answerKind ?? "button"}, ${q.answeredAt}): ${q.answer ?? ""}\nquestion: ${q.text}\n(the inbox monitor's event for this answer never reached this session, e.g. it came during a context compaction; this is that answer)`;

// The transcript holds this answer: its inbox row (raw or escaped inside an event or a tool result) or this sweep's line.
// A reopened qid needs the row's own id or a timestamp at/after that row, never an earlier answer with the same qid.
const embeddedObjects = (text: string): { kind?: string; qid?: string; id?: string; ts?: string; answeredAt?: string }[] => {
  const out: { kind?: string; qid?: string; id?: string; ts?: string; answeredAt?: string }[] = []; for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue; const raw = balancedBlock(text, i);
    if (raw) { try { const parsed: unknown = Bun.JSON5.parse(raw); if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "kind" in parsed && parsed.kind === "answer") out.push({ ...parsed, kind: "answer" }); } catch {}
      if (out.at(-1)?.kind === "answer") i += raw.length - 1;
    }
  }
  return out;
};
const answerRecords = (value: unknown): { kind?: string; qid?: string; id?: string; ts?: string; answeredAt?: string }[] => {
  if (typeof value === "string") return embeddedObjects(value);
  if (Array.isArray(value)) return value.flatMap(answerRecords); if (value && typeof value === "object") { const record = value as { kind?: string; qid?: string; id?: string; ts?: string; answeredAt?: string }; return [...(record.kind === "answer" ? [record] : []), ...Object.values(record).flatMap(answerRecords)]; }
  return []; };
export const sawAnswer = (transcript: string, qid: string, row?: AnswerRow, answeredAt?: string): boolean => {
  return transcript.split("\n").some((line) => {
    if (!line.includes(qid)) return false; try {
      const entry = JSON.parse(line) as { type?: string; customType?: string; content?: unknown; message?: { role?: string; content?: unknown } }, content = entry.type === "message" && ["user", "toolResult"].includes(entry.message?.role ?? "") ? entry.message?.content : entry.type === "custom_message" && ["senpi-monitor:notification", "senpi-codemode:notification"].includes(entry.customType ?? "") ? entry.content : undefined;
      if (content === undefined) return false; const redelivered = (typeof content === "string" ? content : JSON.stringify(content)).match(new RegExp(`\\[DORI\\] ANSWER ${qid} \\([^,]+, ([^)]+)\\)`))?.[1];
      if (redelivered !== undefined) return !row || (answeredAt !== undefined && Date.parse(redelivered) === Date.parse(answeredAt)); return answerRecords(content).some((record) => record.kind === "answer" && record.qid === qid && (!row || (row.id && record.id === row.id) || Date.parse(record.ts ?? record.answeredAt ?? "") >= row.at));
    } catch { return false; }
  }); };

// A herdr /clear starts a new transcript while the pane's argv still names the old one. Match the pane's current title
// to session_info only as a fallback: /resume can select an older same-name agent-linked transcript.
const sessionName = (path: string): string | undefined => {
  const fd = openSync(path, "r"); try {
    const buffer = Buffer.alloc(256 * 1024), bytes = readSync(fd, buffer, 0, buffer.length, 0); let name: string | undefined;
    for (const line of buffer.toString("utf8", 0, bytes).split("\n")) {
      if (!line.includes('"type":"session_info"')) continue;
      try { const entry = JSON.parse(line) as { name?: string }; if (entry.name) name = entry.name; } catch {}
    }
    return name; } finally { closeSync(fd); }
};

export const currentTranscript = (path: string, title: string): string => {
  if (!title || sessionName(path) === title) return readFileSync(path, "utf8"); const dir = dirname(path), name = readdirSync(dir).filter((n) => SESSION_FILE.test(n)).sort().reverse().find((n) => sessionName(join(dir, n)) === title);
  return readFileSync(name ? join(dir, name) : path, "utf8"); };

export type AnswerRow = { readonly id: string; readonly at: number; readonly channel?: string; readonly qid?: string; readonly thread?: string; readonly tmux?: string };
type SendSpec = { readonly to: string; readonly reply?: string; readonly qids: ReadonlySet<string> };
type SendCall = SendSpec & { readonly id: string; readonly at: number; sent: boolean };

const flagValue = (args: readonly unknown[], name: string): string | undefined => { const at = args.indexOf(name), value = at < 0 ? undefined : args[at + 1]; return typeof value === "string" ? value : undefined; };
const qidsIn = (text: string): ReadonlySet<string> => new Set((text.match(/\bq\d+\b/gi) ?? []).map((q) => q.toUpperCase()));
const specFromArgv = (argv: readonly unknown[]): SendSpec | undefined => {
  if (argv[0] !== "dori") return undefined; const to = argv[1] === "send" && argv[2] === "discord" ? flagValue(argv, "--thread") ?? flagValue(argv, "--to") : argv[1] === "thread" && argv[2] === "reply" && typeof argv[3] === "string" && argv[3].startsWith("discord:") ? flagValue(argv, "--thread") ?? argv[3].slice("discord:".length) : undefined;
  if (!to) return undefined; const reply = flagValue(argv, "--reply");
  return { to, ...(reply ? { reply } : {}), qids: qidsIn(argv.filter((part) => typeof part === "string").join(" ")) }; };
const specFromShell = (command: string): SendSpec | undefined => {
  const ends = [command.length, ...[...command.matchAll(/['";|&]/g)].map((match) => match.index ?? -1).filter((at) => at > 0)].sort((a, b) => b - a), args = ends.map((end) => shellWords(command.slice(0, end))).find((words) => words) ?? shellWords(command);
  if (!args) return undefined; const to = flagValue(args, "--thread") ?? flagValue(args, "--to") ?? command.match(/dori thread reply discord:([\w-]+)/)?.[1]; if (!to) return undefined; const reply = flagValue(args, "--reply");
  return { to, ...(reply ? { reply } : {}), qids: qidsIn(command) }; };
const balancedBlock = (text: string, start: number): string | undefined => {
  let depth = 0, quote = ""; for (let i = start; i < text.length; i++) {
    const c = text[i] ?? "";
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = ""; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === text[start]) depth++;
    else if (c === (text[start] === "[" ? "]" : "}")) { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return undefined;
};
const codePosition = (text: string, end: number): boolean => {
  let quote = "", comment = ""; for (let i = 0; i < end; i++) {
    const c = text[i] ?? "", next = text[i + 1] ?? "";
    if (comment === "line") { if (c === "\n") comment = ""; continue; }
    if (comment === "block") { if (c === "*" && next === "/") { comment = ""; i++; } continue; }
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = ""; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "/" && (next === "/" || next === "*")) { comment = next === "/" ? "line" : "block"; i++; continue; }
  }
  return !quote && !comment;
};
const arrayCommandPrefix = (raw: string): string => {
  let quote = ""; for (let i = 1; i < raw.length - 1; i++) {
    const c = raw[i] ?? "";
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = ""; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "{") return `${raw.slice(0, i)}]`;
  }
  return raw;
};
const literalArrays = (text: string): string[] => {
  const out: string[] = []; for (const match of text.matchAll(/\[\s*["']dori["']\s*,\s*["'](?:send|thread)["']/g)) {
    const start = match.index ?? -1; if (start < 0 || !codePosition(text, start) || !/(?:Bun\.spawn|Bun\.spawnSync|subprocess\.run|spawn|execFile|execa|exec)\s*\(\s*$/.test(text.slice(0, start))) continue;
    const raw = balancedBlock(text, start); if (raw) out.push(raw);
  }
  return out; };
const specsFromText = (text: string): SendSpec[] => {
  const out: SendSpec[] = []; for (const raw of literalArrays(text)) {
    try {
      const parsed: unknown = Bun.JSON5.parse(arrayCommandPrefix(raw)); if (Array.isArray(parsed)) { const spec = specFromArgv(parsed); if (spec) out.push(spec); }
    } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  }
  const starts = [...text.matchAll(/\bdori send discord\b|\bdori thread reply discord:[\w-]+/g)].map((match) => match.index ?? -1).filter((at) => at >= 0); starts.forEach((at, i) => {
    const before = text.slice(0, at), segment = before.split(/[;|&]/).at(-1) ?? "";
    if (/\b(?:grep|rg|cat|head|tail|sed|awk|find|strings)\b/.test(segment)) return; const spec = specFromShell(text.slice(at, starts[i + 1] ?? text.length)); if (spec) out.push(spec);
  });
  return out; };
const sendSpecs = (value: unknown): SendSpec[] => {
  if (typeof value === "string") return [...specsFromText(value), ...(/\bdori thread (?:done|wait)\b/.test(value) || /["']dori["']\s*,\s*["']thread["']\s*,\s*["'](?:done|wait)["']/.test(value) ? [{ to: "", qids: new Set<string>() }] : [])]; if (Array.isArray(value)) { if (value[0] === "dori" && value[1] === "thread" && ["done", "wait"].includes(String(value[2]))) return [{ to: "", qids: new Set<string>() }]; const direct = specFromArgv(value); return direct ? [direct] : value.flatMap(sendSpecs); }
  if (value && typeof value === "object") return Object.values(value).flatMap(sendSpecs); return [];
};

// Only an actual SENT/POSTED result of this session's own unambiguous tool call counts. A command alone, another Dori's
// send, assistant narration, another tool's quoted log, or a second send in the same eval is not a receipt. Detached eval
// results must name the originating cell id; one eval running multiple sends cannot prove which send succeeded.
const sendCalls = (transcript: string): SendCall[] => {
  const calls = new Map<string, SendCall>();
  for (const line of transcript.split("\n")) {
    if (!line.startsWith("{")) continue;
    let entry: { type?: string; timestamp?: string; customType?: string; content?: unknown; message?: { role?: string; toolCallId?: string; content?: { type?: string; id?: string; name?: string; arguments?: unknown }[] } };
    try { entry = JSON.parse(line) as typeof entry; } catch { continue; }
    if (entry.type === "message" && entry.message?.role === "assistant") {
      for (const part of entry.message.content ?? []) {
        if (part.type !== "toolCall" || !part.id || !["eval", "bash", "monitor"].includes(part.name ?? "")) continue; const specs = sendSpecs(part.arguments ?? {}), spec = specs.length === 1 ? specs[0] : undefined; if (spec) calls.set(part.id, { id: part.id, at: Date.parse(entry.timestamp ?? ""), ...spec, sent: false });
      }
    } else if (entry.message?.role === "toolResult") {
      if (!/\b(?:SENT|POSTED) \d{15,22}\b/.test(line)) continue; const call = entry.message.toolCallId ? calls.get(entry.message.toolCallId) : undefined;
      if (call) call.sent = true;
    } else if (entry.type === "custom_message" && entry.customType === "senpi-codemode:notification" && typeof entry.content === "string") {
      if (!/\b(?:SENT|POSTED) \d{15,22}\b/.test(entry.content)) continue; const cell = entry.content.match(/Detached eval cell ([^\s]+) \((?:js|py)\) completed\./)?.[1], call = cell ? calls.get(cell) : undefined; if (call) call.sent = true;
    }
  }
  return [...calls.values()];
};

export const discordAnswered = (transcript: string, row: AnswerRow): boolean =>
  sendCalls(transcript).some((call) => call.sent && call.at >= row.at && (row.qid ? call.to === row.thread && call.qids.has(row.qid) : call.to === row.channel && call.reply === row.id));

type UnansweredInput<T extends AnswerRow> = {
  readonly rows: readonly T[];
  readonly cards: readonly Question[];
  readonly lead: { readonly pane: string; readonly path: string; readonly title: string; readonly text?: string };
  readonly sessions: readonly AoeSession[];
  readonly table: readonly Proc[];
  readonly deps: FlowDeps;
};

export const unansweredRows = async <T extends AnswerRow>(input: UnansweredInput<T>): Promise<T[]> => {
  const { rows, cards, lead, sessions, table, deps } = input, cardById = new Map(cards.map((q) => [q.id, q])), transcripts = new Map<string, string>(), waiting: T[] = [];
  for (const row of rows) {
    const target = row.qid ? cardById.get(row.qid)?.tmux || row.tmux || lead.pane : lead.pane;
    if (!transcripts.has(target)) {
      const session = sessionFor(sessions, target), cwd = session?.path;
      const file = target === lead.pane ? { path: lead.path } : cwd ? await sessionFile(deps.run, deps.config.sessionsDir, target, cwd, table) : undefined; transcripts.set(target, file ? target === lead.pane && lead.text !== undefined ? lead.text : currentTranscript(file.path, session?.title ?? "") : "");
    }
    const transcript = transcripts.get(target) ?? "";
    if (row.qid && sawAnswer(transcript, row.qid, row, cardById.get(row.qid)?.answeredAt)) continue; if (discordAnswered(transcript, row)) continue;
    waiting.push(row);
  }
  return waiting;
};

export const reconcileRows = async <T extends AnswerRow>(input: UnansweredInput<T>): Promise<{ readonly waiting: T[]; readonly answeredIds: readonly string[] }> => {
  const path = join(input.deps.config.stateDir, "lead-answered.json"); let previousIds: string[] = [];
  try { previousIds = JSON.parse(readFileSync(path, "utf8")) as string[]; } catch (error) { if (!(error instanceof SyntaxError) && !(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  const previous = new Set(previousIds), candidates = input.rows.filter((row) => !previous.has(row.id)); const waiting = await unansweredRows({ ...input, rows: candidates });
  const waitingIds = new Set(waiting.map((row) => row.id)), currentIds = new Set(input.rows.map((row) => row.id));
  const answeredIds = [...new Set([...previousIds.filter((id) => currentIds.has(id)), ...candidates.filter((row) => !waitingIds.has(row.id)).map((row) => row.id)])]; if (answeredIds.join("\0") !== previousIds.join("\0")) writeFileSync(path, `${JSON.stringify(answeredIds)}\n`);
  return { waiting, answeredIds }; };

const sessionStart = (transcript: string): number => {
  const first = transcript.slice(0, transcript.indexOf("\n") >>> 0);
  try {
    return Date.parse((JSON.parse(first) as { timestamp?: string }).timestamp ?? "");
  } catch {
    return Number.NaN;
  }
};

export const missedAnswersTick = async (deps: FlowDeps): Promise<string[]> => {
  const now = deps.clock.now();
  const cards = (deps.answeredCards?.() ?? []).filter((q) => {
    const at = Date.parse(q.answeredAt ?? "");
    return q.status === "answered" && now - at >= MISSED_ANSWER_GRACE_MS && now - at < MISSED_ANSWER_WINDOW_MS;
  });
  const marks = readMarks(deps);
  const due = cards.filter((q) => !marks[q.id]?.sent && (marks[q.id]?.tries ?? 0) < MAX_TRIES && (q.tmux || deps.config.leadPane));
  if (!due.length) return [];
  const [sessions, table] = await Promise.all([liveSessions(deps.run), procTable(deps.run)]);
  const out: string[] = [];
  const transcripts = new Map<string, string | undefined>();
  for (const q of due) {
    const pane = q.tmux || deps.config.leadPane;
    const cwd = sessionFor(sessions, pane)?.path;
    if (!cwd) continue;
    if (!transcripts.has(pane)) {
      const file = await sessionFile(deps.run, deps.config.sessionsDir, pane, cwd, table);
      transcripts.set(pane, file ? currentTranscript(file.path, sessionFor(sessions, pane)?.title ?? "") : undefined);
    }
    const text = transcripts.get(pane);
    // a session that started after the answer (a rollover) did not ask: the handover carries what it needs
    if (!text || sawAnswer(text, q.id) || !(sessionStart(text) < Date.parse(q.answeredAt ?? ""))) continue;
    const ok = await sendVerified(deps.run, deps.clock, deps.config, pane, answerLine(q));
    const tries = (marks[q.id]?.tries ?? 0) + 1;
    marks[q.id] = { at: iso(deps.clock), tries, sent: ok };
    out.push(
      ok
        ? `CARD_ANSWER_REDELIVERED ${q.id} ${pane}: answered ${q.answeredAt}, not in that session's transcript; typed it there (SUBMITTED)`
        : tries >= MAX_TRIES
          ? `CARD_ANSWER_GAVE_UP ${q.id} ${pane}: ${tries} tries did not reach the pane; read it with dori questions`
          : `CARD_ANSWER_NOT_SUBMITTED ${q.id} ${pane}: answered ${q.answeredAt}, not in that session's transcript; the message did not reach the pane (try ${tries}/${MAX_TRIES})`,
    );
  }
  writeFileSync(marksPath(deps), `${JSON.stringify(marks, null, 1)}\n`);
  return out;
};
