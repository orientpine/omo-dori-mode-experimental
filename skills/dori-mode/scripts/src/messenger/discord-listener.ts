import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { DiscordWords } from "../config.ts";
import type { Discord } from "./discord.ts";
import type { Interaction, QuestionCards } from "./discord-cards.ts";
import { isDoneName, setThreadStatus, type ThreadInfo } from "./discord-thread.ts";
import type { Timers } from "./typing.ts";

export const EYES = "👀";
// GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT (a privileged intent: turn it on in the Developer Portal)
export const LISTENER_INTENTS = 1 | (1 << 9) | (1 << 12) | (1 << 15);
// 4004 bad token, 4013/4014 invalid or disallowed intents: reconnecting cannot fix these
const FATAL_CLOSE = new Set([4004, 4013, 4014]);
const MAX_BACKOFF_MS = 60_000;

export type GatewayConnection = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onMessage(cb: (data: string) => void): void;
  onClose(cb: (code: number) => void): void;
};

export type ListenerTimers = Timers & { readonly setTimeout: (cb: () => void, ms: number) => unknown };

export type DiscordMessage = {
  readonly id: string;
  readonly channel_id: string;
  readonly guild_id?: string;
  readonly content: string;
  readonly timestamp: string;
  readonly author: { readonly id: string; readonly bot?: boolean };
  readonly attachments?: readonly { readonly url: string; readonly filename: string; readonly content_type?: string }[];
  readonly message_reference?: { readonly message_id?: string; readonly channel_id?: string };
};

export type InboxMessage = {
  readonly ts: string;
  readonly id: string;
  readonly channel_id: string;
  readonly scope: "dm" | "channel" | "thread";
  readonly author_id: string;
  readonly content: string;
  readonly transcript: string | null;
  readonly attachments: readonly { readonly url: string; readonly filename: string; readonly content_type: string | null }[];
  readonly reply_to: string | null;
};

export type InboxAnswer = {
  readonly ts: string;
  readonly id: string;
  readonly kind: "answer";
  readonly qid: string;
  readonly answer: string;
  readonly answer_kind: string;
  readonly question: string;
  readonly thread: string | null;
  readonly session: string | null;
  readonly tmux: string | null;
};

export type ListenerDeps = {
  readonly dc: Discord;
  readonly cards: QuestionCards;
  readonly open: () => GatewayConnection;
  readonly token: string;
  readonly guild: string;
  readonly channel: string;
  readonly owner: string;
  readonly words: DiscordWords;
  readonly inboxFile: string;
  readonly timers: ListenerTimers;
  readonly now: () => number;
  readonly log: (line: string) => void;
  readonly fatal: (closeCode: number) => void;
  readonly transcribe?: (url: string, filename: string) => Promise<string>;
};

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 200);
const newer = (a: string, b: string): boolean => BigInt(a) > BigInt(b);

export class DiscordListener {
  private readonly seen = new Set<string>();
  private readonly parents = new Map<string, string>();
  private readonly inflight = new Set<Promise<void>>();
  private readonly sweeps = new Map<string, Promise<void>>();
  private readonly eyesFile: string;
  // channel or thread id -> owner messages that still carry our eyes reaction
  private eyes: Record<string, string[]> = {};
  private self = "";
  private cursor = "0";
  private seq: number | null = null;
  private backoff = 1_000;

  constructor(private readonly d: ListenerDeps) {
    mkdirSync(dirname(d.inboxFile), { recursive: true, mode: 0o700 });
    this.eyesFile = join(dirname(d.inboxFile), "eyes.json");
    if (existsSync(this.eyesFile)) this.eyes = JSON.parse(readFileSync(this.eyesFile, "utf8")) as Record<string, string[]>;
    if (!existsSync(d.inboxFile)) return;
    for (const line of readFileSync(d.inboxFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as { id: string; kind?: string };
      this.seen.add(row.id);
      if (!row.kind && newer(row.id, this.cursor)) this.cursor = row.id;
    }
  }

  private append(row: InboxMessage | InboxAnswer): void {
    appendFileSync(this.d.inboxFile, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  }

  private track(p: Promise<void>, tag: string): void {
    const t = p.catch((e: unknown) => this.d.log(`DISCORD_LISTENER_FAIL ${tag} ${errText(e)}`)).finally(() => this.inflight.delete(t));
    this.inflight.add(t);
  }

  async settled(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight]);
  }

  private async parentOf(channelId: string): Promise<string> {
    const known = this.parents.get(channelId);
    if (known !== undefined) return known;
    const c = await this.d.dc.call<{ parent_id?: string | null }>("GET", `/channels/${channelId}`);
    this.parents.set(channelId, c.parent_id ?? "");
    return c.parent_id ?? "";
  }

  private saveEyes(): void {
    writeFileSync(this.eyesFile, JSON.stringify(this.eyes), { mode: 0o600 });
  }

  // our bot wrote in a channel: take the eyes off the owner's earlier messages there, and off the message it replies to.
  // Sweeps of one channel run one after another; Discord.call waits out a 429's retry_after.
  private clearEyes(m: DiscordMessage): Promise<void> {
    const prev = this.sweeps.get(m.channel_id) ?? Promise.resolve();
    const next = prev.then(() => this.sweep(m));
    const tail = next.catch(() => {});
    this.sweeps.set(m.channel_id, tail);
    void tail.then(() => this.sweeps.get(m.channel_id) === tail && this.sweeps.delete(m.channel_id));
    return next;
  }

  private async sweep(m: DiscordMessage): Promise<void> {
    const targets = (this.eyes[m.channel_id] ?? []).filter((id) => newer(m.id, id)).map((id) => [m.channel_id, id] as const);
    const ref = m.message_reference?.message_id;
    if (ref && !targets.some(([, id]) => id === ref)) {
      const tracked = Object.keys(this.eyes).find((ch) => this.eyes[ch]?.includes(ref));
      targets.push([tracked ?? m.message_reference?.channel_id ?? m.channel_id, ref]);
    }
    const cleared: string[] = [];
    for (const [ch, id] of targets) {
      await this.d.dc.unreact(ch, id, EYES).then(
        () => cleared.push(id),
        (e: unknown) => this.d.log(`DISCORD_UNREACT_FAIL ${id} ${errText(e)}`),
      );
      // a message deleted or already cleared by hand is dropped too, so it is not retried forever
      const left = (this.eyes[ch] ?? []).filter((x) => x !== id);
      if (left.length) this.eyes[ch] = left;
      else delete this.eyes[ch];
      this.saveEyes();
    }
    if (cleared.length) this.d.log(`EYES_CLEARED ${m.channel_id} by=${m.id} ${cleared.join(",")}`);
  }

  async onMessage(m: DiscordMessage): Promise<void> {
    if (this.self && m.author.id === this.self) {
      if (this.d.words.autoUnEye) await this.clearEyes(m);
      return;
    }
    if (this.seen.has(m.id) || m.author.bot || m.author.id !== this.d.owner) return;
    let scope: InboxMessage["scope"];
    if (!m.guild_id) scope = "dm";
    else if (m.guild_id !== this.d.guild) return;
    else if (m.channel_id === this.d.channel) scope = "channel";
    else if ((await this.parentOf(m.channel_id)) === this.d.channel) scope = "thread";
    else return;
    this.seen.add(m.id);
    if (newer(m.id, this.cursor)) this.cursor = m.id;
    await this.d.dc.react(m.channel_id, m.id, EYES).then(
      () => {
        this.eyes[m.channel_id] = [...(this.eyes[m.channel_id] ?? []), m.id];
        this.saveEyes();
      },
      (e: unknown) => this.d.log(`DISCORD_REACT_FAIL ${m.id} ${errText(e)}`),
    );
    let transcript: string | null = null;
    const audio = (m.attachments ?? []).find((a) => (a.content_type ?? "").startsWith("audio/"));
    if (audio && this.d.transcribe) transcript = await this.d.transcribe(audio.url, audio.filename).catch((e: unknown) => (this.d.log(`DISCORD_TRANSCRIBE_FAIL ${m.id} ${errText(e)}`), null));
    this.append({
      ts: m.timestamp,
      id: m.id,
      channel_id: m.channel_id,
      scope,
      author_id: m.author.id,
      content: m.content,
      transcript,
      attachments: (m.attachments ?? []).map((a) => ({ url: a.url, filename: a.filename, content_type: a.content_type ?? null })),
      reply_to: m.message_reference?.message_id ?? null,
    });
    this.d.log(`INBOUND discord-${scope} ${m.channel_id} ${m.id} ${m.author.id} ${JSON.stringify((transcript ?? m.content).slice(0, 200))}`);
    if (scope === "thread") await this.reopenIfDone(m.channel_id).catch((e: unknown) => this.d.log(`DISCORD_REOPEN_FAIL ${m.channel_id} ${errText(e)}`));
  }

  // the owner writing in a closed thread brings the work back: unarchive it and mark it working again
  private async reopenIfDone(threadId: string): Promise<void> {
    const info = await this.d.dc.call<ThreadInfo>("GET", `/channels/${threadId}`);
    if (!isDoneName(info.name ?? "", this.d.words)) return;
    await setThreadStatus(this.d.dc, threadId, "working", this.d.words, info);
    this.d.log(`THREAD_REOPENED ${threadId}`);
  }

  async onInteraction(i: Interaction): Promise<void> {
    // a card sits in the channel or inside its work thread: take a tap only where its card was posted,
    // looked up locally since the interaction must be answered within 3 seconds
    const qid = /^[qm]:([^:]+)/.exec(i.data?.custom_id ?? "")?.[1];
    if (i.channel_id !== this.d.channel && (!qid || i.channel_id !== this.d.cards.store.get(qid)?.channel)) return;
    const outcome = await this.d.cards.handle(i);
    if (outcome.kind === "refused") this.d.log(`CARD_REFUSED ${outcome.user}`);
    if (outcome.kind !== "answered") return;
    const q = outcome.question;
    this.append({ ts: new Date(this.d.now()).toISOString(), id: i.id, kind: "answer", qid: q.id, answer: q.answer ?? "", answer_kind: q.answerKind ?? "button", question: q.text, thread: q.thread, session: q.session, tmux: q.tmux });
    this.d.log(`ANSWER ${q.id} ${q.answerKind} ${JSON.stringify(q.answer ?? "")} thread=${q.thread ?? "-"} session=${q.session ?? "-"} tmux=${q.tmux ?? "-"}`);
    await this.d.cards.afterAnswer(q).catch((e: unknown) => this.d.log(`DISCORD_ECHO_FAIL ${q.id} ${errText(e)}`));
  }

  // after a reconnect, read what the owner wrote in the channel and its open threads while the socket was down
  async backfill(): Promise<number> {
    if (this.cursor === "0") return 0;
    const since = this.cursor;
    const active = await this.d.dc.call<{ threads?: { id: string; parent_id: string }[] }>("GET", `/guilds/${this.d.guild}/threads/active`);
    const channels = [this.d.channel, ...(active.threads ?? []).filter((t) => t.parent_id === this.d.channel).map((t) => t.id)];
    for (const t of active.threads ?? []) this.parents.set(t.id, t.parent_id);
    let added = 0;
    for (const ch of channels) {
      const msgs = await this.d.dc.call<DiscordMessage[]>("GET", `/channels/${ch}/messages?after=${since}&limit=100`);
      for (const m of [...msgs].sort((a, b) => (newer(b.id, a.id) ? -1 : 1))) {
        const before = this.seen.size;
        await this.onMessage({ ...m, guild_id: this.d.guild });
        if (this.seen.size > before) added++;
      }
    }
    this.d.log(`DISCORD_BACKFILL since=${since} added=${added}`);
    return added;
  }

  private dispatch(type: string | null, data: Record<string, unknown>): void {
    if (type === "READY") {
      this.backoff = 1_000;
      this.self = String((data.user as { id?: string } | undefined)?.id ?? "");
      this.d.log("DISCORD_LISTENER_READY");
      this.track(this.backfill().then(() => {}), "backfill");
    } else if (type === "GUILD_CREATE" && data.id === this.d.guild) {
      for (const t of (data.threads as { id: string; parent_id: string }[] | undefined) ?? []) this.parents.set(t.id, t.parent_id);
    } else if (type === "THREAD_CREATE" || type === "THREAD_UPDATE") this.parents.set(String(data.id), String(data.parent_id ?? ""));
    else if (type === "MESSAGE_CREATE") this.track(this.onMessage(data as unknown as DiscordMessage), "message");
    else if (type === "INTERACTION_CREATE") this.track(this.onInteraction(data as unknown as Interaction), "interaction");
  }

  start(): void {
    const ws = this.d.open();
    let beat: unknown;
    let acked = true;
    ws.onMessage((raw) => {
      const p = JSON.parse(raw) as { op: number; d: Record<string, unknown> | null; s?: number | null; t?: string | null };
      if (typeof p.s === "number") this.seq = p.s;
      if (p.op === 10) {
        beat = this.d.timers.setInterval(() => {
          if (!acked) return ws.close(4000, "zombie");
          acked = false;
          ws.send(JSON.stringify({ op: 1, d: this.seq }));
        }, Number(p.d?.heartbeat_interval));
        ws.send(JSON.stringify({ op: 2, d: { token: this.d.token, intents: LISTENER_INTENTS, properties: { os: process.platform, browser: "dori", device: "dori" } } }));
      } else if (p.op === 11) acked = true;
      else if (p.op === 1) ws.send(JSON.stringify({ op: 1, d: this.seq }));
      else if (p.op === 7 || p.op === 9) ws.close(4001, "reconnect");
      else if (p.op === 0) this.dispatch(p.t ?? null, p.d ?? {});
    });
    ws.onClose((code) => {
      if (beat !== undefined) this.d.timers.clearInterval(beat);
      if (FATAL_CLOSE.has(code)) {
        this.d.log(`DISCORD_LISTENER_FATAL close=${code}`);
        this.d.fatal(code);
        return;
      }
      this.d.log(`DISCORD_LISTENER_CLOSED code=${code} retry_in=${this.backoff}ms`);
      this.d.timers.setTimeout(() => this.start(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    });
  }
}
