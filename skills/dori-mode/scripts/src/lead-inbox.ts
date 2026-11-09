import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { liveSessions, sessionFor } from "./aoe.ts";
import { pidAlive, sessionFile } from "./background.ts";
import type { FlowDeps } from "./done-flow.ts";
import { handoverRunning } from "./freshness-handover.ts";
import { frozenPanes } from "./frozen.ts";
import { manifestPath, readManifest } from "./handover.ts";
import { clock, ownerRows, tailOf } from "./lead-limit.ts";
import { sendVerified } from "./panes.ts";
import { procTable } from "./session-id.ts";

// The lead hears the inbox only through a monitor its own session runs, and nothing said when there was none. On 2026-11-09
// YooDori's lead (leadPane set back by hand, not by dori handover) missed a #dori-pair request at 11:48Z; ZzangDori's lead
// moved to a new conversation at 11:11Z and missed SooDori's posts at 11:35Z and 11:50Z; SooDori's lead lost its monitor
// when soodori-herdr restarted at 09:22Z and heard nothing until it re-armed by hand at 11:36Z. LEAD_OWNER_WAITING reads
// only the owner's rows and only asks for a reply, so a pair-bot row that never reached the lead went unseen.
// Each dori watch tick reads, without a model, the session the lead's agent runs now:
// - heard: an owner, pair or pair-bot row of the last 24 hours, newer than the session, whose id is in the session's
//   transcript (a monitor event carries the row's JSON; a record of a delivery still queued does not count);
// - watched: omo's monitor manifest of that session holds a command monitor on the inbox file whose process lives, not
//   suspended, expired or with its delivery paused.
// LEAD_INBOX_UNHEARD when a row stayed unheard leadInboxMin, else LEAD_INBOX_UNWATCHED when the session had no live inbox
// monitor for leadInboxMin: one line typed into the lead per incident (the oldest unheard row, or the start of the gap),
// again after REPEAT_MS while it lasts; a line that did not reach the pane is logged and typed again next tick.
// LEAD_INBOX_OK once both hold again. A lead a handover froze or is moving is left alone. An owner row LEAD_OWNER_WAITING
// already typed into the lead (lead-limit.json wokeAt) counts as told, so one message is not typed twice.

const DAY_MS = 24 * 60 * 60_000;
const INBOX_TAIL_BYTES = 512 * 1024;
const REPEAT_MS = 30 * 60_000;

type Kind = "owner" | "pair" | "pair-bot";
type Row = { readonly id: string; readonly at: number; readonly kind: Kind; readonly text: string };
type Mark = { readonly pane: string; readonly session: string; readonly missingSince?: number; readonly key?: string; readonly typedAt?: number };
type Entry = ReturnType<typeof readManifest>[number] & { readonly deliveryPaused?: boolean };

// the rows the lead must hear: the owner's (lead-limit.ts ownerRows) and every row of the pair channel
export const inboxRows = (inbox: string, ownerId: string): Row[] => {
  const owner = new Set(ownerRows(inbox, ownerId).map((r) => r.id));
  const out: Row[] = [];
  for (const line of inbox.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const r = JSON.parse(line) as { ts?: string; id?: string; scope?: string; content?: string; transcript?: string; answer?: string };
      const id = r.id ?? r.ts ?? "";
      const kind: Kind | undefined = owner.has(id) ? "owner" : r.scope === "pair-bot" ? "pair-bot" : r.scope === "pair" ? "pair" : undefined;
      const at = Date.parse(r.ts ?? "");
      if (kind && id && !Number.isNaN(at)) out.push({ id, at, kind, text: String(r.content || r.transcript || r.answer || "") });
    } catch {}
  }
  return out;
};

// why the session hears no inbox row, or undefined while a monitor on the inbox file runs and delivers
export const watchProblem = (entries: readonly Entry[], inbox: string, now: number, alive: (pid: number) => boolean): string | undefined => {
  const name = basename(inbox);
  const on = entries.filter((e) => e.command?.includes(name));
  if (!on.length) return `no monitor on ${name}`;
  const expired = (e: Entry): boolean => e.expiresAt != null && e.expiresAt <= now;
  const gone = (e: Entry): boolean => e.runtime?.pid === undefined || !alive(e.runtime.pid);
  if (on.some((e) => !e.suspended && !e.deliveryPaused && !expired(e) && !gone(e))) return undefined;
  const e = on[0] as Entry;
  const why = e.deliveryPaused ? "its delivery is paused" : e.suspended ? "it is suspended" : expired(e) ? "it expired" : "its process is gone";
  return `${e.description || "the inbox monitor"} armed but ${why}`;
};

const plain = (s: string, n: number): string => s.replace(/\s+/g, " ").replace(/`/g, "'").replaceAll("$(", "$ (").trim().slice(0, n);
const counts = (rows: readonly Row[]): string => {
  const n = new Map<Kind, number>();
  for (const r of rows) n.set(r.kind, (n.get(r.kind) ?? 0) + 1);
  return [...n].map(([k, c]) => `${k} ${c}`).join(", ");
};
const markPath = (deps: FlowDeps): string => join(deps.config.stateDir, "lead-inbox.json");
const ownerWokeAt = (deps: FlowDeps, pane: string): number => {
  try {
    const m = JSON.parse(readFileSync(join(deps.config.stateDir, "lead-limit.json"), "utf8")) as { pane?: string; wokeAt?: string };
    return m.pane === pane ? Date.parse(m.wokeAt ?? "") || 0 : 0;
  } catch {
    return 0;
  }
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
  const file = cwd ? await sessionFile(deps.run, sessionsDir, pane, cwd, table) : undefined;
  const session = file ? /_([^_]+)\.jsonl$/.exec(file.path)?.[1] : undefined;
  if (!cwd || !file || !session) return [];
  const now = deps.clock.now();
  const wait = leadInboxMin * 60_000;
  const text = readFileSync(file.path, "utf8");
  const start = Date.parse(/"timestamp":"([^"]+)"/.exec(text)?.[1] ?? "");
  const said = text.split("\n").filter((l) => !l.includes('"customType":"work-custody"')).join("\n");
  const told = ownerWokeAt(deps, pane);
  const unheard = inboxRows(tailOf(inbox.path, INBOX_TAIL_BYTES), inbox.ownerId).filter((r) => now - r.at < DAY_MS && !(r.at < start) && !(r.kind === "owner" && r.at <= told) && !said.includes(r.id));
  const problem = watchProblem(readManifest(manifestPath(sessionsDir, cwd, session)), inbox.path, now, alive);

  const old = readMark(deps);
  const mark: Mark = old?.pane === pane && old.session === session ? old : { pane, session };
  const missingSince = problem ? (mark.missingSince ?? now) : undefined;
  let next: Mark = { pane, session, ...(missingSince !== undefined ? { missingSince } : {}), ...(mark.key ? { key: mark.key, typedAt: mark.typedAt } : {}) };
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
    next = { pane, session };
    out.push(`LEAD_INBOX_OK ${pane} session ${session} hears its inbox again`);
  }
  if (JSON.stringify(next) !== JSON.stringify(old)) writeFileSync(markPath(deps), `${JSON.stringify(next)}\n`);
  return out;
};
