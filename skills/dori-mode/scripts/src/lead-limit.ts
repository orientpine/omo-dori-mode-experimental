import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { aoeSessions, sessionFor } from "./aoe.ts";
import { sessionFile } from "./background.ts";
import type { FlowDeps } from "./done-flow.ts";
import { sendVerified } from "./panes.ts";
import { procTable } from "./session-id.ts";

// The owner wrote and the lead did not answer (owner 2026-10-22 02:14 KST "요즘 눈만찍고 대답을 안한다??"). On 10-21 every
// Claude account of the lead was at its usage limit from 16:32Z to 18:50Z: the inbox monitor woke the lead within seconds
// for each of the owner's messages, but every model call ended with "All Claude accounts ... are currently blocked ...
// Soonest automatic retry: 18:50Z", and nothing woke it again when the limit lifted (the next message came at 18:54Z).
// The watch reads the lead's transcript, without a model:
// - LEAD_LIMIT_NOTICE once per block: the lead's newest model reply is an error and an owner message waits for it; the
//   owner gets discord.leadLimitText (with the retry time the error names, in discord.timeZone) where he last wrote.
// - LEAD_LIMIT_CLEARED when a reply works again: discord.leadBackText in the same place.
// - LEAD_OWNER_WAITING when an owner message has had no working reply for leadWakeMin: one line typed into the lead pane,
//   once per newest message, and once more after the retry time the error named has passed.

export type LeadReply = { readonly at: number; readonly error?: string };
export type OwnerRow = { readonly id: string; readonly at: number; readonly channel?: string; readonly scope?: string; readonly text: string };
type LimitMark = { readonly pane: string; readonly noticeFor?: string; readonly noticeChannel?: string; readonly wakeKey?: string; readonly wokeAt?: string };

const TAIL_BYTES = 2 * 1024 * 1024;
const INBOX_TAIL_BYTES = 512 * 1024;
const DAY_MS = 24 * 60 * 60_000;
// a retry this close needs no notice: a short rate limit, not a usage limit
const NOTICE_MIN_WAIT_MS = 5 * 60_000;

const tailOf = (path: string, bytes: number): string => {
  const text = readFileSync(path, "utf8");
  if (text.length <= bytes) return text;
  const cut = text.slice(-bytes);
  return cut.slice(cut.indexOf("\n") + 1);
};

// The lead's model replies, oldest first: an assistant message, with its error when the call failed.
export const leadReplies = (transcript: string): LeadReply[] => {
  const out: LeadReply[] = [];
  for (const line of transcript.split("\n")) {
    if (!line.includes('"role":"assistant"')) continue;
    try {
      const e = JSON.parse(line) as { type?: string; timestamp?: string; message?: { role?: string; stopReason?: string; errorMessage?: string } };
      if (e.type !== "message" || e.message?.role !== "assistant") continue;
      const at = Date.parse(e.timestamp ?? "");
      if (Number.isNaN(at)) continue;
      out.push(e.message.stopReason === "error" ? { at, error: e.message.errorMessage ?? "error" } : { at });
    } catch {}
  }
  return out;
};

// What the owner wrote: his Discord messages (not his posts in the pair channel's bot rows), card answers and voice notes.
export const ownerRows = (inbox: string, ownerId: string): OwnerRow[] => {
  const out: OwnerRow[] = [];
  for (const line of inbox.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const r = JSON.parse(line) as { ts?: string; id?: string; kind?: string; via?: string; author_id?: string; scope?: string; channel_id?: string; content?: string; transcript?: string; answer?: string };
      const owner = r.kind === "answer" || r.via === "owner-webhook" || (!!ownerId && r.author_id === ownerId && r.scope !== "pair-bot");
      const at = Date.parse(r.ts ?? "");
      if (!owner || Number.isNaN(at)) continue;
      out.push({ id: r.id ?? r.ts ?? "", at, ...(r.channel_id ? { channel: r.channel_id } : {}), ...(r.scope ? { scope: r.scope } : {}), text: String(r.content || r.transcript || r.answer || "") });
    } catch {}
  }
  return out;
};

// "Soonest automatic retry: 2026-10-21T18:50:00.000Z." in omo's error for a provider whose accounts are all blocked
export const retryAt = (error: string): number | undefined => {
  const m = /(?:retry|resets?|available)\D{0,20}(\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?Z)/i.exec(error);
  const at = m ? Date.parse(m[1] ?? "") : Number.NaN;
  return Number.isNaN(at) ? undefined : at;
};

const markPath = (deps: FlowDeps): string => join(deps.config.stateDir, "lead-limit.json");
const readMark = (deps: FlowDeps, pane: string): LimitMark => {
  try {
    const m = JSON.parse(readFileSync(markPath(deps), "utf8")) as LimitMark;
    return m.pane === pane ? m : { pane };
  } catch {
    return { pane };
  }
};

const clock = (deps: FlowDeps, at: number): string =>
  new Date(at).toLocaleTimeString(deps.config.discord.locale, { timeZone: deps.config.discord.timeZone, hour: "2-digit", minute: "2-digit", hour12: false });
const plain = (s: string, n: number): string => s.replace(/\s+/g, " ").replace(/`/g, "'").replaceAll("$(", "$ (").trim().slice(0, n);

// where the owner reads the notice: the place of his newest message, if it is his (his channel, a thread, his DM)
const placeOf = (rows: readonly OwnerRow[], fallback: string): string => rows.findLast((r) => r.channel && ["channel", "thread", "dm", "mention"].includes(r.scope ?? ""))?.channel ?? fallback;

export const leadLimitTick = async (deps: FlowDeps): Promise<string[]> => {
  const pane = deps.config.leadPane;
  const inbox = deps.ownerInbox;
  if (!pane || !inbox || !existsSync(inbox.path)) return [];
  const now = deps.clock.now();
  const rows = ownerRows(tailOf(inbox.path, INBOX_TAIL_BYTES), inbox.ownerId).filter((r) => now - r.at < DAY_MS);
  const mark = readMark(deps, pane);
  if (!rows.length && !mark.noticeFor) return [];
  const [sessions, table] = await Promise.all([aoeSessions(deps.run), procTable(deps.run)]);
  const cwd = sessionFor(sessions, pane)?.path;
  const file = cwd ? await sessionFile(deps.run, deps.config.sessionsDir, pane, cwd, table) : undefined;
  if (!file) return [];
  const transcript = tailOf(file.path, TAIL_BYTES);
  const replies = leadReplies(transcript);
  const firstAt = Date.parse(/"timestamp":"([^"]+)"/.exec(transcript)?.[1] ?? "");
  const lastGood = replies.findLast((r) => !r.error)?.at ?? (Number.isNaN(firstAt) ? 0 : firstAt);
  const errors = replies.filter((r) => r.error && r.at > lastGood);
  const blocked = errors.length > 0;
  const until = blocked ? retryAt(errors.at(-1)?.error ?? "") : undefined;
  const waiting = rows.filter((r) => r.at > lastGood);
  const out: string[] = [];
  let next: LimitMark = mark;
  const save = (m: LimitMark): void => {
    next = m;
    writeFileSync(markPath(deps), `${JSON.stringify(m)}\n`);
  };
  const words = deps.config.discord;

  // the limit lifted: the owner hears it where he heard of the limit
  if (mark.noticeFor && !blocked) {
    const posted = deps.postOwner && mark.noticeChannel ? await deps.postOwner(mark.noticeChannel, words.leadBackText).then((id) => `POSTED ${mark.noticeChannel} ${id}`, (e: unknown) => `NOT_POSTED ${String(e).slice(0, 160)}`) : "NOT_POSTED no owner channel";
    save({ pane, ...(mark.wakeKey ? { wakeKey: mark.wakeKey, wokeAt: mark.wokeAt } : {}) });
    out.push(`LEAD_LIMIT_CLEARED ${pane} since ${mark.noticeFor}; ${posted}`);
  }

  const blockSince = errors[0] ? new Date(errors[0].at).toISOString() : "";
  const oldest = waiting[0];
  const longWait = !!oldest && now - oldest.at >= deps.config.leadWakeMin * 60_000;
  if (blocked && oldest && next.noticeFor !== blockSince && (until !== undefined ? until - now >= NOTICE_MIN_WAIT_MS : longWait)) {
    const text = until !== undefined ? words.leadLimitText.replaceAll("{until}", clock(deps, until)) : words.leadLimitNoTimeText.replaceAll("{reason}", plain(errors.at(-1)?.error ?? "", 120));
    const channel = placeOf(waiting, inbox.ownerChannel);
    const posted = deps.postOwner && channel ? await deps.postOwner(channel, text).then((id) => `POSTED ${channel} ${id}`, (e: unknown) => `NOT_POSTED ${String(e).slice(0, 160)}`) : "NOT_POSTED no owner channel";
    if (posted.startsWith("POSTED ")) save({ ...next, noticeFor: blockSince, noticeChannel: channel });
    out.push(`LEAD_LIMIT_NOTICE ${pane} model failing since ${blockSince}, retry ${until !== undefined ? new Date(until).toISOString() : "unknown"}, ${waiting.length} owner message(s) waiting; ${posted}`);
  }

  // wake the lead once the owner waited leadWakeMin, but not while the error says its model is still out
  if (deps.config.leadWakeMin > 0 && longWait && oldest && !(until !== undefined && until > now)) {
    const newest = waiting.at(-1) ?? oldest;
    const key = `${newest.id}|${until ?? ""}`;
    if (next.wakeKey !== key) {
      const min = Math.floor((now - oldest.at) / 60_000);
      const text = `[DORI] LEAD_OWNER_WAITING: ${waiting.length} owner message(s) since ${clock(deps, oldest.at)} have had no reply from you for ${min} min${blocked ? " (your model calls failed meanwhile)" : ""}. The oldest: "${plain(oldest.text, 120)}". Read them in the inbox and answer the owner now.`;
      const ok = await sendVerified(deps.run, deps.clock, deps.config, pane, text);
      if (ok) save({ ...next, wakeKey: key, wokeAt: new Date(now).toISOString() });
      out.push(`LEAD_OWNER_WAITING ${pane} ${waiting.length} owner message(s), oldest ${new Date(oldest.at).toISOString()} (${min} min)${blocked ? ", model failing" : ""}; ${ok ? "woke the lead (SUBMITTED)" : "NOT_SUBMITTED: the line did not reach the pane"}`);
    }
  }
  return out;
};
