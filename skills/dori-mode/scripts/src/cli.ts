#!/usr/bin/env bun
// allow: SIZE_OK — existing command dispatcher; command behavior lives in separate modules.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { currentTmuxSession } from "./aoe.ts";
import { ackHandover, handover } from "./handover.ts";
import { procTable, resolveSession } from "./session-id.ts";
import { restartService } from "./update-ready.ts";
import { ConfigError, configPath, envFilePath, loadConfig, loadEnvFile } from "./config.ts";
import { sendVerified } from "./panes.ts";
import { applyUpdate } from "./update.ts";
import { announceChange } from "./update-announce.ts";
import { deadPaneTick } from "./dead-panes.ts";
import { claimDone, closeLane, type FlowDeps, LaneStateError, objectDone, pauseLane, resumeLane, watchTick } from "./done-flow.ts";
import { freshnessTick } from "./freshness.ts";
import { acquireSlot, pidAlive, releaseSlot } from "./heavy-slot.ts";
import { guardTick, sampleHost } from "./host-guard.ts";
import { areaLabel, type AreaQuery, areaSignals, formatSignals, hasSignals, oneLine, priorFixLines, tagsOf } from "./lane-signals.ts";
import { adoptLane, doneWeakWarning, goalWarning, laneStartText, launchLane, LaunchError, renderBrief, setThread, validateLaunch } from "./launch.ts";
import { addNode, formatIntent, formatTree, gateFix, intentView, laneArea, loadTree, metricAttempts, NODE_KINDS, type NodeKind, recordBranch, recordOverride, recordRefusal, requiredMessage, researchCheck, researchFacts, researchHint, sendResearch, setStatus, stuckSignal, type TreeArea, TreeError, updateTree } from "./explore.ts";
import { challengeMissing, ChallengeError, checkReviewers, familyOf, reviewers, runChallenge } from "./challenge.ts";
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
import { Discord, discordPresence } from "./messenger/discord.ts";
import { openCardIds, QuestionCards, QuestionError, QuestionStore } from "./messenger/discord-cards.ts";
import { DiscordListener } from "./messenger/discord-listener.ts";
import { discordThreadId, postLaneStart, progressText, threadHook, ThreadRefError, type ThreadVerb } from "./messenger/discord-thread.ts";
import { ThreadStatusQueue } from "./messenger/thread-status-queue.ts";
import { realTimers } from "./messenger/typing.ts";
import { transcribe, TranscriptionError } from "./messenger/voice.ts";

const USAGE = `dori <command> [options]

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
                                       PRIOR_FIX lines (hypotheses already tried on M in this area), from the 3rd attempt
                                       SAME_FIX_3 (lanes tag reports "(fix: M / H)" for the same count). From the 2nd
                                       attempt on M with no improvement it refuses (HYPOTHESES_REQUIRED, exit 5) unless
                                       3+ competing --hypotheses each have a cheap --test (STUCK_BRANCH, into the tree);
                                       --improved: the last fix moved M, the count starts again; --no-hypotheses REASON
                                       goes on anyway (HYPOTHESES_OVERRIDE, logged). At the 2nd stuck signal RESEARCH_DUE
                                       sends the lane an external-search step
  tree [show|add|falsify|support|close|reopen] [ID] [--lane K | --cwd DIR | --tag T] [--kind K] [--text T] [--test X] [--metric M] [--result R]
                                       the area's hypothesis tree: open, supported and falsified hypotheses, untried
                                       directions (--kind direction), findings, research due, attempts tried. add takes
                                       --kind hypothesis|direction|finding|research --text; falsify/support/close take
                                       an ID and --result. No area option: this pane's lane, else the current directory
  challenge <key> --plan FILE [--model M] [--all]
                                       a model of another family than the lane's reviews the plan in a fresh context,
                                       with read-only access to the plan's repository: reasons it will fail, missing
                                       alternatives, the cheapest falsifying test. Saved under <stateDir>/challenges/<key>/
                                       and recorded on the lane (CHALLENGE_SAVED). Reviewers go in explore.challengeModels
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
                                       the owner's goal next to the lane's current direction and next step;
                                       INTENT_OK, INTENT_DRIFT or INTENT_NO_GOAL. --direction/--next record what the
                                       lane says it does now; --goal sets a missing goal
  signals [--lane K | --cwd DIR | --tag T]
                                       what earlier lanes tried and how it went: numbered fix attempts and the root-cause
                                       switch, tagged fixes by metric, rejected done claims, re-sends, nudges, outcome,
                                       warnings; no option = one SIGNALS line per open lane. Read it before re-instructing
  close  <key> [--note TEXT]           close now (Done signals must read back live); a discord:<id> work thread is set
                                       done and archived when DORI_DISCORD_TOKEN is set
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
  handover [--note FILE] [--title T] [--model M] [--keep-old] [--no-monitors] [--minutes N] [--dry-run]
                                       move the lead to a new session (backend aoe): write a note (open lanes, the old
                                       session's running monitors, open question cards, todos, timers, --note), open the
                                       new session on it, point leadPane, dori.env DORI_LEAD_*, the lanes and the cards at
                                       it, restart handover.services, then check that its monitors run and that a
                                       [REPORT] probe and an inbox probe are acked from it. Only then is the old session
                                       closed (HANDOVER_DONE); a failed check moves everything back (HANDOVER_VERIFY_FAIL,
                                       exit 3). Run from inside the lead it detaches itself (systemd-run)
  handover ack <id>                    the new lead answers a HANDOVER_PROBE line with this
  thread <reply|wait|done> discord:<id> <text>
                                       post in a work thread and set its status (working, waiting, done); done archives it
                                       (Discord env: DORI_DISCORD_TOKEN, DORI_DISCORD_GUILD, DORI_DISCORD_CHANNEL, DORI_DISCORD_OWNER)`;

const die = (message: string, code = 1): never => {
  console.error(message);
  process.exit(code);
};

await loadEnvFile(envFilePath());
const config = await loadConfig().catch((e: unknown) => (e instanceof ConfigError ? die(`CONFIG_INVALID ${e.message}`, 2) : Promise.reject(e)));
const discordToken = process.env.DORI_DISCORD_TOKEN?.trim();
const deps: FlowDeps = {
  run,
  clock: realClock,
  registry: new Registry(config.stateDir),
  config,
  ...(discordToken
    ? {
        markThreadDone: async (ref: string) => {
          // a rename left pending (429) is applied later by the listener; the close still says it did not happen yet
          const outcome = await threadStatuses(new Discord(fetchHttp, realClock, discordToken)).request(discordThreadId(ref), "done");
          if (outcome === "pending" || outcome === "dropped") throw new Error(`thread rename ${outcome}, see the THREAD_STATUS line`);
        },
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
    to: { type: "string" }, text: { type: "string" }, edit: { type: "string" }, status: { type: "string" },
    option: { type: "string", multiple: true }, session: { type: "string" }, tmux: { type: "string" }, open: { type: "boolean" },
    "done-weak-ok": { type: "boolean" }, tag: { type: "string", multiple: true }, lane: { type: "string" }, metric: { type: "string" }, hypothesis: { type: "string" }, date: { type: "string" }, post: { type: "boolean" },
    pull: { type: "boolean" }, "dry-run": { type: "boolean" }, help: { type: "boolean" },
    hypotheses: { type: "string", multiple: true }, test: { type: "string", multiple: true }, "no-hypotheses": { type: "string" }, improved: { type: "boolean" },
    goal: { type: "string" }, "challenge-before": { type: "string", multiple: true }, plan: { type: "string" }, kind: { type: "string" }, result: { type: "string" },
    direction: { type: "string" }, next: { type: "string" }, gpu: { type: "string", multiple: true }, "gpu-all": { type: "boolean" }, mode: { type: "string" }, minutes: { type: "string" },
    summary: { type: "string" }, file: { type: "string", multiple: true }, all: { type: "boolean" }, check: { type: "boolean" }, send: { type: "boolean" },
    "keep-old": { type: "boolean" }, "no-monitors": { type: "boolean" },
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
// every thread status change goes through this queue: coalesced, retried after a 429, decided by the open cards
const threadStatuses = (dc: Discord, log: (line: string) => void = (line) => console.error(line)) => {
  const store = new QuestionStore(cardDir());
  return new ThreadStatusQueue({ dc, words: config.discord, file: join(cardDir(), "thread-status.json"), openCards: (t) => openCardIds(store, t), now: realClock.now, log });
};
const questionCards = (dc: Discord, statuses?: ThreadStatusQueue) => new QuestionCards(dc, new QuestionStore(cardDir()), { channel: env("DORI_DISCORD_CHANNEL"), owner: env("DORI_DISCORD_OWNER"), words: config.discord }, realClock.now, statuses);

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
      process.exitCode = await announceChange({ config, clock: realClock, send: (pane, text) => sendVerified(run, realClock, config.backend, pane, text), print: (line) => console.log(line) }, { summary: need("summary"), files: Array.isArray(files) ? files.filter((file): file is string => typeof file === "string") : [] }) ? 0 : 1;
      break;
    }
    case "update":
      process.exitCode = await applyUpdate({ config, configPath: configPath(), git: run, systemctl: run, clock: realClock, send: (pane, text) => sendVerified(run, realClock, config.backend, pane, text), print: (line) => console.log(line) }, { pull: Boolean(flags.values.pull), dryRun: Boolean(flags.values["dry-run"]) }) ? 0 : 1;
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
          const started = await postLaneStart(new Discord(fetchHttp, realClock, discordToken), r.lane.thread, laneStartText(config.discord.laneStartText, r.lane, leadBrief)).catch((e: unknown) => `THREAD_START_FAILED ${r.lane.thread}: ${e instanceof Error ? e.message : String(e)}`);
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
      const area: AreaQuery = { lane: l.key, ...(l.cwd && l.cwd !== config.defaultCwd ? { cwd: l.cwd } : {}), tags: tagsOf(l) };
      for (const line of priorFixLines(await areaSignals(await deps.registry.list(), area, config), l.key, metric)) console.log(line);
      const attempt = { at: new Date().toISOString(), metric, hypothesis: normFix(need("hypothesis")), via: "lead" as const, ...(flags.values.improved ? { improved: true } : {}) };
      const branch = { hypotheses: many("hypotheses"), tests: many("test"), override: opt("no-hypotheses") };
      const gate = gateFix(l.fixes ?? [], attempt, branch, config.explore);
      if (gate.verdict === "required") {
        const msg = requiredMessage(l.key, metric, gate, config.explore);
        recordRefusal(deps, msg);
        die(msg, 5);
      }
      if (gate.verdict === "override") console.log(recordOverride(deps, l.key, metric, gate, branch.override ?? ""));
      if (gate.verdict === "branch") console.log(await recordBranch(deps, l, metric, branch, gate));
      const r = await recordFix(deps, l.key, attempt);
      console.log(`FIX_RECORDED ${l.key} attempt=${r.count} on-metric=${gate.attempt}`);
      if (r.alert) console.log(`SAME_FIX_3 ${l.key} ${r.alert}`);
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
        const listed = own ? reviewers(own, config.explore.challengeModels) : [...config.explore.challengeModels];
        const checks = await checkReviewers(deps, listed);
        for (const c of checks) console.log(c.call ? `REVIEWER_OK ${c.listed}${c.call !== c.listed ? ` -> ${c.call}` : ""} (${familyOf(c.listed)}): ${c.note}` : `REVIEWER_SKIP ${c.listed} (${familyOf(c.listed)}): ${c.note}`);
        if (!checks.some((c) => c.call)) die("no reviewer in explore.challengeModels can be called on this host");
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
        const signal = stuckSignal(metricAttempts(l.fixes ?? [], metric), config.explore);
        const delivered = await sendResearch(deps, l, tree, signal, metric);
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
      const v = intentView(l, await loadTree(config.stateDir, laneArea(l, config)), config.explore.driftBelow);
      const lines = formatIntent(l, v);
      for (const line of lines) console.log(line);
      watchLog(config.watchLog, realClock, { source: "intent-check", line: lines.at(-1) ?? "" });
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
      const dc = discordClient();
      const statuses = threadStatuses(dc);
      const posted = await threadHook(dc, verb as ThreadVerb, ref ?? "", text ?? "", config.discord, (t, s) => statuses.request(t, s));
      console.log(`POSTED ${posted}${verb === "done" ? " THREAD_DONE" : verb === "wait" ? " THREAD_WAITING" : ""}`);
      break;
    }
    case "handover": {
      const here = config.backend === "aoe" ? await currentTmuxSession(run) : (process.env.HERDR_PANE_ID ?? "");
      if (key === "ack") {
        console.log(ackHandover(config.stateDir, flags.positionals[1]?.trim() || die("usage: dori handover ack <id>"), here, new Date().toISOString()));
        break;
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
      const r = await handover({
        ...deps,
        configPath: configPath(),
        envPath: envFilePath(),
        cardDir: cardDir(),
        inbox: config.handover.inbox || process.env.DORI_DISCORD_INBOX?.trim() || join(config.stateDir, "discord", "inbox.jsonl"),
        home: process.env.HOME ?? "",
        sessionOf: async (pane, cwd) => (await resolveSession(pane, cwd, await procTable(run), { run, sessionsDir: config.sessionsDir, backend: config.backend })).id,
        routedPane: async () => (await loadConfig()).leadPane,
        alive: pidAlive,
        timers: async () => {
          const pattern = new RegExp(config.handover.timers);
          return (await run(["systemctl", "--user", "list-timers", "--all", "--no-legend", "--no-pager"])).out.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter((l) => l && pattern.test(l));
        },
        restart: (unit) => restartService({ systemctl: run, clock: realClock, timeoutSec: config.update.readyTimeoutSec }, config.update.services.find((s) => s.unit === unit) ?? { unit, paths: [], log: "", ready: "" }),
        nonce: () => crypto.randomUUID().slice(0, 8),
        print: (line) => console.log(line),
      }, { note: opt("note"), title: opt("title"), model: opt("model"), keepOld: Boolean(flags.values["keep-old"]), dryRun: Boolean(flags.values["dry-run"]), noMonitors: Boolean(flags.values["no-monitors"]), verifyMin: minutes });
      process.exit(r.code);
    }
    case "transcribe":
      console.log(await transcribe(run, config.hooks.transcribe, key ?? die("transcribe needs an audio file path")));
      break;
    default:
      console.log(USAGE);
      process.exit(command ? 1 : 0);
  }
} catch (e) {
  if (e instanceof LaunchError || e instanceof UnsafeMessageError || e instanceof MessengerError || e instanceof TranscriptionError || e instanceof QuestionError || e instanceof ThreadRefError || e instanceof LaneStateError || e instanceof ScorecardError || e instanceof TreeError || e instanceof ChallengeError || e instanceof ForkError) die(e.message);
  throw e;
}
