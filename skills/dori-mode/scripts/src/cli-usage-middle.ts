export const USAGE_MIDDLE = `  challenge <key> --plan FILE [--model M] [--all]
                                       a model of another family than the lane's reviews the plan in a fresh context,
                                       with read-only access to the plan's repository: reasons it will fail, missing
                                       alternatives, the cheapest falsifying test. Saved under <stateDir>/challenges/<key>/
                                       and recorded on the lane (CHALLENGE_SAVED). Reviewers go in reviewers.models
                                       order (best GPT, Claude, Grok); the first that writes a review wins, --all asks one
                                       of each family in turn. Ids this host cannot call are skipped before any call
  challenge --check [<key>]            each reviewer id: REVIEWER_OK (and the id it is called as) or REVIEWER_SKIP and why
  review <owner/repo#N> [--dir CHECKOUT] [--model M] [--lane K] [--no-test "<reason>"]
                                       a review receipt pinned to the PR's head commit: CHECKOUT (default: here) must be
                                       that head with no changes; the commit checks run first (REVIEW_CHECKS_FAILED: a
                                       commit's author or committer is not mergeGate.identities[repo], or a fix: commit
                                       changes source and no commit adds or changes a test; --no-test waives only the
                                       test rule, its reason kept in the tests receipt); mergeGate.testCommand next (TESTS_OK, or
                                       REVIEW_TESTS_FAILED and no review); then a fresh reviewer of another family than
                                       the lane's model reads the diff and the code and ends with VERDICT: CLEAR|BLOCK
                                       (exit 1 on BLOCK). For repos without CI: a PR with GitHub checks or auto-merge is
                                       refused (unsupported). Receipts: <stateDir>/receipts/<repo>_<N>@<sha>.<kind>.json
  merge <owner/repo#N> [--dry-run] [--delete-branch]
                                       MERGE_REFUSED <reason> unless the head has a CLEAR review receipt and a passing
                                       local test receipt; then gh pr merge --squash --match-head-commit <head>, read back
                                       as MERGED ... merge=<sha>. A commit pushed after the review has no receipt, so it is
                                       refused until reviewed again
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
  intent-check <key> [--direction TEXT] [--next TEXT] [--goal "owner words"] | intent-check <key> --reread
                                       the owner's goal next to the lane's current direction and next step, then a reviewer
                                       of another family (reviewers.models, reviewers.first first) reads them, the brief,
                                       the owner's words in it and in the lead's [LEAD] relays, his card answers and
                                       messages in the lane's thread (dated, the newest wins; in a thread other lanes share,
                                       only those tied to this lane) and the newest reports: INTENT_CHECK <key> OK, or
                                       VIOLATION|CONTRADICTION|GOAL_LOSS with quoted evidence as the stuck ladder's context
                                       rung (STUCK "@context"; again after a confirmed re-read, rung 4). An owner quote not
                                       in his words is dropped (INTENT_CHECK_UNGROUNDED), one in a shared thread's message
                                       for another lane too (INTENT_CHECK_SHARED), a report an earlier check read is not
                                       flagged again (INTENT_CHECK_STALE). --direction/--next record what the lane says it
                                       does now; --goal sets a missing goal. --reread: you confirmed the last finding, so
                                       the lane gets stuck.rereadText (its brief and the owner's words to re-read; REREAD_SENT)
  repeat-check <key> [--since ISO|Nd|Nh] [--until ISO] [--repo DIR ...] [--backtest]
                                       untagged repeats: a gate line (metric) that failed and was re-targeted by a new
                                       prescription or patch, from the lane's [REPORT] lines, its branch commits (worktrees,
                                       cwd, --repo) and tree entries; INFERRED <key> "<metric>" <n> with the evidence from
                                       stuck.researchAt cycles (the inferred half of the stuck count). Default window: the
                                       lane's current session. --backtest prints each time a count reached it, with its time
  signals [--lane K | --cwd DIR | --tag T]
                                       what earlier lanes tried and how it went: numbered fix attempts and the root-cause
                                       switch, tagged fixes by metric, rejected done claims, re-sends, nudges, outcome,
                                       warnings; no option = one SIGNALS line per open lane. Read it before re-instructing
  lesson add <key> --rule TEXT --evidence PATH [--cwd DIR]
                                       keep a rule the lane learned about its repo (the lane's cwd); the next launch there
                                       puts it in the brief under "Lessons for this repo"
  lesson add --global --rule TEXT --evidence REF
                                       the lead's rule for every lane, whatever its repo (upstream dori-superagent#97): every
                                       launch puts up to 4 in the brief under "Lessons for every lane"; refused with a lane
                                       key, --cwd, or from an open lane's pane
  lesson list [--cwd DIR]              current lessons (global ones included), newest first; a damaged journal line is a
                                       LESSON_WARNING
  lesson mark <id> --outcome pending|helped|no-effect|harmful|encoded
                                       only pending and helped ones reach new briefs; a global one is the lead's to mark
  worklog add <title> --source REF     record an owner request when it arrives (upstream dori-superagent#96)
  worklog next|note <id> <text>        set the item's next step, or add a note (a decision, an owner)
  worklog close <id> --result TEXT     close the item with what came of it
  worklog list [--open]                items as JSON; <stateDir>/worklog.md holds the same for reading, and the
                                       dori handover note lists the open ones
  close  <key> [--note TEXT] [--summary TEXT] [--posted ID|LINK] [--lesson TEXT [--evidence PATH]]...
                                       close now (Done signals must read back live); a lane with a work thread first posts
                                       its summary for the owner there (--summary, the claim's, else one a model writes from
                                       its last report and REPORT.md): none is CLOSE_SUMMARY_MISSING, a post that failed is
                                       CLOSE_SUMMARY_NOT_SENT, exit 2 and nothing changed. Then a discord:<id> thread is set
                                       done and archived when DORI_DISCORD_TOKEN is set; a thread another open lane or an
                                       open card uses only gets the summary posted. With the result already in the thread
                                       (the claim's RESULT_ALREADY_POSTED, or --posted for one the lead relayed) and no
                                       --summary, nothing is posted: CLOSE_SUMMARY_SKIPPED. A lane moved for being stuck that
                                       closes with no outcome line gets the --note as one, counted unknown (ROLLOVER_OUTCOME)
  watch                                long-running: emits LANE_* lines every 30 s
  update [--pull] [--dry-run]           apply changed scripts to configured services and report unset new config keys
  notify-change --summary TEXT [--file PATH ...]
                                       tell the lead about changed guidance using update.announce
  scorecard [--date YYYY-MM-DD|today|yesterday] [--post] [--to discord:<id>]
                                       the day's token scorecard from session usage, the registry, the lanes log and the
                                       inbox (no model call), saved to <stateDir>/scorecard/<date>.json and latest.md;
                                       --post also sends it to scorecard.postTo or DORI_DISCORD_CHANNEL (off by default)
  freshness [--loop MIN]               nudge silent lanes, hand their last report to the lead
  dead-panes [--loop MIN]              print DEAD_PANE <id> for stopped agent panes
  guard [--loop MIN]                   host load, memory, disk and pane-count alerts
  heavy <label> [--mem SIZE] -- <command ...>
                                       run a heavy command when a slot is free and load is low; beside a running one only
                                       when GPU, memory and CPU each keep heavyHeadroomPct (10) percent free with it
                                       (HEAVY_ADMIT / HEAVY_WAIT lines on stderr and in state/heavy/heavy.log); waiters
                                       start in the order they came. The command runs in its own systemd user scope
                                       (HEAVY_SCOPE) capped at MemoryMax: --mem (e.g. 70G), else what keeps 10% free at
                                       its start; over it only the job is killed (HEAVY_OOM, exit 137), never the lane
                                       that started it. --mem also waits until that much memory keeps 10% free (counting
                                       what running jobs said and do not use yet) and refuses one that never fits
  gpu-room [label] [--want SIZE]       make SIZE (heavyGpuFreeGb, 20G) of free memory for a GPU start, as dori heavy does
                                       before every GPU job: below it, page cache is pushed out by touching anonymous
                                       memory and letting it go, never taking MemAvailable under heavyHeadroomPct and
                                       stopping once anything is swapped out (HEAVY_GPU_ROOM / _SHORT / _FAILED on stderr
                                       and in state/heavy/heavy.log; nothing when enough is free)
  heavy <label> --job <name> [--in FILE ...] [--out DIR] [--rl] [-- arg ...]
                                       run heavyQueue.jobs.<name> in the GPU line of all hosts: on the queue host here
                                       first, then on a heavyQueue.helpers host (an rl job only where its heavyQueue.rl), else wait;
                                       elsewhere sent to the queue host (heavyQueue.queue), run here only while it cannot
                                       be reached. Prints the job's stdout, copies its result files to --out, exits with
                                       its code (HEAVY_HELPER / HEAVY_DONE / HEAVY_QUEUE_DOWN lines)
  heavy <label> [--mem SIZE] --kind cpu|browser|gpu --sync PATH ... [--env NAME ...] [--tools NAME ...] [--back GLOB ...] [--stale-again] -- <command ...>
                                       run the lane's own command on the less busy PC: a heavyQueue.helpers host when this
                                       one is more than 15 points busier or refuses it, in a bwrap box with no network,
                                       the --sync folders copied there at the same paths and changed files copied back
                                       (HEAVY_SPREAD / HEAVY_SYNC / HEAVY_BACK / HEAVY_DONE); the working folder outside --sync
                                       goes along (HEAVY_SHIP); another path stops it (HEAVY_LOCAL_REFUSED: add --sync; --local: here);
                                       the --sync paths go as one archive checked there by its sha256 (ASSET_OK: its bytes
                                       arrived as sent and tar took them; the unpacked tree is not walked again)
                                       no sign of life for heavyQueue.staleMin minutes: HEAVY_HELPER_STALE, exit 124
                                       (--stale-again: back to the line, another helper or here)
  heavy hold-local [on --until <30|2h|HH:MM|ISO> --reason "<why>" [--except <account> ...] | off]
                                       a measuring window on this host: until off or --until (24 h at most), no new heavy
                                       job of any account but --except ones takes a slot here; one that may go to a helper
                                       goes there, the rest wait (HEAVY_HOLD_LOCAL lines name who, why and until); running
                                       jobs go on, and --job transcribe runs here (HEAVY_HOLD_EXEMPT)
  heavy <label> --kind cpu|browser|gpu --sync PATH ... --items FILE [--mem-per-worker SIZE [--mem SIZE]] [--out DIR] [--on HOST,...] [--not-on HOST,...] -- <command with {item} and {n}>
                                       one batch over this host and every helper at once (not batch: false ones; --on /
                                       --not-on narrow them): each line of FILE a job of its own, up to --mem /
                                       --mem-per-worker per host, none new on a host short of memory (HEAVY_BATCH_SHRINK),
                                       a dead helper's or OOM item once more elsewhere (HEAVY_BATCH_RETRY); outputs and
                                       receipts.jsonl (the host of each item) in --out (HEAVY_BATCH_DONE)
  heavy <label> --helpers-only --kind cpu|browser|gpu --sync PATH ... -- <command ...>
                                       the same, never on this host: it waits for a helper that admits it (it takes no
                                       slot or ticket here), exit 2 with HEAVY_HELPERS_ONLY when none can take it
  heavy-serve <label> <name> [--rl] -- [arg ...]
                                       queue host side of a job sent by another host: inputs as tar on stdin, result tar
                                       on stdout
  heavy-worker [--caller ACCOUNT]      a helper's forced command for the queue host's key (SSH_ORIGINAL_COMMAND "run
                                       <label> <name> [arg ...]", "exec ..." when heavyQueue.exec is
                                       true, or "sweep"); job files live in heavyQueue.jobDir and
                                       are deleted after each run
  can-launch                           exit 0 if the host has room for a new lane, else print why and exit 4
  state-git [init|commit|log [N]|restore <time|sha> [--file PATH ...]|loop|check|push-check] [--dir DIR ...]
  state-git backup [create|preview|approve --by "lead: ..." [--history-ok DIR:PATH ...]|push|tick [--clock ISO]]
                                       the private backup (stateGit.backup.repo): a checked snapshot per directory,
                                       pushed by the loop at stateGit.backup.at (06:00) when no pane is mid-turn, no
                                       heavy job and no git lock (again every retryMin, none after until); the first
                                       push waits for approve; push-check is the pre-push hook
                                       this Dori's state in local git (config dir, stateDir, inbox dir; pushed only as above):
                                       commit only when something changed, never env/inbox/briefs/logs or token-shaped
                                       content; restore "yesterday 21:00" (stateGit.timeZone) commits first, so it can
                                       be undone; loop is what dori-lanes runs every stateGit.everyMin minutes
  send <slack|telegram|discord> --to TARGET --text TEXT | --text-file FILE [--thread ID] [--edit ID] [--status working|done] [--no-typing] [--ping USER_ID] [--reply ID] [--again]
  send slack --to CHANNEL --file PATH [--file PATH ...] [--text TEXT | --text-file FILE] [--thread TS]
  send discord --to CHANNEL --file PATH [--file PATH ...] [--text TEXT | --text-file FILE] [--thread ID] [--reply ID]
                                       post or edit a message (tokens from DORI_SLACK_TOKEN or DORI_SLACK_TOKEN_FILE, DORI_TELEGRAM_TOKEN, DORI_DISCORD_TOKEN);
                                       telegram --thread and --edit take a positive whole-number id; an empty, bare or malformed id is
                                       refused before any request, never converted into a General post or a null-id edit;
                                       a value flag left without its value is refused, and --help before a command prints usage without running it;
                                       --file (slack, up to 10, 1 GB each) uploads the files and shares them as one message
                                       with the text, in the thread with --thread (SENT <file ids>); a missing, empty or too
                                       big file is refused before anything is sent (SEND_FILE_MISSING|REFUSED|TOO_BIG, exit 2);
                                       shared once per call, never retried or repeat-checked: a failure exits non-zero;
                                       the watcher's eyes stay on (a text answer takes them off)
                                       --file (discord, up to 10, 20 MiB each, 25 MiB a message; also thread reply|wait|done) posts the text
                                       and the files as one message (SENT <id>; same refusals before anything is sent); a
                                       repeat needs the same files too (sha256), --again sends it anyway
`;
