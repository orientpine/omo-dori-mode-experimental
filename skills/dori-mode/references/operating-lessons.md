# Operating lessons

Things that went wrong, or nearly did, while running a Dori every day, and what to do instead. Each one names the behavior of the scripts that causes it, so you can check it still holds.

## 1. A done claim closes the lane: do not give it more work afterwards

When a lane runs `dori claim-done`, `dori watch` waits out the close window (`closeAfterMin`, 5 minutes by default), reads every `Done =` signal back, and when they all hold it closes the lane: the thread is marked done, the aoe session or herdr tab is closed, and the lane's worktrees are removed. An instruction you send the lane after its claim is lost with the session, and the follow-up has to start as a new lane.

If you want the lane to do one more thing after it claimed:

- run `dori object-done <key> --reason "<the extra item>"` first, inside the window. The lane goes back to not-done and gets `[LEAD] not done: ...` in its pane; send the extra instruction after that, and it claims again when finished;
- or, when you launch it, give the lane a `Done =` signal that already checks the extra item, so a claim made before it is ready is turned into not-done instead of closing.

## 2. Pausing a lane that waits on the owner

`dori freshness` nudges every lane whose status is `working` and has been silent too long, and posts its last report to the thread. For a lane that is deliberately waiting on an owner decision, that repeats a ping nobody can act on.

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

One-shot commands (`dori ask`, `dori launch`, `dori send`, ...) use the new code at once. Long-running processes do not: they keep the code they started with until restarted. Restart each unit whose code changed and check its log for its ready line:

```sh
systemctl --user restart dori-lanes            # watch, freshness, dead-panes, guard
systemctl --user restart dori-inbound          # the Discord listener
systemctl --user restart dori-session-watch
```

Skipping the restart is easy to miss: merged fixes then sit unused in a loop that still runs the old code, for as long as nobody restarts it.

## 7. Replacing a listener: shadow first

To swap one inbound listener for another, run the new one as a shadow that writes only to its own inbox file and never to the messenger, compare the two inboxes id by id in a written table, then switch in one command that stops the old one before starting the new one, so the two never receive live at the same time, and keep the one-line rollback ready. The full procedure with the checks is in [`../setups/discord-aoe/README.md`](../setups/discord-aoe/README.md#switching-an-existing-listener-over).
