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
4. Closing marks your thread done (through the thread hook, and with a Discord token also by renaming the thread to its done mark and archiving it), closes your tab, and removes your worktrees. A lane with no usable thread ref gets `THREAD_MISSING <key>` instead of a silent skip; the lead fixes the ref with `dori set-thread <key> <adapter>:<id>`.

If the lead has paused your lane (`dori pause`, e.g. while it waits on the owner), your claim is recorded but nothing closes on a timer; you get a `[LEAD]` line saying so, and the lead closes the lane or objects.

## Reporting honestly

- A blocker, an impossible task or an ambiguous request is a fine report: `[REPORT] <key> | blocker | <what blocks, what you tried, what you need>`. Say it plainly instead of retrying or claiming done.
- Cap your retries: after two or three failed attempts at the same step, report a blocker.
- Tag a report that is a fix attempt for a failing check or metric with `(fix: <metric> / <hypothesis>)`. The third attempt on the same metric with the same hypothesis alerts the lead (`SAME_FIX_3`): stop patching, reproduce the failure and read the logs for the root cause.
- If your brief has a "Past signals" section, read it before you plan: it lists what earlier lanes in the same repo or topic tried and what failed. Don't repeat a fix listed there without a new reason.
- When you make or change a yardstick (a metric, a threshold, a check), write one line on how it could get better while the real goal gets worse.

## If the Dori objects, or a check fails

You get `[LEAD] not done: <reasons>; keep working, claim again when fixed` in your pane, and the lane goes back to not-done. This happens when:

- the Dori objects;
- a `Done =` signal does not read back live;
- there is unpushed work (the reason names the path).

Fix every reason, then claim again. A new claim starts a fresh 5-minute window.
