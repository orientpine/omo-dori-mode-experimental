import type { ArgvTemplate } from "./config-types.ts";

// The stuck ladder (dori fix-attempt, freshness): one count per metric, the failed attempts since the last PASS or
// --improved, the larger of the tagged count (fix tags, dori fix-attempt) and the inferred one (untagged reports, commits,
// tree). Rung 2 from hypothesesAt attempts: competing hypotheses with cheap tests before the next patch. Rung 3 from
// researchAt attempts: ulw research and a dori challenge of the next plan, in the same session, no rollover. Rung 4: a
// failure after rung 3, the same hypothesis fixatedAfter times, or an intent-check finding that comes back: the lead may
// roll the lane over. rereadText ({key}, {brief}, {finding}) goes to a lane whose report broke the owner's words, only when
// the lead confirms it with dori intent-check <key> --reread.
export type Stuck = { readonly hypothesesAt: number; readonly researchAt: number; readonly fixatedAfter: number; readonly rereadText: string };

// Reviewer models of another family for dori challenge and dori intent-check, in order (best GPT, Claude, Grok, then a
// second model of each family). Each command takes the first callable one of another family than the lane's.
// allowSameFamily: dori challenge (and challenge --check) also keeps a model of the lane's family (only the lane's own
// model is skipped), so an account can have Claude Fable review a Claude Opus lane. intent-check, the directives check,
// the close summary and the rollover audit still take another family. first: the models id those four try first
// (gpt-6.1-sol: on live Korean lane logs the cheaper gpt-6-luna misread a relayed order's scope); command: their argv
// template ({model}, {prompt}, {system}); minutes: their time limit per call.
export type Reviewers = { readonly models: readonly string[]; readonly allowSameFamily: boolean; readonly first: string; readonly command: ArgvTemplate; readonly minutes: number };

// dori review / dori merge (src/merge-gate.ts). repos: "<owner>/<repo>" -> ISO time; claim-done refuses a lane whose done
// signal names a PR of that repo merged at or after that time without dori merge (empty: no repo is checked). testCommand
// runs in <checkout>/<testDir> for a PR with no GitHub checks, at most testMinutes.
// identities: "<owner>/<repo>" (any case) -> the name and email every PR commit's author and committer must have (dori review)
export type MergeGate = { readonly repos: Readonly<Record<string, string>>; readonly identities: Readonly<Record<string, { readonly name: string; readonly email: string }>>; readonly testCommand: readonly string[]; readonly testDir: string; readonly testMinutes: number };

// dori scorecard: where the day's numbers come from and how the card reads. Empty paths leave that line as n/a.
export type Scorecard = {
  readonly timeZone: string;
  readonly language: "en" | "ko";
  // session files whose cost line ① counts; empty means sessionsDir (every session on the host)
  readonly sessions: string;
  readonly lanesLog: string;
  readonly leadSessions: string;
  readonly inbox: string;
  readonly replyPattern: string;
  readonly leadSendPattern: string;
  readonly postTo: string;
  // days of <stateDir>/scorecard/YYYY-MM-DD.json kept; older files are removed when a new one is written
  readonly keepDays: number;
};

// dori signals: the failure record of earlier lanes. launchLanes caps how many lanes the "Past signals" section of a new
// brief lists. A report or lead message matching numberedAttemptPattern (group 1 = the attempt number) is a numbered fix
// attempt; one matching rootCausePattern after the first attempt is the switch to a root-cause hunt.
export type Signals = { readonly launchLanes: number; readonly numberedAttemptPattern: string; readonly rootCausePattern: string };

// Exploration when a lane is stuck (dori fix-attempt, tree, challenge, fork-explore, research-hint).
// minHypotheses: competing hypotheses, each with a cheap discriminating test, that rung 2 of the stuck ladder asks for.
// researchText goes to the lane at rung 3 when sendResearchToLane is on ({question}, {n}, {metric}, {key}). It must start
// with "ulw research " (RESEARCH_PREFIX): omo attaches its ulw-research skill only to typed input that names it, and not
// when the text starts with a [TAG]. researchVerifyMin: how long after sending the lane's session log may take to show the
// skill pointer and a read of its SKILL.md before RESEARCH_NOT_STARTED.
// Before a review each reviewers.models id is checked against modelsCommand (the host's models) and authCommand
// ({provider}: is it logged in); an id the host cannot call is skipped or moved to a logged-in provider of the same model.
// challengeCommand / branchCommand: argv templates ({model}, {prompt}, and {system}, the reviewer's system prompt, for
// challengeCommand); branchMinutes: time limit per fork-explore branch.
export type Explore = {
  readonly minHypotheses: number;
  readonly sendResearchToLane: boolean;
  readonly researchText: string;
  readonly researchVerifyMin: number;
  readonly treeLines: number;
  readonly modelsCommand: ArgvTemplate;
  readonly authCommand: ArgvTemplate;
  readonly challengeCommand: ArgvTemplate;
  readonly challengeMinutes: number;
  readonly branchCommand: ArgvTemplate;
  readonly branchMinutes: number;
};

// Signals that need no tag from the lane: the inferred count of the stuck ladder (and what dori intent-check reads). The inferred count is
// the cycles of "a gate line failed, then a new attempt targets it" on one metric; repeatGapMin: attempts on one
// metric closer than this are one attempt told twice. failPattern / passPattern: a gate line's verdict; verdictPattern: a
// prescription's verdict (fails every known metric the text names); inferAttemptPattern: a new attempt (a prescription, an
// adjustment, a patch; "시작"/"반영" alone are not, they also start evals and record decisions);
// prescriptionPattern: words that make it an attempt even when the text also reads as a diagnosis (diagnosticPattern).
// aliases: metric names that mean the same gate ({ "교착": ["deadlock"] }); the key is the name shown. conditionWords: names
// of conditions a report breaks results down by (soil, seed, depth, cell: "교착 113(양토 1.0 61 ...)"), never a metric.
// discriminationPattern: a report or tree entry that tells hypotheses apart (dori tree H.., 가설 판별); when it makes no new
// attempt itself (its result changed the next action), the next attempt on a metric it investigated is not a repeat; one that
// prescribes again in the same report counts as an attempt. targetScope: an
// attempt targets a metric named in the same "sentence" (the default: reports name the target a few words from the prescription)
// or the same "clause" (between commas: quieter, misses more).
// intentCheck: what dori intent-check's reviewer reads: reports (the newest reports it reads at least), maxReports (at
// most this many of the reports since the last check, all of them up to that), relays (how many owner [LEAD] relays it
// reads, and how many of the owner's decisions in the lane's thread: card answers, his messages).
export type IntentCheck = {
  readonly reports: number;
  readonly maxReports: number;
  readonly relays: number;
};

export type AutoSignals = {
  readonly repeatGapMin: number;
  readonly failPattern: string;
  readonly passPattern: string;
  readonly verdictPattern: string;
  readonly inferAttemptPattern: string;
  readonly prescriptionPattern: string;
  readonly diagnosticPattern: string;
  readonly aliases: Readonly<Record<string, readonly string[]>>;
  readonly conditionWords: readonly string[];
  readonly discriminationPattern: string;
  readonly targetScope: "clause" | "sentence";
  readonly intentCheck: IntentCheck;
};

// dori handover: switch the lead to a new agent session. prompt starts the first message of the new session (the note's
// path follows); title names it (empty: the old title plus MMDDhhmm); model (empty: defaultModel); services are the user
// units restarted after leadPane moves, so long-running sweeps read it again (empty: the update.services units); timers is
// a regex for `systemctl --user list-timers` lines listed in the note; verifyMin bounds the checks; inbox is the file the
// inbox probe goes to (empty: DORI_DISCORD_INBOX, else <stateDir>/discord/inbox.jsonl); cwd is where the new session opens
// (empty: the old lead's path with symlinks resolved); watchers are the watches that are not omo monitors of the old
// session (a host guard, a separate listener): check is an argv ({pane}, {session} filled in) whose exit 0 means it runs,
// before the move for the old lead and after it for the new one; arm tells the new session how to start it, if it must.
// Rollover (moving a session to a new one): readyMin is how long a lane's `dori handover ready` mark stays valid. lane* and
// lead* are the thresholds at which freshness says a rollover is due (ROLLOVER_DUE): context use in percent (status line),
// compactions in the session log, hours since the session began, thousands of tokens still held after the last compaction
// (*AfterCompactK); 0 turns one off. A stuck lane is due at rung 4 of the
// stuck ladder (stuck.*). Nothing switches on a threshold: the lead decides (dori rollover-propose prints proposalText
// for the lead and logs it), runs the handover with --approved-by lead:<reason and signal>, and the handover tells the
// owner afterwards and logs that message's id. autoRolloverLanes / autoRolloverLead let freshness start it on a measured
// threshold or at rung 4 of the stuck ladder without asking; off until the owner decides from dori rollover-stats. An
// automatic lane start waits up to autoWaitMin minutes for the lane's turn to end and moves it at that idle moment; a lane
// that stays busy, or runs a chain that would die, is asked to reach a safe point first (again after autoRetryMin), and
// the move starts again once it is idle or marked ready. There is no last try: a move that failed is started again after
// autoRetryMin minutes, doubling up to 8 times that while failures go on.
// An automatic start never moves a lane that runs or watches a training or eval chain: one with a tag in trainingTags, or
// a live monitor whose command, path or description matches trainingWatch (a regex, case-insensitive); the lead moves it.
// That message to the owner is written by the scripts (rollover.ts ownerRolloverText), one or two plain sentences in
// discord.locale's language: what moved, why, and that he has nothing to do; it goes in the lane's discord thread or DORI_DISCORD_CHANNEL and carries no
// pane, config key or link (the watch log does). supplementRounds is how many times a lane handover fills in what the new session's
// restatement left out (from the note and the old log) and asks again before it rolls back; 0 rolls back at the first gap.
// A committed lead handover freezes the old lead (SIGSTOP on its agent and every child) instead of closing it; frozenCloseH
// is how many hours later freshness closes it (0: only by hand, dori handover close-frozen); the owner's message of that
// rollover says how long the old one is kept, and a lane's says how much context the move took off.
// The audit after a committed handover (rollover-audit.ts): freshness starts it auditAfterMin minutes after the commit, for
// handovers committed at most auditWindowH hours ago (0 turns it off); the lead's instructions of the old session's last
// auditLeadH hours are read with the owner's quoted words; auditSummaryAt ("Mon 08:30" in scorecard.timeZone; empty: off)
// is when the week's summary goes to the lead's inbox.
// statsPeers: "<user>:<absolute path of that Dori's rollover-log.jsonl>" per other Dori on this host, read as that account
// (sudo -n -u <user> cat) by dori rollover-stats --stuck so one command shows each Dori's stuck rollovers (empty: this one).
export type HandoverWatcher = { readonly name: string; readonly check: readonly string[]; readonly arm?: string };

export type Handover = {
  readonly prompt: string;
  readonly title: string;
  readonly model: string;
  readonly services: readonly string[];
  readonly timers: string;
  readonly verifyMin: number;
  readonly inbox: string;
  readonly cwd: string;
  readonly watchers: readonly HandoverWatcher[];
  readonly readyMin: number;
  readonly laneContextPct: number;
  readonly laneCompactions: number;
  readonly laneAgeH: number;
  readonly laneAfterCompactK: number;
  readonly leadContextPct: number;
  readonly leadCompactions: number;
  readonly leadAgeH: number;
  readonly leadAfterCompactK: number;
  readonly autoRolloverLanes: boolean;
  readonly autoRolloverLead: boolean;
  readonly autoRetryMin: number;
  readonly autoWaitMin: number;
  readonly trainingTags: readonly string[];
  readonly trainingWatch: string;
  readonly supplementRounds: number;
  readonly frozenCloseH: number;
  readonly proposalText: string;
  readonly auditAfterMin: number;
  readonly auditWindowH: number;
  readonly auditLeadH: number;
  readonly auditSummaryAt: string;
  readonly statsPeers: readonly string[];
};

// dori backlog: the list the dori-lanes freshness loop starts lanes from (src/backlog.ts); off unless a Dori turns it on
// hostMaxLanes counts every Dori's backlog lanes on this host (files in hostDir); writeNeedsOwnerLink turns an item added
// without --read-only and without a checked owner message link into a question for the owner
export type BacklogSettings = {
  readonly enabled: boolean;
  readonly everyMin: number;
  readonly maxLanes: number;
  readonly maxStarts: number;
  readonly hostMaxLanes: number;
  readonly hostDir: string;
  // the other Doris' #dori-pair posts that start a repair request (empty: off), a lane each at once: the owner's standing rule
  // fix-to-soodori is its approval; a reply is not taken
  readonly pairRepairPattern: string;
  // the Done line of an item the backlog made itself (a feed entry): {id} and {stateDir} are filled in
  readonly intakeDone: string;
  readonly writeNeedsOwnerLink: boolean;
  // a command printing a JSON list of the owner's todos (YooDori: the dashboard's todo-list --open --json), each
  // {todo_id|id, title, status, approved_at, auto_applied, ...}; run at each sweep. An entry the owner approved by card
  // (auto_applied false) works within its own scope, any other only reads and drafts and asks before it writes
  readonly feedCommand: readonly string[];
  // inbox row kinds that are the owner's own orders (YooDori: dashboard-order): each new row becomes an item at once; one about
  // a todo whose lane runs goes to the lead for that lane
  readonly orderKinds: readonly string[];
  // "HH:MM" in timeZone: once a day after it, one backlog-day row in the lead's inbox (done, started, waiting on the owner)
  readonly dayReportAt: string;
  readonly timeZone: string;
};
