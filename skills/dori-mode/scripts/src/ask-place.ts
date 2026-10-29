import { existsSync, readFileSync } from "node:fs";

import { hasThread, type Lane } from "./registry.ts";
import type { ThreadMap } from "./messenger/thread-map.ts";

// Where a question card goes (owner 2026-10-29 22:07 KST "스레드 내에 카드 만드는게 강제가 아닌가?", directive request-thread:
// his short requests and answers in the channel, permission and approval cards in the thread). In order:
// --thread: that thread. --reply-to <his message>: his message in the channel is answered there as a reply, his message in a
// thread sends the card to that thread. --channel "<reason>": the channel, with the reason on the card. None of them: the open
// lane of the asking session (--tmux, --session, else the pane the command runs in) with a Discord work thread, else the one
// thread dori thread open mapped to that session (ASK_THREAD_AUTO). Nothing found: ASK_THREAD_REQUIRED, nothing is posted.
export type AskPlace =
  | { readonly kind: "thread"; readonly thread: string; readonly line?: string; readonly pane?: string }
  | { readonly kind: "channel"; readonly why: string }
  | { readonly kind: "reply"; readonly replyTo: string; readonly thread: string | null };

export class AskPlaceError extends Error {}

export type AskPlaceInput = {
  readonly thread?: string;
  // undefined: not given; "": given without a reason (refused)
  readonly channel?: string;
  readonly replyTo?: string;
  readonly tmux?: string;
  readonly session?: string;
  // the tmux session (or herdr pane) the command runs in; "" outside one
  readonly here: string;
  readonly lanes: readonly Lane[];
  readonly threads: ThreadMap;
  readonly inbox: string;
  readonly owner: string;
};

const discordThread = (ref: string): string | undefined => (ref.startsWith("discord:") ? ref.slice("discord:".length) : undefined);

type InboxRow = { readonly id?: string; readonly channel_id?: string; readonly scope?: string; readonly author_id?: string };
const inboxRow = (file: string, id: string): InboxRow | undefined => {
  if (!file || !existsSync(file)) return undefined;
  for (const line of readFileSync(file, "utf8").split("\n").reverse()) {
    if (!line.includes(id)) continue;
    try {
      const row = JSON.parse(line) as InboxRow;
      if (row.id === id) return row;
    } catch {
      continue;
    }
  }
  return undefined;
};

const required = (asker: string, lanes: readonly Lane[]): AskPlaceError => {
  const open = lanes.filter((l) => hasThread(l) && discordThread(l.thread)).slice(0, 5).map((l) => `${l.key} ${l.thread}`);
  return new AskPlaceError(
    `ASK_THREAD_REQUIRED: no work thread found for ${asker ? `session ${asker}` : "this session"}; nothing was posted. A question or approval card goes in the thread of its work (directive request-thread): ` +
      `pass --thread discord:<id>${open.length ? ` (open lane threads: ${open.join(", ")})` : ""}, --tmux <the lane's session> to use its thread, ` +
      `--reply-to <the owner's message id> when it answers what he asked in the channel, or --channel "<reason>" for a card that belongs in the channel.`,
  );
};

export const askPlace = (input: AskPlaceInput): AskPlace => {
  const given = [input.thread !== undefined && "--thread", input.channel !== undefined && "--channel", input.replyTo !== undefined && "--reply-to"].filter(Boolean);
  if (given.length > 1) throw new AskPlaceError(`pass one of --thread, --reply-to or --channel, not ${given.join(" and ")}; nothing was posted`);
  if (input.thread !== undefined) {
    const thread = input.thread.replace(/^discord:/, "").trim();
    if (!thread) throw new AskPlaceError("--thread needs a thread: --thread discord:<id>; nothing was posted");
    return { kind: "thread", thread };
  }
  if (input.channel !== undefined) {
    const why = input.channel.trim();
    if (!why) throw new AskPlaceError(`--channel needs a reason: --channel "<why this card belongs in the channel, not in a work thread>"; nothing was posted`);
    return { kind: "channel", why };
  }
  if (input.replyTo !== undefined) {
    const id = /(?:^|\/)(\d{5,25})\/?$/.exec(input.replyTo.trim())?.[1] ?? "";
    const row = id ? inboxRow(input.inbox, id) : undefined;
    if (!row || row.author_id !== input.owner || (row.scope !== "channel" && row.scope !== "thread"))
      throw new AskPlaceError(`ASK_REPLY_TO_UNKNOWN ${input.replyTo}: --reply-to takes the id or link of the owner's own message in this Dori's channel or one of its threads (from the inbox); nothing was posted`);
    return { kind: "reply", replyTo: id, thread: row.scope === "thread" ? (row.channel_id ?? null) : null };
  }
  const lane = input.lanes.find((l) => (input.tmux ? l.pane === input.tmux : input.session ? l.session === input.session : !!input.here && l.pane === input.here));
  const own = lane && hasThread(lane) ? discordThread(lane.thread) : undefined;
  if (lane && own) return { kind: "thread", thread: own, line: `ASK_THREAD_AUTO discord:${own} lane ${lane.key}`, ...(lane.pane ? { pane: lane.pane } : {}) };
  const who = input.tmux || input.session || input.here;
  const mapped = who ? Object.entries(input.threads).filter(([, t]) => t.session === who).map(([id]) => id) : [];
  if (mapped.length === 1) return { kind: "thread", thread: mapped[0] ?? "", line: `ASK_THREAD_AUTO discord:${mapped[0]} mapped to ${who}` };
  throw required(who, input.lanes);
};
