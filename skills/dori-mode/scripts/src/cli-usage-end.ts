export const USAGE_END = `                                       --text-file posts the file's text (real line breaks) the same way as --text. A text
                                       with a literal \n and no real line break outside code is refused before anything is
                                       sent (SEND_LITERAL_NEWLINE, exit 2; also thread reply|wait|done|open --first, ask,
                                       claim-done and close --summary)
                                       --status (discord) writes it as the progress message, in discord.statusStyle;
                                       Discord posts show typing first (best effort); --no-typing skips it
                                       --ping USER_ID (digits only) mentions and pings only that user on a new Discord post
                                       --reply ID (Discord, digits only) posts it as a reply to that message, no ping
                                       the same new message (place, --reply, --ping, text) within 10 minutes, or the
                                       place's last post at any age, is not sent again: SEND_DUPLICATE <place> <earlier
                                       id>, exit 3, also for two sends at once (thread reply too; wait|done still set
                                       their status, exit 0); --again sends it anyway; a post prints what the service
                                       holds: SENT <id> len=<n> sha=<8 hex> first="<40 chars>"; an option send does not
                                       take is refused (UNKNOWN_OPTION, exit 2)
  type <pane> --text TEXT | --text-file FILE
                                       type text into an agent pane and confirm it was submitted: Enter, an empty input
                                       box (one more Enter if not), a running turn. Prints SUBMITTED, or NOT_SUBMITTED
                                       <reason> (also in the watch log) and exits 1. Use it for every [LEAD] relay
  presence <slack|discord>             keep the account shown as online until stopped
  transcribe <audio-file>              run hooks.transcribe and print the text
  inbound slack [--loop MIN]           print INBOUND lines: unread thread replies (threads view), replies in threads
                                       the Dori posted in (any helper), DMs and channels with unread mentions
  inbound telegram [--loop MIN]        print INBOUND lines: the owner's Telegram DMs and his messages in the configured
                                       group topic (DORI_TELEGRAM_TOKEN, DORI_TELEGRAM_OWNER_ID, optional
                                       DORI_TELEGRAM_GROUP_ID, DORI_TELEGRAM_TOPIC_ID), owner-gated getUpdates; his
                                       edits as edit:dm / edit:topic, mid=<message_id> on every line, live-location
                                       refreshes dropped, media with file=<kind>:<file_id>
  inbound discord                      long-running gateway listener: the owner's messages get an eyes reaction and an
                                       inbox row, voice is transcribed, question-card answers are recorded; with
                                       DORI_DISCORD_WATCH_CHANNELS + DORI_DISCORD_WATCH_BOTS a monitoring bot's problem
                                       alert there (DORI_DISCORD_WATCH_MATCH) is a scope:"watch" row for the lead
  eyes off <message id | link>         take this Dori's own eyes off one message at once: an owner message it read and
                                       will not answer (another Dori's work in the pair channel). Prints EYES_OFF
                                       <channel> <id>; the channel comes from the link, eyes.json or
                                       DORI_DISCORD_PAIR_CHANNEL. Other reactions stay. The id goes into eyes-off.jsonl
                                       beside the inbox, so LEAD_OWNER_WAITING no longer counts that message
  ask --text Q --option A [--option B ...] [--thread REF | --reply-to MSG | --channel "<reason>"] [--session ID] [--tmux NAME]
                                       post a Discord question card; the first option is the recommended one. It goes in
                                       its work's thread: --thread, else the open lane thread of the asking session
                                       (--tmux, --session or this pane) or the one thread mapped to it (ASK_THREAD_AUTO);
                                       --reply-to answers the owner's own message where he wrote it; --channel "<reason>"
                                       posts in the channel with the reason on the card; none found: ASK_THREAD_REQUIRED
                                       (exit 2), nothing posted
  questions [--open]                   list tracked question cards
  reopen <Qn> / resolve <Qn> [--answer TEXT]
                                       put a card's buttons back / forget a settled question; a card still open (the
                                       owner answered in text) folds into its record with TEXT as the answer
  handover --approved-by REF [--note FILE] [--title T] [--model M] [--keep-old] [--no-monitors] [--minutes N] [--dry-run]
                                       move the lead to a new session (omo on aoe or herdr): write a note (open lanes, the old
                                       session's running monitors, open question cards, todos, timers, the owner's
                                       messages of the last 24 h from the inbox, the old log's path, --note: the old lead's
                                       summary under the headings of handover --template), open the new session on it,
                                       point leadPane, dori.env DORI_LEAD_*, the lanes and the cards at it, restart
                                       handover.services, then check that its monitors run, that a [REPORT] probe and an
                                       inbox probe are acked from it, and that its restatement (HANDOVER_UNDERSTAND) names
                                       every open lane, card and timer, the owner's words and the summary's decisions and
                                       follow-ups; what it leaves out is sent back with the old log lines behind it
                                       (HANDOVER_SUPPLEMENT, up to handover.supplementRounds rounds). Only then is the old
                                       lead frozen (SIGSTOP on its agent and children, HANDOVER_OLD_FROZEN, HANDOVER_DONE) and
                                       closed handover.frozenCloseH hours later by freshness; a failed check moves everything
                                       back and freezes nothing (HANDOVER_VERIFY_FAIL, exit 3). Run from inside the lead it
                                       detaches itself (systemd-run)
  handover frozen | thaw <pane> | close-frozen [<pane>]
                                       list the frozen old sessions (leads, and lanes kept for the work their monitors
                                       started); resume one frozen by mistake; close one now, or every one whose close time
                                       passed or whose monitors' work ended (its log stays)
  handover audit <note.md|key|lead> [--dry-run] [--no-send] [--force]
                                       the audit after a committed handover (freshness starts it handover.auditAfterMin
                                       after the commit): the owner's quoted words and recent lead instructions only the
                                       old conversation held (a reviewer sorts them: standing, done, chatter), and the
                                       todos, goal and monitors the new session lacks; one line per gap in
                                       <stateDir>/handover/audit.jsonl, sent once as HANDOVER_SUPPLEMENT (HANDOVER_AUDIT)
  handover gap <key|lead> --kind K --text T [--fixed]
                                       record what a session found later that its handover did not carry (HANDOVER_GAP)
  handover audit-summary [--days N] [--send]
                                       the audit ledger summed up; --send puts it in the lead's inbox (freshness does it
                                       each week after handover.auditSummaryAt)
  handover --template                  print the headings of the old lead's summary (--note FILE)
  handover ack <id> [--state DIR]      the new lead answers a HANDOVER_PROBE, HANDOVER_UNDERSTAND or HANDOVER_SUPPLEMENT line with this
  handover --lane <key> --approved-by REF [--note FILE] [--model M] [--thinking L] [--force] [--keep-old] [--minutes N] [--dry-run]
                                       move a lane to a new session (run by the lead): REF is lead:<reason and the signal behind
                                       it> (the lead decides; the owner gets a line afterwards, its message id goes to the
                                       log, ROLLOVER_OWNER_REPORT_MISSING when it cannot be sent), or the owner's answered card
                                       Qn or message link, kept in the note and log: refuses while a local chain of the
                                       lane's agent or eval kernel (not the session's own launcher shell or idle kernel), a
                                       background eval cell, a running turn or an open question would die, unless the lane
                                       ran handover ready (or --force); a lead's or owner's request refused that way waits
                                       (HANDOVER_PENDING): the lane is asked for its safe point and freshness starts it again
                                       by itself; a run that finds a waiting run of the lane makes it step aside and moves
                                       the lane itself (HANDOVER_TAKEN_OVER); an automatic start (auto:) never moves a lane that
                                       runs or watches a training or eval chain (handover.trainingTags, trainingWatch);
                                       --wait-idle MIN (freshness's automatic start): waits up to MIN minutes for a running
                                       turn to end and freezes the old agent at that idle moment, before the new session opens;
                                       under the lane's lock an automatic run gives way to a lead's waiting request
                                       (HANDOVER_YIELDED); --request-at AT --request-pane PANE (freshness's start again of a
                                       waiting request): moves only while that request still waits in PANE (HANDOVER_REQUEST_GONE);
                                       writes a note (brief, owner goal, Done, the owner's messages since the last handover, todos, goal,
                                       monitors, local chains, detached jobs, last reports, model and thinking), opens a
                                       session in the same real path with --model and --thinking, points the registry and
                                       cards at it, checks its status line, monitors and a [LEAD] probe ack, then closes the
                                       old session (HANDOVER_DONE); a failed check moves back and closes the new one (exit 3);
                                       a run killed midway is repaired by the next run for that lane (HANDOVER_RECOVERED)
  rollover-propose <lead|key> [--dry-run]
                                       the rollover proposal for the lead to decide: handover.proposalText with the length
                                       signals, the thresholds crossed, the lane's stuck rung and the note a dry-run handover
                                       writes (ROLLOVER_PROPOSAL), logged to <stateDir>/rollover-log.jsonl; then run the
                                       handover with --approved-by "lead:<reason and signal>" (or "lead:<reason>,
                                       owner <message id>" when the owner asked for it: checked against the inbox)
  compaction-trial [--json]           the early-compaction trial (config compactionTrial): each arm's lanes and their
                                       context per call, calls >= 300k, tokens and usage per lane, compactions (fallback),
                                       re-reads per compaction, lead not-done and fix attempts, from the session logs;
                                       the daily rows freshness wrote are in <stateDir>/compaction-trial/daily.jsonl
  rollover-stats [--window H] [--stuck]
                                       proposals and rollovers from the log: signal values, approval time, each step's time
                                       and result, and the lane's watch-log quality signals H hours (24) before and after;
                                       then STUCK_OUTCOMES: stuck (rung 4) rollovers, resolved / not resolved / unknown, and
                                       one STUCK_ROLLOVER line each with the lane's own words. --stuck prints only that, for
                                       this Dori and each handover.statsPeers Dori
  handover ready [<key>] --note FILE   run by a lane in its own pane at a safe point: the local chains running now may end
                                       with the old session; FILE is the lane's conversation summary (its headings: handover
                                       ready --template) and goes into the note (valid handover.readyMin minutes)
  thread open <title> [--from MSG_ID] [--first TEXT] [--session S]
                                       open and map a work thread; standalone threads require --first. The directive
                                       ledger is read first against the title, first message and owner's message:
                                       THREAD_DIRECTIVES and one line per directive; unreadable: THREAD_REFUSED, nothing opened
  thread map discord:<id> <session|none>
                                       set the mapped session, preserving the title
  thread list                          print mapped thread ids, sessions and titles
  thread set discord:<id> working|waiting|done|standing|unstanding [--open-card]
                                       queue its status; done archives it and removes its mapping
  thread <reply|wait|done> discord:<id> <text> | --text-file FILE [--file PATH ...]
                                       post in a work thread and set its status (working, waiting, done); done archives it
                                       (Discord env: DORI_DISCORD_TOKEN, DORI_DISCORD_GUILD, DORI_DISCORD_CHANNEL, DORI_DISCORD_OWNER)`;
