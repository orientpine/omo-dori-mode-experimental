#!/usr/bin/env bun
// allow: SIZE_OK — existing command dispatcher; command behavior lives in separate modules.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { currentTmuxSession } from "./aoe.ts";
import { findLead, LeadError } from "./lead.ts";
import { ackHandover, handover, type HandoverDeps } from "./handover.ts";
import { laneHandover, type LaneHandoverDeps, markReady, paneSignals, SUMMARY_TEMPLATE } from "./lane-handover.ts";
import { appendRollover, dueReasons, LEAD_PREFIX, quietReason, readRollovers, rolloverStats, sessionStart } from "./rollover.ts";
import { procTable, resolveSession } from "./session-id.ts";
import { restartService } from "./update-ready.ts";
import { ConfigError, configPath, envFilePath, loadConfig, loadEnvFile, resolveInstance } from "./config.ts";
import { sendVerified, submitToPane } from "./panes.ts";
import { applyUpdate } from "./update.ts";
import { announceChange } from "./update-announce.ts";
import { deadPaneTick } from "./dead-panes.ts";
import { claimDone, closeLane, type FlowDeps, LaneStateError, objectDone, pauseLane, resumeLane, watchTick } from "./done-flow.ts";
import { freshnessTick } from "./freshness.ts";
import { acquireSlot, pidAlive, releaseSlot } from "./heavy-slot.ts";
import { guardTick, sampleHost } from "./host-guard.ts";
import { areaLabel, type AreaQuery, areaSignals, formatSignals, hasSignals, oneLine, priorFixLines, tagsOf } from "./lane-signals.ts";
import { adoptLane, doneWeakWarning, goalWarning, laneStartText, launchLane, LaunchError, renderBrief, setThread, validateLaunch } from "./launch.ts";
import { addNode, formatIntent, formatTree, gateFix, intentView, laneArea, loadTree, NODE_KINDS, type NodeKind, recordBranch, recordOverride, recordRefusal, requiredMessage, researchCheck, researchFacts, researchHint, sendResearch, setStatus, stuckTop, stuckView, type TreeArea, TreeError, updateTree } from "./explore.ts";
import { challengeMissing, ChallengeError, checkReviewers, familyOf, reviewers, runChallenge } from "./challenge.ts";
import { canonical, evidenceLines, inferredLine, inferRepeats, laneEvents, type MetricRepeat, suspects } from "./auto-signals.ts";
import { runOwnerCheck, sendReread } from "./owner-check.ts";
import { branchesFrom, ForkError, forkExplore, type Mode } from "./fork-explore.ts";
import { Registry, statusOf } from "./registry.ts";
import { realClock, run } from "./run.ts";
import { watchLog } from "./watch-log.ts";
import { syncRegistry } from "./sync.ts";
import { canLaunch } from "./routing.ts";
import { normFix, recordFix } from "./same-fix.ts";
import { computeScorecard, dayWindow, formatScorecard, saveScorecard, ScorecardError } from "./scorecard.ts";
import { fetchHttp, MessengerError, UnsafeMessageError } from "./messenger/http.ts";
import { Slack } from "./messenger/slack.ts";
import { pollSlackInbound } from "./messenger/slack-inbound.ts";
import { ThreadLedger } from "./messenger/thread-ledger.ts";
import { slackPresence } from "./messenger/slack-presence.ts";
import { Telegram } from "./messenger/telegram.ts";
import { Discord, discordPresence, tokenBotId } from "./messenger/discord.ts";
import { openCardIds, QuestionCards, QuestionError, QuestionStore } from "./messenger/discord-cards.ts";
import { DiscordListener } from "./messenger/discord-listener.ts";
import { bareThreadName, discordThreadId, postInThread, postLaneStart, progressText, threadHook, threadName, ThreadRefError, type ThreadVerb } from "./messenger/discord-thread.ts";
import { mapThread, threads } from "./messenger/thread-map.ts";
import { ThreadStatusQueue } from "./messenger/thread-status-queue.ts";
import { realTimers } from "./messenger/typing.ts";
import { transcribe, TranscriptionError } from "./messenger/voice.ts";

const USAGE = `dori <command> [options]

  lead                                 print the live lead as "<aoe-id> <tmux-session>"
  launch <key> --title T --brief FILE --done "merged o/r#N; closed o/r#M" [--thread REF] [--model M] [--cwd DIR] [--tag T ...] [--done-weak-ok]
         [--goal "owner words"] [--challenge-before STEP ...] [--dry-run]
                                       prints LAUNCH_DONE_WEAK (and still launches) when every Done signal only checks
                                       files or text; --done-weak-ok silences it. The brief gets a "Past signals" section
                                       from earlier lanes in the same cwd or with a shared tag (the key's first word is one)
                                       and the area's "Hypothesis tree". --goal keeps the owner's words for intent-check
                                       (LAUNCH_NO_GOAL without it); --challenge-before makes the lane run dori challenge
                                       before that step (claim-done is refused until it did); --dry-run prints the brief
                                       as the lane would read it and opens nothing
  adopt  <key> --pane ID --title T --brief FILE --done "..." [--thread REF] [--tag T ...] [--goal G] [--challenge-before STEP ...]
                                       REF is <adapter>:<id> (discord:<thread id>); an empty or malformed REF is refused
  set-thread <key> <adapter>:<id>      point an open lane at another work thread
  sync   [--write]                     registry vs live panes; read-only unless --write; a SIGNALS line per open lane with a record
  claim-done [<key>] --evidence TEXT  key defaults to the lane registered for this pane ($HERDR_PANE_ID, or the tmux session with backend aoe)
  object-done <key> --reason TEXT [--reason TEXT ...]
  pause  <key> <reason>                park a lane that waits on a human: no freshness nudge or post, LANE_BLOCKED or
                                       DEAD_PANE for it, and a done claim does not close it; the reason goes in its history
  resume <key>                         back to the status it had before the pause
  fix-attempt <key> --metric M --hypothesis H [--hypotheses H1 --test T1 ...] [--improved] [--no-hypotheses REASON]
                                       record that you asked the lane for another fix of M on hypothesis H; first prints
                                       PRIOR_FIX lines (hypotheses already tried on M in this area). One step of the stuck
                                       ladder (lanes tag reports "(fix: M / H)" for the same count; untagged repeats count
                                       too): from stuck.hypothesesAt (2) failed attempts on M it refuses (HYPOTHESES_REQUIRED,
                                       exit 5) unless 3+ competing --hypotheses each have a cheap --test (STUCK_BRANCH, into
                                       the tree); at stuck.researchAt (3) STUCK rung 3 sends the lane ulw research and a
                                       challenge of its next plan; after that, or one hypothesis fixatedAfter (3) times,
                                       STUCK rung 4 (the lead may roll it over). --improved: the last fix moved M, the count
                                       starts again; --no-hypotheses REASON goes on anyway (HYPOTHESES_OVERRIDE, logged)
  tree [show|add|falsify|support|close|reopen] [ID] [--lane K | --cwd DIR | --tag T] [--kind K] [--text T] [--test X] [--metric M] [--result R]
                                       the area's hypothesis tree: open, supported and falsified hypotheses, untried
                                       directions (--kind direction), findings, research due, attempts tried. add takes
                                       --kind hypothesis|direction|finding|research --text; falsify/support/close take
                                       an ID and --result. No area option: this pane's lane, else the current directory
  challenge <key> --plan FILE [--model M] [--all]
                                       a model of another family than the lane's reviews the plan in a fresh context,
                                       with read-only access to the plan's repository: reasons it will fail, missing
                                       alternatives, the cheapest falsifying test. Saved under <stateDir>/challenges/<key>/
                                       and recorded on the lane (CHALLENGE_SAVED). Reviewers go in reviewers.models
                                       order (best GPT, Claude, Grok); the first that writes a review wins, --all asks one
                                       of each family in turn. Ids this host cannot call are skipped before any call
  challenge --check [<key>]            each reviewer id: REVIEWER_OK (and the id it is called as) or REVIEWER_SKIP and why
  fork-explore <key> --metric M --hypotheses H1 --test T1 --hypotheses H2 --test T2 ... [--gpu N ...|--gpu-all]
               [--mode agent|cmd] [--minutes N] [--model M]
                                       one time-boxed task per hypothesis, in parallel, all on metric M; GPU branches
                                       (--gpu <branch number>) wait for a heavy slot. agent: an omo -p run per branch;
                                       cmd: each --test is a command. Prints a comparison table, feeds the tree
  research-hint <key> [--send]         a search plan for the lane's stuck symptom (papers, issues, repos), from its records;
                                       --send types explore.researchText into the lane: "ulw research " and a question
                                       built from its records, so omo starts its ulw-research skill (RESEARCH_SENT)
  research-check <key>                 did the last ulw research text start the skill: the lane's session log holds the
                                       omo-ulw-research:skill-pointer and a read of ulw-research/SKILL.md (RESEARCH_STARTED),
                                       not yet (RESEARCH_PENDING), or not within explore.researchVerifyMin (RESEARCH_NOT_STARTED,
                                       exit 6). freshness runs the same check on every tick
  intent-check <key> [--direction TEXT] [--next TEXT] [--goal "owner words"]
                                       the owner's goal next to the lane's current direction and next step, then the
                                       owner check on them at once (no interval): OWNER_CHECK <key> OK, or a finding as the
                                       stuck ladder's context rung (STUCK). --direction/--next record what the lane says it
                                       does now; --goal sets a missing goal
  repeat-check <key> [--since ISO|Nd|Nh] [--until ISO] [--repo DIR ...] [--backtest]
                                       untagged repeats: a gate line (metric) that failed and was re-targeted by a new
                                       prescription or patch, from the lane's [REPORT] lines, its branch commits (worktrees,
                                       cwd, --repo) and tree entries; INFERRED <key> "<metric>" <n> with the evidence from
                                       stuck.researchAt cycles (the inferred half of the stuck count). Default window: the
                                       lane's current session. --backtest prints each time a count reached it, with its time
  owner-check <key> [--force | --reread]
                                       a reviewer of another family (reviewers.models, autoSignals.ownerCheck.first first)
                                       reads the brief, the owner's words in it and in the lead's [LEAD] relays, his card
                                       answers and messages in the lane's thread (dated, the newest wins), and the
                                       newest reports: OWNER_CHECK <key> VIOLATION|CONTRADICTION|GOAL_LOSS|OK with quoted
                                       evidence. An owner quote not in his words (goal, brief, quoted part of a relay,
                                       his decisions) is dropped (OWNER_CHECK_UNGROUNDED); a report an earlier check read
                                       is not flagged again (OWNER_CHECK_STALE); a report quote not found is marked
                                       unverified. A finding is the
                                       stuck ladder's context rung (STUCK "@context"); again in the next check, rung 4.
                                       Only on a report newer than the last check; --force skips the interval and daily
                                       limit. --reread: you confirmed the last finding, so the lane gets stuck.rereadText
                                       (its brief and the owner's words to re-read; REREAD_SENT). freshness runs it on new reports
  signals [--lane K | --cwd DIR | --tag T]
                                       what earlier lanes tried and how it went: numbered fix attempts and the root-cause
                                       switch, tagged fixes by metric, rejected done claims, re-sends, nudges, outcome,
                                       warnings; no option = one SIGNALS line per open lane. Read it before re-instructing
  close  <key> [--note TEXT]           close now (Done signals must read back live); a discord:<id> work thread is set
                                       done and archived when DORI_DISCORD_TOKEN is set; a thread another open
                                       lane or an open card uses only gets the result posted
  watch                                long-running: emits LANE_* lines every 30 s
  update [--pull] [--dry-run]           apply changed scripts to configured services and report unset new config keys
  notify-change --summary TEXT [--file PATH ...]
                                       tell the lead about changed guidance using update.announce
  scorecard [--date YYYY-MM-DD|today|yesterday] [--post] [--to discord:<id>]
                                       the day's token scorecard from session usage, the registry, the lanes log and the
                                       inbox (no model call), saved to <stateDir>/scorecard/<date>.json and latest.md;
                                       --post also sends it to scorecard.postTo or DORI_DISCORD_CHANNEL (off by default)
  freshness [--loop MIN]               nudge silent lanes, post their last report via hooks.threadReply
  dead-panes [--loop MIN]              print DEAD_PANE <id> for stopped agent panes
  guard [--loop MIN]                   host load, memory, disk and pane-count alerts
  heavy <label> -- <command ...>       run a heavy command when a slot is free and load is low
  can-launch                           exit 0 if the host has room for a new lane, else print why and exit 4
  send <slack|telegram|discord> --to TARGET --text TEXT [--thread ID] [--edit ID] [--status working|done] [--no-typing] [--ping USER_ID]
                                       post or edit a message (tokens from DORI_SLACK_TOKEN, DORI_TELEGRAM_TOKEN, DORI_DISCORD_TOKEN);
                                       --status (discord) writes it as the progress message, in discord.statusStyle;
                                       Discord posts show typing first (best effort); --no-typing skips it
                                       --ping USER_ID (digits only) mentions and pings only that user on a new Discord post
  type <pane> --text TEXT | --text-file FILE
                                       type text into an agent pane and confirm it was submitted: Enter, an empty input
                                       box (one more Enter if not), a running turn. Prints SUBMITTED, or NOT_SUBMITTED
                                       <reason> (also in the watch log) and exits 1. Use it for every [LEAD] relay
  presence <slack|discord>             keep the account shown as online until stopped
  transcribe <audio-file>              run hooks.transcribe and print the text
  inbound slack [--loop MIN]           print INBOUND lines: unread thread replies (threads view), replies in threads
                                       the Dori posted in (any helper), DMs and channels with unread mentions
  inbound discord                      long-running gateway listener: the owner's messages get an eyes reaction and an
                                       inbox row, voice is transcribed, question-card answers are recorded
  ask --text Q --option A [--option B ...] [--thread REF] [--session ID] [--tmux NAME]
                                       post a Discord question card; the first option is the recommended one
  questions [--open]                   list tracked question cards
  reopen <Qn> / resolve <Qn> [--answer TEXT]
                                       put a card's buttons back / forget a settled question; a card still open (the
                                       owner answered in text) folds into its record with TEXT as the answer
  handover --approved-by REF [--note FILE] [--title T] [--model M] [--keep-old] [--no-monitors] [--minutes N] [--dry-run]
                                       move the lead to a new session (backend aoe): write a note (open lanes, the old
                                       session's running monitors, open question cards, todos, timers, --note), open the
                                       new session on it, point leadPane, dori.env DORI_LEAD_*, the lanes and the cards at
                                       it, restart handover.services, then check that its monitors run and that a
                                       [REPORT] probe and an inbox probe are acked from it. Only then is the old session
                                       closed (HANDOVER_DONE); a failed check moves everything back (HANDOVER_VERIFY_FAIL,
                                       exit 3). Run from inside the lead it detaches itself (systemd-run)
  handover ack <id> [--state DIR]      the new lead answers a HANDOVER_PROBE line with this (the line gives --state)
  handover --lane <key> --approved-by REF [--note FILE] [--model M] [--thinking L] [--force] [--keep-old] [--minutes N] [--dry-run]
                                       move a lane to a new session (run by the lead): REF is lead:<reason and the signal behind
                                       it> (the lead decides; the owner gets a line afterwards, its message id goes to the
                                       log, ROLLOVER_OWNER_REPORT_MISSING when it cannot be sent), or the owner's answered card
                                       Qn or message link, kept in the note and log: refuses while a local chain of the
                                       lane's agent, a running turn or an open question would die, unless the lane ran
                                       handover ready (or --force); writes a note (brief, owner goal, Done, todos, goal,
                                       monitors, local chains, detached jobs, last reports, model and thinking), opens a
                                       session in the same real path with --model and --thinking, points the registry and
                                       cards at it, checks its status line, monitors and a [LEAD] probe ack, then closes the
                                       old session (HANDOVER_DONE); a failed check moves back and closes the new one (exit 3);
                                       a run killed midway is repaired by the next run for that lane (HANDOVER_RECOVERED)
  rollover-propose <lead|key> [--dry-run]
                                       the rollover proposal for the lead to decide: handover.proposalText with the length
                                       signals, the thresholds crossed, the lane's stuck rung and the note a dry-run handover
                                       writes (ROLLOVER_PROPOSAL), logged to <stateDir>/rollover-log.jsonl; then run the
                                       handover with --approved-by "lead:<reason and signal>"
  rollover-stats [--window H]          proposals and rollovers from the log: signal values, approval time, each step's time
                                       and result, and the lane's watch-log quality signals H hours (24) before and after
  handover ready [<key>] --note FILE   run by a lane in its own pane at a safe point: the local chains running now may end
                                       with the old session; FILE is the lane's conversation summary (its headings: handover
                                       ready --template) and goes into the note (valid handover.readyMin minutes)
  thread open <title> [--from MSG_ID] [--first TEXT] [--session S]
                                       open and map a work thread; standalone threads require --first
  thread map discord:<id> <session|none>
                                       set the mapped session, preserving the title
  thread list                          print mapped thread ids, sessions and titles
  thread set discord:<id> working|waiting|done [--open-card]
                                       queue its status; done archives it and removes its mapping
  thread <reply|wait|done> discord:<id> <text>
                                       post in a work thread and set its status (working, waiting, done); done archives it
                                       (Discord env: DORI_DISCORD_TOKEN, DORI_DISCORD_GUILD, DORI_DISCORD_CHANNEL, DORI_DISCORD_OWNER)`;

const die = (message: string, code = 1): never => {
  console.error(message);
  process.exit(code);
};

await resolveInstance(process.cwd());
const foreignEnv = await loadEnvFile(envFilePath());
if (foreignEnv.length) console.error(`DORI_ENV_FOREIGN dropped ${foreignEnv.length} inherited variables of another Dori (its bot token differs from ${envFilePath()}): ${foreignEnv.join(" ")}`);
const config = await loadConfig().catch((e: unknown) => (e instanceof ConfigError ? die(`CONFIG_INVALID ${e.message}`, 2) : Promise.reject(e)));
const discordToken = process.env.DORI_DISCORD_TOKEN?.trim();
const deps: FlowDeps = {
  run,
  clock: realClock,
  registry: new Registry(config.stateDir),
  config,
  // a close leaves a thread with an open question card as it is (cards are kept per Discord thread id)
  openCards: (ref: string) => (ref.startsWith("discord:") ? openCardIds(new QuestionStore(cardDir()), discordThreadId(ref)) : []),
  ...(discordToken
    ? {
        markThreadDone: async (ref: string) => {
          // a rename left pending (429) is applied later by the listener; the close still says it did not happen yet
          const outcome = await threadStatuses(ownDiscord(discordToken)).request(discordThreadId(ref), "done");
          if (outcome === "pending" || outcome === "dropped") throw new Error(`thread rename ${outcome}, see the THREAD_STATUS line`);
        },
        postInThread: async (ref: string, text: string) => postInThread(ownDiscord(discordToken), ref, text),
        requestThreadStatus: async (ref: string, status: "working" | "waiting") => String(await threadStatuses(ownDiscord(discordToken)).request(discordThreadId(ref), status)),
      }
    : {}),
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
    to: { type: "string" }, text: { type: "string" }, edit: { type: "string" }, status: { type: "string" }, "no-typing": { type: "boolean" }, ping: { type: "string" },
    option: { type: "string", multiple: true }, session: { type: "string" }, tmux: { type: "string" }, open: { type: "boolean" },
    from: { type: "string" }, first: { type: "string" }, "open-card": { type: "boolean" },
    "done-weak-ok": { type: "boolean" }, tag: { type: "string", multiple: true }, lane: { type: "string" }, metric: { type: "string" }, hypothesis: { type: "string" }, date: { type: "string" }, post: { type: "boolean" },
    pull: { type: "boolean" }, "dry-run": { type: "boolean" }, help: { type: "boolean" },
    hypotheses: { type: "string", multiple: true }, test: { type: "string", multiple: true }, "no-hypotheses": { type: "string" }, improved: { type: "boolean" }, template: { type: "boolean" },
    goal: { type: "string" }, "challenge-before": { type: "string", multiple: true }, plan: { type: "string" }, kind: { type: "string" }, result: { type: "string" },
    direction: { type: "string" }, next: { type: "string" }, gpu: { type: "string", multiple: true }, "gpu-all": { type: "boolean" }, mode: { type: "string" }, minutes: { type: "string" },
    summary: { type: "string" }, file: { type: "string", multiple: true }, all: { type: "boolean" }, check: { type: "boolean" }, send: { type: "boolean" },
    "keep-old": { type: "boolean" }, "no-monitors": { type: "boolean" }, state: { type: "string" }, "text-file": { type: "string" },
    force: { type: "boolean" }, thinking: { type: "string" }, "approved-by": { type: "string" }, window: { type: "string" }, reread: { type: "boolean" },
    answer: { type: "string" }, repo: { type: "string", multiple: true }, since: { type: "string" }, until: { type: "string" }, backtest: { type: "boolean" },
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
const tags = (): string[] => ((flags.values.tag as string[] | undefined) ?? []).map((t) => t.trim()).filter(Boolean);
const many = (name: string): string[] => ((flags.values[name] as string[] | undefined) ?? []).map((t) => t.trim()).filter(Boolean);

// `dori <command> --help`: that command's lines of USAGE
const helpFor = (cmd: string): string => {
  const lines = USAGE.split("\n");
  const at = lines.findIndex((l) => new RegExp(`^  ${cmd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`).test(l));
  if (!cmd || at < 0) return USAGE;
  const out = [lines[at] ?? ""];
  for (const l of lines.slice(at + 1)) {
    if (/^  \S/.test(l)) break;
    out.push(l);
  }
  return `dori ${out.join("\n").trim()}`;
};
if (flags.values.help) {
  console.log(helpFor(command));
  process.exit(0);
}
const loopMin = Number(opt("loop") ?? 0);

const realpathOr = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};
// the owner's after-the-fact line of a rollover the lead decided: in the given Discord thread, else DORI_DISCORD_CHANNEL
const reportOwner = discordToken && process.env.DORI_DISCORD_CHANNEL?.trim()
  ? { reportOwner: async (thread: string | null, text: string): Promise<string> => discordClient().send(thread ?? env("DORI_DISCORD_CHANNEL"), text) }
  : {};
const sessionOfPane = async (pane: string, cwd: string): Promise<string> => (await resolveSession(pane, cwd, await procTable(run), { run, sessionsDir: config.sessionsDir, backend: config.backend })).id;
const laneDepsFor = (print: (line: string) => void = (line) => console.log(line)): LaneHandoverDeps => ({
  ...deps,
  cardDir: cardDir(),
  home: process.env.HOME ?? "",
  sessionOf: sessionOfPane,
  procs: () => procTable(run),
  envOf: (pid) => {
    try {
      return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").join("\n");
    } catch {
      return "";
    }
  },
  alive: pidAlive,
  signal: (pid, sig) => {
    try {
      process.kill(pid, sig);
      return true;
    } catch {
      return false;
    }
  },
  realpath: realpathOr,
  nonce: () => crypto.randomUUID().slice(0, 8),
  print,
  ...reportOwner,
});
const leadDepsFor = (print: (line: string) => void): HandoverDeps => ({
  ...deps,
  configPath: configPath(),
  envPath: envFilePath(),
  cardDir: cardDir(),
  inbox: config.handover.inbox || process.env.DORI_DISCORD_INBOX?.trim() || join(config.stateDir, "discord", "inbox.jsonl"),
  home: process.env.HOME ?? "",
  sessionOf: sessionOfPane,
  routedPane: async () => (await loadConfig()).leadPane,
  envLeadPane: process.env.DORI_LEAD_PANE?.trim() ?? "",
  alive: pidAlive,
  realpath: realpathOr,
  timers: async () => {
    const pattern = new RegExp(config.handover.timers);
    return (await run(["systemctl", "--user", "list-timers", "--all", "--no-legend", "--no-pager"])).out.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter((l) => l && pattern.test(l));
  },
  restart: (unit) => restartService({ systemctl: run, clock: realClock, timeoutSec: config.update.readyTimeoutSec }, config.update.services.find((s) => s.unit === unit) ?? { unit, paths: [], log: "", ready: "" }),
  nonce: () => crypto.randomUUID().slice(0, 8),
  print,
  ...reportOwner,
});
// dori commands that talk to the owner refuse from a session that a running handover is replacing (no double replies)
const quietGuard = async (): Promise<void> => {
  const here = config.backend === "aoe" ? await currentTmuxSession(run) : (process.env.HERDR_PANE_ID ?? "");
  const why = quietReason(config.stateDir, here, Date.now());
  if (why) die(why, 4);
};
const passEnv = (): string[] => ["PATH", "HOME", "DORI_CONFIG", "DORI_STATE_DIR", "DORI_ENV_FILE", "DORI_DISCORD_INBOX", "DORI_DISCORD_STATE_DIR"].filter((n) => process.env[n] !== undefined).map((n) => `--setenv=${n}`);

const lane = async (k: string | undefined) => {
  const here = config.backend === "aoe" ? await currentTmuxSession(run) : (process.env.HERDR_PANE_ID ?? "");
  const found = k ? await deps.registry.read(k) : await deps.registry.byPane(here);
  if (!found) return die(k ? `no registered lane "${k}"` : "no open lane is registered for this pane");
  if (statusOf(found) === "closed") return die(`lane ${found.key} is already closed`);
  return found;
};

const env = (name: string): string => process.env[name]?.trim() || die(`${name} is not set`);
// Discord writes go out only as this Dori's own bot: the token's bot must be discord.botId when that is set, and is never
// the pair Dori's bot (DORI_DISCORD_PAIR_BOT). An inherited token of another Dori fails here instead of posting as it.
const discordBotProblem = (token: string): string | undefined => {
  const bot = tokenBotId(token);
  const pairBot = process.env.DORI_DISCORD_PAIR_BOT?.trim() ?? "";
  const where = `config ${configPath()}, env file ${envFilePath()}`;
  if (config.discord.botId && bot !== config.discord.botId)
    return `DISCORD_BOT_MISMATCH DORI_DISCORD_TOKEN is bot ${bot ?? "unknown"}, but this Dori is bot ${config.discord.botId} (discord.botId; ${where}). Nothing was sent. An inherited token of another Dori? Unset the DORI_DISCORD_* variables or fix the token.`;
  if (pairBot && bot === pairBot) return `DISCORD_BOT_MISMATCH DORI_DISCORD_TOKEN is the pair Dori's bot ${bot} (DORI_DISCORD_PAIR_BOT; ${where}). Nothing was sent.`;
  return undefined;
};
const checkedDiscordToken = (token: string): string => {
  const why = discordBotProblem(token);
  return why ? die(why, 2) : token;
};
const ownDiscord = (token: string): Discord => {
  const why = discordBotProblem(token);
  if (why) throw new Error(why);
  return new Discord(fetchHttp, realClock, token);
};
const discordClient = () => new Discord(fetchHttp, realClock, checkedDiscordToken(env("DORI_DISCORD_TOKEN")));
// question cards and their answers; DORI_DISCORD_STATE_DIR keeps them where an existing install already has them
const cardDir = (): string => process.env.DORI_DISCORD_STATE_DIR?.trim() || join(config.stateDir, "discord");
// every thread status change goes through this queue: coalesced, retried after a 429, decided by the open cards and
// the lanes still working in the thread
// working, or sent back to work by an objection (not-done); a lane that claimed done or is paused waits like the thread
// The lane whose close runs a thread hook (DORI_CLOSING_LANE) is still open in the registry then, but no longer works there.
const workingLanes = async (t: string): Promise<string[]> =>
  (await deps.registry.open()).filter((l) => l.key !== process.env.DORI_CLOSING_LANE && l.thread === `discord:${t}` && (statusOf(l) === "working" || statusOf(l) === "not-done")).map((l) => l.key);
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

// one SIGNALS line per open lane that has a record, for the lead's status view (dori sync, dori signals)
const openSignals = async (): Promise<string[]> => {
  const open = await deps.registry.open();
  return (await areaSignals(open, { tags: [...new Set(open.flatMap((l) => tagsOf(l)))] }, config)).filter(hasSignals).map(oneLine);
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
    case "notify-change": {
      const files = flags.values.file;
      process.exitCode = await announceChange({ config, clock: realClock, send: (pane, text) => sendVerified(run, realClock, config, pane, text), print: (line) => console.log(line) }, { summary: need("summary"), files: Array.isArray(files) ? files.filter((file): file is string => typeof file === "string") : [] }) ? 0 : 1;
      break;
    }
    case "type": {
      const pane = key ?? die("type needs a pane (tmux session with backend aoe, herdr pane id otherwise)");
      const file = opt("text-file");
      const text = file ? (await Bun.file(file).text()).trim() : need("text");
      if (!text) die("type needs non-empty text");
      const r = await submitToPane(run, realClock, config, pane, text);
      console.log(r.status === "SUBMITTED" ? `SUBMITTED ${pane}` : `NOT_SUBMITTED ${pane} ${r.reason}`);
      process.exitCode = r.status === "SUBMITTED" ? 0 : 1;
      break;
    }
    case "update":
      process.exitCode = await applyUpdate({ config, configPath: configPath(), git: run, systemctl: run, clock: realClock, send: (pane, text) => sendVerified(run, realClock, config, pane, text), print: (line) => console.log(line) }, { pull: Boolean(flags.values.pull), dryRun: Boolean(flags.values["dry-run"]) }) ? 0 : 1;
      break;
    case "launch": {
      const input = { key: key ?? "", title: need("title"), brief: need("brief"), done: need("done"), thread: threadOpt(), model: opt("model"), cwd: opt("cwd"), tags: tags(), doneWeakOk: Boolean(flags.values["done-weak-ok"]), goal: opt("goal"), challengeBefore: many("challenge-before") };
      const noGoal = goalWarning(input);
      if (noGoal) console.log(noGoal);
      if (flags.values["dry-run"]) {
        await validateLaunch(deps, input);
        const weak = await doneWeakWarning(input, input.cwd ?? config.defaultCwd);
        if (weak) console.log(weak);
        console.log((await renderBrief(deps, input)).text);
        console.log(`DRY_RUN ${input.key}: brief not written, no pane opened, nothing registered`);
        break;
      }
      const leadBrief = await Bun.file(input.brief).text().catch(() => "");
      const r = await launchLane(deps, input, (line) => console.log(line));
      console.log(`LAUNCHED ${r.lane.key} pane=${r.lane.pane} tab=${r.lane.tab ?? "?"}`);
      if (r.lane.thread.startsWith("discord:")) {
        if (!discordToken) console.log(`THREAD_START_NO_TOKEN ${r.lane.thread}: DORI_DISCORD_TOKEN is not set, so no first message was posted`);
        else {
          const started = await Promise.resolve().then(() => postLaneStart(ownDiscord(discordToken), r.lane.thread, laneStartText(config.discord.laneStartText, r.lane, leadBrief))).catch((e: unknown) => `THREAD_START_FAILED ${r.lane.thread}: ${e instanceof Error ? e.message : String(e)}`);
          console.log(started);
        }
      }
      console.log(r.startup);
      process.exit(r.startup.startsWith("STARTUP_OK") ? 0 : 3);
    }
    case "adopt": {
      const l = await adoptLane(deps, { key: key ?? "", title: need("title"), brief: need("brief"), done: need("done"), thread: threadOpt(), pane: need("pane"), tags: tags(), goal: opt("goal"), challengeBefore: many("challenge-before") });
      console.log(`ADOPTED ${l.key} pane=${l.pane} thread=${l.thread}`);
      break;
    }
    case "sync": {
      const r = await syncRegistry(deps, Boolean(flags.values.write));
      console.log("key | thread | pane | session | status");
      for (const row of [...r.rows, ...r.unregistered]) console.log([row.key, row.thread, row.pane, row.session, row.status].join(" | "));
      for (const s of await openSignals()) console.log(s);
      console.log(r.drift.length ? `DRIFT (${r.drift.length}):\n${r.drift.map((d) => `- ${d}`).join("\n")}` : "DRIFT none");
      console.log(flags.values.write ? "WROTE session ids" : "READ_ONLY");
      break;
    }
    case "set-thread": {
      const ref = flags.positionals[1]?.trim() ?? die("usage: dori set-thread <key> <adapter>:<id>");
      console.log(await setThread(deps, await lane(key ?? die("set-thread needs a lane key")), ref));
      break;
    }
    case "claim-done": {
      const l = await lane(key);
      const missing = challengeMissing(l);
      if (missing) die(missing, 5);
      console.log(await claimDone(deps, l, need("evidence")));
      break;
    }
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
      const metric = normFix(need("metric"));
      // the name the stuck count uses (autoSignals.aliases), so PRIOR_FIX and the gate lines name what STUCK counts
      const shown = canonical(metric, config.autoSignals.aliases);
      const area: AreaQuery = { lane: l.key, ...(l.cwd && l.cwd !== config.defaultCwd ? { cwd: l.cwd } : {}), tags: tagsOf(l) };
      for (const line of priorFixLines(await areaSignals(await deps.registry.list(), area, config), l.key, metric, config.autoSignals.aliases)) console.log(line);
      const attempt = { at: new Date().toISOString(), metric, hypothesis: normFix(need("hypothesis")), via: "lead" as const, ...(flags.values.improved ? { improved: true } : {}) };
      const branch = { hypotheses: many("hypotheses"), tests: many("test"), override: opt("no-hypotheses") };
      const gate = gateFix(l, attempt, branch, config);
      if (gate.verdict === "required") {
        const msg = requiredMessage(l.key, shown, gate, config.explore);
        recordRefusal(deps, msg);
        die(msg, 5);
      }
      if (gate.verdict === "override") console.log(recordOverride(deps, l.key, shown, gate, branch.override ?? ""));
      if (gate.verdict === "branch") console.log(await recordBranch(deps, l, shown, branch, gate));
      const r = await recordFix(deps, l.key, attempt);
      const v = stuckView((await deps.registry.read(l.key)) ?? l, metric, config);
      console.log(`FIX_RECORDED ${l.key} attempt=${r.count} on-metric=${gate.attempt} stuck=${v.n} (tagged ${v.tagged}, inferred ${v.inferred})`);
      for (const n of r.notes) console.log(n);
      break;
    }
    case "tree": {
      const verb = key ?? "show";
      const anyLane = async (k: string) => (await deps.registry.read(k)) ?? die(`no registered lane "${k}"`);
      const here = config.backend === "aoe" ? await currentTmuxSession(run).catch(() => "") : (process.env.HERDR_PANE_ID ?? "");
      const paneLane = here ? await deps.registry.byPane(here) : null;
      const laneKey = opt("lane");
      const area: TreeArea = laneKey ? laneArea(await anyLane(laneKey), config) : opt("cwd") ? { cwd: resolve(opt("cwd") ?? "") } : tags()[0] ? { tag: tags()[0] } : paneLane ? laneArea(paneLane, config) : { cwd: resolve(process.cwd()) };
      const at = new Date().toISOString();
      const id = flags.positionals[1] ?? "";
      if (verb === "show") console.log(formatTree(await loadTree(config.stateDir, area)));
      else if (verb === "add") {
        const kind = (opt("kind") ?? "hypothesis") as NodeKind;
        if (!NODE_KINDS.includes(kind)) die(`--kind is one of ${NODE_KINDS.join(", ")}`);
        let added: { id: string; isNew: boolean } = { id: "", isNew: false };
        await updateTree(config.stateDir, area, (t) => {
          const r = addNode(t, { kind, text: need("text"), test: opt("test"), metric: opt("metric") ? normFix(opt("metric") ?? "") : undefined, lane: laneKey ?? paneLane?.key, source: "dori tree add", result: opt("result") }, at);
          added = { id: r.node.id, isNew: r.added };
          return r.tree;
        });
        console.log(`TREE_${added.isNew ? "ADDED" : "EXISTS"} ${added.id} in ${area.cwd ? `cwd ${area.cwd}` : `tag ${area.tag}`}`);
      } else if (verb === "falsify" || verb === "support" || verb === "close" || verb === "reopen") {
        if (!id) die(`usage: dori tree ${verb} <ID> [--result TEXT]`);
        const status = verb === "falsify" ? "falsified" : verb === "support" ? "supported" : verb === "close" ? "closed" : "open";
        let shown = "";
        await updateTree(config.stateDir, area, (t) => {
          const r = setStatus(t, id, status, opt("result"), at);
          shown = `${r.node.id} ${r.node.status}${r.node.result ? ` -> ${r.node.result}` : ""}`;
          return r.tree;
        });
        console.log(`TREE_SET ${shown}`);
      } else die("usage: dori tree [show|add|falsify|support|close|reopen] [ID] [--lane K | --cwd DIR | --tag T]");
      break;
    }
    case "challenge": {
      if (flags.values.check) {
        const own = key ? ((await lane(key)).model ?? config.defaultModel) : undefined;
        const listed = own ? reviewers(own, config.reviewers.models) : [...config.reviewers.models];
        const checks = await checkReviewers(deps, listed);
        for (const c of checks) console.log(c.call ? `REVIEWER_OK ${c.listed}${c.call !== c.listed ? ` -> ${c.call}` : ""} (${familyOf(c.listed)}): ${c.note}` : `REVIEWER_SKIP ${c.listed} (${familyOf(c.listed)}): ${c.note}`);
        if (!checks.some((c) => c.call)) die("no reviewer in reviewers.models can be called on this host");
        break;
      }
      const l = await lane(key ?? die("challenge needs a lane key"));
      const r = await runChallenge(deps, l, resolve(need("plan")), { model: opt("model"), all: Boolean(flags.values.all) });
      for (const f of r.failures) console.log(`CHALLENGE_SKIP ${f}`);
      for (const v of r.reviews) {
        console.log(v.text);
        console.log(`CHALLENGE_SAVED ${v.record.file} reviewer=${v.record.model}`);
      }
      break;
    }
    case "fork-explore": {
      const l = await lane(key ?? die("fork-explore needs a lane key"));
      const mode = (opt("mode") ?? "agent") as Mode;
      if (mode !== "agent" && mode !== "cmd") die("--mode is agent or cmd");
      const minutes = Number(opt("minutes") ?? config.explore.branchMinutes);
      if (!(minutes > 0)) die("--minutes must be a positive number");
      const branches = branchesFrom(many("hypotheses"), many("test"), many("gpu").map(Number), Boolean(flags.values["gpu-all"]));
      const load = async () => (await sampleHost(run, config.backend)).load1;
      const takeSlot = async (label: string) => {
        const slot = await acquireSlot({ dir: `${config.stateDir}/heavy`, slots: config.heavySlots, maxLoad: config.heavyMaxLoad, clock: realClock, load, alive: pidAlive, pid: process.pid }, label);
        return () => releaseSlot(slot);
      };
      console.log(`FORK_START ${l.key} ${branches.length} branches on "${need("metric")}" (${branches.filter((b) => b.gpu).length} gpu, queued on the heavy slot), ${minutes} min each, mode ${mode}`);
      const r = await forkExplore(deps, l, { metric: normFix(need("metric")), branches, mode, minutes, model: opt("model") }, takeSlot);
      console.log(r.table);
      console.log(`FORK_SAVED ${r.file}; tree updated (dori tree --lane ${l.key})`);
      break;
    }
    case "research-hint": {
      const l = (await deps.registry.read(key ?? die("research-hint needs a lane key"))) ?? die(`no registered lane "${key}"`);
      const tree = await loadTree(config.stateDir, laneArea(l, config));
      for (const line of researchHint(l, tree)) console.log(line);
      if (flags.values.send) {
        if (!l.pane) die(`lane ${l.key} has no pane to send the ulw research text to`);
        const { metric } = researchFacts(l, tree);
        const delivered = await sendResearch(deps, l, tree, stuckView(l, metric, config).n, metric);
        const line = delivered ? `RESEARCH_SENT ${l.key}: ulw research text typed into pane ${l.pane}; dori research-check ${l.key} (or freshness) confirms the skill started` : `RESEARCH_SEND_FAILED ${l.key}: the text did not reach pane ${l.pane}`;
        watchLog(config.watchLog, realClock, { source: "research", line });
        console.log(line);
        if (!delivered) process.exit(1);
      }
      break;
    }
    case "research-check": {
      const l = (await deps.registry.read(key ?? die("research-check needs a lane key"))) ?? die(`no registered lane "${key}"`);
      const r = await researchCheck(deps, l);
      console.log(r.line);
      if (r.verdict === "not-started") process.exit(6);
      break;
    }
    case "intent-check": {
      let l = await lane(key ?? die("intent-check needs a lane key"));
      const at = new Date().toISOString();
      const patch = {
        ...(opt("goal") ? { goal: opt("goal") } : {}),
        ...(opt("direction") || opt("next") ? { direction: { at, text: opt("direction") ?? l.direction?.text ?? "", ...(opt("next") ? { next: opt("next") } : {}) } } : {}),
      };
      if (Object.keys(patch).length) {
        await deps.registry.patch(l.key, patch);
        l = { ...l, ...patch };
      }
      for (const line of formatIntent(l, intentView(l, await loadTree(config.stateDir, laneArea(l, config))))) console.log(line);
      // the verdict is the owner check's, run now on the direction just stated
      const r = await runOwnerCheck(deps, l, { force: true, direction: true });
      if (r.skipped) {
        console.log(r.skipped);
        if (r.skipped.startsWith("OWNER_CHECK_FAILED")) process.exit(1);
        break;
      }
      for (const line of r.lines) console.log(line);
      break;
    }
    case "repeat-check": {
      const l = (await deps.registry.read(key ?? die("repeat-check needs a lane key"))) ?? die(`no registered lane "${key}"`);
      const ago = /^(\d+(?:\.\d+)?)([dh])$/.exec(opt("since") ?? "");
      const since = ago ? new Date(Date.now() - Number(ago[1]) * (ago[2] === "d" ? 86_400_000 : 3_600_000)).toISOString() : (opt("since") ?? sessionStart(l));
      if (Number.isNaN(Date.parse(since))) die(`--since takes an ISO time or Nd / Nh, not ${opt("since")}`);
      const scan = await laneEvents(deps, l, { since, ...(opt("until") ? { until: opt("until") } : {}), repos: many("repo") });
      const cfg = config.autoSignals;
      const after = config.stuck.researchAt;
      console.log(`REPEAT_SCAN ${l.key} since ${since}${opt("until") ? ` until ${opt("until")}` : ""}: ${scan.reports} reports, ${scan.commits} commits, ${scan.tree} tree entries; scope ${cfg.targetScope}, aliases ${Object.keys(cfg.aliases).length}, after ${after} (stuck.researchAt)`);
      const tagged = (metric: string): number => stuckView(l, metric, config).tagged;
      if (flags.values.backtest) {
        // each time a metric's inferred count reached stuck.researchAt or grew past it, report by report
        const fired: { at: string; r: MetricRepeat }[] = [];
        inferRepeats(scan.events, cfg, (r, e) => r.n >= after && fired.push({ at: e.at, r }));
        for (const f of fired) {
          console.log(`${f.at} ${inferredLine(l.key, f.r, tagged(f.r.metric))}`);
          for (const line of evidenceLines(f.r).slice(-4)) console.log(line);
        }
        console.log(`REPEAT_BACKTEST ${l.key} ${fired.length} alerts on ${new Set(fired.map((f) => f.r.metric)).size} metrics`);
        break;
      }
      const state = inferRepeats(scan.events, cfg);
      const hits = suspects(state, after);
      for (const r of hits) {
        console.log(inferredLine(l.key, r, tagged(r.metric)));
        for (const line of evidenceLines(r)) console.log(line);
      }
      if (!hits.length) console.log(`REPEAT_NONE ${l.key} no metric re-targeted ${after}+ times after failing (counts: ${[...state.counts.values()].map((r) => `${r.metric} ${r.n}`).join(", ") || "none"})`);
      break;
    }
    case "owner-check": {
      const l = await lane(key ?? die("owner-check needs a lane key"));
      if (flags.values.reread) {
        const sent = await sendReread(deps, l);
        console.log(sent.line);
        if (!sent.ok) process.exit(1);
        break;
      }
      const r = await runOwnerCheck(deps, l, { force: Boolean(flags.values.force) });
      if (r.skipped) {
        console.log(r.skipped);
        if (r.skipped.startsWith("OWNER_CHECK_FAILED")) process.exit(1);
        break;
      }
      for (const line of r.lines) console.log(line);
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
        sessionsDir: config.scorecard.sessions,
        lanes: await deps.registry.list(),
        settings: config.scorecard,
        inbox: config.scorecard.inbox || process.env.DORI_DISCORD_INBOX?.trim() || join(config.stateDir, "discord", "inbox.jsonl"),
        owner: process.env.DORI_DISCORD_OWNER?.trim() ?? "",
      }, window);
      const text = formatScorecard(data, config.scorecard.language, Date.now());
      console.log(text);
      console.log(`SAVED ${await saveScorecard(join(config.stateDir, "scorecard"), data, text, config.scorecard.keepDays)}`);
      if (flags.values.post) {
        const ref = opt("to") || config.scorecard.postTo || `discord:${env("DORI_DISCORD_CHANNEL")}`;
        const id = /^discord:(\d{5,25})$/.exec(ref)?.[1] ?? die(`scorecard posts to discord:<channel or thread id>, not ${ref}`);
        console.log(`SENT ${await discordClient().send(id, text)}`);
      }
      break;
    }
    case "signals": {
      const q: AreaQuery = { ...(opt("lane") ? { lane: opt("lane") } : {}), ...(opt("cwd") ? { cwd: resolve(opt("cwd") ?? "") } : {}), ...(tags().length ? { tags: tags() } : {}) };
      if (!q.lane && !q.cwd && !q.tags) {
        const lines = await openSignals();
        console.log(lines.length ? lines.join("\n") : "SIGNALS none for open lanes");
        break;
      }
      const list = await areaSignals(await deps.registry.list(), q, config);
      console.log(list.length ? formatSignals(areaLabel(q), list) : `SIGNALS no lane in ${areaLabel(q)}`);
      break;
    }
    case "freshness":
      await every(loopMin, async () => {
        const laneDeps = laneDepsFor(() => {});
        const hooks = {
          signals: (pane: string, model: string) => paneSignals(laneDeps, pane, model),
          // automatic rollover (handover.autoRolloverLanes / autoRolloverLead): a detached run, approved as auto:<key>
          auto: async (who: "lead" | "lane", k: string) => {
            const unit = `dori-rollover-${k}-${Date.now()}`;
            const log = join(config.stateDir, "handover", "run.log");
            mkdirSync(join(config.stateDir, "handover"), { recursive: true });
            const r = await run(["systemd-run", "--user", "--collect", `--unit=${unit}`, "--setenv=DORI_HANDOVER_DETACHED=1", ...passEnv(), `--property=StandardOutput=append:${log}`, `--property=StandardError=append:${log}`, process.execPath, import.meta.path, "handover", ...(who === "lane" ? ["--lane", k] : []), "--approved-by", `auto:handover.autoRollover${who === "lane" ? "Lanes" : "Lead"}`]);
            return r.code === 0 ? `started unit=${unit} log=${log}` : `could not start: ${(r.err || r.out).trim().slice(0, 160)}`;
          },
        };
        for (const a of await freshnessTick(deps, process.env.HOME ?? "", hooks)) console.log(`${a.kind.toUpperCase()} ${a.lane} ${a.detail}`);
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
      await quietGuard();
      const platform = key ?? die("send needs slack, telegram or discord");
      const to = need("to");
      const status = opt("status");
      if (status !== undefined && (platform !== "discord" || (status !== "working" && status !== "done"))) die("--status takes working or done, with discord");
      const text = status === "working" || status === "done" ? progressText(status, need("text"), config.discord) : need("text");
      const thread = opt("thread");
      const edit = opt("edit");
      const rawPing = flags.values.ping;
      if (rawPing !== undefined && (typeof rawPing !== "string" || rawPing.length === 0 || /[^0-9]/.test(rawPing))) die("--ping takes a digits-only user id");
      const ping = typeof rawPing === "string" ? rawPing : undefined;
      if (ping !== undefined && (platform !== "discord" || edit)) die("--ping is only supported for new Discord messages");
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
        const dc = new Discord(fetchHttp, realClock, checkedDiscordToken(token("DORI_DISCORD_TOKEN")));
        if (edit) await dc.edit(to, edit, text);
        else console.log(`SENT ${await dc.send(thread ?? to, text, !flags.values["no-typing"], ping)}`);
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
        const token = checkedDiscordToken(process.env.DORI_DISCORD_TOKEN ?? die("DORI_DISCORD_TOKEN is not set"));
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
        const statuses = threadStatuses(dc, (line) => console.log(line));
        // the listener owns the delayed renames: a burst becomes one rename, and a 429 waits out retry_after
        if (!shadowInbox) statuses.watch({ setTimeout: (cb, ms) => setTimeout(cb, ms), setInterval: (cb, ms) => setInterval(cb, ms) });
        const listener = new DiscordListener({
          dc,
          cards: questionCards(dc, statuses),
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
      await quietGuard();
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
      const resolved = (await questionCards(discordClient()).resolve(id, opt("answer"))) ?? die(`no question ${id}`);
      console.log(`RESOLVED ${id} ${resolved}`);
      break;
    }
    case "lead":
      console.log(await findLead(run, config));
      break;
    case "thread": {
      await quietGuard();
      const [verb, ref, text] = flags.positionals;
      if (verb === "list") {
        for (const [id, entry] of Object.entries(threads(cardDir()))) console.log(`${id} ${entry.session ?? "none"} ${entry.title}`);
        break;
      }
      if (verb === "map") {
        if (!ref || !text?.trim()) die("usage: dori thread map discord:<id> <session|none>");
        mapThread(cardDir(), discordThreadId(ref ?? ""), text === "none" ? null : text ?? null);
        console.log(`THREAD_MAPPED ${ref} ${text}`);
        break;
      }
      if (verb === "open") {
        const title = bareThreadName(ref ?? "", config.discord).trim();
        const from = opt("from")?.trim();
        const first = opt("first")?.trim();
        if (!title || (!from && !first)) die("usage: dori thread open <title> [--from MSG_ID] [--first TEXT] [--session S]; standalone threads need --first");
        const dc = discordClient();
        const id = await dc.startThread(env("DORI_DISCORD_CHANNEL"), from, threadName("working", title, config.discord));
        if (!from && first) await dc.send(id, first);
        mapThread(cardDir(), id, opt("session") ?? null, title);
        console.log(`THREAD_OPENED discord:${id}`);
        break;
      }
      // Marking a thread done by hand (thread done, thread set done) makes the same check as closing a lane (#47): while
      // another open lane or an open question card uses the thread, it is left as it is. The lane whose close runs this
      // (hooks.threadDone, which sets DORI_CLOSING_LANE, or --lane) is not another user. --force marks it done anyway.
      const holdersOf = async (thread: string): Promise<string> => {
        const closing = opt("lane") ?? process.env.DORI_CLOSING_LANE ?? "";
        const sharing = (await deps.registry.open()).filter((l) => l.key !== closing && l.thread === thread).map((l) => l.key);
        const cards = deps.openCards?.(thread) ?? [];
        return [...(sharing.length ? [`open lane ${sharing.join(", ")} uses it`] : []), ...(cards.length ? [`open card ${cards.join(", ")}`] : [])].join("; ");
      };
      if (verb === "set") {
        if (!ref || (text !== "working" && text !== "waiting" && text !== "done")) die("usage: dori thread set discord:<id> working|waiting|done [--open-card] [--force]");
        const status = text === "done" ? "done" : flags.values["open-card"] ? "waiting" : text === "waiting" ? "waiting" : "working";
        const id = discordThreadId(ref ?? "");
        const holders = status === "done" ? await holdersOf(`discord:${id}`) : "";
        if (holders && !flags.values.force) {
          console.log(`THREAD_LEFT_OPEN discord:${id}: ${holders}; not marked done (--force marks it done anyway)`);
          break;
        }
        if (holders) console.log(`THREAD_DONE_FORCED discord:${id}: ${holders}; marking it done anyway`);
        await threadStatuses(discordClient()).request(id, status);
        break;
      }
      if ((verb !== "reply" && verb !== "wait" && verb !== "done") || !ref || !text?.trim()) die("usage: dori thread <reply|wait|done> discord:<thread id> <text>");
      const dc = discordClient();
      if (verb === "done") {
        // the text is posted either way; with users left the thread keeps its mark and stays open
        const thread = `discord:${discordThreadId(ref ?? "")}`;
        const holders = await holdersOf(thread);
        if (holders && !flags.values.force) {
          console.log(`POSTED ${await postInThread(dc, ref ?? "", text ?? "")} THREAD_LEFT_OPEN ${thread}: ${holders}; not marked done (--force marks it done anyway)`);
          break;
        }
        if (holders) console.log(`THREAD_DONE_FORCED ${thread}: ${holders}; marking it done anyway`);
      }
      const statuses = threadStatuses(dc);
      const posted = await threadHook(dc, verb as ThreadVerb, ref ?? "", text ?? "", config.discord, (t, s) => statuses.request(t, s));
      console.log(`POSTED ${posted}${verb === "done" ? " THREAD_DONE" : verb === "wait" ? " THREAD_WAITING" : ""}`);
      break;
    }
    case "handover": {
      const here = config.backend === "aoe" ? await currentTmuxSession(run) : (process.env.HERDR_PANE_ID ?? "");
      if (key === "ack") {
        console.log(ackHandover(opt("state") ? resolve(opt("state") ?? "") : config.stateDir, flags.positionals[1]?.trim() || die("usage: dori handover ack <id> [--state DIR]"), here, new Date().toISOString()));
        break;
      }
      if (key === "ready" || opt("lane")) {
        const laneDeps = laneDepsFor();
        if (key === "ready") {
          if (flags.values.template) {
            console.log(SUMMARY_TEMPLATE);
            break;
          }
          const r = await markReady(laneDeps, await lane(flags.positionals[1]), here, process.pid, opt("note"));
          console.log(r.line);
          process.exit(r.code);
        }
        const minutes = opt("minutes") ? Number(opt("minutes")) : undefined;
        if (minutes !== undefined && !(minutes > 0)) die("--minutes must be a positive number");
        const r = await laneHandover(laneDeps, opt("lane") ?? "", here, { approvedBy: opt("approved-by"), note: opt("note"), model: opt("model"), thinking: opt("thinking"), force: Boolean(flags.values.force), keepOld: Boolean(flags.values["keep-old"]), dryRun: Boolean(flags.values["dry-run"]), verifyMin: minutes });
        process.exit(r.code);
      }
      // closing the old lead ends every process in its tmux session, so a handover started there continues as a user unit
      if (here && here === config.leadPane && !flags.values["dry-run"] && !flags.values["keep-old"] && !process.env.DORI_HANDOVER_DETACHED) {
        const unit = `dori-handover-${Date.now()}`;
        const log = join(config.stateDir, "handover", "run.log");
        mkdirSync(join(config.stateDir, "handover"), { recursive: true });
        const pass = ["PATH", "DORI_CONFIG", "DORI_STATE_DIR", "DORI_ENV_FILE", "DORI_LEAD_PANE", "DORI_DISCORD_INBOX", "DORI_DISCORD_STATE_DIR"].filter((n) => process.env[n] !== undefined).map((n) => `--setenv=${n}`);
        const r = await run(["systemd-run", "--user", "--collect", `--unit=${unit}`, "--setenv=DORI_HANDOVER_DETACHED=1", ...pass, `--property=StandardOutput=append:${log}`, `--property=StandardError=append:${log}`, process.execPath, import.meta.path, "handover", ...rest]);
        if (r.code !== 0) die(`HANDOVER_DETACH_FAIL ${r.err || r.out}`);
        console.log(`HANDOVER_DETACHED unit=${unit} log=${log}; progress also goes to ${config.watchLog}`);
        break;
      }
      const minutes = opt("minutes") ? Number(opt("minutes")) : undefined;
      if (minutes !== undefined && !(minutes > 0)) die("--minutes must be a positive number");
      const r = await handover(leadDepsFor((line) => console.log(line)), { approvedBy: opt("approved-by"), note: opt("note"), title: opt("title"), model: opt("model"), keepOld: Boolean(flags.values["keep-old"]), dryRun: Boolean(flags.values["dry-run"]), noMonitors: Boolean(flags.values["no-monitors"]), verifyMin: minutes });
      process.exit(r.code);
    }
    case "rollover-propose": {
      const who = key === "lead" ? "lead" : "lane";
      const l = who === "lane" ? await lane(key) : undefined;
      const pane = l ? (l.pane ?? die(`lane ${l.key} has no pane`)) : config.leadPane || die("leadPane is not set");
      const model = l ? (l.model ?? config.defaultModel) : config.handover.model || config.defaultModel;
      const stuck = l ? stuckTop(l) : undefined;
      const signals = { ...(await paneSignals(laneDepsFor(() => {}), pane, model)), ...(stuck ? { stuck } : {}) };
      const h = config.handover;
      const hit = dueReasons(signals, who === "lane" ? { contextPct: h.laneContextPct, compactions: h.laneCompactions, ageH: h.laneAgeH } : { contextPct: h.leadContextPct, compactions: h.leadCompactions, ageH: h.leadAgeH });
      const lines: string[] = [];
      const preview = l ? await laneHandover(laneDepsFor((line) => lines.push(line)), l.key, "", { dryRun: true }) : await handover(leadDepsFor((line) => lines.push(line)), { dryRun: true });
      const blockers = lines.filter((x) => x.startsWith("HANDOVER_REFUSED")).map((x) => x.replace(/^HANDOVER_REFUSED\s*/, "")).join("; ");
      const shown = [signals.contextPct !== undefined ? `context ${signals.contextPct}%` : "", signals.compactions !== undefined ? `${signals.compactions} compactions` : "", signals.ageH !== undefined ? `${signals.ageH} h old` : "", stuck ? `stuck rung ${stuck.rung} on "${stuck.metric}" (${stuck.n} attempts)` : ""].filter(Boolean).join(", ");
      const text = h.proposalText.replaceAll("{who}", l ? `lane ${l.key} (${l.title})` : "the lead").replaceAll("{signals}", hit.length ? `${shown} (${hit.join(", ")})` : `${shown || "no signals"} (no threshold crossed)`).replaceAll("{note}", preview.note ?? "(no note)").replaceAll("{blockers}", blockers ? `. Blocked now: ${blockers}` : "");
      const run = `dori handover ${l ? `--lane ${l.key} ` : ""}--approved-by "${LEAD_PREFIX}<your reason>, ${(hit[0] ?? "<the signal>").replaceAll('"', "'")}"`;
      if (flags.values["dry-run"]) {
        console.log(`ROLLOVER_PROPOSAL_DRY_RUN ${who} ${l?.key ?? "lead"}: ${text}; to go ahead: ${run}`);
        break;
      }
      appendRollover(config.stateDir, { kind: "proposal", who, at: new Date().toISOString(), key: l?.key ?? "lead", pane, signals, crossed: hit, ...(preview.note ? { note: preview.note } : {}), blockers });
      console.log(`ROLLOVER_PROPOSAL ${who} ${l?.key ?? "lead"}: ${text}; logged. Your decision: to go ahead, ${run} (the owner is told afterwards)`);
      break;
    }
    case "rollover-stats": {
      const window = opt("window") ? Number(opt("window")) : 24;
      if (!(window > 0)) die("--window must be a positive number of hours");
      const watch = existsSync(config.watchLog) ? readFileSync(config.watchLog, "utf8").split("\n") : [];
      for (const line of rolloverStats(readRollovers(config.stateDir), watch, Date.now(), window)) console.log(line);
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
  if (e instanceof LeadError || e instanceof LaunchError || e instanceof UnsafeMessageError || e instanceof MessengerError || e instanceof TranscriptionError || e instanceof QuestionError || e instanceof ThreadRefError || e instanceof LaneStateError || e instanceof ScorecardError || e instanceof TreeError || e instanceof ChallengeError || e instanceof ForkError) die(e.message);
  throw e;
}
