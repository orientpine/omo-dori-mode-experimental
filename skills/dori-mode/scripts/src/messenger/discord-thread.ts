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

const STATUS_PREFIX = /^\[[^\]]{1,20}\]\s*/;

export type ThreadStatus = "working" | "waiting" | "done";

export const setThreadStatus = async (dc: Discord, threadId: string, status: ThreadStatus, words: DiscordWords): Promise<void> => {
  const { name = "" } = await dc.call<{ name?: string }>("GET", `/channels/${threadId}`);
  await dc.setThread(threadId, { name: `[${words[status]}] ${name.replace(STATUS_PREFIX, "")}` });
  if (status === "done") await dc.setThread(threadId, { archived: true });
};

export const threadHook = async (dc: Discord, verb: "reply" | "done", ref: string, text: string, words: DiscordWords): Promise<string> => {
  const id = discordThreadId(ref);
  const plain = withoutEmoji(text);
  if (!plain) throw new ThreadRefError("nothing to post after removing emoji");
  await dc.typing(id).catch(() => {});
  const posted = await dc.send(id, plain);
  if (verb === "done") await setThreadStatus(dc, id, "done", words);
  return posted;
};
