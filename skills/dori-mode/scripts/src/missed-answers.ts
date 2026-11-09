import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { liveSessions, sessionFor } from "./aoe.ts";
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

// The transcript holds the answer: its inbox row (raw or escaped inside an event or a tool result) or this sweep's line.
export const sawAnswer = (transcript: string, qid: string): boolean =>
  new RegExp(`\\\\*"qid\\\\*"\\s*:\\s*\\\\*"${qid}\\\\*"`).test(transcript) || transcript.includes(`[DORI] ANSWER ${qid} (`);

// A herdr /clear starts a new transcript while the pane's argv still names the old one. Match the pane's current title
// to the new session_info, never to a newer unrelated session in the same cwd; aoe transcripts without one use argv.
const sessionName = (path: string): string | undefined => {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(256 * 1024);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    let name: string | undefined;
    for (const line of buffer.toString("utf8", 0, bytes).split("\n")) {
      if (!line.includes('"type":"session_info"')) continue;
      try {
        const entry = JSON.parse(line) as { name?: string };
        if (entry.name) name = entry.name;
      } catch {}
    }
    return name;
  } finally {
    closeSync(fd);
  }
};

export const currentTranscript = (path: string, title: string): string => {
  if (!title) return readFileSync(path, "utf8");
  const dir = dirname(path);
  const name = readdirSync(dir).filter((n) => SESSION_FILE.test(n)).sort().reverse().find((n) => sessionName(join(dir, n)) === title);
  return readFileSync(name ? join(dir, name) : path, "utf8");
};

export type AnswerRow = { readonly id: string; readonly at: number; readonly channel?: string; readonly qid?: string; readonly thread?: string };
type SendSpec = { readonly to: string; readonly reply?: string; readonly qids: ReadonlySet<string> };
type SendCall = SendSpec & { readonly id: string; readonly at: number; sent: boolean };

const flagValue = (args: readonly unknown[], name: string): string | undefined => {
  const at = args.indexOf(name);
  const value = at < 0 ? undefined : args[at + 1];
  return typeof value === "string" ? value : undefined;
};
const qidsIn = (text: string): ReadonlySet<string> => new Set((text.match(/\bq\d+\b/gi) ?? []).map((q) => q.toUpperCase()));
const specFromArgv = (argv: readonly unknown[]): SendSpec | undefined => {
  if (argv[0] !== "dori") return undefined;
  if (argv[1] === "send" && argv[2] === "discord") {
    const to = flagValue(argv, "--thread") ?? flagValue(argv, "--to");
    if (!to) return undefined; const reply = flagValue(argv, "--reply");
    return { to, ...(reply ? { reply } : {}), qids: qidsIn(argv.filter((part) => typeof part === "string").join(" ")) };
  }
  if (argv[1] === "thread" && argv[2] === "reply" && typeof argv[3] === "string" && argv[3].startsWith("discord:")) {
    const reply = flagValue(argv, "--reply"); return { to: flagValue(argv, "--thread") ?? argv[3].slice("discord:".length), ...(reply ? { reply } : {}), qids: qidsIn(argv.filter((part) => typeof part === "string").join(" ")) };
  }
  return undefined;
};
const shellFlag = (command: string, name: string): string | undefined => { const match = command.match(new RegExp(`${name}\\s+(?:"([^"]+)"|'([^']+)'|([\\w-]+))`)); return match?.[1] ?? match?.[2] ?? match?.[3]; };
const specFromShell = (command: string): SendSpec | undefined => {
  const to = shellFlag(command, "--thread") ?? shellFlag(command, "--to") ?? command.match(/dori thread reply discord:([\w-]+)/)?.[1];
  if (!to) return undefined; const reply = shellFlag(command, "--reply");
  return { to, ...(reply ? { reply } : {}), qids: qidsIn(command) };
};
const specsFromText = (text: string): SendSpec[] => {
  const out: SendSpec[] = [];
  for (const match of text.matchAll(/\[\s*"dori"\s*,\s*(?:"send"\s*,\s*"discord"|"thread"\s*,\s*"reply")[\s\S]*?\]/g)) {
    try {
      const parsed: unknown = JSON.parse(match[0]);
      if (Array.isArray(parsed)) {
        const spec = specFromArgv(parsed);
        if (spec) out.push(spec);
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  const starts = [...text.matchAll(/\bdori send discord\b|\bdori thread reply discord:[\w-]+/g)].map((match) => match.index ?? -1).filter((at) => at >= 0);
  starts.forEach((at, i) => {
    const spec = specFromShell(text.slice(at, starts[i + 1] ?? text.length));
    if (spec) out.push(spec);
  });
  return out;
};
const sendSpecs = (value: unknown): SendSpec[] => {
  if (typeof value === "string") return specsFromText(value);
  if (Array.isArray(value)) {
    const direct = specFromArgv(value);
    return direct ? [direct] : value.flatMap(sendSpecs);
  }
  if (value && typeof value === "object") return Object.values(value).flatMap(sendSpecs);
  return [];
};

// Only an actual SENT/POSTED result of this session's own unambiguous tool call counts. A command alone, another Dori's
// send, assistant narration, another tool's quoted log, or a second send in the same eval is not a receipt. Detached eval
// results must name the originating cell id; one eval running multiple sends cannot prove which send succeeded.
const sendCalls = (transcript: string): SendCall[] => {
  const calls = new Map<string, SendCall>();
  for (const line of transcript.split("\n")) {
    if (!line.startsWith("{")) continue;
    let entry: { type?: string; timestamp?: string; customType?: string; content?: unknown; message?: { role?: string; toolCallId?: string; content?: { type?: string; id?: string; arguments?: unknown }[] } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (entry.type === "message" && entry.message?.role === "assistant") {
      for (const part of entry.message.content ?? []) {
        if (part.type !== "toolCall" || !part.id) continue;
        const specs = sendSpecs(part.arguments ?? {});
        const spec = specs.length === 1 ? specs[0] : undefined;
        if (spec) calls.set(part.id, { id: part.id, at: Date.parse(entry.timestamp ?? ""), ...spec, sent: false });
      }
    } else if (entry.message?.role === "toolResult") {
      if (!/\b(?:SENT|POSTED) \d{15,22}\b/.test(line)) continue;
      const call = entry.message.toolCallId ? calls.get(entry.message.toolCallId) : undefined;
      if (call) call.sent = true;
    } else if (entry.type === "custom_message" && entry.customType === "senpi-codemode:notification" && typeof entry.content === "string") {
      if (!/\b(?:SENT|POSTED) \d{15,22}\b/.test(entry.content)) continue;
      const cell = entry.content.match(/Detached eval cell ([^\s]+) \(js\) completed\./)?.[1];
      const call = cell ? calls.get(cell) : undefined;
      if (call) call.sent = true;
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
  const { rows, cards, lead, sessions, table, deps } = input;
  const cardById = new Map(cards.map((q) => [q.id, q]));
  const transcripts = new Map<string, string>();
  const waiting: T[] = [];
  for (const row of rows) {
    const target = row.qid ? cardById.get(row.qid)?.tmux || lead.pane : lead.pane;
    if (!transcripts.has(target)) {
      const session = sessionFor(sessions, target);
      const cwd = session?.path;
      const file = target === lead.pane ? { path: lead.path } : cwd ? await sessionFile(deps.run, deps.config.sessionsDir, target, cwd, table) : undefined;
      transcripts.set(target, file ? target === lead.pane && lead.text !== undefined ? lead.text : currentTranscript(file.path, session?.title ?? "") : "");
    }
    const transcript = transcripts.get(target) ?? "";
    if (row.qid && sawAnswer(transcript, row.qid)) continue;
    if (discordAnswered(transcript, row)) continue;
    waiting.push(row);
  }
  return waiting;
};

export const reconcileRows = async <T extends AnswerRow>(input: UnansweredInput<T> & { readonly answeredIds: readonly string[] }): Promise<{ readonly waiting: T[]; readonly answeredIds: readonly string[] }> => {
  const previous = new Set(input.answeredIds), candidates = input.rows.filter((row) => !previous.has(row.id));
  const waiting = await unansweredRows({ ...input, rows: candidates });
  const waitingIds = new Set(waiting.map((row) => row.id)), currentIds = new Set(input.rows.map((row) => row.id));
  const answeredIds = [...new Set([...input.answeredIds.filter((id) => currentIds.has(id)), ...candidates.filter((row) => !waitingIds.has(row.id)).map((row) => row.id)])]; return { waiting, answeredIds };
};

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
