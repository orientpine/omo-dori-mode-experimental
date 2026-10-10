#!/usr/bin/env bun
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { currentTmuxSession } from "./aoe.ts";
import { envFilePath, loadConfig, loadEnvFile } from "./config.ts";
import { deadPaneTick } from "./dead-panes.ts";
import { claimDone, closeLane, type FlowDeps, LaneStateError, objectDone, pauseLane, resumeLane, watchTick } from "./done-flow.ts";
import { freshnessTick } from "./freshness.ts";
import { acquireSlot, pidAlive, releaseSlot } from "./heavy-slot.ts";
import { guardTick, sampleHost } from "./host-guard.ts";
import { adoptLane, launchLane, LaunchError, setThread } from "./launch.ts";
import { Registry, statusOf } from "./registry.ts";
import { realClock, run } from "./run.ts";
import { syncRegistry } from "./sync.ts";
import { canLaunch } from "./routing.ts";
import { normFix, recordFix } from "./same-fix.ts";
import { computeScorecard, dayWindow, formatScorecard, ScorecardError } from "./scorecard.ts";
import { fetchHttp, MessengerError, UnsafeMessageError } from "./messenger/http.ts";
import { Slack } from "./messenger/slack.ts";
import { pollSlackInbound } from "./messenger/slack-inbound.ts";
import { ThreadLedger } from "./messenger/thread-ledger.ts";
import { slackPresence } from "./messenger/slack-presence.ts";
import { Telegram } from "./messenger/telegram.ts";
import { Discord, discordPresence } from "./messenger/discord.ts";
import { QuestionCards, QuestionError, QuestionStore } from "./messenger/discord-cards.ts";
import { DiscordListener } from "./messenger/discord-listener.ts";
import { discordThreadId, progressText, setThreadStatus, threadHook, ThreadRefError, type ThreadVerb } from "./messenger/discord-thread.ts";
import { realTimers } from "./messenger/typing.ts";
import { transcribe, TranscriptionError } from "./messenger/voice.ts";

const USAGE = `dori <command> [options]

  launch <key> --title T --brief FILE --done "merged o/r#N; closed o/r#M" [--thread REF] [--model M] [--cwd DIR] [--done-weak-ok]
                                       prints LAUNCH_DONE_WEAK (and still launches) when every Done signal only checks
                                       files or text; --done-weak-ok silences it
  adopt  <key> --pane ID --title T --brief FILE --done "..." [--thread REF]
                                       REF is <adapter>:<id> (discord:<thread id>); an empty or malformed REF is refused
  set-thread <key> <adapter>:<id>      point an open lane at another work thread
  sync   [--write]                     registry vs live panes; read-only unless --write
  claim-done [<key>] --evidence TEXT  key defaults to the lane registered for this pane ($HERDR_PANE_ID, or the tmux session with backend aoe)
  object-done <key> --reason TEXT [--reason TEXT ...]
  pause  <key> <reason>                park a lane that waits on a human: no freshness nudge or post, LANE_BLOCKED or
                                       DEAD_PANE for it, and a done claim does not close it; the reason goes in its history
  resume <key>                         back to the status it had before the pause
  fix-attempt <key> --metric M --hypothesis H
                                       record that you asked the lane for another fix of M on hypothesis H; from the 3rd
                                       attempt it prints SAME_FIX_3 (lanes tag reports "(fix: M / H)" for the same count)
  close  <key> [--note TEXT]           close now (Done signals must read back live); a discord:<id> work thread is set
                                       done and archived when DORI_DISCORD_TOKEN is set
  watch                                long-running: emits LANE_* lines every 30 s
  scorecard [--date YYYY-MM-DD|today|yesterday] [--post] [--to discord:<id>]
                                       the day's token scorecard from session usage, the registry, the lanes log and the
                                       inbox (no model call); --post sends it to scorecard.postTo or DORI_DISCORD_CHANNEL
  freshness [--loop MIN]               nudge silent lanes, post their last report via hooks.threadReply
  dead-panes [--loop MIN]              print DEAD_PANE <id> for stopped agent panes
  guard [--loop MIN]                   host load, memory, disk and pane-count alerts
  heavy <label> -- <command ...>       run a heavy command when a slot is free and load is low
  can-launch                           exit 0 if the host has room for a new lane, else print why and exit 4
  send <slack|telegram|discord> --to TARGET --text TEXT [--thread ID] [--edit ID] [--status working|done]
                                       post or edit a message (tokens from DORI_SLACK_TOKEN, DORI_TELEGRAM_TOKEN, DORI_DISCORD_TOKEN);
                                       --status (discord) writes it as the progress message, in discord.statusStyle
  presence <slack|discord>             keep the account shown as online until stopped
  transcribe <audio-file>              run hooks.transcribe and print the text
  inbound slack [--loop MIN]           print INBOUND lines: unread thread replies (threads view), replies in threads
                                       the Dori posted in (any helper), DMs and channels with unread mentions
  inbound discord                      long-running gateway listener: the owner's messages get an eyes reaction and an
                                       inbox row, voice is transcribed, question-card answers are recorded
  ask --text Q --option A [--option B ...] [--thread REF] [--session ID] [--tmux NAME]
                                       post a Discord question card; the first option is the recommended one
  questions [--open]                   list tracked question cards
  reopen <Qn> / resolve <Qn>           put a card's buttons back / forget a settled question
  thread <reply|wait|done> discord:<id> <text>
                                       post in a work thread and set its status (working, waiting, done); done archives it
                                       (Discord env: DORI_DISCORD_TOKEN, DORI_DISCORD_GUILD, DORI_DISCORD_CHANNEL, DORI_DISCORD_OWNER)`;

const die = (message: string, code = 1): never => {
  console.error(message);
  process.exit(code);
};

await loadEnvFile(envFilePath());
const config = await loadConfig();
const discordToken = process.env.DORI_DISCORD_TOKEN?.trim();
const deps: FlowDeps = {
  run,
  clock: realClock,
  registry: new Registry(config.stateDir),
  config,
  ...(discordToken ? { markThreadDone: (ref: string) => setThreadStatus(new Discord(fetchHttp, realClock, discordToken), discordThreadId(ref), "done", config.discord) } : {}),
};
const [command = "", ...rest] = process.argv.slice(2);

const flags = parseArgs({
  args: rest,
  allowPositionals: true,
  strict: false,
  options: {
    title: { type: "string" }, brief: { type: "string" }, done: { type: "string" }, thread: { type: "string" },
    model: { type: "string" }, cwd: { type: "string" }, pane: { type: "string" }, evidence: { type: "string" },
    reason: { type: "string", multiple: true }, note: { type: "string" }, write: { type: "boolean" }, loop: { type: "string" },
    to: { type: "string" }, text: { type: "string" }, edit: { type: "string" }, status: { type: "string" },
    option: { type: "string", multiple: true }, session: { type: "string" }, tmux: { type: "string" }, open: { type: "boolean" },
    "done-weak-ok": { type: "boolean" }, metric: { type: "string" }, hypothesis: { type: "string" }, date: { type: "string" }, post: { type: "boolean" },
  },
});
const opt = (name: string): string | undefined => {
  const v = flags.values[name];
  return typeof v === "string" ? v.trim() : undefined;
};
const need = (name: string): string => opt(name) || die(`--${name} is required`);
// a bare --thread (no value) is a thread ref that came out empty, not a lane without a thread
const threadOpt = (): string | undefined => (flags.values.thread === true ? "" : opt("thread"));
const key = flags.positionals[0];
const loopMin = Number(opt("loop") ?? 0);

const lane = async (k: string | undefined) => {
  const here = config.backend === "aoe" ? await currentTmuxSession(run) : (process.env.HERDR_PANE_ID ?? "");
  const found = k ? await deps.registry.read(k) : await deps.registry.byPane(here);
  if (!found) return die(k ? `no registered lane "${k}"` : "no open lane is registered for this pane");
  if (statusOf(found) === "closed") return die(`lane ${found.key} is already closed`);
  return found;
};

const env = (name: string): string => process.env[name]?.trim() || die(`${name} is not set`);
const discordClient = () => new Discord(fetchHttp, realClock, env("DORI_DISCORD_TOKEN"));
// question cards and their answers; DORI_DISCORD_STATE_DIR keeps them where an existing install already has them
const cardDir = (): string => process.env.DORI_DISCORD_STATE_DIR?.trim() || join(config.stateDir, "discord");
const questionCards = (dc: Discord) => new QuestionCards(dc, new QuestionStore(cardDir()), { channel: env("DORI_DISCORD_CHANNEL"), owner: env("DORI_DISCORD_OWNER"), words: config.discord }, realClock.now);

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

const every = async (minutes: number, tick: () => Promise<void>): Promise<void> => {
  for (;;) {
    await tick().catch((e: unknown) => console.log(`WARN ${e instanceof Error ? e.message : String(e)}`.slice(0, 300)));
    if (minutes <= 0) return;
    await Bun.sleep(minutes * 60_000);
  }
};

try {
  switch (command) {
    case "launch": {
      const r = await launchLane(deps, { key: key ?? "", title: need("title"), brief: need("brief"), done: need("done"), thread: threadOpt(), model: opt("model"), cwd: opt("cwd"), doneWeakOk: Boolean(flags.values["done-weak-ok"]) }, (line) => console.log(line));
      console.log(`LAUNCHED ${r.lane.key} pane=${r.lane.pane} tab=${r.lane.tab ?? "?"}`);
      console.log(r.startup);
      process.exit(r.startup.startsWith("STARTUP_OK") ? 0 : 3);
    }
    case "adopt": {
      const l = await adoptLane(deps, { key: key ?? "", title: need("title"), brief: need("brief"), done: need("done"), thread: threadOpt(), pane: need("pane") });
      console.log(`ADOPTED ${l.key} pane=${l.pane} thread=${l.thread}`);
      break;
    }
    case "sync": {
      const r = await syncRegistry(deps, Boolean(flags.values.write));
      console.log("key | thread | pane | session | status");
      for (const row of [...r.rows, ...r.unregistered]) console.log([row.key, row.thread, row.pane, row.session, row.status].join(" | "));
      console.log(r.drift.length ? `DRIFT (${r.drift.length}):\n${r.drift.map((d) => `- ${d}`).join("\n")}` : "DRIFT none");
      console.log(flags.values.write ? "WROTE session ids" : "READ_ONLY");
      break;
    }
    case "set-thread": {
      const ref = flags.positionals[1]?.trim() ?? die("usage: dori set-thread <key> <adapter>:<id>");
      console.log(await setThread(deps, await lane(key ?? die("set-thread needs a lane key")), ref));
      break;
    }
    case "claim-done":
      console.log(await claimDone(deps, await lane(key), need("evidence")));
      break;
    case "object-done": {
      const reasons = (flags.values.reason as string[] | undefined)?.map((r) => r.trim()).filter(Boolean) ?? [];
      if (!reasons.length) die("--reason is required");
      console.log(await objectDone(deps, await lane(key ?? die("object-done needs a lane key")), reasons));
      break;
    }
    case "pause": {
      const reason = flags.positionals.slice(1).join(" ").trim() || die("usage: dori pause <key> <reason>");
      console.log(await pauseLane(deps, await lane(key ?? die("pause needs a lane key")), reason));
      break;
    }
    case "fix-attempt": {
      const l = await lane(key ?? die("fix-attempt needs a lane key"));
      const r = await recordFix(deps, l.key, { at: new Date().toISOString(), metric: normFix(need("metric")), hypothesis: normFix(need("hypothesis")), via: "lead" });
      console.log(`FIX_RECORDED ${l.key} attempt=${r.count}`);
      if (r.alert) console.log(`SAME_FIX_3 ${l.key} ${r.alert}`);
      break;
    }
    case "resume":
      for (const line of await resumeLane(deps, await lane(key ?? die("resume needs a lane key")))) console.log(line);
      break;
    case "close": {
      const r = await closeLane(deps, await lane(key ?? die("close needs a lane key")), opt("note") ?? "closed by the lead");
      for (const line of r.lines) console.log(line);
      process.exit(r.closed ? 0 : 2);
    }
    case "watch":
      console.log("LANE_WATCH_READY");
      for (;;) {
        for (const line of await watchTick(deps).catch((e: unknown) => [`LANE_WATCH_WARN ${String(e).slice(0, 200)}`])) console.log(line);
        await Bun.sleep(30_000);
      }
    case "scorecard": {
      const window = dayWindow(opt("date") ?? "today", config.scorecard.timeZone, Date.now());
      const data = await computeScorecard({
        sessionsDir: config.sessionsDir,
        lanes: await deps.registry.list(),
        settings: config.scorecard,
        inbox: config.scorecard.inbox || process.env.DORI_DISCORD_INBOX?.trim() || join(config.stateDir, "discord", "inbox.jsonl"),
        owner: process.env.DORI_DISCORD_OWNER?.trim() ?? "",
      }, window);
      const text = formatScorecard(data, config.scorecard.language, Date.now());
      console.log(text);
      if (flags.values.post) {
        const ref = opt("to") || config.scorecard.postTo || `discord:${env("DORI_DISCORD_CHANNEL")}`;
        const id = /^discord:(\d{5,25})$/.exec(ref)?.[1] ?? die(`scorecard posts to discord:<channel or thread id>, not ${ref}`);
        console.log(`SENT ${await discordClient().send(id, text)}`);
      }
      break;
    }
    case "freshness":
      await every(loopMin, async () => {
        for (const a of await freshnessTick(deps, process.env.HOME ?? "")) console.log(`${a.kind.toUpperCase()} ${a.lane} ${a.detail}`);
      });
      break;
    case "dead-panes": {
      const seen = new Set<string>();
      await every(loopMin, async () => {
        const paused = (await deps.registry.open()).flatMap((l) => (statusOf(l) === "paused" && l.pane ? [l.pane] : []));
        for (const line of await deadPaneTick(run, config, seen, new Date().toISOString().slice(0, 13), paused)) console.log(line);
      });
      break;
    }
    case "guard": {
      const state = { alerting: false };
      console.log("HOST_GUARD_READY");
      await every(loopMin, async () => {
        for (const line of guardTick(await sampleHost(run, config.backend), config.guard, state)) console.log(line);
      });
      break;
    }
    case "heavy": {
      const sep = rest.indexOf("--");
      const label = rest[0];
      const cmd = sep >= 0 ? rest.slice(sep + 1) : [];
      if (!label || label === "--" || !cmd.length) die("usage: dori heavy <label> -- <command ...>");
      const load = async () => (await sampleHost(run, config.backend)).load1;
      const slot = await acquireSlot({ dir: `${config.stateDir}/heavy`, slots: config.heavySlots, maxLoad: config.heavyMaxLoad, clock: realClock, load, alive: pidAlive, pid: process.pid }, label ?? "");
      try {
        const child = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit", stdin: "inherit" });
        process.exitCode = await child.exited;
      } finally {
        releaseSlot(slot);
      }
      break;
    }
    case "can-launch": {
      const v = canLaunch(await sampleHost(run, config.backend), config.guard);
      console.log(v.ok ? "CAN_LAUNCH" : `HOLD ${v.reasons.join(" | ")}`);
      process.exit(v.ok ? 0 : 4);
    }
    case "send": {
      const platform = key ?? die("send needs slack, telegram or discord");
      const to = need("to");
      const status = opt("status");
      if (status !== undefined && (platform !== "discord" || (status !== "working" && status !== "done"))) die("--status takes working or done, with discord");
      const text = status === "working" || status === "done" ? progressText(status, need("text"), config.discord) : need("text");
      const thread = opt("thread");
      const edit = opt("edit");
      const token = (name: string) => process.env[name] ?? die(`${name} is not set`);
      if (platform === "slack") {
        const slack = new Slack(fetchHttp, realClock, { token: token("DORI_SLACK_TOKEN"), cookie: process.env.DORI_SLACK_COOKIE }, undefined, new ThreadLedger(`${config.stateDir}/slack-threads.json`));
        if (edit) await slack.edit(to, edit, text);
        else console.log(`SENT ${(await slack.post(to, text, thread)).ts}`);
      } else if (platform === "telegram") {
        const tg = new Telegram(fetchHttp, realClock, token("DORI_TELEGRAM_TOKEN"));
        const target = { chatId: to, ...(thread ? { threadId: Number(thread) } : {}) };
        if (edit) await tg.edit(target, Number(edit), text);
        else console.log(`SENT ${await tg.send(target, text)}`);
      } else if (platform === "discord") {
        const dc = new Discord(fetchHttp, realClock, token("DORI_DISCORD_TOKEN"));
        if (edit) await dc.edit(to, edit, text);
        else console.log(`SENT ${await dc.send(thread ?? to, text)}`);
      } else die(`unknown platform ${platform}`);
      break;
    }
    case "presence": {
      if (key === "slack") {
        const auth = { token: process.env.DORI_SLACK_TOKEN ?? die("DORI_SLACK_TOKEN is not set"), cookie: process.env.DORI_SLACK_COOKIE ?? die("DORI_SLACK_COOKIE is not set (user-token presence needs the d cookie)") };
        const p = slackPresence(new Slack(fetchHttp, realClock, auth), (url, headers) => {
          const options: Bun.WebSocketOptions = { headers: { ...headers } };
          const ws = new WebSocket(url, options);
          return { isOpen: () => ws.readyState === WebSocket.OPEN, send: (f) => ws.send(f), close: () => ws.close() };
        }, auth);
        console.log("PRESENCE_READY slack");
        await every(1, async () => console.log(`PRESENCE slack ${await p.hold()}`));
      } else if (key === "discord") {
        const token = process.env.DORI_DISCORD_TOKEN ?? die("DORI_DISCORD_TOKEN is not set");
        discordPresence(() => {
          const ws = new WebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
          let handler: (d: string) => void = () => {};
          ws.addEventListener("message", (e) => handler(String(e.data)));
          return { send: (d) => ws.send(d), close: () => ws.close(), onMessage: (cb) => { handler = cb; } };
        }, token, realTimers);
        console.log("PRESENCE_READY discord");
        await new Promise(() => {});
      } else die("presence needs slack or discord");
      break;
    }
    case "inbound": {
      if (key === "discord") {
        // a shadow run writes only to its own inbox, never the live one (which dori.env may also name)
        const shadowInbox = process.env.DORI_DISCORD_SHADOW_INBOX?.trim() ?? "";
        const liveInbox = process.env.DORI_DISCORD_INBOX?.trim() || join(config.stateDir, "discord", "inbox.jsonl");
        if (shadowInbox && resolve(shadowInbox) === resolve(liveInbox)) die("DORI_DISCORD_SHADOW_INBOX must differ from the live inbox");
        const dc = discordClient();
        const listener = new DiscordListener({
          dc,
          cards: questionCards(dc),
          open: () => {
            const ws = new WebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
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
          ownerWebhook: process.env.DORI_DISCORD_OWNER_WEBHOOK?.trim() ?? "",
          pairChannel: process.env.DORI_DISCORD_PAIR_CHANNEL?.trim() ?? "",
          pairBot: process.env.DORI_DISCORD_PAIR_BOT?.trim() ?? "",
          shadow: !!shadowInbox,
          words: config.discord,
          inboxFile: shadowInbox || liveInbox,
          timers: { ...realTimers, setTimeout: (cb, ms) => setTimeout(cb, ms) },
          now: realClock.now,
          log: (line) => console.log(line),
          fatal: (code) => process.exit(code === 4014 ? 4 : 3),
          ...(config.hooks.transcribe?.length ? { transcribe: transcribeUrl } : {}),
        });
        listener.start();
        await new Promise(() => {});
      }
      if (key !== "slack") die("inbound supports slack and discord");
      const auth = { token: process.env.DORI_SLACK_TOKEN ?? die("DORI_SLACK_TOKEN is not set"), cookie: process.env.DORI_SLACK_COOKIE };
      const ledger = new ThreadLedger(`${config.stateDir}/slack-threads.json`);
      const slack = new Slack(fetchHttp, realClock, auth, undefined, ledger);
      const me = String((await slack.call("auth.test", {})).user_id ?? die("auth.test returned no user_id"));
      console.log("INBOUND_READY slack");
      await every(loopMin, async () => {
        for (const i of await pollSlackInbound(slack, ledger, { selfUserId: me })) console.log(`INBOUND ${i.source} ${i.channel} ${i.threadTs ?? "-"} ${i.ts || "-"} ${i.user ?? "-"} ${JSON.stringify((i.text ?? "").slice(0, 200))}`);
      });
      break;
    }
    case "ask": {
      const thread = opt("thread")?.replace(/^discord:/, "");
      const q = await questionCards(discordClient()).ask(need("text"), (flags.values.option as string[] | undefined) ?? [], { thread: thread || null, session: opt("session") || null, tmux: opt("tmux") || null });
      console.log(`ASKED ${q.id} message=${q.message}`);
      break;
    }
    case "questions": {
      const all = new QuestionStore(cardDir()).all().filter((q) => !flags.values.open || q.status === "open");
      for (const q of all) console.log(`${q.id} ${q.status} ${JSON.stringify(q.text)}${q.answer ? ` -> ${JSON.stringify(q.answer)} (${q.answerKind})` : ""} thread=${q.thread ?? "-"} session=${q.session ?? "-"} tmux=${q.tmux ?? "-"}`);
      if (!all.length) console.log("NO_QUESTIONS");
      break;
    }
    case "reopen":
      console.log(`REOPENED ${(await questionCards(discordClient()).reopen(key ?? die("reopen needs a question id"))).id}`);
      break;
    case "resolve": {
      const id = key ?? die("resolve needs a question id");
      if (!(await questionCards(discordClient()).resolve(id))) die(`no question ${id}`);
      console.log(`RESOLVED ${id}`);
      break;
    }
    case "thread": {
      const [verb, ref, text] = flags.positionals;
      if ((verb !== "reply" && verb !== "wait" && verb !== "done") || !ref || !text?.trim()) die("usage: dori thread <reply|wait|done> discord:<thread id> <text>");
      const posted = await threadHook(discordClient(), verb as ThreadVerb, ref ?? "", text ?? "", config.discord);
      console.log(`POSTED ${posted}${verb === "done" ? " THREAD_DONE" : verb === "wait" ? " THREAD_WAITING" : ""}`);
      break;
    }
    case "transcribe":
      console.log(await transcribe(run, config.hooks.transcribe, key ?? die("transcribe needs an audio file path")));
      break;
    default:
      console.log(USAGE);
      process.exit(command ? 1 : 0);
  }
} catch (e) {
  if (e instanceof LaunchError || e instanceof UnsafeMessageError || e instanceof MessengerError || e instanceof TranscriptionError || e instanceof QuestionError || e instanceof ThreadRefError || e instanceof LaneStateError || e instanceof ScorecardError) die(e.message);
  throw e;
}
