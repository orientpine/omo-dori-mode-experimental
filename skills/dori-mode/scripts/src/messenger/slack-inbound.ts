import { MessengerError } from "./http.ts";
import type { Slack } from "./slack.ts";
import { type LedgerThread, type ThreadLedger, type ThreadRoot, tsAfter } from "./thread-ledger.ts";

export type Inbound = {
  readonly source: "threads-view" | "own-thread" | "unread";
  readonly channel: string;
  readonly ts: string;
  readonly threadTs?: string | undefined;
  readonly user?: string | undefined;
  readonly text?: string | undefined;
  readonly root?: ThreadRoot | undefined;
  readonly recent?: readonly Recent[] | undefined;
};

type Recent = { readonly ts: string; readonly user?: string | undefined; readonly text: string };

type Msg = { readonly ts?: string; readonly thread_ts?: string; readonly user?: string; readonly text?: string; readonly bot_id?: string; readonly channel?: string };
type ThreadView = { readonly root_msg?: Msg & { readonly channel?: string }; readonly unread_replies?: readonly Msg[] };
type Counted = { readonly id: string; readonly has_unreads?: boolean; readonly mention_count?: number };
type RepliesPage = { readonly messages?: readonly Msg[]; readonly response_metadata?: { readonly next_cursor?: string } };

const recentBefore = (messages: readonly Msg[], currentTs: string): readonly Recent[] => messages.flatMap((m) => m.ts && tsAfter(currentTs, m.ts) ? [{ ts: m.ts, user: m.user, text: (m.text ?? "").split(/\r?\n/, 1)[0] ?? "" }] : []).slice(-3);

export type InboundOptions = {
  readonly selfUserId: string;
  readonly threadsViewLimit?: number;
  readonly warn?: (message: string) => void;
};

// Upstream #182 / #180: bot tokens cannot read these views, but can still read replies in watched threads.
const USER_TOKEN_ONLY = {
  "subscriptions.thread.getView": "the threads view",
  "client.counts": "the unread counts",
} as const;

export const pollSlackInbound = async (slack: Slack, ledger: ThreadLedger, opts: InboundOptions): Promise<Inbound[]> => {
  const out: Inbound[] = [];
  const updates: LedgerThread[] = [];
  const seen = new Set<string>();
  const add = (i: Inbound) => {
    const k = `${i.channel}:${i.ts}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(i);
  };
  const fromOthers = (m: Msg) => m.user !== undefined && m.user !== opts.selfUserId && !m.bot_id;
  const userTokenOnly = async (method: keyof typeof USER_TOKEN_ONLY, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    try {
      return await slack.call(method, params);
    } catch (e) {
      if (!(e instanceof MessengerError) || e.code !== "not_allowed_token_type") throw e;
      opts.warn?.(`slack ${method}: not_allowed_token_type (a bot token); skipping ${USER_TOKEN_ONLY[method]}, replies in own threads still arrive`);
      return {};
    }
  };

  const history = async (channel: string, rootTs: string) => {
    const root = await ledger.root(channel, rootTs, async () => {
      const r = (await slack.call("conversations.replies", { channel, ts: rootTs, limit: 1 })) as RepliesPage;
      const msg = r.messages?.find((m) => m.ts === rootTs);
      if (!msg) throw new MessengerError(`slack conversations.replies: root ${channel}/${rootTs}: thread_not_found`, 200, "thread_not_found");
      return { channel, rootTs, user: msg.user, text: (msg.text ?? "").slice(0, 1000) };
    });
    const messages: Msg[] = [];
    let cursor: string | undefined;
    do {
      const r = (await slack.call("conversations.replies", { channel, ts: rootTs, oldest: rootTs, inclusive: false, limit: 50, ...(cursor ? { cursor } : {}) })) as RepliesPage;
      messages.push(...(r.messages ?? []));
      cursor = r.response_metadata?.next_cursor?.trim() || undefined;
    } while (cursor);
    return { root, messages };
  };

  const view = (await userTokenOnly("subscriptions.thread.getView", { limit: opts.threadsViewLimit ?? 20 })) as { threads?: readonly ThreadView[] };
  for (const t of view.threads ?? []) {
    const channel = t.root_msg?.channel;
    const unread = (t.unread_replies ?? []).filter((m) => m.ts && fromOthers(m));
    const rootTs = t.root_msg?.ts ?? unread[0]?.thread_ts;
    if (!channel || !rootTs || unread.length === 0) continue;
    const { root, messages } = await history(channel, rootTs);
    for (const m of unread) {
      if (!m.ts) continue;
      const threadTs = m.thread_ts ?? rootTs;
      add({ source: "threads-view", channel, ts: m.ts, threadTs, user: m.user, text: m.text, root, recent: recentBefore(messages, m.ts) });
      updates.push({ channel, rootTs: threadTs, seenTs: m.ts });
    }
  }

  for (const t of await ledger.list()) {
    const { root, messages } = await history(t.channel, t.rootTs);
    let newest = t.seenTs;
    for (const m of messages) {
      if (!m.ts || !tsAfter(m.ts, t.seenTs)) continue;
      if (tsAfter(m.ts, newest)) newest = m.ts;
      if (fromOthers(m)) add({ source: "own-thread", channel: t.channel, ts: m.ts, threadTs: t.rootTs, user: m.user, text: m.text, root, recent: recentBefore(messages, m.ts) });
    }
    if (newest !== t.seenTs) updates.push({ channel: t.channel, rootTs: t.rootTs, seenTs: newest });
  }

  const counts = (await userTokenOnly("client.counts", {})) as { channels?: readonly Counted[]; ims?: readonly Counted[]; mpims?: readonly Counted[] };
  for (const c of [...(counts.ims ?? []), ...(counts.mpims ?? []), ...(counts.channels ?? []).filter((c) => (c.mention_count ?? 0) > 0)]) {
    if (c.has_unreads || (c.mention_count ?? 0) > 0) add({ source: "unread", channel: c.id, ts: "", text: `${c.mention_count ?? 0} mention(s), unread` });
  }
  // A later API failure must leave every reply available for the next poll.
  for (const t of updates) await ledger.markSeen(t.channel, t.rootTs, t.seenTs);
  return out;
};
