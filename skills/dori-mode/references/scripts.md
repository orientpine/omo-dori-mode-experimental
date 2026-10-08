# Scripts

`scripts/` is a bun + TypeScript package with one CLI, `dori`. Every external command runs as an argv array; nothing builds a shell string.

## Install and test

```sh
cd skills/dori-mode/scripts
bun install          # dev dependencies only (types, tsc)
bun link             # puts `dori` on your PATH
bun test             # behavior tests with fake herdr/git/gh; nothing real is touched
bunx tsc --noEmit    # typecheck
```

Needs: bun 1.3+, herdr, git, and the GitHub CLI (`gh`) for `merged`/`closed` signals (npm for `published`). The `command`, `file` and `url` signals need nothing extra. The full list of signal kinds is in `sessions.md`. The host guard reads `sysctl`, `memory_pressure` and `df` on macOS; on Linux it reads `/proc/loadavg` and `df`, and memory and swap read as unknown.

## Configuration

`~/.dori/config.json` (or the path in `DORI_CONFIG`). Every field is optional; see `config.example.json`. `DORI_STATE_DIR` and `DORI_LEAD_PANE` override the file.

| Field | Default | Used by |
|---|---|---|
| `backend` | `herdr` | every pane command; `aoe` runs lanes as aoe/tmux sessions (below) |
| `stateDir` | `~/.dori/state` | registry, heavy slots |
| `laneWorkspace` | current workspace | `launch` |
| `workspaces` | all | `sync`, `dead-panes` |
| `ignorePanes`, `leadPane` | none | panes the sweeps skip; `leadPane` is also where lanes report |
| `defaultCwd` | home | where lanes start, and the repo whose worktrees they own |
| `agentCommand`, `defaultModel`, `launchKeywords` | `omo --model {model} {prompt}` | `launch` |
| `sessionsDir` | `~/.omo/agent/sessions` | session-id lookup |
| `nudgeAfterMin`, `postAfterMin` | 15, 20 | `freshness` |
| `closeAfterMin` | 5 | `watch` |
| `heavySlots`, `heavyMaxLoad` | 1, 80 | `heavy` |
| `deadPanePatterns` | `has stopped`, `no suitable jobs` | `dead-panes` |
| `guard` | load 150/80, 20% memory, 50 GB disk, 20 panes | `guard` |
| `hooks.threadReply`, `hooks.threadDone` | none | `freshness`, `close` |
| `hooks.transcribe` | none | `transcribe` (argv with `{file}`, prints the text), `inbound discord` voice notes |
| `discord` | English words, `en-US`, `UTC`, `statusStyle: "words"` | `statusStyle` (`words` for `[working]`-style marks, `emoji` for 🔄 ⏸️ ✅ and ⏳), thread status words (`working`, `waiting`, `done`) and question-card wording (`other`, `pick` with `{n}` for the option number, `recommended`, `answered`, `ownerOnly`, `byButton`, `byText`), plus `locale` and `timeZone` for answer times |

Tokens and ids come from the environment. Every command first reads `~/.dori/dori.env` (or the file in `DORI_ENV_FILE`), `KEY=VALUE` per line; a variable already set wins. The Discord commands need `DORI_DISCORD_TOKEN`, `DORI_DISCORD_GUILD`, `DORI_DISCORD_CHANNEL` (the one channel the Dori talks in) and `DORI_DISCORD_OWNER`.

### Backend `aoe`

With `"backend": "aoe"` lanes run as [agent-of-empires](https://github.com/njbrake/agent-of-empires) sessions instead of herdr panes. Needs `aoe` and `tmux`. What differs:

- A pane id is the session's tmux name, `aoe_<title>_<first 8 of the aoe id>`; `leadPane` and `ignorePanes` take these names. Panes are the live sessions in `aoe list` that have a tmux session; `aoe_term_*` terminals and stopped sessions are not panes. `workspace_id` is the aoe profile, so leave `workspaces` empty or list profiles.
- `launch` runs `aoe add <cwd> -t <key> --tool <agentCommand[0]> -l --extra-args "--model <model>"`, waits up to 3 minutes for the agent's `❯` prompt, then types the lane prompt. `agentCommand`'s other arguments and `laneWorkspace` are not used. aoe refuses a title+path pair that already exists, even in its trash.
- Text goes in with `tmux send-keys -t =<name>: -l -- <text>` and a separate `Enter`, each an argv array. Only the agent's input line (the last line starting with `❯`) counts as unsent text, so the same text echoed in the transcript does not trigger extra Enters.
- `close` runs `aoe session stop <id>` and `aoe rm <id>`: the session goes to the aoe trash and can be restored. It is never purged.
- The session id comes from the agent's `--session-id` argument (aoe passes one to omo), found under the tmux pane's pid; the environment and session-file rules follow as with herdr.
- `claim-done` without a key finds the lane by the tmux session it runs in. `guard` and `can-launch` count aoe sessions as panes.
- `watch` also reads `aoe ps --json` and the lane screens and prints `LANE_BLOCKED <key> <state> <pane>` for a working lane whose agent waits for a human (see `dori watch` below).
- `launch` reports `STARTUP_ERROR` with the agent's own message as soon as a startup error or `Pane is dead` shows while it waits for the prompt.

Hooks are argv templates for your messenger CLI. `{thread}`, `{text}` and `{key}` are filled into each argument separately, so the text stays one argument whatever it contains.

## Library modules

The CLI is a thin layer over typed modules you can import in your own scripts:

| Module | What it gives you |
|---|---|
| `src/messenger/slack.ts` | `Slack`: post, edit, thread replies, file upload (upload URL + complete), presence; 429 backoff |
| `src/messenger/telegram.ts` | `Telegram`: send, edit, typing, `sendMessageDraft` streaming with a `Thinking…` start, forum topics (create, rename, close, reopen), HTML tables |
| `src/messenger/discord.ts` | `Discord`: send without pings, edit, typing, reactions, threads (start, rename, archive); gateway presence |
| `src/messenger/discord-cards.ts` | `QuestionCards`, `QuestionStore`: post a question card (inside its work thread when given, marking the thread waiting), handle its button and modal interactions, reopen, resolve, and after an answer leave the record in the work thread and mark it working again |
| `src/messenger/discord-listener.ts` | `DiscordListener`: the gateway listener behind `dori inbound discord` |
| `src/messenger/discord-thread.ts` | `threadHook`, `setThreadStatus`: the Discord thread hooks |
| `src/messenger/typing.ts` | `typingWhile`: show typing while a piece of work runs, stop when it ends |
| `src/messenger/voice.ts` | `transcribe`: voice note to text through your hook |
| `src/messenger/thread-ledger.ts` | `ThreadLedger`: every thread the Dori posts in, persisted; given to `Slack`, it records each `chat.postMessage` (also raw `call`s) |
| `src/messenger/slack-inbound.ts` | `pollSlackInbound`: threads view, the ledger's threads and unread counts, deduplicated, own messages filtered |
| `src/messenger/slack-presence.ts` | `slackPresence`: hold a user account active |
| `src/routing.ts` | `canLaunch`, `idleLaneFor`: the routing checks |

Every module takes its HTTP, clock and timers as arguments. That is how the tests run without the network.

## Commands

### `dori launch <key> --title T --brief FILE --done "..." [--thread REF] [--model M] [--cwd DIR]`
Opens a lane: appends the footer to the brief, opens a tab, starts the agent, and checks the pane for startup errors after 20 seconds. Exit 3 on `STARTUP_ERROR`.

### `dori adopt <key> --pane ID --title T --brief FILE --done "..." [--thread REF]`
Registers a lane that is already running.

### `dori sync [--write]`
Prints `key | thread | pane | session | status` for every open lane and every unregistered agent pane, followed by drift. Read-only unless `--write`, which stores session ids.

### `dori claim-done [<key>] --evidence TEXT` / `dori object-done <key> --reason TEXT ...`
The two halves of the done flow. Both message the lane's pane and check that Enter registered.

### `dori close <key> [--note TEXT]`
Closes a lane now. Refuses (exit 2) unless every `Done =` signal reads back live. On success it marks the thread done through `hooks.threadDone`, closes the tab, and removes the lane's worktrees with a plain `git worktree remove`, which refuses a dirty worktree.

### `dori watch`
Runs forever. Every 30 seconds it prints each new claim once (`LANE_DONE_CLAIMED`). Claims older than `closeAfterMin` are settled: unpushed or uncommitted work and failing signals turn into objections (`LANE_NOT_DONE`); otherwise the lane is closed (`LANE_CLOSED`). The deadline lives in the registry, so a restart picks up where it left off.

With backend `aoe` it also prints `LANE_BLOCKED <key> <state> <pane>` once each time a working (or not-done) lane's agent stops for a human. Unless the screen shows a running turn (`esc to interrupt`), `state` is `waiting` or `error` when `aoe ps --json` says so, `question` when omo's question UI (`Ask user ·`, `(0/1 answered)`) is on screen (aoe shows that as `idle`), and `idle` once the turn has stayed ended for 45 seconds. A lane waiting on something that will wake it is not idle: its status line shows a monitor (`◉ watching`), wake sources on duty (`wake source`), a scheduled goal continuation (`goal continues in`) or an active goal (`Pursuing goal`). The state is kept in the lane's `blocked` and `idleSince` fields, so a restart does not repeat the line; when the lane runs again they clear and the next block is reported again. If `aoe ps` fails, the tick prints `LANE_WATCH_WARN blocked check: ...` and the done flow still runs.

### `dori freshness [--loop MIN]`
For working lanes that have gone quiet: a nudge in the pane after `nudgeAfterMin`, then the lane's last `[REPORT]` line posted to its thread after `postAfterMin`, with home paths and pane ids scrubbed. Each happens once per silence.

Lanes send `[REPORT]` lines to the lead pane, so the report is read from the last 3000 lines of `leadPane` first and from the lane's own screen second. A report the agent UI wrapped over several lines is joined up to the next blank line. A report that differs from the last one seen (kept in the lane's `lastReport`) counts as hearing from the lane and starts a new silence. Output lines: `NUDGED`, `NUDGE-FAILED` (the text stayed in the pane's input), `POSTED`, `NO-REPORT`.

### `dori dead-panes [--loop MIN]`
Prints `DEAD_PANE <id>` once per hour for a pane whose last lines match `deadPanePatterns`.

### `dori guard [--loop MIN]`
Prints `HOST_GUARD ALERT <reasons>` when load, free memory, free disk or the pane count crosses its threshold, and `HOST_GUARD CLEAR` when it recovers. It also prints `COMPUTE_READY` / `COMPUTE_BUSY` as load crosses `loadOk`. Only changes are printed.

### `dori can-launch`
Prints `CAN_LAUNCH` and exits 0 when the host has room for another lane. Otherwise it prints `HOLD <reasons>` and exits 4. The reasons come from the guard's memory, disk and pane-count thresholds. CPU load alone never holds a launch, because it moves too fast to plan around.

### `dori send <slack|telegram|discord> --to TARGET --text TEXT [--thread ID] [--edit ID]`
Posts a message, or edits one with `--edit`. Tokens come from `DORI_SLACK_TOKEN` (plus `DORI_SLACK_COOKIE` for a user token), `DORI_TELEGRAM_TOKEN` or `DORI_DISCORD_TOKEN`. Text containing `$(` is refused, since it can only come from a shell string. Rate limits are retried with the server's wait time; other errors fail at once.

### `dori presence <slack|discord>`
Keeps the account shown as online until stopped.
- **Discord:** the bot connects to the gateway and identifies as online.
- **Slack, user token:** it opens one web-client-type socket and tickles it every minute. Slack shows a user active only while such a socket is open, and auto-aways an idle one after about 30 minutes.
- Run one instance per account. Two writers flip each other's presence.

### `dori inbound slack [--loop MIN]`
Prints `INBOUND <source> <channel> <thread> <ts> <user> <text>`. It reads from three places, each message once:
- `threads-view`: unread replies in threads the account follows (Slack's own Threads view);
- `own-thread`: new replies in any thread the Dori posted in, tagged or not;
- `unread`: DMs, group DMs and channels with unread mentions.

The Dori's own messages and bot messages are skipped. Every message the Dori posts records its thread in `<stateDir>/slack-threads.json`, whichever helper sends it, so a guest's untagged reply under a root posted with a raw API call is still found.

### `dori inbound discord`
Runs until stopped (run it as a service, see `setups/discord-aoe/`). It connects to the gateway with the message-content intent and handles:
- the owner's messages in `DORI_DISCORD_CHANNEL`, its threads, and DMs; everyone else, bots included, is skipped. Each gets the eyes reaction at once, a voice note is transcribed through `hooks.transcribe`, and one row is appended to the inbox file (`DORI_DISCORD_INBOX`, default `<stateDir>/discord/inbox.jsonl`) and printed as `INBOUND discord-<scope> <channel> <id> <author> <text>`;
- question-card taps and write-my-own submissions (below), appended as `kind:"answer"` rows and printed as `ANSWER <Qn> <kind> <answer> thread=… session=… tmux=…`;
- after each reconnect, the owner's messages it missed in the channel and its active threads, oldest first;
- an owner message in a done thread (✅ or `[done]`) reopens it: the thread is unarchived, marked working, and `THREAD_REOPENED <thread>` is printed.

A rejected token or a missing intent stops it (exit 3, or 4 for a disallowed intent); other disconnects retry with backoff up to a minute.

### `dori ask --text Q --option A [--option B ...] [--thread REF] [--session ID] [--tmux NAME]`
Posts a question card, pinging only the owner, and prints `ASKED <Qn> message=<id>`. With `--thread` the card goes inside that work thread and the thread is marked waiting (`[waiting]`, or ⏸️ with emoji status); without it the card goes to `DORI_DISCORD_CHANNEL`. Each option is shown in full as a numbered line with a short pick button beside it, and the first option's button is the highlighted one, so put your recommendation first; a write-my-own button that opens a text box is added last (1 to 9 options). `--thread`, `--session` and `--tmux` travel with the answer so you know where to relay it. Only the owner's answer counts: the card folds into `[answered] <Qn> … → <answer>` (`✅ <Qn> …` with emoji status) in the interaction response, the answer is appended to `<stateDir>/discord/answers.jsonl`. A card inside its thread is that thread's record; a card in the channel for a thread also leaves a silent record line in the thread. Once no question in the thread is open, the thread is marked working again (🔄). The listener takes taps from the channel and from the thread a card was posted in, and must be running to receive them. A failed thread rename is printed as `THREAD_STATUS_FAIL <thread> <error>` and does not fail the card.

### `dori questions [--open]` / `dori reopen <Qn>` / `dori resolve <Qn>`
List tracked questions; put a card's buttons back where it was posted (when a typed answer was not really an answer), marking its thread waiting again; forget a question once its follow-up is done. The folded card stays in the chat as the record.

### `dori thread <reply|wait|done> discord:<thread id> <text>`
A ready `hooks.threadReply` / `hooks.threadDone` for Discord: `["dori", "thread", "reply", "{thread}", "{text}"]`. It shows typing, posts the text with emoji removed, and sets the status mark at the start of the thread name: `reply` working, `wait` waiting, `done` done. `done` archives the thread; the others unarchive it. Nothing is renamed when the mark already holds, because Discord allows only about two renames per ten minutes.

### `dori send discord --to <thread> [--edit <id>] --status working|done --text <text>`
Writes the text as the progress message in `discord.statusStyle`: `working: <text>` / `done: <text>`, or `⏳ · <text>` / `✅ <text>` with emoji.

### `dori transcribe <audio-file>`
Runs `hooks.transcribe` and prints the transcript. A failed or empty transcription is an error, never an empty message.

### `dori heavy <label> -- <command ...>`
Waits until load is under `heavyMaxLoad` and one of `heavySlots` is free, then runs the command and frees the slot when it exits. A slot held by a process that no longer exists (or a zombie) is taken over. Use it for full builds and test suites. Installs, focused tests and git do not need it.
