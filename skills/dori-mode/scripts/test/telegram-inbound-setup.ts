import type { Http, HttpRequest, HttpResponse } from "../src/messenger/http.ts";
import { Telegram } from "../src/messenger/telegram.ts";
import { fakeClock } from "./fakes.ts";

export const OWNER = 5250;
export const OTHER = 6612;
export const GROUP = -1004;
export const TOPIC = 3;

export type U = { update_id: number; message?: unknown; edited_message?: unknown };

export const msg = (from: number, chatId: number, type: string, text: string, thread?: number, isTopicMessage?: boolean) => ({
  message_id: 1,
  from: { id: from, is_bot: false, username: from === OWNER ? "owner" : "someone" },
  chat: { id: chatId, type },
  ...(thread === undefined ? {} : { message_thread_id: thread }),
  ...(isTopicMessage === undefined ? {} : { is_topic_message: isTopicMessage }),
  text,
});

export const telegramFake = (batches: U[][]) => {
  const bodies: Record<string, unknown>[] = [];
  const http: Http = async (req: HttpRequest): Promise<HttpResponse> => {
    bodies.push(JSON.parse(String(req.body ?? "{}")) as Record<string, unknown>);
    const batch = batches.shift() ?? [];
    return { status: 200, headers: {}, body: JSON.stringify({ ok: true, result: batch }) };
  };
  return { http, bodies };
};

export const mk = (http: Http): Telegram => new Telegram(http, fakeClock(0), "T");
