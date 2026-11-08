import { USAGE_MIDDLE } from "./cli-usage-middle.ts";
import { USAGE_END } from "./cli-usage-end.ts";

const USAGE_START = `dori <command> [options]

  lead                                 print the live lead as "<aoe-id> <tmux-session>" (herdr: "<omo session id> <pane>"),
                                       " stopped" after it when its session or agent is not running
  serve [--log FILE] [--only TAG ...] [--install-task]
                                       keep this Dori's loops running in one process where there is no systemd (native
                                       Windows): watch, freshness, dead-panes, guard, state-git, inbound discord and the
                                       session watcher, each started again when it exits, every line stamped and tagged in
                                       --log (default <stateDir>/serve.log); --install-task registers it with the Windows
                                       Task Scheduler to start at logon with no execution time limit
  revive <herdr pane> [--text TEXT]    start the omo session recorded for a herdr pane whose agent is gone again in that
                                       pane (omo --session-id), wait for its prompt and type TEXT; REVIVE_OK or REVIVE_FAIL;
                                       a pane whose agent runs is left alone (REVIVE_ALREADY_RUNNING)
  launch <key> --title T --brief FILE --done "merged o/r#N; closed o/r#M" --thread REF|new [--why-new "<reason>"] | --no-thread "<reason>" [--model M] [--cwd DIR] [--tag T ...] [--done-weak-ok]
         [--goal "owner words"] [--challenge-before STEP ...] [--use-gpu] [--ui] [--dry-run]
         [--wall-minutes N|none] [--token-limit N|none] [--cost-limit N|none] [--activity-path FILE ...]
                                       every lane opens with a work thread (the owner's long work gets one): --thread REF
                                       for the open thread the work continues in, --thread new to open one named T in this
                                       Dori's own channel (DORI_DISCORD_CHANNEL; THREAD_OPENED, then the lane's first
                                       message), or --no-thread "<reason>" for a lane the owner did not ask for
                                       (LAUNCH_THREADLESS, kept in the registry). Neither, or --thread none: LAUNCH_NO_THREAD,
                                       exit 4, nothing opened; a channel id as REF: LAUNCH_THREAD_IS_CHANNEL, exit 4.
                                       --thread new first looks for related open threads (a lane open there or closed
                                       less than related.recentH hours ago; an owner message the brief links in it, the
                                       same link, its ~/.dori/qa/<key>/ folder, shared title and brief words): found, it
                                       prints a LAUNCH_RELATED_THREAD line per thread with its evidence and exits 4,
                                       nothing opened; pass --thread REF to continue there, or --why-new "<reason>" to
                                       open a new one anyway (LAUNCH_NEW_THREAD_WHY, the reason kept in the registry)
                                       prints LAUNCH_DONE_WEAK (and still launches) when every Done signal only checks
                                       files or text; --done-weak-ok silences it. The brief gets a "Past signals" section
                                       from earlier lanes in the same cwd or with a shared tag (the key's first word is one)
                                       and the area's "Hypothesis tree". --goal keeps the owner's words for intent-check
                                       (LAUNCH_NO_GOAL without it); --challenge-before makes the lane run dori challenge
                                       before that step (claim-done is refused until it did); --dry-run prints the brief
                                       as the lane would read it and opens nothing. The session starts with config
                                       launchEnv (aoe), e.g. the GPU hidden; --use-gpu starts it without, and the
                                       registry keeps that for handover and restart. --ui puts the owner's seven UI steps
                                       (references/ui-work.md) at the top of the brief, after its ulw line; a brief that
                                       reads like UI work without --ui prints LAUNCH_UI_HINT (and still launches). A brief with none of
                                       the eight steps of references/sessions.md gets them after its four fields
                                       (LAUNCH_STEPS_ADDED); with only some, LAUNCH_STEPS_PARTIAL and nothing added.
                                       The directive ledger (config directives.common + .local, dori directives): a
                                       directive in scope (all lanes, UI work, a kind of work, the --cwd repo, a keyword;
                                       quoted words and directive names do not count) that the brief lacks is added as
                                       written there (LAUNCH_DIRECTIVE_ADDED); a require directive the brief does not meet
                                       stops the launch (LAUNCH_DIRECTIVE_MISSING, exit 4, nothing opened) unless
                                       --waive <id> "<reason>" (repeatable) leaves it out: LAUNCH_DIRECTIVE_WAIVED in the
                                       watch log and the registry, and discord.waiveText to the owner
  backlog [list [--all]|add <id> --title T --brief FILE --done "..." [--priority 1-9] [--cwd DIR] [--thread REF|new | --no-thread "<reason>"] [--why-new R] [--goal "owner words"] [--tag T ...] [--ask "<question for the owner>"] [--read-only] [--owner-link URL] [--by owner|lead]|drop <id> [--reason R]|decide <id> [--question Q --hash H] --text "<the owner's answer>"|tick [--force]]
                                       the list of work the owner or the lead put by hand (no GitHub import): with
                                       config backlog.enabled, the freshness loop of dori-lanes runs a pass every tick: a
                                       running item whose lane closed is done (BACKLOG_DONE), an item with --ask puts one
                                       backlog-ask row in the lead's inbox and never starts before decide (BACKLOG_ASK), and
                                       the next open items start at once by priority through dori launch (its directives,
                                       eight steps and work thread; --thread new by default) under the lane key bl-<id>
                                       while fewer than backlog.maxLanes backlog lanes of this Dori and backlog.hostMaxLanes
                                       of all Doris on the host run, at most backlog.maxStarts a pass, and, checked before
                                       each start, a model account is free and dori can-launch and the load guard allow
                                       (BACKLOG_STARTED; BACKLOG_HOLD and BACKLOG_WAIT when that changes or at a
                                       backlog.everyMin sweep). With backlog.writeNeedsOwnerLink an item without --read-only
                                       and without a checked --owner-link asks the owner first; --read-only items launch
                                       with a read-only rule. A refused launch holds the item at once, a backend failure
                                       after two tries (BACKLOG_HELD, a backlog-held row) until add replaces it or drop.
                                       backlog.feedCommand (YooDori's dashboard todos) is read at each sweep: an entry the
                                       owner approved by card (auto_applied false) works within its own scope, any other
                                       only reads and drafts (the limit is added at each launch from the item's state, and
                                       bound to the entry's content: changed content asks again, decide --question --hash
                                       answers that one question); an entry on hold (보류) waits, one finished or gone on
                                       the dashboard drops its open item. backlog.dayReportAt sends one backlog-day row a day.
                                       tick runs a pass by hand (--force: a sweep now, even when off)
  directives [table|prompts|check [--static]|apply <key> [--dry-run]|hint <text>|links [--push]]
                                       hint prints the directives (at most five) an owner message with that text carries
                                       in its inbox row (DIRECTIVE_HINT / DIRECTIVE_HINT_NONE);
                                       the directive ledger: table (default) prints it as one table for the owner; prompts
                                       prints his words next to the prompt each brief gets (형 원문 | 지침문); check
                                       validates both layers and has a reviewer of another family compare every new or
                                       changed prompt with his words (DIRECTIVES_OK, or DIRECTIVES_BAD / _MEANING_FAILED
                                       lines and exit 1; --static skips the reviewer); apply sends a lane launched before
                                       a directive was in the ledger the ones in scope its brief lacks, as one [LEAD]
                                       message, and adds them to its brief under "## 추가 지침(리드, launch 뒤)"
                                       (DIRECTIVES_APPLIED; none missing: DIRECTIVES_APPLY_NONE; not submitted:
                                       DIRECTIVES_APPLY_NOT_SENT, exit 1, brief unchanged)
  directive-audit [--since 24h|Nd|ISO] [--dry-run]
                                       the lanes opened since then against the ledger (directives in scope missing from
                                       the brief, a lane without a thread) and the owner's messages that read like a
                                       standing directive no ledger entry cites, a lead thread opened without the ledger read
                                       (DIRECTIVE_LEAD thread:<id>), and a line of the lead's memory (system/, reference/)
                                       that keeps a ledger directive a second time instead of a pointer "장부:<id>"
                                       (DIRECTIVE_DUPLICATE): DIRECTIVE_GAP / DIRECTIVE_LEAD / DIRECTIVE_UNLEDGERED /
                                       DIRECTIVE_DUPLICATE lines into the watch log and one [DIRECTIVE_AUDIT] summary to
                                       the lead; none: DIRECTIVE_AUDIT_OK on stdout only. --dry-run prints and sends nothing
  adopt  <key> --pane ID --title T --brief FILE --done "..." [--thread REF] [--tag T ...] [--goal G] [--challenge-before STEP ...] [--use-gpu]
                                       REF is <adapter>:<id> (discord:<thread id>); an empty or malformed REF is refused
  set-thread <key> <adapter>:<id>      point an open lane at another work thread
  done-set <key> --done "<signals>" --reason "<why>"
                                       change an open lane's Done line when its plan changed after launch: the new line is
                                       checked like launch's and read once now (SIGNAL OK/NOT lines, DONE_SET <key> live k/n);
                                       the earlier line stays in the lane's doneChanges, the watch log gets DONE_SET, the
                                       brief's footer gets the new line and the lane is told. dori close and the watcher then
                                       read the new line, and every signal still has to read back live
  set-gpu <key> on|off                 on: the lane's next session (handover, restart) starts without launchEnv; off: with it
  launch-env <tmux-session>            env(1) arguments a restart of that session needs to start like dori opens it
                                       (NAME=VALUE for a lane, --unset=NAME for a --use-gpu lane or any other session;
                                       nothing without launchEnv); used by setups/discord-aoe/self-restart.sh
  sync   [--write]                     registry vs live panes; read-only unless --write; a SIGNALS line per open lane with a record
  checkpoint <key> --step ID --result TEXT --evidence PATH [--remote-effect RECEIPT]...
                                       record a finished step in <stateDir>/lane-state/<key>/checkpoints.jsonl (locked);
                                       the same step again with the same data is a no-op, with other data it is refused;
                                       one --remote-effect per receipt (a push, a merge), each recorded under one step only
  checkpoints <key>                    print the lane's finished steps (JSON); read them before resuming remote work
  caps <key> [--wall-minutes N|none] [--token-limit N|none] [--cost-limit N|none]
                                       print the lane's caps (supervision.defaults, then supervision.lanes.<key>, then its own);
                                       with flags, set its own (none: off). At a cap freshness tells the lead once (LANE_CAP);
                                       the lane is never stopped or told
  claim-done [<key>] --evidence TEXT [--summary TEXT] [--posted ID|LINK] [--post-summary] [--rollover-outcome TEXT [--rollover-unresolved]]
                                       key defaults to the lane registered for this pane (its own session: $HC_TERMINAL_ID,
                                       else $HERDR_PANE_ID, else its tmux session); --summary: 2 to 5 plain lines for the owner's thread in his language.
                                       The result reaches the thread once: when this lane's session posted in its work thread
                                       (dori send, dori thread) in the last 30 minutes, or --posted names that message, it is
                                       the result (RESULT_ALREADY_POSTED) and the close posts no summary; --post-summary: that
                                       post was not the result, post the summary anyway. A lane moved to a new session at
                                       rung 4 of the stuck ladder gives --rollover-outcome: one line on what it did
                                       differently after the move (--rollover-unresolved: the move did not solve it); without
                                       it the claim is ROLLOVER_OUTCOME_MISSING, exit 2, nothing recorded
                                       (what changed, what is left, when it reaches where it is used), posted before the close
                                       marks the thread done; paths, commit hashes, backticks or report heads are refused
                                       (SUMMARY_REFUSED, exit 2). Without it the close has a model write one from the lane's
                                       last report and REPORT.md
  object-done <key> --reason TEXT [--reason TEXT ...]
  pause  <key> <reason>                park a lane that waits on a human: no freshness nudge or post, LANE_BLOCKED or
                                       DEAD_PANE for it, and a done claim does not close it; the reason goes in its history.
                                       With aoe it first pauses the omo goal of the lane's session (/goal pause, read back:
                                       GOAL_PAUSED or GOAL_SKIPPED); PAUSE_UNVERIFIED, exit 3, lane unchanged, if not confirmed
  resume <key>                         back to the status it had before the pause, and /goal resume for a goal the pause
                                       paused (RESUME_UNVERIFIED, exit 3, still paused, if not confirmed)
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
`;

export const USAGE = USAGE_START + USAGE_MIDDLE + USAGE_END;
