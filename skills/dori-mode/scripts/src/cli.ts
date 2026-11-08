#!/usr/bin/env bun
import { join } from "node:path";
import { parseArgs } from "node:util";
import { CheckpointError } from "./checkpoints.ts";
import { LessonError } from "./lessons.ts";
import { WorklogError } from "./worklog.ts";
import { leadAlertPoster } from "./autoturn.ts";
import { LeadError } from "./lead.ts";
import { ConfigError, envFilePath, loadConfig, loadEnvFile, resolveInstance } from "./config.ts";
import { type FlowDeps, LaneStateError } from "./done-flow.ts";
import { HeavyJobError } from "./heavy-queue.ts";
import { LaunchError } from "./launch.ts";
import { DirectiveError } from "./directives.ts";
import { TreeError } from "./explore.ts";
import { ChallengeError } from "./challenge.ts";
import { GateRefusal } from "./merge-gate.ts";
import { ForkError } from "./fork-explore.ts";
import { Registry } from "./registry.ts";
import { realClock, run } from "./run.ts";
import { ScorecardError } from "./scorecard.ts";
import { MessengerError, UnsafeMessageError } from "./messenger/http.ts";
import { openCardIds, QuestionError, QuestionStore } from "./messenger/discord-cards.ts";
import { discordThreadId, postInThread, threadName, ThreadRefError } from "./messenger/discord-thread.ts";
import { mapThread, threads } from "./messenger/thread-map.ts";
import { TranscriptionError } from "./messenger/voice.ts";
import { type Command, die, helpFor, makeCli } from "./cli-context.ts";
import { USAGE } from "./cli-usage.ts";
import { makeDiscordDeps } from "./cli-deps-discord.ts";
import { makeSignal } from "./cli-deps-handover.ts";
import { lanesCommands } from "./cli-lanes.ts";
import { laneStateCommands } from "./cli-lane-state.ts";
import { reviewCommands } from "./cli-review.ts";
import { opsCommands } from "./cli-ops.ts";
import { freshnessCommands } from "./cli-freshness.ts";
import { heavyCommands } from "./cli-heavy.ts";
import { stateGitCommands } from "./cli-state-git.ts";
import { backlogCommands } from "./cli-backlog.ts";
import { messengerCommands } from "./cli-messenger.ts";
import { inboundCommands } from "./cli-inbound.ts";
import { cardsCommands } from "./cli-cards.ts";
import { threadCommands } from "./cli-thread.ts";
import { handoverCommands } from "./cli-handover.ts";
import { directivesCommands } from "./cli-directives.ts";
import { journalCommands } from "./cli-journal.ts";

await resolveInstance(process.cwd());
const foreignEnv = await loadEnvFile(envFilePath());
if (foreignEnv.length) console.error(`DORI_ENV_FOREIGN dropped ${foreignEnv.length} inherited variables of another Dori (its bot token differs from ${envFilePath()}): ${foreignEnv.join(" ")}`);
const config = await loadConfig().catch((e: unknown) => (e instanceof ConfigError ? die(`CONFIG_INVALID ${e.message}`, 2) : Promise.reject(e)));
const discordToken = process.env["DORI_DISCORD_TOKEN"]?.trim();
const deps: FlowDeps = {
  run,
  clock: realClock,
  registry: new Registry(config.stateDir),
  config,
  // a close leaves a thread with an open question card as it is (cards are kept per Discord thread id)
  openCards: (ref: string) => (ref.startsWith("discord:") ? openCardIds(new QuestionStore(cardDir()), discordThreadId(ref)) : []),
  answeredCards: () => new QuestionStore(cardDir()).all().filter((q) => q.status === "answered"),
  ...(discordToken
    ? {
        markThreadDone: async (ref: string) => {
          // a rename left pending (429) is applied later by the listener; the close still says it did not happen yet
          const outcome = await threadStatuses(ownDiscord(discordToken)).request(discordThreadId(ref), "done");
          if (outcome === "pending" || outcome === "dropped") throw new Error(`thread rename ${outcome}, see the THREAD_STATUS line`);
        },
        postInThread: async (ref: string, text: string) => postInThread(ownDiscord(discordToken), ref, text),
        requestThreadStatus: async (ref: string, status: "working" | "waiting") => String(await threadStatuses(ownDiscord(discordToken)).request(discordThreadId(ref), status)),
        standingThread: (ref: string) => threads(cardDir())[discordThreadId(ref)]?.standing === true,
        reopenThread: async (ref: string, title: string) => {
          const id = discordThreadId(ref);
          const outcome = String(await threadStatuses(ownDiscord(discordToken)).request(id, "working"));
          // a done mark dropped its record (thread-status-queue.ts); a lane works in it again, mapped like --thread new
          if (outcome !== "dropped" && !threads(cardDir())[id]) mapThread(cardDir(), id, null, title);
          return outcome;
        },
        postOwner: async (channel: string, text: string) => ownDiscord(discordToken).send(channel, text),
        postLeadAlert: leadAlertPoster((channel, text) => ownDiscord(discordToken).send(channel, text), {
          pair: process.env["DORI_DISCORD_PAIR_CHANNEL"]?.trim() ?? "",
          owner: process.env["DORI_DISCORD_CHANNEL"]?.trim() ?? "",
        }),
        ...(process.env["DORI_DISCORD_CHANNEL"]?.trim()
          ? {
              // dori launch --thread new: a working thread in this Dori's own channel, mapped like dori thread open
              openThread: async (title: string) => {
                const id = await ownDiscord(discordToken).startThread(env("DORI_DISCORD_CHANNEL"), undefined, threadName("working", title, config.discord));
                mapThread(cardDir(), id, null, title);
                return `discord:${id}`;
              },
            }
          : {}),
      }
    : {}),
  ownerInbox: {
    path: process.env["DORI_DISCORD_INBOX"]?.trim() || join(config.stateDir, "discord", "inbox.jsonl"),
    ownerId: process.env["DORI_DISCORD_OWNER"]?.trim() ?? "",
    ownerChannel: process.env["DORI_DISCORD_CHANNEL"]?.trim() ?? "",
  },
  channels: [process.env["DORI_DISCORD_CHANNEL"], process.env["DORI_DISCORD_PAIR_CHANNEL"], process.env["DORI_DISCORD_WATCH_CHANNELS"]].flatMap((v) => (v ?? "").split(/[\s,]+/)).filter(Boolean),
};
const [command = "", ...rest] = process.argv.slice(2);
// --waive <id> "<reason>" takes two values, which parseArgs cannot: taken out of the arguments first
const waive: Record<string, string> = {};
for (let i = rest.indexOf("--waive"); i >= 0; i = rest.indexOf("--waive")) {
  const [id, reason] = [rest[i + 1], rest[i + 2]];
  if (!id || !reason?.trim() || id.startsWith("--") || reason.startsWith("--")) die('--waive takes a directive id and a reason: --waive <id> "<reason>"');
  waive[id ?? ""] = reason?.trim() ?? "";
  rest.splice(i, 3);
}
const flags = parseArgs({
  args: rest,
  allowPositionals: true,
  strict: false,
  options: {
    title: { type: "string" }, brief: { type: "string" }, done: { type: "string" }, thread: { type: "string" },
    model: { type: "string" }, cwd: { type: "string" }, pane: { type: "string" }, evidence: { type: "string", multiple: true },
    reason: { type: "string", multiple: true }, note: { type: "string" }, write: { type: "boolean" }, loop: { type: "string" },
    to: { type: "string" }, text: { type: "string" }, edit: { type: "string" }, status: { type: "string" }, "no-typing": { type: "boolean" }, ping: { type: "string" },
    option: { type: "string", multiple: true }, session: { type: "string" }, tmux: { type: "string" }, open: { type: "boolean" },
    from: { type: "string" }, first: { type: "string" }, "open-card": { type: "boolean" },
    "done-weak-ok": { type: "boolean" }, tag: { type: "string", multiple: true }, lane: { type: "string" }, metric: { type: "string" }, hypothesis: { type: "string" }, date: { type: "string" }, post: { type: "boolean" },
    pull: { type: "boolean" }, push: { type: "boolean" }, "dry-run": { type: "boolean" }, help: { type: "boolean" }, "use-gpu": { type: "boolean" }, ui: { type: "boolean" },
    hypotheses: { type: "string", multiple: true }, test: { type: "string", multiple: true }, "no-hypotheses": { type: "string" }, improved: { type: "boolean" }, template: { type: "boolean" },
    goal: { type: "string" }, "challenge-before": { type: "string", multiple: true }, plan: { type: "string" }, kind: { type: "string" }, result: { type: "string" },
    direction: { type: "string" }, next: { type: "string" }, gpu: { type: "string", multiple: true }, "gpu-all": { type: "boolean" }, mode: { type: "string" }, minutes: { type: "string" },
    summary: { type: "string" }, file: { type: "string", multiple: true }, all: { type: "boolean" }, check: { type: "boolean" }, send: { type: "boolean" },
    "keep-old": { type: "boolean" }, "wait-idle": { type: "string" }, "request-at": { type: "string" }, "request-pane": { type: "string" }, "no-monitors": { type: "boolean" }, state: { type: "string" }, "text-file": { type: "string" },
    force: { type: "boolean" }, thinking: { type: "string" }, "approved-by": { type: "string" }, window: { type: "string" }, reread: { type: "boolean" },
    answer: { type: "string" }, repo: { type: "string", multiple: true }, since: { type: "string" }, until: { type: "string" }, backtest: { type: "boolean" },
    static: { type: "boolean" }, dir: { type: "string", multiple: true }, "no-thread": { type: "string" }, "why-new": { type: "string" },
    remote: { type: "string" }, url: { type: "string" }, by: { type: "string" }, "history-ok": { type: "string", multiple: true }, clock: { type: "string" },
    rule: { type: "string" }, outcome: { type: "string" }, lesson: { type: "string", multiple: true }, global: { type: "boolean" },
    job: { type: "string" }, in: { type: "string", multiple: true }, out: { type: "string" }, rl: { type: "boolean" }, mem: { type: "string" }, want: { type: "string" }, sync: { type: "string", multiple: true }, env: { type: "string", multiple: true }, tools: { type: "string", multiple: true }, back: { type: "string", multiple: true }, caller: { type: "string" },
    reply: { type: "string" }, again: { type: "boolean" }, channel: { type: "string" }, "reply-to": { type: "string" }, posted: { type: "string" }, "post-summary": { type: "boolean" }, "rollover-outcome": { type: "string" }, "rollover-unresolved": { type: "boolean" }, stuck: { type: "boolean" },
    step: { type: "string" }, "remote-effect": { type: "string", multiple: true },
    "wall-minutes": { type: "string" }, "token-limit": { type: "string" }, "cost-limit": { type: "string" }, "activity-path": { type: "string", multiple: true },
    "delete-branch": { type: "boolean" }, "no-test": { type: "string" }, "install-task": { type: "boolean" }, only: { type: "string", multiple: true }, log: { type: "string" }, priority: { type: "string" }, ask: { type: "string" }, "read-only": { type: "boolean" }, "owner-link": { type: "string" }, hash: { type: "string" }, question: { type: "string" },
    source: { type: "string" },
  },
});
if (flags.values.help) {
  console.log(helpFor(command));
  process.exit(0);
}
const cli = makeCli(command, rest, flags, config, deps, waive, discordToken, import.meta.path, import.meta.url, makeSignal());
const { cardDir, threadStatuses, ownDiscord, env } = makeDiscordDeps(cli);

const commands: Readonly<Record<string, Command>> = {
  ...lanesCommands,
  ...laneStateCommands,
  ...reviewCommands,
  ...opsCommands,
  ...freshnessCommands,
  ...heavyCommands,
  ...stateGitCommands,
  ...backlogCommands,
  ...messengerCommands,
  ...inboundCommands,
  ...cardsCommands,
  ...threadCommands,
  ...handoverCommands,
  ...directivesCommands,
  ...journalCommands,
};
const handler = Object.hasOwn(commands, command) ? commands[command] : undefined;

try {
  if (handler) await handler(cli);
  else {
    console.log(USAGE);
    process.exit(command ? 1 : 0);
  }
} catch (e) {
  if (e instanceof LeadError || e instanceof LaunchError || e instanceof UnsafeMessageError || e instanceof MessengerError || e instanceof TranscriptionError || e instanceof QuestionError || e instanceof ThreadRefError || e instanceof LaneStateError || e instanceof ScorecardError || e instanceof TreeError || e instanceof ChallengeError || e instanceof GateRefusal || e instanceof ForkError || e instanceof DirectiveError || e instanceof HeavyJobError || e instanceof CheckpointError || e instanceof LessonError || e instanceof WorklogError) die(e.message);
  throw e;
}
