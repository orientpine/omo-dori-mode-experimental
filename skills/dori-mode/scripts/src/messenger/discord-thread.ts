import type { DiscordWords } from "../config.ts";
import type { Discord } from "./discord.ts";

export class ThreadRefError extends Error {}

export const discordThreadId = (ref: string): string => {
  const id = /^discord:(\d{5,25})$/.exec(ref.trim())?.[1];
  if (!id) throw new ThreadRefError(`not a Discord thread ref: "${ref}" (expected discord:<thread id>)`);
  return id;
};

export const withoutEmoji = (text: string): string =>
  text
    .replace(/\p{Extended_Pictographic}\uFE0F?/gu, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

export type ThreadStatus = "working" | "waiting" | "done";

export const STATUS_EMOJI: Readonly<Record<ThreadStatus, string>> = { working: "🔄", waiting: "⏸️", done: "✅" };

// either style's mark, so switching statusStyle never leaves two marks on one name
const STATUS_PREFIX = /^(?:\[[^\]]{1,20}\]|(?:🔄|⏸|✅|⏳)\uFE0F?)\s*/u;

export const statusMark = (status: ThreadStatus, words: DiscordWords): string => (words.statusStyle === "emoji" ? STATUS_EMOJI[status] : `[${words[status]}]`);

export const isDoneName = (name: string, words: DiscordWords): boolean => name.startsWith(STATUS_EMOJI.done) || name.startsWith(`[${words.done}]`);

export const progressText = (status: "working" | "done", text: string, words: DiscordWords): string =>
  words.statusStyle === "emoji" ? (status === "working" ? `⏳ · ${text}` : `${STATUS_EMOJI.done} ${text}`) : `${words[status]}: ${text}`;

export type ThreadInfo = { readonly name?: string; readonly thread_metadata?: { readonly archived?: boolean } };

// Discord rate-limits thread renames (about two per ten minutes), so nothing is sent when the status already holds.
export const setThreadStatus = async (dc: Discord, threadId: string, status: ThreadStatus, words: DiscordWords, current?: ThreadInfo): Promise<void> => {
  const info = current ?? (await dc.call<ThreadInfo>("GET", `/channels/${threadId}`));
  const name = info.name ?? "";
  const next = `${statusMark(status, words)} ${name.replace(STATUS_PREFIX, "")}`;
  const archived = info.thread_metadata?.archived === true;
  if (status === "done") {
    if (next === name && archived) return;
    if (next !== name) {
      // Discord refuses to rename an archived thread (50083), so it is opened, renamed, then archived again
      if (archived) await dc.setThread(threadId, { archived: false });
      await dc.setThread(threadId, { name: next });
    }
    await dc.setThread(threadId, { archived: true });
    return;
  }
  if (next !== name || archived) await dc.setThread(threadId, { ...(next !== name ? { name: next } : {}), ...(archived ? { archived: false } : {}) });
};

export type ThreadVerb = "reply" | "wait" | "done";
const VERB_STATUS: Readonly<Record<ThreadVerb, ThreadStatus>> = { reply: "working", wait: "waiting", done: "done" };

export const threadHook = async (dc: Discord, verb: ThreadVerb, ref: string, text: string, words: DiscordWords): Promise<string> => {
  const id = discordThreadId(ref);
  const plain = withoutEmoji(text);
  if (!plain) throw new ThreadRefError("nothing to post after removing emoji");
  await dc.typing(id).catch(() => {});
  const posted = await dc.send(id, plain);
  await setThreadStatus(dc, id, VERB_STATUS[verb], words);
  return posted;
};
