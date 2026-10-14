# Lane done protocol

Give this file to every lane you launch.

When your lane's `Done =` signals are live and every change is pushed, claim done from your own session. The signals might be a PR merged, an issue closed or a version published. For local or QA-only work they can also be a command that passes, a file with the expected content, or a URL that answers (see `sessions.md`). Run them yourself first: the watcher re-runs every one and never takes your word for it.

```sh
dori claim-done <your-lane-key> --evidence "<merge SHA, closed issue, version, links>"
```

The key is in your brief's lane footer. If you leave it out, the lane registered for your pane is used.

## What happens next

1. The Dori gets a `LANE_DONE_CLAIMED` event, and you get a `[LEAD]` line saying when the lane closes.
2. Stay idle and start no new work.
3. If the Dori does not object within 5 minutes, the watcher closes the lane. Before closing, it reads back every `Done =` signal live. It refuses to close if any of your worktrees still has uncommitted tracked changes, or commits that are on no remote.
4. Closing marks your thread done (through the thread hook, and with a Discord token also by renaming the thread to its done mark and archiving it), unless another open lane or an open question card still uses the thread: then your result is only posted there and the thread keeps its status. It closes your tab, and removes your worktrees. A lane with no usable thread ref gets `THREAD_MISSING <key>` instead of a silent skip; the lead fixes the ref with `dori set-thread <key> <adapter>:<id>`.

If the lead has paused your lane (`dori pause`, e.g. while it waits on the owner), your claim is recorded but nothing closes on a timer; you get a `[LEAD]` line saying so, and the lead closes the lane or objects.

## Reporting honestly

- A blocker, an impossible task or an ambiguous request is a fine report: `[REPORT] <key> | blocker | <what blocks, what you tried, what you need>`. Say it plainly instead of retrying or claiming done.
- Cap your retries: after two or three failed attempts at the same step, report a blocker.
- Evidence is the real thing: the real screen, the real call, the real output, with a capture, output or file path for [끝난 상태] and for each QA item. A passing test suite alone does not show the result works; keep the repository's tests green as well, and for a code change show with a mutation that they catch the bug.
- Step 6 of the brief (back to a new plan until [끝난 상태] holds) does not reset the retry cap or the stuck ladder: they count failed attempts per metric, whatever the plan.
- Inside your brief's [넘으면 안 되는 선], proceed without asking: plan approval is given in advance. Report a `| question |` only to cross a line or for a choice only the owner can make.
- Tag a report that is a fix attempt for a failing check or metric with `(fix: <metric> / <hypothesis>)`. The lead's stuck ladder counts failed attempts on one metric (untagged ones too): at the 2nd, competing hypotheses before the next patch; at the 3rd you get ulw research and a challenge of your next plan; with one hypothesis tried 3 times after you branched, or a failure after the research, the lead may move you to a new session. Stop patching, reproduce the failure and read the logs for the root cause.
- If your brief has a "Past signals" section, read it before you plan: it lists what earlier lanes in the same repo or topic tried and what failed. Don't repeat a fix listed there without a new reason.
- When you make or change a yardstick (a metric, a threshold, a check), write one line on how it could get better while the real goal gets worse.

## If the Dori objects, or a check fails

You get `[LEAD] not done: <reasons>; keep working, claim again when fixed` in your pane, and the lane goes back to not-done. This happens when:

- the Dori objects;
- a `Done =` signal does not read back live;
- there is unpushed work (the reason names the path).

Fix every reason, then claim again. A new claim starts a fresh 5-minute window.
