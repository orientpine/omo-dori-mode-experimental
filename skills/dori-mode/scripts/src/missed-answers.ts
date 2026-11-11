import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { liveSessions, sessionFor } from "./aoe.ts";
import { balancedBlock, discordAnswered, type AnswerRow } from "./answer-sends.ts";
export { discordAnswered, type AnswerRow } from "./answer-sends.ts";
import type { AoeSession } from "./aoe.ts";
import { sessionFile } from "./background.ts";
import { argvSessionLog, readHerdrSessions } from "./herdr-sessions.ts";
import { lanePredecessorTranscripts, predecessorTranscripts } from "./answer-predecessors.ts";
import type { FlowDeps } from "./done-flow.ts";
import type { Question } from "./messenger/discord-cards.ts";
import { sendVerified } from "./panes.ts";
import { iso } from "./run.ts";
import { type Lane, statusOf } from "./registry.ts";
import { procTable, SESSION_FILE } from "./session-id.ts";
import type { Proc, SessionHit } from "./session-id.ts";

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
    if (raw) { try { const parsed: unknown = Bun.JSON5.parse(raw); out.push(...answerRecords(parsed)); i += raw.length - 1; }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    }
  }
  return out;
};
const answerRecords = (value: unknown): { kind?: string; qid?: string; id?: string; ts?: string; answeredAt?: string }[] => {
  if (typeof value === "string") {
    try { const parsed: unknown = JSON.parse(value); return answerRecords(parsed); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; return embeddedObjects(value); }
  }
  if (Array.isArray(value)) return value.flatMap(answerRecords); if (value && typeof value === "object") { const record = value as { kind?: string; qid?: string; id?: string; ts?: string; answeredAt?: string }; return record.kind === "answer" ? [record] : Object.values(record).flatMap(answerRecords); }
  return []; };
export const sawAnswer = (transcript: string, qid: string, row?: AnswerRow, answeredAt?: string): boolean => {
  return transcript.split("\n").some((line) => {
    if (!line.includes(qid)) return false; try {
      const entry = JSON.parse(line) as { type?: string; customType?: string; content?: unknown; message?: { role?: string; content?: unknown } }, content = entry.type === "message" && ["user", "toolResult"].includes(entry.message?.role ?? "") ? entry.message?.content : entry.type === "custom_message" && ["senpi-monitor:notification", "senpi-codemode:notification"].includes(entry.customType ?? "") ? entry.content : undefined;
      if (content === undefined) return false; const redelivered = (typeof content === "string" ? content : JSON.stringify(content)).match(new RegExp(`\\[DORI\\] ANSWER ${qid} \\([^,]+, ([^)]+)\\)`))?.[1];
      if (redelivered !== undefined) return !row || (answeredAt !== undefined && Date.parse(redelivered) === Date.parse(answeredAt)); return answerRecords(content).some((record) => record.kind === "answer" && record.qid === qid && (!row || (row.id && record.id === row.id) || Date.parse(record.ts ?? record.answeredAt ?? "") >= row.at));
    } catch { return false; }
  }); };

// Child environments survive /clear. Compare their resolved log with current-title logs by write time; an older
// same-name /resume wins when its log was written last, including after its identifying child ended (same-agent record).
const sessionName = (path: string): string | undefined => {
  const fd = openSync(path, "r"); try {
    const buffer = Buffer.alloc(256 * 1024), bytes = readSync(fd, buffer, 0, buffer.length, 0); let name: string | undefined;
    for (const line of buffer.toString("utf8", 0, bytes).split("\n")) {
      if (!line.includes('"type":"session_info"')) continue;
      try { const entry = JSON.parse(line) as { name?: string }; if (entry.name) name = entry.name; } catch {}
    }
    return name; } finally { closeSync(fd); }
};

export const currentTranscript = (file: { readonly path: string; readonly via?: SessionHit["via"] }, title: string): string => {
  if (!title) return readFileSync(file.path, "utf8");
  const dir = dirname(file.path), matches = readdirSync(dir).filter((n) => SESSION_FILE.test(n)).sort().reverse().map((n) => join(dir, n)).filter((path) => sessionName(path) === title).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  const newest = matches[0], resolved = file.via === "child-env" && sessionName(file.path) === title;
  return readFileSync(newest && (!resolved || statSync(newest).mtimeMs > statSync(file.path).mtimeMs) ? newest : file.path, "utf8"); };


type UnansweredInput<T extends AnswerRow> = {
  readonly rows: readonly T[];
  readonly cards: readonly Question[];
  readonly lead: { readonly pane: string; readonly path: string; readonly title: string; readonly text?: string };
  readonly sessions: readonly AoeSession[];
  readonly table: readonly Proc[];
  readonly deps: FlowDeps;
};

export const readAnswerHistory = (path: string): Question[] =>
  existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Question) : [];

export const unansweredRows = async <T extends AnswerRow>(input: UnansweredInput<T>): Promise<T[]> => {
  const { rows, cards, lead, sessions, table, deps } = input, cardById = new Map(cards.map((q) => [q.id, q])), transcripts = new Map<string, { readonly text: string; readonly path?: string }>(), waiting: T[] = [];
  const history = deps.answerHistory?.() ?? [];
  let archived: readonly Lane[] | undefined;
  const predecessors = new Map<string, readonly string[]>();
  for (const row of rows) {
    // Inbox ts is written after QuestionStore.answer. Pick the last version at that instant, never today's live card.
    const version = row.qid ? history.filter((q) => q.id === row.qid && Date.parse(q.answeredAt ?? "") <= row.at).sort((a, b) => Date.parse(b.answeredAt ?? "") - Date.parse(a.answeredAt ?? ""))[0] : undefined;
    const target = row.qid ? version?.tmux || cardById.get(row.qid)?.tmux || row.tmux || lead.pane : lead.pane;
    const session = sessionFor(sessions, target), key = session || target === lead.pane ? target : `${target}\0${row.at}`;
    if (!transcripts.has(key)) {
      const cwd = session?.path;
      let file = target === lead.pane ? { path: lead.path } : cwd ? await sessionFile(deps.run, deps.config.sessionsDir, target, cwd, table, deps.config.stateDir) : undefined;
      if (!file && !session && target !== lead.pane) {
        // Closing a lane keeps its session identity and log. Read that exact session, never a newer same-title log.
        archived ??= await deps.registry.list();
        const lane = archived.filter((l) => l.pane === target && statusOf(l) === "closed" && Date.parse(l.openedAt) <= row.at && row.at <= Date.parse(l.closedAt ?? "")).sort((a, b) => Date.parse(b.openedAt) - Date.parse(a.openedAt))[0];
        if (lane?.session && lane.cwd) {
          const kept = readHerdrSessions(deps.config.stateDir)[target];
          const path = kept?.session === lane.session && kept.cwd === lane.cwd && kept.log && existsSync(kept.log) ? kept.log : argvSessionLog([], deps.config.sessionsDir, lane.cwd, lane.session);
          if (path) file = { path };
        }
      }
      transcripts.set(key, { text: file ? target === lead.pane && lead.text !== undefined ? lead.text : currentTranscript(file, session?.title ?? "") : "", ...(file ? { path: file.path } : {}) });
    }
    const current = transcripts.get(key), transcript = current?.text ?? "";
    if (row.qid && sawAnswer(transcript, row.qid, row, version?.answeredAt ?? cardById.get(row.qid)?.answeredAt)) continue; if (discordAnswered(transcript, row)) continue;
    if (target === lead.pane || row.qid) {
      let texts = predecessors.get(key);
      if (!texts) {
        const root = target === lead.pane || !session ? lead : current?.path ? { pane: target, path: current.path, text: transcript } : undefined;
        texts = root ? predecessorTranscripts(deps, root, target === lead.pane ? undefined : target) : [];
        if (row.qid && target !== lead.pane && !session) {
          archived ??= await deps.registry.list();
          texts = [...texts, ...lanePredecessorTranscripts(deps, archived, { pane: target, at: row.at, ...(version?.session ? { session: version.session } : {}) })];
        }
        predecessors.set(key, texts);
      }
      if (texts.some((text) => (row.qid && sawAnswer(text, row.qid, row, version?.answeredAt ?? cardById.get(row.qid)?.answeredAt)) || discordAnswered(text, row))) continue;
    }
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
      const file = await sessionFile(deps.run, deps.config.sessionsDir, pane, cwd, table, deps.config.stateDir);
      transcripts.set(pane, file ? currentTranscript(file, sessionFor(sessions, pane)?.title ?? "") : undefined);
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
