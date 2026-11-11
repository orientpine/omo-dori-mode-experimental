import { join } from "node:path";
import { realClock } from "./run.ts";
import { fetchHttp } from "./messenger/http.ts";
import { clearEyes, Slack, slackRowIds, slackUnreact } from "./messenger/slack.ts";
import type { UploadFile } from "./messenger/slack.ts";
import { type DiscordFile, discordMessageProblem, filesKey, readDiscordFiles, readUploads, UploadRefused } from "./messenger/upload-files.ts";
import { ThreadLedger } from "./messenger/thread-ledger.ts";
import { slackPresence } from "./messenger/slack-presence.ts";
import { Telegram } from "./messenger/telegram.ts";
import { Discord, discordPresence } from "./messenger/discord.ts";
import { progressText } from "./messenger/discord-thread.ts";
import { duplicateLine, SEND_DUPLICATE_EXIT, type Sent, sendKey, sendOnce, sentLine } from "./send-dedupe.ts";
import { realTimers } from "./messenger/typing.ts";
import type { Command } from "./cli-context.ts";
import { die, envSlackToken, every } from "./cli-context.ts";
import { makeHandoverDeps } from "./cli-deps-handover.ts";
import { makeDiscordDeps } from "./cli-deps-discord.ts";

const sendCommand: Command = async (context) => {
  const { key, onlyOptions, need, opt, flags, postable, textOrFile, config } = context;
  const { quietGuard } = makeHandoverDeps(context);
  const { checkedDiscordToken, discordApi, ownerSpeech, ownerPlace, notePost, withFileNames } = makeDiscordDeps(context);
  await quietGuard();
  const platform = key ?? die("send needs slack, telegram or discord");
  onlyOptions("send", ["to", "text", "text-file", "thread", "edit", "status", "no-typing", "ping", "reply", "again", "file"], 1);
  const to = need("to");
  const status = opt("status");
  if (status !== undefined && (platform !== "discord" || (status !== "working" && status !== "done"))) die("--status takes working or done, with discord");
  // a bare telegram --thread/--edit gets the telegram id refusal below; on slack and discord opt() refuses it as valueless
  const thread = platform === "telegram" && flags.values.thread === true ? undefined : opt("thread");
  const edit = platform === "telegram" && flags.values.edit === true ? undefined : opt("edit");
  const filePaths = ((flags.values.file as (string | boolean)[] | undefined) ?? []).map((p) => (typeof p === "string" ? p.trim() : ""));
  if (filePaths.some((p) => !p)) die("SEND_FILE_REFUSED --file takes a path; nothing was sent", 2);
  if (filePaths.length && platform !== "slack" && platform !== "discord") die(`SEND_FILE_REFUSED --file is only supported for slack and discord, not ${platform}; nothing was sent`, 2);
  if (filePaths.length && edit) die("SEND_FILE_REFUSED --file is for a new message, not --edit; nothing was sent", 2);
  if (filePaths.length && platform === "slack" && flags.values.again) die("SEND_FILE_REFUSED --again is for a text post; a slack --file send is never checked for repeats; nothing was sent", 2);
  let uploads: UploadFile[] = [];
  // discord: the files go in the message's own request and their sha256 into its repeat check
  let discordFiles: DiscordFile[] = [];
  try {
    if (filePaths.length && platform === "slack") uploads = readUploads(filePaths);
    if (filePaths.length && platform === "discord") discordFiles = await readDiscordFiles(filePaths);
  } catch (e) {
    if (!(e instanceof UploadRefused)) throw e;
    die(e.message, 2);
  }
  // with --file the text is optional: it goes out as the files' message (Slack initial_comment, Discord content)
  const body = filePaths.length && !opt("text") && !opt("text-file") ? "" : postable(await textOrFile(opt("text"), "send needs --text TEXT or --text-file FILE (or --file PATH, slack or discord)"), "send");
  const text = status === "working" || status === "done" ? progressText(status, body, config.discord) : body;
  const tooBig = discordMessageProblem(discordFiles, text);
  if (tooBig) die(tooBig, 2);
  const rawPing = flags.values.ping;
  if (rawPing !== undefined && (typeof rawPing !== "string" || rawPing.length === 0 || /[^0-9]/.test(rawPing))) die("--ping takes a digits-only user id");
  const ping = typeof rawPing === "string" ? rawPing : undefined;
  if (ping !== undefined && (platform !== "discord" || edit)) die("--ping is only supported for new Discord messages");
  const reply = opt("reply");
  if (flags.values.reply !== undefined && (!reply || /[^0-9]/.test(reply))) die("--reply takes the digits-only id of the message this one answers");
  if (reply !== undefined && (platform !== "discord" || edit)) die("--reply is only supported for new Discord messages");
  if (flags.values.again && edit) die("--again is for a new message; an edit is never checked for repeats");
  const token = (name: string) => process.env[name] ?? die(`${name} is not set`);
  // a new message goes out once per place, reply target, ping and text in SEND_DEDUPE_MS, and never when it is the
  // place's last post (src/send-dedupe.ts); a repeat exits SEND_DUPLICATE_EXIT, a post prints what the service holds
  const place = platform === "discord" ? `discord:${thread ?? to}` : `${platform}:${to}${thread ? `/${thread}` : ""}`;
  const sentDir = join(config.stateDir, "sent");
  // a Discord text keys as it goes out: prepared once (Discord.prepare: the --ping in front unless the text has it,
  // review 8 of #338; thread links named; underscores escaped, review 6 of #358) and posted as prepared
  const dedupeKey = (keyText: string) => sendKey([platform, platform === "discord" ? (thread ?? to) : `${to}/${thread ?? ""}`, reply, ping, keyText, ...filesKey(discordFiles)]);
  // an edit is never checked and does not move the place's last-post record (docs/follow-ups.md)
  const once = async (post: () => Promise<Sent>, keyText = text) => {
    const r = await sendOnce(sentDir, place, dedupeKey(keyText), post, { again: Boolean(flags.values.again), replyTo: reply });
    console.log(r.duplicate ? duplicateLine(place, r) : sentLine("SENT", r));
    if (r.duplicate) process.exitCode = SEND_DUPLICATE_EXIT;
    return r;
  };
  if (platform === "slack") {
    const slackKey = envSlackToken();
    const slack = new Slack(fetchHttp, realClock, { token: slackKey, cookie: process.env["DORI_SLACK_COOKIE"] }, process.env["DORI_SLACK_API"]?.trim() || undefined, new ThreadLedger(`${config.stateDir}/slack-threads.json`));
    if (edit) await slack.edit(to, edit, text);
    else {
      let posted: { channel: string; ts: string } | undefined;
      // files are shared once per call and never by the repeat check: a failure exits non-zero and a person calls again.
      const files = { inbox: process.env["DORI_DISCORD_INBOX"]?.trim() || join(config.stateDir, "discord", "inbox.jsonl"), uneyed: join(config.stateDir, "slack-uneyed.log") };
      // completeUploadExternal names no message ts, so the share answers the rows there before its upload started and
      // none that came during it (OkDori answered the owner with a file share and the eyes stayed, 2026-11-03)
      let known: ReadonlySet<string> | undefined;
      if (uploads.length) {
        known = slackRowIds(files.inbox, to);
        console.log(`SENT ${(await slack.upload(to, uploads, thread, text || undefined)).join(",")}`);
        posted = { channel: to, ts: "" };
      } else
        await once(async () => {
          const p = await slack.post(to, text, thread);
          posted = p;
          return { id: p.ts, content: p.text };
        });
      // only the watcher's bot puts eyes on; a member's token (xoxp-) must never take a reaction off
      if (posted && slackKey.startsWith("xoxb-")) {
        for (const line of await clearEyes(slackUnreact(slackKey, process.env["DORI_SLACK_API"]?.trim() || undefined), files, posted, thread, 3000, known)) console.log(line);
      }
    }
  } else if (platform === "telegram") {
    // A malformed or empty id must not fall through to a General post or an edit with a null message id.
    const id = (flag: "thread" | "edit", what: string): number | undefined => {
      if (flags.values[flag] === undefined) return undefined;
      const value = typeof flags.values[flag] === "string" ? opt(flag) ?? "" : "";
      return /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))
        ? Number(value)
        : die(`--${flag} must be a Telegram ${what} id, a whole number above 0`);
    };
    const threadId = id("thread", "topic");
    const messageId = id("edit", "message");
    const tg = new Telegram(fetchHttp, realClock, token("DORI_TELEGRAM_TOKEN"));
    const target = { chatId: to, ...(threadId !== undefined ? { threadId } : {}) };
    if (messageId !== undefined) await tg.edit(target, messageId, text);
    else
      await once(async () => {
        const m = await tg.post(target, text);
        return { id: String(m.id), content: m.text };
      });
  } else if (platform === "discord") {
    const dc = new Discord(fetchHttp, realClock, checkedDiscordToken(token("DORI_DISCORD_TOKEN")), discordApi());
    await ownerSpeech(body, "send", () => ownerPlace(dc, edit ? to : (thread ?? to)));
    if (edit) await dc.edit(to, edit, text);
    else {
      const prepared = await dc.prepare(text, ping);
      const r = await once(() => dc.post(thread ?? to, prepared, !flags.values["no-typing"], ping, reply, discordFiles, true), prepared);
      if (!r.duplicate) await notePost(thread ?? to, r.id, withFileNames(body, discordFiles));
    }
  } else die(`unknown platform ${platform}`);
  return;
};

const presenceCommand: Command = async (context) => {
  const { key } = context;
  const { checkedDiscordToken, gatewaySocket } = makeDiscordDeps(context);
  if (key === "slack") {
    const auth = { token: envSlackToken(), cookie: process.env["DORI_SLACK_COOKIE"] ?? die("DORI_SLACK_COOKIE is not set (user-token presence needs the d cookie)") };
    const p = slackPresence(new Slack(fetchHttp, realClock, auth), (url, headers) => {
      const options: Bun.WebSocketOptions = { headers: { ...headers } };
      const ws = new WebSocket(url, options);
      return { isOpen: () => ws.readyState === WebSocket.OPEN, send: (f) => ws.send(f), close: () => ws.close() };
    }, auth);
    console.log("PRESENCE_READY slack");
    await every(1, async () => console.log(`PRESENCE slack ${await p.hold()}`));
  } else if (key === "discord") {
    const token = checkedDiscordToken(process.env["DORI_DISCORD_TOKEN"] ?? die("DORI_DISCORD_TOKEN is not set"));
    discordPresence(() => {
      const ws = gatewaySocket();
      let handler: (d: string) => void = () => {};
      ws.addEventListener("message", (e) => handler(String(e.data)));
      return { send: (d) => ws.send(d), close: () => ws.close(), onMessage: (cb) => { handler = cb; } };
    }, token, realTimers);
    console.log("PRESENCE_READY discord");
    await new Promise(() => {});
  } else die("presence needs slack or discord");
  return;
};

export const messengerCommands: Readonly<Record<string, Command>> = {
  "send": sendCommand,
  "presence": presenceCommand,
};
