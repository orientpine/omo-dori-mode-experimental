import { join } from "node:path";
import { currentTmuxSession } from "./aoe.ts";
import { type AskPlace, AskPlaceError, askPlace } from "./ask-place.ts";
import { run } from "./run.ts";
import { notePosted } from "./send-dedupe.ts";
import { QuestionStore } from "./messenger/discord-cards.ts";
import { threads } from "./messenger/thread-map.ts";
import type { Command } from "./cli-context.ts";
import { die } from "./cli-context.ts";
import { makeHandoverDeps } from "./cli-deps-handover.ts";
import { makeDiscordDeps } from "./cli-deps-discord.ts";

const askCommand: Command = async (context) => {
  const { need, flags, postable, threadOpt, opt, deps, config } = context;
  const { quietGuard } = makeHandoverDeps(context);
  const { ownerSpeech, cardDir, questionCards, discordClient } = makeDiscordDeps(context);
  await quietGuard();
  // a card is for the owner: only he answers it
  await ownerSpeech([need("text"), ...((flags.values.option as string[] | undefined) ?? [])].join("\n"), "ask", async () => true);
  const text = postable(need("text"), "ask");
  let place: AskPlace;
  try {
    place = askPlace({
      thread: threadOpt(),
      channel: flags.values.channel === true ? "" : opt("channel"),
      replyTo: flags.values["reply-to"] === true ? "" : opt("reply-to"),
      tmux: opt("tmux"),
      session: opt("session"),
      here: await currentTmuxSession(run).catch(() => ""),
      lanes: await deps.registry.open(),
      threads: threads(cardDir()),
      inbox: process.env["DORI_DISCORD_INBOX"]?.trim() || join(config.stateDir, "discord", "inbox.jsonl"),
      owner: process.env["DORI_DISCORD_OWNER"]?.trim() ?? "",
    });
  } catch (e) {
    if (e instanceof AskPlaceError) die(e.message, 2);
    throw e;
  }
  const thread = place.kind === "channel" ? null : place.thread;
  const q = await questionCards(discordClient()).ask(text, (flags.values.option as string[] | undefined) ?? [], {
    thread,
    session: opt("session") || null,
    // the lane found from this pane is where its answer is relayed, as if --tmux had named it
    tmux: opt("tmux") || (place.kind === "thread" ? place.pane : undefined) || null,
    ...(place.kind === "channel" ? { channelWhy: place.why } : {}),
    ...(place.kind === "reply" ? { replyTo: place.replyTo } : {}),
  });
  // the card is this Dori's post in its place: it answers the owner's lines there like a dori send would (answeredBy)
  if (q.message) notePosted(join(config.stateDir, "sent"), `discord:${q.channel}`, q.message, { replyTo: place.kind === "reply" ? place.replyTo : undefined });
  if (place.kind === "thread" && place.line) console.log(place.line);
  if (place.kind === "channel") console.log(`ASK_CHANNEL ${q.id}: ${place.why}`);
  if (place.kind === "reply") console.log(`ASK_REPLY ${q.id} ${place.replyTo} ${place.thread ? `in thread discord:${place.thread}` : "in the channel"}`);
  console.log(`ASKED ${q.id} message=${q.message}`);
  return;
};

const questionsCommand: Command = async (context) => {
  const { flags } = context;
  const { cardDir } = makeDiscordDeps(context);
  const all = new QuestionStore(cardDir()).all().filter((q) => !flags.values.open || q.status === "open");
  for (const q of all) console.log(`${q.id} ${q.status} ${JSON.stringify(q.text)}${q.answer ? ` -> ${JSON.stringify(q.answer)} (${q.answerKind})` : ""} thread=${q.thread ?? "-"} session=${q.session ?? "-"} tmux=${q.tmux ?? "-"}`);
  if (!all.length) console.log("NO_QUESTIONS");
  return;
};

const reopenCommand: Command = async (context) => {
  const { key } = context;
  const { questionCards, discordClient } = makeDiscordDeps(context);
  console.log(`REOPENED ${(await questionCards(discordClient()).reopen(key ?? die("reopen needs a question id"))).id}`);
  return;
};

const resolveCommand: Command = async (context) => {
  const { key, opt } = context;
  const { questionCards, discordClient } = makeDiscordDeps(context);
  const id = key ?? die("resolve needs a question id");
  const resolved = (await questionCards(discordClient()).resolve(id, opt("answer"))) ?? die(`no question ${id}`);
  console.log(`RESOLVED ${id} ${resolved}`);
  return;
};

export const cardsCommands: Readonly<Record<string, Command>> = {
  "ask": askCommand,
  "questions": questionsCommand,
  "reopen": reopenCommand,
  "resolve": resolveCommand,
};
