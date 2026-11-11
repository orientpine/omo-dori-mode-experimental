import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { liveSessions, sessionFor } from "./aoe.ts";
import { pidAlive } from "./background.ts";
import type { FlowDeps } from "./done-flow.ts";
import { handoverRunning } from "./freshness-handover.ts";
import { frozenPanes } from "./frozen.ts";
import { manifestPath, readManifest } from "./handover.ts";
import { readHerdrSessions, sessionLog } from "./herdr-sessions.ts";
import { clock, ownerRows, tailOf } from "./lead-limit.ts";
import { callsThisDori, watchProblem } from "./lead-inbox-watch.ts";
import { sawAnswer } from "./missed-answers.ts";
import { tokenBotId } from "./messenger/discord.ts";
import { sendVerified } from "./panes.ts";
import { procTable, resolveSession, sessionDirFor } from "./session-id.ts";

// The lead hears the inbox only through a monitor its own session runs, and nothing said when there was none. On 2026-11-09
// YooDori's lead (leadPane set back by hand, not by dori handover) missed a #dori-pair request at 11:48Z; ZzangDori's lead
// moved to a new conversation at 11:11Z and missed SooDori's posts at 11:35Z and 11:50Z; SooDori's lead lost its monitor
// when soodori-herdr restarted at 09:22Z and heard nothing until it re-armed by hand at 11:36Z. LEAD_OWNER_WAITING reads
// only the owner's rows and only asks for a reply, so a pair-bot row that never reached the lead went unseen.
// Each dori watch tick reads, without a model, the session the lead's agent runs now:
// - heard: an owner, pair or pair-bot row of the last 24 hours, newer than the session, whose own id is in a delivered
//   monitor event or a raw inbox row in the session's transcript, or whose dori send --reply tool call has a real SENT
//   receipt (a reply_to id by itself or a queued work-custody record does not count); heard ids persist in lead-inbox.json
//   across compaction; a card answer redelivered by missedAnswersTick counts through sawAnswer. The first tick with a live
//   monitor baselines the existing backlog so only rows that arrive afterwards can alert;
// - watched: omo's monitor manifest of that session holds a command monitor whose command or absolute shell script names
//   the inbox file, whose process lives, not suspended, expired or with its delivery paused. /new and /resume select the
//   transcript omo wrote last, not argv's.
// LEAD_INBOX_UNHEARD when a row stayed unheard leadInboxMin, else LEAD_INBOX_UNWATCHED when the session had no live inbox
// monitor for leadInboxMin: one line typed into the lead per incident (the oldest unheard row, or the start of the gap),
// again after REPEAT_MS while it lasts; a line that did not reach the pane is logged and typed again next tick.
// LEAD_INBOX_OK once both hold again. A lead a handover froze or is moving is left alone. Only owner-row ids recorded by a
// successful LEAD_OWNER_WAITING wake are deduped, so a backfilled row with an older timestamp is still reported.

const DAY_MS = 24 * 60 * 60_000;
const INBOX_TAIL_BYTES = 512 * 1024;
const REPEAT_MS = 30 * 60_000;

type Kind = "owner" | "pair" | "pair-bot";
type Row = { readonly id: string; readonly at: number; readonly kind: Kind; readonly text: string; readonly qid?: string };
type Mark = { readonly pane: string; readonly session: string; readonly agentPid?: number; readonly log?: string; readonly missingSince?: number; readonly key?: string; readonly typedAt?: number; readonly heardIds?: readonly string[]; readonly baselineDone?: boolean };

// the rows the lead must hear: the owner's (lead-limit.ts ownerRows), every owner row of the pair channel and the pair-bot
// rows that call this Dori
export const inboxRows = (inbox: string, ownerId: string, names: readonly string[] = [], botId = ""): Row[] => {
  const owner = new Set(ownerRows(inbox, ownerId).map((r) => r.id));
  const out: Row[] = [];
  for (const line of inbox.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const r = JSON.parse(line) as { ts?: string; id?: string; scope?: string; content?: string; transcript?: string; answer?: string; qid?: string };
      const id = r.id ?? r.ts ?? "";
      const kind: Kind | undefined = owner.has(id) ? "owner" : r.scope === "pair-bot" ? "pair-bot" : r.scope === "pair" ? "pair" : undefined;
      const at = Date.parse(r.ts ?? "");
      const text = String(r.content || r.transcript || r.answer || "");
      if (kind === "pair-bot" && !callsThisDori([r.content, r.transcript, r.answer].filter(Boolean).join("\n"), names, botId)) continue;
      if (kind && id && !Number.isNaN(at)) out.push({ id, at, kind, text, ...(r.qid ? { qid: r.qid } : {}) });
    } catch {}
  }
  return out;
};

const plain = (s: string, n: number): string => s.replace(/\s+/g, " ").replace(/`/g, "'").replaceAll("$(", "$ (").trim().slice(0, n);
const counts = (rows: readonly Row[]): string => {
  const n = new Map<Kind, number>();
  for (const r of rows) n.set(r.kind, (n.get(r.kind) ?? 0) + 1);
  return [...n].map(([k, c]) => `${k} ${c}`).join(", ");
};
const markPath = (deps: FlowDeps): string => join(deps.config.stateDir, "lead-inbox.json");
const ownerWokeIds = (deps: FlowDeps, pane: string): ReadonlySet<string> => {
  try {
    const m = JSON.parse(readFileSync(join(deps.config.stateDir, "lead-limit.json"), "utf8")) as { pane?: string; wakeKey?: string; wakeIds?: readonly string[] };
    return new Set(m.pane === pane ? [...(m.wakeIds ?? []), m.wakeKey?.split("|")[0] ?? ""].filter(Boolean) : []);
  } catch {
    return new Set();
  }
};

// A monitor event carries the row's own id. A reply_to id by itself, or an id the lead merely quoted, is not delivery
// evidence; a raw inbox row in a tool result is evidence because the lead read it. A dori send --reply tool call counts
// only when its own tool result (or its eval completion) has a real SENT receipt; ambiguous multi-send calls and queued
// work-custody records are ignored.
const deliveredIds = (transcript: string): ReadonlySet<string> => {
  const ids = new Set<string>();
  const replyByCall = new Map<string, string>();
  const collect = (text: string): void => {
    for (const m of text.matchAll(/"id"\s*:\s*"([\w-]+)"/g)) if (m[1]) ids.add(m[1]);
  };
  for (const line of transcript.split("\n")) {
    try {
      const e = JSON.parse(line) as { type?: string; customType?: string; content?: unknown; message?: { role?: string; toolCallId?: string; content?: unknown } };
      if (e.customType === "work-custody") continue;
      if (e.type === "custom_message" && e.customType === "senpi-monitor:notification" && typeof e.content === "string") collect(e.content);
      const parts = Array.isArray(e.message?.content) ? e.message.content : [];
      if (e.type === "message" && e.message?.role === "assistant") {
        for (const part of parts) {
          if (typeof part !== "object" || part === null || !("type" in part) || part.type !== "toolCall" || !("id" in part) || typeof part.id !== "string") continue;
          const input = "arguments" in part ? part.arguments : "input" in part ? part.input : "";
          const args = (typeof input === "object" && input !== null && "code" in input && typeof input.code === "string" ? input.code : JSON.stringify(input)) ?? "";
          const sends = [...args.matchAll(/\bdori send\b/g)];
          if (sends.length !== 1) {
            replyByCall.delete(part.id);
            continue;
          }
          const targets = [...args.matchAll(/--reply\s+(\d{6,})/g)].map((m) => m[1] ?? "").filter(Boolean);
          const [target] = targets;
          if (targets.length === 1 && target) replyByCall.set(part.id, target);
          else replyByCall.delete(part.id);
        }
      }
      if (e.type !== "message" || e.message?.role !== "toolResult") continue;
      for (const part of parts) {
        const text = typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : "";
        if (text.includes('"channel_id"') && text.includes('"scope"')) collect(text);
        if (!/\bSENT \d{6,}\b/.test(text)) continue;
        const cell = /\bEval cell ([\w-]+) \(js\) is completed\./.exec(text)?.[1];
        const target = (e.message.toolCallId ? replyByCall.get(e.message.toolCallId) : undefined) ?? (cell ? replyByCall.get(cell) : undefined);
        if (target) ids.add(target);
      }
    } catch {}
  }
  return ids;
};

const ENV_ID = /(?:^|\s)PI_SESSION_ID=([0-9a-f-]{36})(?:\s|$)/;
const ENV_FILE = /(?:^|\s)PI_SESSION_FILE=(.+?\.jsonl)(?=\s|$)/;

// /new and /resume keep the agent's pid and argv. Of the launch, child-environment, recorded and previous-tick sessions for
// this same agent pid, omo is running the one whose transcript it wrote last. This local selection keeps #424 independent
// of #419; resolveSession takes over once that shared fix is on main. sessionLog also covers --session-dir and external logs.
const currentLeadSession = async (deps: FlowDeps, pane: string, cwd: string, table: Awaited<ReturnType<typeof procTable>>) => {
  const hit = await resolveSession(pane, cwd, table, { run: deps.run, sessionsDir: deps.config.sessionsDir, backend: "aoe" });
  if (!hit.pid) return undefined;
  const named: { id: string; log?: string | undefined }[] = hit.id ? [{ id: hit.id }] : [];
  for (const child of table.filter((p) => p.ppid === hit.pid).slice(0, 40)) {
    const line = (await deps.run(["ps", "eww", "-o", "command=", "-p", String(child.pid)])).out.replace(/\r?\n$/, "");
    const env = line.startsWith(child.cmd) ? line.slice(child.cmd.length) : "";
    const id = ENV_ID.exec(env)?.[1];
    if (id) named.push({ id, log: ENV_FILE.exec(env)?.[1] });
  }
  const previous = readMark(deps);
  if (previous?.pane === pane && previous.agentPid === hit.pid) named.push({ id: previous.session, log: previous.log });
  const kept = readHerdrSessions(deps.config.stateDir)[pane];
  if (kept?.session) named.push({ id: kept.session, log: kept.log });
  if (!named.length) return undefined;
  const candidates = await Promise.all([...new Set(named.map((n) => n.id))].map(async (id) => {
    const hint = named.findLast((n) => n.id === id && n.log)?.log;
    let path = await sessionLog(deps.run, table, hit.pid!, id, deps.config.sessionsDir, cwd, hint);
    if (!path) {
      try {
        const dir = sessionDirFor(deps.config.sessionsDir, cwd);
        const name = readdirSync(dir).find((n) => n.endsWith(`_${id}.jsonl`));
        path = name ? join(dir, name) : undefined;
      } catch {}
    }
    let at = Number.NEGATIVE_INFINITY;
    try {
      if (path) at = statSync(path).mtimeMs;
    } catch {}
    return { id, path, at };
  }));
  const current = candidates.reduce((a, b) => (b.at > a.at ? b : a));
  return current.path ? { path: current.path, pid: hit.pid } : undefined;
};
const readMark = (deps: FlowDeps): Mark | undefined => {
  try {
    return JSON.parse(readFileSync(markPath(deps), "utf8")) as Mark;
  } catch {
    return undefined;
  }
};

export const leadInboxTick = async (deps: FlowDeps, alive: (pid: number) => boolean = pidAlive): Promise<string[]> => {
  const { leadPane: pane, leadInboxMin, stateDir, sessionsDir } = deps.config;
  const inbox = deps.ownerInbox;
  if (!pane || !inbox || leadInboxMin <= 0 || !existsSync(inbox.path)) return [];
  if (frozenPanes(stateDir).includes(pane) || handoverRunning(stateDir, "lead", "lead", alive)) return [];
  const [sessions, table] = await Promise.all([liveSessions(deps.run), procTable(deps.run)]);
  const cwd = sessionFor(sessions, pane)?.path;
  const file = cwd ? await currentLeadSession(deps, pane, cwd, table) : undefined;
  const session = file ? /_([^_]+)\.jsonl$/.exec(file.path)?.[1] : undefined;
  if (!cwd || !file || !session) return [];
  const now = deps.clock.now();
  const wait = leadInboxMin * 60_000;
  const text = readFileSync(file.path, "utf8");
  const start = Date.parse(/"timestamp":"([^"]+)"/.exec(text)?.[1] ?? "");
  const told = ownerWokeIds(deps, pane);
  const rows = inboxRows(tailOf(inbox.path, INBOX_TAIL_BYTES), inbox.ownerId, deps.config.discord.callNames, deps.config.discord.botId || tokenBotId(process.env["DORI_DISCORD_TOKEN"] ?? "") || "");
  const delivered = deliveredIds(text);
  const deliveredText = text.split("\n").filter((line) => !line.includes('"customType":"work-custody"')).join("\n");
  const candidates = rows.filter((r) => now - r.at < DAY_MS && !(r.at < start)).sort((a, b) => a.at - b.at);
  const candidateIds = new Set(candidates.map((r) => r.id));
  const besideLog = join(dirname(file.path), "extensions", "terminal", `${session}.json`);
  const problem = watchProblem(readManifest(existsSync(besideLog) ? besideLog : manifestPath(sessionsDir, cwd, session)), inbox.path, now, alive);

  const old = readMark(deps);
  const sameSession = old?.pane === pane && old.session === session && (old.agentPid === undefined || old.agentPid === file.pid);
  const mark: Mark = sameSession ? { ...old, agentPid: file.pid, log: file.path } : { pane, session, agentPid: file.pid, log: file.path };
  const heard = new Set([...(sameSession ? (old?.heardIds ?? []) : [])].filter((id) => candidateIds.has(id)));
  for (const row of candidates) {
    if (delivered.has(row.id) || (row.kind === "owner" && told.has(row.id)) || (row.qid && sawAnswer(deliveredText, row.qid))) heard.add(row.id);
  }
  const baseline = !problem && (!sameSession || old?.baselineDone !== true);
  if (baseline) for (const row of candidates) heard.add(row.id);
  const unheard = candidates.filter((row) => !heard.has(row.id));
  const baselineDone = !problem || (sameSession && old?.baselineDone === true);
  const heardState = { heardIds: [...heard].sort(), ...(baselineDone ? { baselineDone: true } : {}) };
  const missingSince = problem ? (mark.missingSince ?? now) : undefined;
  let next: Mark = { pane, session, agentPid: file.pid, log: file.path, ...heardState, ...(missingSince !== undefined ? { missingSince } : {}), ...(mark.key ? { key: mark.key, typedAt: mark.typedAt } : {}) };
  const out: string[] = [];
  const oldest = unheard[0];
  const newest = unheard.at(-1);
  const watchNote = problem ? `Your session runs no live inbox monitor (${problem}). ` : "";
  const incident = oldest && newest && now - oldest.at >= wait
    ? {
        key: `unheard|${session}|${oldest.id}`,
        head: `LEAD_INBOX_UNHEARD ${pane} ${unheard.length} inbox row(s) (${counts(unheard)}) never reached session ${session}, oldest ${oldest.id} ${new Date(oldest.at).toISOString()} (${Math.floor((now - oldest.at) / 60_000)} min)${problem ? `, no live inbox monitor (${problem})` : ""}`,
        text: `[DORI] LEAD_INBOX_UNHEARD: ${unheard.length} inbox row(s) since ${clock(deps, oldest.at)} never reached your session (${counts(unheard)}). ${watchNote}Read them in ${inbox.path} now and act on them (the newest: "${plain(newest.text, 120)}")${problem ? `; then arm a persistent monitor on the inbox again, for example tail -n 0 -F ${inbox.path}` : ""}.`,
      }
    : problem && missingSince !== undefined && now - missingSince >= wait
      ? {
          key: `unwatched|${session}|${missingSince}`,
          head: `LEAD_INBOX_UNWATCHED ${pane} session ${session} since ${new Date(missingSince).toISOString()}: ${problem}`,
          text: `[DORI] LEAD_INBOX_UNWATCHED: your session hears no inbox row (${problem}), so owner and pair messages do not reach you. Arm a persistent monitor on the inbox now, for example tail -n 0 -F ${inbox.path}, and read the rows since ${clock(deps, missingSince)} in it.`,
        }
      : undefined;

  if (incident && (incident.key !== mark.key || now - (mark.typedAt ?? 0) >= REPEAT_MS)) {
    const ok = await sendVerified(deps.run, deps.clock, deps.config, pane, incident.text);
    if (ok) next = { ...next, key: incident.key, typedAt: now };
    out.push(`${incident.head}; ${ok ? "woke the lead (SUBMITTED)" : "NOT_SUBMITTED: the line did not reach the pane, typed again next tick"}`);
  } else if (!incident && !problem && !unheard.length && mark.key) {
    next = { pane, session, agentPid: file.pid, log: file.path, ...heardState };
    out.push(`LEAD_INBOX_OK ${pane} session ${session} hears its inbox again`);
  }
  if (JSON.stringify(next) !== JSON.stringify(old)) writeFileSync(markPath(deps), `${JSON.stringify(next)}\n`);
  return out;
};
