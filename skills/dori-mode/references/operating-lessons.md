# Operating lessons

Things that went wrong, or nearly did, while running a Dori every day, and what to do instead. Each one names the behavior of the scripts that causes it, so you can check it still holds.

## 1. A done claim closes the lane: do not give it more work afterwards

When a lane runs `dori claim-done`, `dori watch` waits out the close window (`closeAfterMin`, 5 minutes by default), reads every `Done =` signal back, and when they all hold it closes the lane: the thread is marked done, the aoe session or herdr tab is closed, and the lane's worktrees are removed. An instruction you send the lane after its claim is lost with the session, and the follow-up has to start as a new lane.

If you want the lane to do one more thing after it claimed:

- run `dori object-done <key> --reason "<the extra item>"` first, inside the window. The lane goes back to not-done and gets `[LEAD] not done: ...` in its pane; send the extra instruction after that, and it claims again when finished;
- or, when you launch it, give the lane a `Done =` signal that already checks the extra item, so a claim made before it is ready is turned into not-done instead of closing.

## 2. Pausing a lane that waits on the owner

`dori freshness` nudges every lane whose status is `working` and has been silent too long, and posts a short status line to the thread. For a lane that is deliberately waiting on an owner decision, that repeats a ping nobody can act on.

Pause it instead: `dori pause <key> "waiting on the owner's decision about X"`. The lane's status becomes `paused` and the reason goes into its history. From then on freshness neither nudges nor posts for it, `dori watch` reports no `LANE_BLOCKED` for it, `dori dead-panes` skips its pane, and a done claim it makes is announced (`LANE_DONE_CLAIMED_PAUSED`) but does not close it on a timer. When the owner answers, `dori resume <key>` puts back the status it had (working or not-done) and restarts its silence clock. Don't edit the registry file by hand for this any more.

## 3. A new lane thread starts with what it is for

A thread that only shows the lane's title and nothing else looks abandoned to the owner, especially when the lane reports only to the Dori's own pane. When you open a lane's thread, make its first post say in a line or two what the lane is doing and why. Post the lane's important reports (milestones, blockers, the done result) in that thread too, not only in your pane.

## 4. Replacing a question card that was never answered

If a card becomes moot before the owner taps it (you asked a better question, or the lane decided itself), run `dori resolve <qid>`. Besides forgetting the question, it returns the card's thread from waiting (⏸️) to working (🔄) when no other card in that thread is still open. Without it the thread keeps showing that it waits on the owner.

## 5. Two Dori bots in one channel: no eyes on the other bot

The eyes reaction promises "I read this and will answer". When two Doris share a pair channel (`DORI_DISCORD_PAIR_CHANNEL`, `DORI_DISCORD_PAIR_BOT`), the other Dori's posts arrive as `pair-bot` rows: information, not requests. The listener puts no eyes on them, because an eyes reaction that is never followed by an answer only confuses the people reading the channel. The owner's own messages in the pair channel still get eyes.

## 6. Applying an update to the scripts

`dori` runs the code of its clone (`~/.dori/src`) directly. After a change is merged upstream:

```sh
git -C ~/.dori/src pull --ff-only
```

One-shot commands (`dori ask`, `dori launch`, `dori send`, ...) use the new code at once. Long-running processes keep the code they started with until restarted. Configure `update.services` with their source prefixes, logs and ready patterns, then baseline `dori update` before the next pull. After a pull:

```sh
dori update
```

`dori update` replaces the manual restarts and ready-line checks, logs new unset config keys, and tells the lead what changed. The `dori-update.path` user unit runs it automatically when the clone's checked-out branch ref changes; see the setup's "Auto-apply updates" step. `dori update --pull` combines the pull and apply. A rejected pull logs and alerts `UPDATE_FAIL` rather than silently leaving stale code running.

## 7. Replacing a listener: shadow first

To swap one inbound listener for another, run the new one as a shadow that writes only to its own inbox file and never to the messenger, compare the two inboxes id by id in a written table, then switch in one command that stops the old one before starting the new one, so the two never receive live at the same time, and keep the one-line rollback ready. The full procedure with the checks is in [`../setups/discord-aoe/README.md`](../setups/discord-aoe/README.md#switching-an-existing-listener-over).

## 8. What goes to the owner is in plain words

A lane's `[REPORT]` is a note for the lead: abbreviations, numbered items, an English head, written for someone who knows the plan. Posted as it is in the owner's thread it reads like an office memo, and the owner asked why it was written like that. Anything a script posts to the owner on its own must be in plain words, in the owner's language, and short.

- `dori freshness` posts `discord.quietText` (`{min}` = minutes since the last report) after `postAfterMin`, not the report. The report goes to the lead pane as `[DORI] <key>: ... Last report: ...`; when you see it, tell the owner where the lane stands in your own words.
- The automatic close in `dori watch` posts `discord.doneText` through `hooks.threadDone`, not `Done: <evidence>`. The evidence stays in the lane's record; sum up the result for the owner yourself.
- Set both in the owner's language, for example Korean in casual speech: `"quietText": "진행 중이야 — 마지막 보고는 {min}분 전. 정리해서 곧 알려 줄게."`.
- `discord.postRawReports: true` brings back posting the raw report and evidence. Leave it off unless the owner reads those notes directly.

## 9. Stuck on one metric: branch the explanations, do not repeat the patch

An RL lane (E7) training an excavator to dump soil into a bank kept failing on one metric: the policy picked up a load and stood still instead of dumping. The lead re-instructed it with reward patches, one after another: a dump credit, then a small reward for dumping waste in the spoil band. Each patch had a plausible story and none moved the metric. What found the cause was a forced four-way diagnosis: four competing explanations (the reward is too weak; exploration has collapsed; the critic undervalues the states after a dump; the geometry of the target makes dumping unreachable), each with one cheap test that only that explanation predicts. The exploration test answered first: the swing action's sigma had collapsed to 0.0068, so the policy could no longer try the swing that leads to a dump. Reward patches could never have fixed that.

What the scripts now do so this happens on the second failed patch instead of after many:

- `dori fix-attempt` refuses a second attempt on one metric with no improvement unless it comes with at least three competing hypotheses and one discriminating test each (`HYPOTHESES_REQUIRED`, exit 5). With them it logs `STUCK_BRANCH` and puts them into the area's hypothesis tree. `--improved` resets the count after a fix that did move the metric.
- `dori fork-explore` runs the tests side by side (GPU ones queue on the heavy slot) and prints one table; for E7 that is reward x2, a swing-sigma log, a value probe before and after a dump, and a reachability check of the dump point, all reporting the dump count.
- At the third attempt the lane is told to search outside first (`dori research-hint`: here, "policy gradient action std collapse" is a known failure mode with known remedies such as an entropy bonus or a std floor).
- The search goes through omo's ulw research, and that only starts from what is typed. omo attaches its ulw-research skill pointer only to typed input that names `ulw research`. A text that starts with a `[TAG]` such as `[LEAD]` is masked whole, and a brief that mentions the skill is not typed input. So the old `[LEAD] ... search outside` text never started it: no lane session on the host ever showed the pointer. The text now starts with `ulw research ` and the question built from the lane's records, and `dori research-check` reads the session log for the pointer (`omo-ulw-research:skill-pointer`) and a read of `ulw-research/SKILL.md` instead of trusting that the lane started.
- A read means a call that reads the file, not any call that names it. The first check counted any tool call whose arguments held `ulw-research/SKILL.md`. On a re-send in the same session the lane did not read the skill again, but it recorded a `dori tree add` finding whose text said "the session log shows ulw-research/SKILL.md was read", and the check reported `RESEARCH_STARTED`. It now counts only the `read` tool on that path, or an `eval`/`bash` call that opens the file (`Bun.file`, `readFile`, `cat`, `sed`, `head`, ...); quoting the path in a finding, an `echo` or a note does not count.
- The tree goes into every new brief for that repo, so the next lane sees "reward too small: falsified" and does not start from it again.
- Before the next expensive step (a nine-seed run), `dori challenge` gets a model of another family to argue against the plan, and `dori intent-check` compares the lane's new direction with the owner's goal in their own words, which catches a lane that has started optimizing a proxy.

## 10. The lead routes; it does not make the change itself

One day a Dori worked through a run of small requests by doing them itself: it renamed folders and the services that pointed at them, swapped a bot token in an env file, edited its agent config, and handed a few pieces to in-process child tasks. Each step was quick and each one worked. The owner still told it to stop and open a session for every job, however simple: none of those changes had a thread, a brief or a Done check, so the owner could not see what had changed or whether anyone had checked it, and while the Dori was busy editing, new messages waited.

Open a lane with `dori launch` for every change, even a one-line one, with a `Done =` signal that reads the result back. Keep for yourself only what changes nothing: reading to answer, launching, pausing and closing lanes, checking a done claim live, and messaging. A child task or subagent inside your own session is not a lane. The rule is in `SKILL.md`, "Every change goes to a lane".

## 11. The tool owns a thread's status mark

The owner asked why a thread was called "🔄 🔄 Dori ...". The lead had opened it with a title that already began with "🔄 ", and the code that opens a thread adds its own "🔄 ". On close only the first mark was swapped, which gave "✅ 🔄 ...".

- Pass a plain title. Never start it with 🔄, ⏸️, ✅, ⏳ or a `[working]`-style word.
- Every status change (reply, wait, done, a card asked or answered, a reopen, `dori close`, the automatic close) now strips all leading marks and writes exactly one, so a name that already stacked marks heals at its next status change.
- A local thread opener of your own (a `kit.ts` `openThread`) must do the same: strip every leading mark from the title before it adds one.

## 12. Tangled card answers and the rename limit

Three question cards went up in one thread in quick succession. The owner answered two by button and the third by voice in the thread, and the lead resolved that one by hand. Every ask, answer and resolve renamed the thread (⏸️ and 🔄). Discord allows about two renames per ten minutes per thread, so one rename came back 429 with `retry_after` 340 s. It was logged and dropped, and the title stayed wrong.

- Thread status renames now go through one queue per thread, persisted in `thread-status.json` next to `questions.json`. A burst becomes one rename. A 429 keeps the rename with the time Discord gave (`THREAD_STATUS_PENDING`), and `dori inbound discord` applies it then (`THREAD_STATUS_APPLIED`), also after a restart. Only a refusal that waiting cannot fix is dropped (`THREAD_STATUS_DROPPED`). A one-shot command never waits out the limit itself: it leaves the rename for the listener.
- The mark comes from the truth, not the last event: a closed lane is ✅, any open card in the thread is ⏸️, otherwise 🔄. A reply or an answer while another card is still open leaves ⏸️.
- When the owner answers in text in a thread where a card is still open, the inbox row carries `open_cards` and a `note` (`card Qn still open, owner replied in text`), and the listener prints `CARD_STILL_OPEN`. It never resolves the card on a guess. Read the reply, then `dori resolve <Qn>`. Resolving the last open card turns the thread 🔄.
- A local script that renames threads directly (a `kit.ts` `setThread`) must not retry inside the 429 window either. Write the rename to the same `thread-status.json` and let the listener apply it.

## 13. A reviewer that never writes the review

The E7 lane ran `dori challenge` on its next-run design three times and got no review each time (exit 1). The grok reviewers answered with one line, roughly "I will check the files first, then write the three sections", and stopped: the reviewer runs with no tools and one reply, the plan cited other files, and the model spent its only reply announcing that it would read them. The lane tried another model, a "this file is self-contained, write the three sections now" note inside the plan, and another working directory; none helped. The gpt and gemini reviewers failed for a different reason: their provider ids (`github-copilot/...`, `google/...`) were not logged in on that machine, and omo exits 1 with a pointer to its docs.

- The first fix (fork PR #31) told the reviewer it had no tools and retried a reply without the headings. It helped, but it treated the symptom, and a reviewer without tools thought for 3.5-7 minutes, past the old 5-minute limit.
- The root cause, found by reproducing the failure from the exact plan and tree: `omo -p` runs the reviewer as an agent, and an agent run ends at the first reply without a tool call. Given a plan that cites files and results, an agent model's habit is "announce, then read"; with `--no-tools` the announcement was the whole output (5 of 5 runs; the json event stream held nothing more, stop reason `stop`, no tool call, a few hundred tokens). Changing only `--no-tools` to read-only tools (`read,grep,find,ls`) in the plan's repository turned the same inputs into complete reviews (4 of 4, 7-8 reads each, about 3 minutes) that cite the real numbers. That is now the default; the stricter retry stays as a safety net.
- Reviewer ids are checked against `omo --list-models` and the logged-in providers before any call. A model on a provider that is not logged in is called on one that is; one no logged-in provider offers is skipped with the reason. `omo auth check` alone is not enough: it reports a subscription provider served by an extension as `not_ready` (`provider_not_found`) while its accounts are logged in, so an account that is not blocked also counts.
- The default order is the best GPT, Claude and Grok model a subscription login offers, then a second model of each. The first that writes a review wins; `--all` asks one of each family when one review is not enough.
- Check which reviewers your machine can call before you depend on one: `dori challenge --check`.
