import { join } from "node:path";
import { directiveLine, textDirectives } from "./directives.ts";
import { type DiscordFile, discordMessageProblem, filesKey, readDiscordFiles, UploadRefused } from "./messenger/upload-files.ts";
import { bareThreadName, discordThreadId, postInThread, prepareInThread, threadName, type ThreadStatus, type ThreadVerb, VERB_STATUS } from "./messenger/discord-thread.ts";
import { duplicateLine, SEND_DUPLICATE_EXIT, type Sent, sendKey, sendOnce, sentLine } from "./send-dedupe.ts";
import { mapThread, standThread, threads, unstandThread } from "./messenger/thread-map.ts";
import type { Command } from "./cli-context.ts";
import { die } from "./cli-context.ts";
import { makeHandoverDeps } from "./cli-deps-handover.ts";
import { makeDiscordDeps } from "./cli-deps-discord.ts";
import { makeDirectiveDeps } from "./cli-deps-directives.ts";

const threadCommand: Command = async (context) => {
  const { flags, config, opt, postable, deps, onlyOptions, textOrFile } = context;
  const { quietGuard } = makeHandoverDeps(context);
  const { cardDir, discordClient, env, threadStatuses, ownerSpeech, ownerPlace, notePost, withFileNames } = makeDiscordDeps(context);
  const { inboxText, hintLedger } = makeDirectiveDeps(context);
  await quietGuard();
  const [verb, ref, text] = flags.positionals;
  if (verb === "list") {
    for (const [id, entry] of Object.entries(threads(cardDir()))) console.log(`${id} ${entry.session ?? "none"} ${entry.title}${entry.standing ? " [standing]" : ""}`);
    return;
  }
  if (verb === "map") {
    if (!ref || !text?.trim()) die("usage: dori thread map discord:<id> <session|none>");
    mapThread(cardDir(), discordThreadId(ref ?? ""), text === "none" ? null : text ?? null);
    console.log(`THREAD_MAPPED ${ref} ${text}`);
    return;
  }
  if (verb === "open") {
    const title = bareThreadName(ref ?? "", config.discord).trim();
    const from = opt("from")?.trim();
    const first = opt("first")?.trim();
    // every option is read before the thread is opened: a refusal after startThread would leave an unmapped thread
    const session = opt("session") ?? null;
    if (first) postable(first, "thread open --first");
    if (!title || (!from && !first)) die("usage: dori thread open <title> [--from MSG_ID] [--first TEXT] [--session S]; standalone threads need --first");
    // a thread the lead opens is work without a lane brief: the ledger is read against its title, first message and the
    // owner's message it starts from before anything is opened; a ledger that cannot be read opens nothing
    let found: ReturnType<typeof textDirectives> = [];
    try {
      found = textDirectives([title, first ?? "", from ? inboxText(from) : ""].join("\n"), hintLedger({ strict: true }), { all: true });
    } catch (e) {
      die(`THREAD_REFUSED ${title}: the directive ledger could not be read (${e instanceof Error ? e.message : String(e)}); no thread is opened without its directives. Fix the ledger (dori directives check), or open the work as a lane (dori launch --thread new)`);
    }
    const dc = discordClient();
    const id = await dc.startThread(env("DORI_DISCORD_CHANNEL"), from, threadName("working", title, config.discord));
    if (!from && first) await dc.send(id, first);
    mapThread(cardDir(), id, session, title, { directives: found.map(({ e }) => e.id), openedAt: new Date().toISOString() });
    console.log(`THREAD_DIRECTIVES discord:${id} ${found.length}: ${found.map(({ e, why }) => `${e.id} (${why})`).join(", ") || "none in scope"}; follow them in this thread's work`);
    for (const { e } of found) console.log(directiveLine(e));
    console.log(`THREAD_OPENED discord:${id}`);
    return;
  }
  // Marking a thread done by hand (thread done, thread set done) makes the same check as closing a lane (#47): while
  // another open lane or an open question card uses the thread, it is left as it is. The lane whose close runs this
  // (hooks.threadDone, which sets DORI_CLOSING_LANE, or --lane) is not another user. --force marks it done anyway.
  const holdersOf = async (thread: string): Promise<string> => {
    const closing = opt("lane") ?? process.env["DORI_CLOSING_LANE"] ?? "";
    const sharing = (await deps.registry.open()).filter((l) => l.key !== closing && l.thread === thread).map((l) => l.key);
    const cards = deps.openCards?.(thread) ?? [];
    const standing = threads(cardDir())[discordThreadId(thread)]?.standing === true;
    return [...(sharing.length ? [`open lane ${sharing.join(", ")} uses it`] : []), ...(cards.length ? [`open card ${cards.join(", ")}`] : []), ...(standing ? ["standing thread"] : [])].join("; ");
  };
  if (verb === "set") {
    if (!ref || (text !== "working" && text !== "waiting" && text !== "done" && text !== "standing" && text !== "unstanding")) die("usage: dori thread set discord:<id> working|waiting|done|standing|unstanding [--open-card] [--force]");
    if (text === "standing") {
      const id = discordThreadId(ref ?? "");
      standThread(cardDir(), id);
      // the queue shows it standing from here on, whatever status is asked
      console.log(`THREAD_STANDING discord:${id} ${await threadStatuses(discordClient()).request(id, "waiting")}`);
      return;
    }
    if (text === "unstanding") {
      const id = discordThreadId(ref ?? "");
      // false: released before and its rename may have failed, so it is asked again
      if (!unstandThread(cardDir(), id) && threads(cardDir())[id]?.standing !== false) {
        console.log(`THREAD_NOT_STANDING discord:${id}`);
        return;
      }
      // back to the normal rules: waiting unless a lane works there or a card is open
      console.log(`THREAD_UNSTANDING discord:${id} ${await threadStatuses(discordClient()).request(id, "waiting")}`);
      return;
    }
    const status = text === "done" ? "done" : flags.values["open-card"] ? "waiting" : text === "waiting" ? "waiting" : "working";
    const id = discordThreadId(ref ?? "");
    const holders = status === "done" ? await holdersOf(`discord:${id}`) : "";
    if (holders && !flags.values.force) {
      console.log(`THREAD_LEFT_OPEN discord:${id}: ${holders}; not marked done (--force marks it done anyway)`);
      return;
    }
    if (holders) console.log(`THREAD_DONE_FORCED discord:${id}: ${holders}; marking it done anyway`);
    if (status === "done") unstandThread(cardDir(), id);
    await threadStatuses(discordClient()).request(id, status);
    return;
  }
  if ((verb !== "reply" && verb !== "wait" && verb !== "done") || !ref) die("usage: dori thread <reply|wait|done> discord:<thread id> <text> | --text-file FILE");
  onlyOptions(`thread ${verb}`, ["text-file", "force", "lane", "again", "file"], 3);
  const filePaths = ((flags.values.file as (string | boolean)[] | undefined) ?? []).map((p) => (typeof p === "string" ? p.trim() : ""));
  if (filePaths.some((p) => !p)) die("SEND_FILE_REFUSED --file takes a path; nothing was sent", 2);
  let files: DiscordFile[] = [];
  try {
    files = await readDiscordFiles(filePaths);
  } catch (e) {
    if (!(e instanceof UploadRefused)) throw e;
    die(e.message, 2);
  }
  const body = files.length && !text?.trim() && !opt("text-file") ? "" : postable(await textOrFile(text?.trim(), "usage: dori thread <reply|wait|done> discord:<thread id> <text> | --text-file FILE (or --file PATH)"), `thread ${verb}`);
  const tooBig = discordMessageProblem(files, body);
  if (tooBig) die(tooBig, 2);
  const dc = discordClient();
  await ownerSpeech(body, `thread ${verb}`, () => ownerPlace(dc, discordThreadId(ref ?? "")));
  // keyed on the text as it is posted, prepared once (emoji removed, review 10 of #338; then Discord.prepare, review 6
  // of #358) and posted as prepared: the same key as `dori send discord --to <thread id>` for the same text, so the
  // two commands do not post one text twice either
  const place = `discord:${discordThreadId(ref ?? "")}`;
  const prepared = await prepareInThread(dc, body);
  const threadOnce = (post: () => Promise<Sent>) => sendOnce(join(config.stateDir, "sent"), place, sendKey(["discord", discordThreadId(ref ?? ""), undefined, undefined, prepared, ...filesKey(files)]), post, { again: Boolean(flags.values.again) });
  if (verb === "done") {
    // the text is posted either way; with users left the thread keeps its mark and stays open
    const thread = `discord:${discordThreadId(ref ?? "")}`;
    const holders = await holdersOf(thread);
    if (holders && !flags.values.force) {
      const r = await threadOnce(() => postInThread(dc, ref ?? "", prepared, files, true));
      if (!r.duplicate) await notePost(discordThreadId(ref ?? ""), r.id, withFileNames(body, files));
      console.log(`${r.duplicate ? duplicateLine(place, r) : sentLine("POSTED", r)} THREAD_LEFT_OPEN ${thread}: ${holders}; not marked done (--force marks it done anyway)`);
      return;
    }
    if (holders) console.log(`THREAD_DONE_FORCED ${thread}: ${holders}; marking it done anyway`);
  }
  const statuses = threadStatuses(dc);
  // released after the post: a post that fails leaves a standing thread standing
  const mark = (t: string, s: ThreadStatus) => {
    if (verb === "done") unstandThread(cardDir(), t);
    return statuses.request(t, s);
  };
  // only the post is inside the repeat check, so it is recorded as soon as Discord made it; the status step comes after
  // (review 10 of #338: a slow status step left the post unrecorded past the claim's minute). A repeat is not posted,
  // but the status still goes through: a done after a reply with the same words still closes
  const r = await threadOnce(() => postInThread(dc, ref ?? "", prepared, files, true));
  await mark(discordThreadId(ref ?? ""), VERB_STATUS[verb as ThreadVerb]);
  if (!r.duplicate) await notePost(discordThreadId(ref ?? ""), r.id, withFileNames(body, files));
  console.log(`${r.duplicate ? duplicateLine(place, r) : sentLine("POSTED", r)}${verb === "done" ? " THREAD_DONE" : verb === "wait" ? " THREAD_WAITING" : ""}`);
  // wait and done still set their status, so only a reply that posted nothing exits as a repeat
  if (r.duplicate && verb === "reply") process.exitCode = SEND_DUPLICATE_EXIT;
  return;
};

export const threadCommands: Readonly<Record<string, Command>> = {
  "thread": threadCommand,
};
