import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentTmuxSession } from "./aoe.ts";
import { configPath, envFilePath } from "./config.ts";
import { recordThreadPost } from "./done-flow.ts";
import { ownerSpeechProblem } from "./close-summary.ts";
import { statusOf } from "./registry.ts";
import { realClock, run } from "./run.ts";
import { fetchHttp } from "./messenger/http.ts";
import type { DiscordFile } from "./messenger/upload-files.ts";
import { Discord, tokenBotId } from "./messenger/discord.ts";
import { openCardIds, QuestionCards, QuestionStore } from "./messenger/discord-cards.ts";
import { ThreadStatusQueue } from "./messenger/thread-status-queue.ts";
import { transcribe, TranscriptionError } from "./messenger/voice.ts";
import type { Cli } from "./cli-context.ts";
import { die } from "./cli-context.ts";

export const makeDiscordDeps = (cli: Pick<Cli, "deps" | "config">) => {
  const { deps, config } = cli;

  // A post this session made in an open lane's own work thread is recorded on that lane, so its close does not post the same
  // result a second time (done-flow.ts recordThreadPost). Not recording it only means the close posts its summary as before.
  const notePost = async (thread: string, id: string, text: string): Promise<void> => {
    const here = await currentTmuxSession(run).catch(() => "");
    await recordThreadPost(deps.registry, here, thread, id, text, new Date().toISOString()).catch((e: unknown) => console.error(`THREAD_POST_NOT_RECORDED discord:${thread} ${id}: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`));
  };
  const withFileNames = (text: string, files: readonly DiscordFile[]): string => [text, ...files.map((f) => `[file] ${f.filename}`)].filter(Boolean).join("\n");
  const env = (name: string): string => process.env[name]?.trim() || die(`${name} is not set`);
  const idList = (value: string | undefined): string[] => (value ?? "").split(/[\s,]+/).filter(Boolean);
  const watchMatch = (value: string | undefined): { watchMatch?: RegExp } => {
    const source = value?.trim();
    if (!source) return {};
    try {
      return { watchMatch: new RegExp(source) };
    } catch {
      return die(`DORI_DISCORD_WATCH_MATCH is not a valid regular expression: ${source}`);
    }
  };
  // Discord writes go out only as this Dori's own bot: the token's bot must be discord.botId when that is set, and is never
  // any pair Dori's bot (DORI_DISCORD_PAIR_BOT). An inherited token of another Dori fails here instead of posting as it.
  const discordBotProblem = (token: string): string | undefined => {
    const bot = tokenBotId(token);
    const pairBots = idList(process.env["DORI_DISCORD_PAIR_BOT"]);
    const where = `config ${configPath()}, env file ${envFilePath()}`;
    if (config.discord.botId && bot !== config.discord.botId)
      return `DISCORD_BOT_MISMATCH DORI_DISCORD_TOKEN is bot ${bot ?? "unknown"}, but this Dori is bot ${config.discord.botId} (discord.botId; ${where}). Nothing was sent. An inherited token of another Dori? Unset the DORI_DISCORD_* variables or fix the token.`;
    if (bot && pairBots.includes(bot)) return `DISCORD_BOT_MISMATCH DORI_DISCORD_TOKEN is the pair Dori's bot ${bot} (DORI_DISCORD_PAIR_BOT; ${where}). Nothing was sent.`;
    return undefined;
  };
  const checkedDiscordToken = (token: string): string => {
    const why = discordBotProblem(token);
    return why ? die(why, 2) : token;
  };
  // DORI_DISCORD_API: the REST base for a Dori whose only way out is an egress gate (setups/egress-gate); unset = Discord
  const discordApi = (): string => process.env["DORI_DISCORD_API"]?.trim() || "https://discord.com/api/v10";
  // the gateway socket follows HTTPS_PROXY when one is set, like fetch does
  const gatewaySocket = (): WebSocket => {
    const proxy = process.env["HTTPS_PROXY"]?.trim() || process.env["https_proxy"]?.trim();
    return new WebSocket("wss://gateway.discord.gg/?v=10&encoding=json", proxy ? { proxy } : undefined);
  };
  const ownDiscord = (token: string): Discord => {
    const why = discordBotProblem(token);
    if (why) throw new Error(why);
    return new Discord(fetchHttp, realClock, token, discordApi());
  };
  const discordClient = () => new Discord(fetchHttp, realClock, checkedDiscordToken(env("DORI_DISCORD_TOKEN")), discordApi());
  // A Discord place that is the owner's: DORI_DISCORD_CHANNEL, a thread in it, or a DM (a bot's DM is with the owner). The pair
  // channel is the Doris' own. A place that cannot be looked up counts as his.
  const ownerPlace = async (dc: Discord, id: string): Promise<boolean> => {
    const channel = process.env["DORI_DISCORD_CHANNEL"]?.trim() ?? "";
    if (id === (process.env["DORI_DISCORD_PAIR_CHANNEL"]?.trim() || undefined)) return false;
    if (id === channel) return true;
    const c = await dc.call<{ type?: number; parent_id?: string | null }>("GET", `/channels/${id}`).catch(() => undefined);
    return !c || c.type === 1 || (channel !== "" && c.parent_id === channel);
  };
  // What dori send, thread and ask post for the owner is in the speech this Dori uses with him (close-summary.ts
  // ownerSpeechProblem), refused before anything is sent; the place is looked up only for a text that fails.
  const ownerSpeech = async (text: string, what: string, toOwner: () => Promise<boolean>): Promise<void> => {
    const problem = ownerSpeechProblem(text, config.discord.locale, config.discord.ownerSpeech);
    if (problem && (await toOwner())) die(`SPEECH_REFUSED ${what}: ${problem}; nothing was sent`, 2);
  };
  // question cards and their answers; DORI_DISCORD_STATE_DIR keeps them where an existing install already has them
  const cardDir = (): string => process.env["DORI_DISCORD_STATE_DIR"]?.trim() || join(config.stateDir, "discord");
  // every thread status change goes through this queue: coalesced, retried after a 429, decided by the open cards and
  // the lanes still working in the thread
  // working, or sent back to work by an objection (not-done); a lane that claimed done or is paused waits like the thread
  // The lane whose close runs a thread hook (DORI_CLOSING_LANE) is still open in the registry then, but no longer works there.
  const workingLanes = async (t: string): Promise<string[]> =>
    (await deps.registry.open()).filter((l) => l.key !== process.env["DORI_CLOSING_LANE"] && l.thread === `discord:${t}` && (statusOf(l) === "working" || statusOf(l) === "not-done")).map((l) => l.key);
  const threadStatuses = (dc: Discord, log: (line: string) => void = (line) => console.error(line)) => {
    const store = new QuestionStore(cardDir());
    return new ThreadStatusQueue({ dc, words: config.discord, file: join(cardDir(), "thread-status.json"), openCards: (t) => openCardIds(store, t), workingLanes, now: realClock.now, log });
  };
  const questionCards = (dc: Discord, statuses: ThreadStatusQueue = threadStatuses(dc)) => new QuestionCards(dc, new QuestionStore(cardDir()), { channel: env("DORI_DISCORD_CHANNEL"), owner: env("DORI_DISCORD_OWNER"), words: config.discord }, realClock.now, statuses);
  const transcribeUrl = async (url: string, filename: string): Promise<string> => {
    const dir = mkdtempSync(join(tmpdir(), "dori-voice-"));
    try {
      const res = await fetch(url);
      if (!res.ok) throw new TranscriptionError(`voice download failed: ${res.status}`);
      const file = join(dir, filename.replace(/[^\w.-]/g, "_") || "voice");
      await Bun.write(file, await res.arrayBuffer());
      return await transcribe(run, config.hooks.transcribe, file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  return { notePost, withFileNames, env, idList, watchMatch, discordBotProblem, checkedDiscordToken, discordApi, gatewaySocket, ownDiscord, discordClient, ownerPlace, ownerSpeech, cardDir, workingLanes, threadStatuses, questionCards, transcribeUrl };
};
