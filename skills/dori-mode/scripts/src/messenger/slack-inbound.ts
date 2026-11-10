import { MessengerError } from "./http.ts";
import type { Slack } from "./slack.ts";
import { type LedgerThread, type ThreadLedger, tsAfter } from "./thread-ledger.ts";

export type Inbound = {
  readonly source: "threads-view" | "own-thread" | "unread";
  readonly channel: string;
  readonly ts: string;
  readonly threadTs?: string | undefined;
  readonly user?: string | undefined;
  readonly text?: string | undefined;
};

type Msg = { readonly ts?: string; readonly thread_ts?: string; readonly user?: string; readonly text?: string; readonly bot_id?: string; readonly channel?: string };
type ThreadView = { readonly root_msg?: Msg & { readonly channel?: string }; readonly unread_replies?: readonly Msg[] };
type Counted = { readonly id: string; readonly has_unreads?: boolean; readonly mention_count?: number };

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

  const view = (await userTokenOnly("subscriptions.thread.getView", { limit: opts.threadsViewLimit ?? 20 })) as { threads?: readonly ThreadView[] };
  for (const t of view.threads ?? []) {
    const channel = t.root_msg?.channel;
    if (!channel) continue;
    for (const m of t.unread_replies ?? []) {
      if (!m.ts || !fromOthers(m)) continue;
      add({ source: "threads-view", channel, ts: m.ts, threadTs: m.thread_ts, user: m.user, text: m.text });
      if (m.thread_ts) updates.push({ channel, rootTs: m.thread_ts, seenTs: m.ts });
    }
  }

  for (const t of await ledger.list()) {
    const r = (await slack.call("conversations.replies", { channel: t.channel, ts: t.rootTs, oldest: t.seenTs, inclusive: false, limit: 50 })) as { messages?: readonly Msg[] };
    let newest = t.seenTs;
    for (const m of r.messages ?? []) {
      if (!m.ts || !tsAfter(m.ts, t.seenTs)) continue;
      if (tsAfter(m.ts, newest)) newest = m.ts;
      if (fromOthers(m)) add({ source: "own-thread", channel: t.channel, ts: m.ts, threadTs: t.rootTs, user: m.user, text: m.text });
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
