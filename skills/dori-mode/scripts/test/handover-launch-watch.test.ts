import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchOf, liveMonitors, missingMonitors, monitorLine } from "../src/handover.ts";
import { workEnded } from "../src/handover-monitors.ts";

// port-hc-runtime's lane handover rolled back on 2026-11-08 22:35Z: the old session ran its 4eae ci as a monitor that
// fed a script to a remote shell (node-dori-do ... ssh ori4eae bash -s < ci.sh > log). launchOf did not see work in it,
// so the note had no LAUNCHES_WORK and the check wanted that same command; the new session rightly waited on the old
// run's pid instead (while kill -0 ...), so as not to run the ci twice, and the move was undone.
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "handover-launch-watch-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const entry = (e: Record<string, unknown>) => ({ persistent: true, suspended: false, expiresAt: null, ...e }) as never;
const CI_SCRIPT = [
  "set -u",
  'git -C "$SRC" fetch -q origin "$REF" || exit 90',
  'git -C "$SRC" worktree add -q --detach "$WT" "$SHA" || exit 91',
  'cd "$WT/skills/dori-mode/scripts" || exit 92',
  "bun install --frozen-lockfile >/dev/null 2>&1",
  "bun run ci 2>&1",
  'git -C "$SRC" worktree remove --force "$WT"',
].join("\n");
const FILTER = "^(CI4EAE_DONE|CI_EXIT|LOC_|.* (pass|fail)$|\\(fail\\)|.*error TS)";
const ciCommand = (script: string, log: string) =>
  `node-dori-do oriclaw bash -lc 'ssh -o BatchMode=yes ori4eae bash -s' < ${script} > ${log} 2>&1; echo "CI4EAE_DONE exit=$?"; grep -E '^CI_EXIT|^LOC_' ${log} | head -12`;

test("a script fed to a shell, here or over ssh, under sudo or node-dori-do, with or without script args, starts work", () => {
  // Given: the real ci script, whose own lines start nothing launchOf knew
  const script = join(dir, "ci-4eae-r11.sh");
  writeFileSync(script, CI_SCRIPT);
  const log = join(dir, "ci.log");
  // When / Then
  const real = launchOf(ciCommand(script, log), "/home/test");
  expect(real?.why).toBe("a script run by a shell from its input (bash -s < file)");
  expect(real?.writes).toEqual([log]);
  for (const c of [`ssh ori4eae bash -s < ${script} > ${log} 2>&1`, `sudo -n -u oriclaw -H bash -s -- 5dac768 r11 < ${script}`, `ssh host 'sh -s' <<'EOF'\nbun run ci\nEOF`, `bash -xs < ${script}`]) {
    expect([c, launchOf(c, "/home/test")?.why]).toEqual([c, "a script run by a shell from its input (bash -s < file)"]);
  }
  // a watch that only reads stays watch-only: the new session's pid wait, a remote tail, a here-string to grep
  for (const c of [
    `while kill -0 3146081 2>/dev/null; do sleep 20; done; echo "CI4EAE_DONE exit=unknown"; grep -E '^CI_EXIT' ${log} | head -12`,
    "ssh -o BatchMode=yes ori4eae tail -F /tmp/ci.log",
    `grep -c PASS < ${log}`,
  ]) {
    expect([c, launchOf(c, "/home/test")]).toEqual([c, undefined]);
  }
});

test("the note marks the remote ci LAUNCHES_WORK, and the new session's pid wait with its filter counts as armed; the same command does not", () => {
  // Given: the old session's ci monitor, as its manifest held it
  const script = join(dir, "ci-4eae-r11.sh");
  writeFileSync(script, CI_SCRIPT);
  const log = join(dir, "ci.log");
  const description = "#404 5dac768 full ci on 4eae";
  const [ci] = liveMonitors([entry({ description, command: ciCommand(script, log), filter: FILTER, persistent: false, runtime: { pid: 3146081 } })], 0, () => true, "/home/test");
  if (!ci) throw new Error("no monitor");
  expect(monitorLine(ci)).toContain("LAUNCHES_WORK");
  const waitOn = `while kill -0 3146081 2>/dev/null; do sleep 20; done; echo "CI4EAE_DONE exit=unknown(watched pid 3146081)"; grep -E '^CI_EXIT|^LOC_' ${log} | head -12`;
  // When / Then: what the new session armed on 22:20Z (another description, the same filter) and the same description
  expect(missingMonitors([ci], [entry({ description: `${description} (watch-only: old session's run pid 3146081 still live)`, command: waitOn, filter: FILTER, runtime: { pid: 9 } })], () => true, "/home/test", 0)).toEqual([]);
  expect(missingMonitors([ci], [entry({ description, command: waitOn, runtime: { pid: 9 } })], () => true, "/home/test", 0)).toEqual([]);
  // the ci command armed again would run the ci a second time, and no watch at all still fails the move
  expect(missingMonitors([ci], [entry({ description, command: ci.command, filter: FILTER, runtime: { pid: 9 } })], () => true, "/home/test", 0)).toEqual([`${description} (armed again with the command that starts work; arm a watch-only one instead)`]);
  expect(missingMonitors([ci], [], () => true, "/home/test", 0)).toEqual([`${description} (starts work: arm a watch-only one with the same description)`]);
});

const HOME = "/home/test";

// port-hc-runtime again on 2026-11-08 23:06Z: the note (22:51Z) held its review #404 round 9 monitor, the new session
// armed a pid wait named after it with a note of its own appended, and the review (the work) ended at 22:55Z.
test("a dori review monitor starts work; its wait named after it counts while it runs, and once the work ended nothing is asked", () => {
  // Given
  const log = join(dir, "review-404-r9.log");
  const description = "dori review #404 round 9";
  const filter = "^(REVIEW_DONE|CHECKS_|TESTS_|REVIEW |REFUSED)";
  const command = `cd /tmp/wt-refs && dori review orientpine/omo-dori-mode-experimental#404 > ${log} 2>&1; echo "REVIEW_DONE exit=$?"; grep -E '^(CHECKS_|TESTS_|REVIEW |REFUSED)' ${log} | cut -c1-300`;
  const [review] = liveMonitors([entry({ description, command, filter, persistent: false, runtime: { pid: 3636000 } })], 0, () => true, HOME);
  if (!review) throw new Error("no monitor");
  expect(review.launch?.why).toBe("dori review");
  const named = `${description} (watch-only: old session's review pid 3636161 already running)`;
  const wait = `while kill -0 3636161 2>/dev/null; do sleep 15; done; echo "REVIEW_DONE exit=watch-only"`;
  const work = [{ pid: 3636000, start: "88120", cmd: description, pids: [3636161], starts: ["88123"] }];
  // When / Then: while the review runs, its wait counts and no wait at all does not
  const running = workEnded(work, () => true, (pid) => (pid === 3636000 ? "88120" : "88123"));
  expect(missingMonitors([review], [entry({ description: named, command: wait, runtime: { pid: 9 } })], () => true, HOME, 0, running)).toEqual([]);
  expect(missingMonitors([review], [], () => true, HOME, 0, running)).toEqual([`${description} (starts work: arm a watch-only one with the same description)`]);
  // once the review ended, the wait that ended with it is not asked for
  expect(missingMonitors([review], [], () => true, HOME, 0, workEnded(work, () => false, () => undefined))).toHaveLength(1);
  // another watch whose name only begins with the same words is not it
  expect(missingMonitors([review], [entry({ description: `${description}0`, command: wait, runtime: { pid: 9 } })], () => true, HOME, 0, running)).toEqual([`${description} (starts work: arm a watch-only one with the same description)`]);
});

// #414 review 4: the implicit stdin form wanted a space before < and no descriptor, so these needed the command again.
test("a script fed to a shell with no space before < or with descriptor 0 starts work, here or over ssh", () => {
  for (const c of ["bash</tmp/job.sh", "bash -s</tmp/job.sh", "ssh host bash 0< /tmp/job.sh", "ssh host 'bash' 0</tmp/job.sh > /tmp/job.log 2>&1", "sudo -n -u oriclaw -H bash -l 0< /tmp/job.sh"]) {
    expect([c, launchOf(c, HOME, () => "bun test")?.why]).toEqual([c, "a script run by a shell from its input (bash -s < file)"]);
  }
  // -c, a script argument and another descriptor still read no script from stdin
  // a shell given a string is work since #414 after review 21, whatever the string holds; its input is no script
  for (const c of ["bash -c 'tail -F /tmp/x.log'</dev/null", "bash -lc 'tail -F /tmp/x.log' 0</dev/null"]) {
    expect([c, launchOf(c, HOME, () => undefined)?.why]).toEqual([c, "a script the handover cannot read"]);
  }
  // another descriptor is not stdin: the remote shell reads ssh's own input, which the handover cannot see, so it fails
  // closed as work that keeps its watch (#414 review 20; before: no launch)
  expect(launchOf("ssh host bash 10< /tmp/job.sh", HOME, () => "sleep 30\n")?.detached).toBe(true);
  // review 13: a script argument is not stdin work, but an unreadable executable script is still work and detached
  expect(launchOf("bash /nonexistent/x.sh 0< /tmp/in", HOME, () => undefined)).toEqual({ why: "a script the handover cannot read", writes: [], detached: true });
});

test("a script fed to a shell with combined options or with its output redirected first starts work", () => {
  for (const c of ["bash -se < /tmp/job.sh", "bash -s > /tmp/job.log 2>&1 < /tmp/job.sh", "ssh h bash -ex -s -- a < /tmp/job.sh"]) {
    expect([c, launchOf(c, HOME)?.why]).toEqual([c, "a script run by a shell from its input (bash -s < file)"]);
  }
});
