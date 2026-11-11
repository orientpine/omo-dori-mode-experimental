import { join, resolve } from "node:path";
import { messageLines } from "./directive-hints.ts";
import { realClock } from "./run.ts";
import { fetchHttp } from "./messenger/http.ts";
import { Slack } from "./messenger/slack.ts";
import { pollSlackInbound } from "./messenger/slack-inbound.ts";
import { envInt, fileTgInboundStore, telegramInboundLoop, writeLineSync } from "./messenger/telegram-inbound.ts";
import { formatTelegramInbound } from "./messenger/telegram-line.ts";
import { ThreadLedger } from "./messenger/thread-ledger.ts";
import { Telegram } from "./messenger/telegram.ts";
import { DiscordListener } from "./messenger/discord-listener.ts";
import { realTimers } from "./messenger/typing.ts";
import type { Command } from "./cli-context.ts";
import { die, every } from "./cli-context.ts";
import { makeDiscordDeps } from "./cli-deps-discord.ts";
import { makeDirectiveDeps } from "./cli-deps-directives.ts";

const inboundCommand: Command = async (context) => {
  const { loopMinutes, key, config } = context;
  const { discordClient, threadStatuses, questionCards, gatewaySocket, env, idList, watchMatch, transcribeUrl } = makeDiscordDeps(context);
  const { hintLedger } = makeDirectiveDeps(context);
  const minutes = loopMinutes();
  if (key === "discord") {
    // a shadow run writes only to its own inbox, never the live one (which dori.env may also name)
    const shadowInbox = process.env["DORI_DISCORD_SHADOW_INBOX"]?.trim() ?? "";
    const liveInbox = process.env["DORI_DISCORD_INBOX"]?.trim() || join(config.stateDir, "discord", "inbox.jsonl");
    if (shadowInbox && resolve(shadowInbox) === resolve(liveInbox)) die("DORI_DISCORD_SHADOW_INBOX must differ from the live inbox");
    const dc = discordClient();
    const statuses = threadStatuses(dc, (line) => console.log(line));
    // the listener owns the delayed renames: a burst becomes one rename, and a 429 waits out retry_after
    if (!shadowInbox) statuses.watch({ setTimeout: (cb, ms) => setTimeout(cb, ms), setInterval: (cb, ms) => setInterval(cb, ms) });
    const listener = new DiscordListener({
      dc,
      cards: questionCards(dc, statuses),
      open: () => {
        const ws = gatewaySocket();
        return {
          send: (d) => ws.send(d),
          close: (code, reason) => ws.close(code, reason),
          onMessage: (cb) => ws.addEventListener("message", (e) => cb(String(e.data))),
          onClose: (cb) => ws.addEventListener("close", (e) => cb(e.code)),
        };
      },
      token: env("DORI_DISCORD_TOKEN"),
      guild: env("DORI_DISCORD_GUILD"),
      channel: env("DORI_DISCORD_CHANNEL"),
      owner: env("DORI_DISCORD_OWNER"),
      ownerWebhook: process.env["DORI_DISCORD_OWNER_WEBHOOK"]?.trim() ?? "",
      pairChannel: process.env["DORI_DISCORD_PAIR_CHANNEL"]?.trim() ?? "",
      pairBots: idList(process.env["DORI_DISCORD_PAIR_BOT"]),
      watchChannels: idList(process.env["DORI_DISCORD_WATCH_CHANNELS"]),
      watchBots: idList(process.env["DORI_DISCORD_WATCH_BOTS"]),
      ...watchMatch(process.env["DORI_DISCORD_WATCH_MATCH"]),
      shadow: !!shadowInbox,
      words: config.discord,
      inboxFile: shadowInbox || liveInbox,
      timers: { ...realTimers, setTimeout: (cb, ms) => setTimeout(cb, ms) },
      now: realClock.now,
      log: (line) => console.log(line),
      fatal: (code) => process.exit(code === 4014 ? 4 : 3),
      ...(config.hooks.transcribe?.length ? { transcribe: transcribeUrl } : {}),
      // read per message, so a ledger edited while the listener runs is what the next message gets
      hints: (text) => messageLines(text, hintLedger()),
    });
    listener.start();
    await new Promise(() => {});
  }
  // upstream dori-superagent #76 (https://github.com/sisyphuslabs/dori-superagent/pull/76): telegram inbound; #79
  // (https://github.com/sisyphuslabs/dori-superagent/pull/79): edits, media file ids, envInt and its inbound loop; #110
  // (https://github.com/sisyphuslabs/dori-superagent/pull/110): mid= on every line, in telegram-line.ts
  if (key === "telegram") {
    const tg = new Telegram(fetchHttp, realClock, process.env["DORI_TELEGRAM_TOKEN"] ?? die("DORI_TELEGRAM_TOKEN is not set"));
    const store = fileTgInboundStore(`${config.stateDir}/telegram-offset`);
    // review 1 of #350: a blank id is refused rather than read as 0, and so are ids Telegram never gives; #79's envInt
    // also refuses 1e3 and 0x10
    const num = (name: string, positive?: string): number => {
      const raw = process.env[name];
      let n = 0;
      try {
        n = envInt(name, raw);
      } catch (e) {
        die(e instanceof Error ? e.message : String(e));
      }
      if (positive && n <= 0) die(`${name} must be a positive ${positive} id, got: ${JSON.stringify(raw)}`);
      return n;
    };
    const ownerId = num("DORI_TELEGRAM_OWNER_ID", "user");
    const groupChatId = process.env["DORI_TELEGRAM_GROUP_ID"] === undefined ? undefined : num("DORI_TELEGRAM_GROUP_ID");
    const topicId = process.env["DORI_TELEGRAM_TOPIC_ID"] === undefined ? undefined : num("DORI_TELEGRAM_TOPIC_ID", "topic");
    console.log(`INBOUND_READY telegram owner=${ownerId} group=${groupChatId ?? "-"} topic=${topicId ?? "-"}`);
    // writeLineSync, not console.log, which drops a failed write (a closed stdout): the whole line is out before the offset moves past its message.
    await telegramInboundLoop(
      tg,
      store,
      { ownerId, groupChatId, topicId },
      minutes,
      (i) => void writeLineSync(`${formatTelegramInbound(i)}\n`),
      (m) => console.log(`WARN ${m}`.slice(0, 300)),
    );
    return;
  }
  if (key !== "slack") die("inbound supports slack, discord and telegram");
  const auth = { token: process.env["DORI_SLACK_TOKEN"] ?? die("DORI_SLACK_TOKEN is not set"), cookie: process.env["DORI_SLACK_COOKIE"] };
  const ledger = new ThreadLedger(`${config.stateDir}/slack-threads.json`);
  const slack = new Slack(fetchHttp, realClock, auth, process.env["DORI_SLACK_API"]?.trim() || undefined, ledger);
  const me = String((await slack.call("auth.test", {}))["user_id"] ?? die("auth.test returned no user_id"));
  console.log("INBOUND_READY slack");
  const told = new Set<string>();
  const warn = (message: string) => {
    if (!told.has(message)) console.log(`WARN ${message}`.slice(0, 300));
    told.add(message);
  };
  await every(minutes, async () => {
    for (const i of await pollSlackInbound(slack, ledger, { selfUserId: me, warn })) {
      const context = i.root ? ` root=${JSON.stringify(i.root)} recent=${JSON.stringify(i.recent ?? [])}` : "";
      console.log(`INBOUND ${i.source} ${i.channel} ${i.threadTs ?? "-"} ${i.ts || "-"} ${i.user ?? "-"} ${JSON.stringify(i.text ?? "")}${context}`);
    }
  });
  return;
};

export const inboundCommands: Readonly<Record<string, Command>> = {
  "inbound": inboundCommand,
};
