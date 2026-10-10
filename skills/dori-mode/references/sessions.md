# Sessions (lanes)

A lane is one agent session doing one job in its own herdr tab, or its own aoe session with `backend: "aoe"` (see "The aoe backend" below). You launch it, track it in the registry, answer it when it is stuck, and close it when its work is proven done.

## Launching

```sh
dori launch fix-login --title "Fix the login redirect loop" \
  --brief ~/briefs/fix-login.md --done "merged acme/app#412; closed acme/app#398" \
  --thread "telegram:<chat>/<topic>" --model anthropic/claude-opus-5-5
```

`launch` checks the key and the `Done =` line, appends a footer to the brief, opens a tab in `laneWorkspace`, starts the agent, and after 20 seconds reads the pane for startup errors (missing module, no API key, rate limit, quota). On `STARTUP_ERROR`, relaunch on another model.

Write the brief like a careful prompt:

- open with the keywords you would type yourself (for example `ulw set goal and work`);
- where the code is and what has been learned so far;
- the ideal end state, from the point of view of whoever uses the result;
- what not to touch;
- how and when to report;
- when the lane makes or changes a yardstick (a metric, a threshold, a pass/fail check), one line on how that yardstick could get better while the real goal gets worse;
- that a blocker, an impossible task or an ambiguous request is a fine report (`| blocker |`), not a failure to hide;
- a retry cap: after a set number of failed attempts at the same step (two or three), report a blocker instead of trying again.

**Why the `Done =` line has to be checkable:** the watcher closes lanes on its own, so it can only trust what it can read back itself. `launch` and `adopt` refuse any signal outside this list. Signals are joined with `;`, and every one has to pass.

| Signal | Passes when |
|---|---|
| `merged <owner/repo>#N` | the PR is merged and has a merge commit |
| `closed <owner/repo>#N` | the issue is closed |
| `published <pkg>@<version>` | npm has that exact version |
| `command ["argv","as","json"] [stdout~"regex"]` | the command exits 0 when the watcher runs it, and stdout matches if a regex is given |
| `file <path> [sha256=<hex>] [json:.a.b=<json value>]` | the file exists, its sha256 matches, and the JSON field equals the value |
| `url <http(s) url> [status=200] [body~"regex"]` | a GET returns that status, and the body matches if a regex is given |

The last three are for work that never lands as a PR: a local setup, a QA pass, a running service. Write the check so that it can fail. `command ["bun","test"] stdout~" 0 fail"` is a real check, while `command ["true"]` checks nothing. The watcher runs commands itself, in the lane's directory, as a plain argv with no shell. They have a 2-minute limit. It never trusts the lane's own report that something passed. Relative file paths resolve from the lane's directory, and `~` is your home. JSON values compare as JSON, so `json:.n=3` and `json:.n="3"` are different checks.

Example for a QA-only lane:

```
Done = command ["bun","test"] stdout~" 0 fail"; file qa/report.json json:.passed=true; url http://localhost:3000/health body~"ready"
```

Work no script can check (a design review, a judgement call) stays in the lane's own plan. You judge it yourself before the claim.

**Measure behavior, not files.** A Done line that only proves files exist or contain some text lets a lane pass without the thing working. `launch` prints `LAUNCH_DONE_WEAK <key>: ...` when every signal is a `file` signal or a command that only reads files or text (`grep`, `test`, `cat`, `ls`, `wc`, `jq` and the like, given directly, through `sh -c`, or in a shell script it can read). Add at least one signal that runs the thing: its tests, a command that exercises it, a `url` with the expected status and body. The lane still launches; pass `--done-weak-ok` when a file really is the deliverable (a report, a dataset).

## Repeated fixes

Fixing the same symptom again and again on the same idea burns tokens without moving. A lane tags a report that is a fix attempt with `(fix: <metric> / <hypothesis>)`, e.g. `[REPORT] e7 | milestone | raised the reward again (fix: deadlock count / reward too small)`. When you re-instruct a lane to fix something, record it yourself:

```sh
dori fix-attempt e7 --metric "deadlock count" --hypothesis "reward too small"
```

From the third attempt on one metric with one hypothesis (`sameFix.after`, default 3), `dori freshness` prints `SAME_FIX_3 <key> attempt N on "<metric>" with the same hypothesis "<hypothesis>": ...` (and `fix-attempt` prints it too). Counting is conservative: only tagged reports and recorded re-instructions count, metric and hypothesis must match (case and spacing aside), a report read again is not a new attempt, and a fix you asked for that the lane then reports counts once. Then tell the lane to stop patching and find the root cause, by reproducing the failure and reading the logs. With `sameFix.sendToLane: true` that note (`sameFix.laneText`) goes to the lane automatically; by default only you are told. The lane is never stopped.

Before you re-instruct a lane, read its record: `dori signals --lane <key>` (or `--cwd <repo>`, `--tag <topic>` for the whole area). It lists the numbered attempts the lane and you already made ("adjustment 1" .. "adjustment 4", read from the `[REPORT]` lines and your messages to it), whether and when the work switched to a root-cause hunt, the fixes by metric and hypothesis, rejected done claims with their reasons, and how often you re-sent or the sweep nudged. A fix on that list is not a new idea; after two failed patches on one metric, ask for the root cause instead of a third. `dori fix-attempt` prints the same per-metric list (`PRIOR_FIX`) before it records, and `dori launch` puts a short version into a new lane's brief as "Past signals" so the next lane in that repo or topic starts from it.

## The registry

One JSON file per lane under `<stateDir>/lanes/`, written atomically (temp file + rename), so two writers never leave a half-written file. Each lane records:

| Field | Meaning |
|---|---|
| `thread` | where its updates go, as `platform:thread` (or `none`) |
| `pane`, `tab` | its herdr location; with aoe, `pane` is the session's tmux name (`aoe_<title>_<first 8 of the id>`) and there is no tab |
| `session` | the agent's own session id, so a closed job can be reopened later |
| `status` | `working`, `done-claimed`, `verified-done`, `not-done`, `closed` |
| `claim`, `objection`, `history` | what was claimed, what was objected, every status change |

`dori sync` compares the registry with live panes and prints drift (a pane that is gone, a session id that changed, an empty `Done =` line). It never deletes anything. With `--write` it stores the session ids it found.

How the session id is found for a pane, in order:

1. the agent process's `--session <id>` argument;
2. `PI_SESSION_ID` in the environment of one of its child processes;
3. the session file whose timestamp falls within three minutes after the agent process started.

The id from step 1 is the session the agent was launched with. If someone switches sessions inside the agent, only steps 2 and 3 notice.

When the owner writes in a closed lane's thread, reopen its recorded session in a new tab, set its monitors again, and keep replying there.

## Messaging a session

Before you type into a pane:

1. check it runs a live agent (`herdr pane process-info --pane <id>`), not a shell, a stopped agent or a startup screen;
2. read it (`herdr pane read <id> --source recent-unwrapped --lines 40`) and confirm the input line is empty and no approval or question prompt is open;
3. send once, as one argument (the scripts' `sendVerified` does this);
4. read the pane again: if your text is still on the input line, press Enter again, then re-check.

Exit code 0 and echoed input are not proof the agent got the message. A reply from the session, or its record of handling the message, is.

With aoe the same steps read: `aoe ps --json` shows the session's state (`waiting` means a question or approval is open), `tmux capture-pane -p -J -t =<name>:` reads it, the input line is the last line starting with `❯`, and text goes in with `tmux send-keys -t =<name>: -l -- <text>` followed by a separate `Enter`. The `=` and trailing `:` make tmux match the exact session name; an empty name would hit whatever pane you are in.

## Watching

- Sessions that turn blocked or ask a question: answer them or bring them to the owner.
- Sessions that report a bug: reproduce it before it counts, then give it its own thread.
- `dori dead-panes` reports agent panes that stopped; restart the session in place (`<agent> --session <id>`) unless its work is finished.
- With aoe, `dori watch` also prints `LANE_BLOCKED <key> <state> <pane>` once each time a working lane's agent stops for a human. `state` is `waiting` or `error` (from `aoe ps --json`), `question` (omo's question UI is open on screen; aoe shows that as `idle`), or `idle` (the turn ended and stayed ended for 45 seconds, and nothing is set to wake it: no `◉ watching` monitor, `wake source`, `goal continues in` or `Pursuing goal` on its status line). It never fires while the screen shows a running turn (`esc to interrupt`): aoe's state lags behind omo, so the screen decides.

## The aoe backend

Set `"backend": "aoe"` in `~/.dori/config.json` to run lanes as aoe (agent-of-empires) sessions on tmux instead of herdr tabs. Everything above holds; these parts differ:

- **Launch** runs `aoe add <cwd> -t <key> --tool <agentCommand[0]> -l --extra-args "--model <model>"`, waits up to 3 minutes for the agent's `❯` prompt, then types the lane prompt and checks it left the input line. The aoe title is the lane key. aoe refuses a title and path pair that already exists, even in its trash; `aoe rm <id> --purge` clears it.
- **Pane ids** are tmux session names. `dori adopt <key> --pane aoe_<title>_<id8>` registers a running session; `tmux ls` lists them (`aoe_term_*` are plain terminals, not agents).
- **Reports.** The footer tells the lane to send `[REPORT]` lines to the lead's tmux session as two argv calls (`send-keys -l -- <line>`, then `Enter`). The report lands in the lead's pane, not the lane's, so `dori freshness` reads the lead pane (last 3000 lines) first and the lane's screen second. A report it has not seen before counts as hearing from the lane.
- **Claim from inside a lane.** `dori claim-done` without a key finds the lane by the tmux session it runs in.
- **Close** stops the session (`aoe session stop`) and moves it to the aoe trash (`aoe rm`), where it can still be restored. It never purges.
- **Blocked lanes** come from `aoe ps --json` plus the screen check, as `LANE_BLOCKED` lines from `dori watch`.
- **Startup errors.** An agent that exits at once (a bad model name, a missing module) leaves a dead pane with no prompt; `launch` reports its message as `STARTUP_ERROR` as soon as it is on screen instead of waiting out the 3-minute prompt timeout.
