import { expect, test } from "bun:test";

import { launchOf } from "../src/handover.ts";
import { workEnded } from "../src/handover-monitors.ts";
import { runsOther } from "../src/handover-script-runs.ts";

const HOME = "/home/test";

test("a fed script runs another command when a command word is a path, expanded, a runner, or a job goes to the background", () => {
  expect(["sleep 30 &\n", "/opt/job/run\n", "$J\n", "nohup x\n", "env /tmp/x\n", "echo \"$(bash x)\"\n", "env -S 'bash /tmp/x'\n", "env -C /tmp bun run ci\n", "env --split-string='sh x'\n", "env -i bun run ci\n", "2>&1 bash /tmp/inner.sh\n", ">/dev/null /tmp/inner\n", "python3 job.py\n", "make all\n", "echo 'unclosed\n", "echo \"x `bash /tmp/inner` y\"\n", "echo 'x ` y'\n", "echo \"a $(python3 job.py) b\"\n"].map(runsOther)).toEqual([true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true]);
  expect(["git fetch -q\nbun run ci\n", "env -u X FOO=1 bun run ci 2>&1\n", "echo \"a $(date) b\" >> /tmp/c\n", "until [ -f /tmp/s ]; do sleep 2; done\n", "git -C /home/o/src fetch -q origin x || { echo F; exit 90; }\ncode=$?\nbun run ci 2>&1 >/tmp/l\n"].map(runsOther)).toEqual([false, false, false, false, false]);
});

// #414 review 35: an escaped quote is no quote to the shell, so the command between two of them runs; any backslash in a
// fed script keeps its watch, and workEnded does not take such work for ended when the monitor's own process ends
test("a backslash in a fed script keeps its watch, and its work is not taken for ended", () => {
  const script = 'sleep 30\necho \\"\n/tmp/inner\necho \\"\n';
  expect(runsOther(script)).toBe(true);
  const command = "bash -s < /tmp/outer.sh";
  const launch = launchOf(command, HOME, (path) => (path === "/tmp/outer.sh" ? script : undefined));
  expect(launch?.detached).toBe(true);
  const ended = workEnded([{ pid: 7, cmd: "w", pids: [8] }], () => false, () => undefined);
  expect(ended({ description: "w", command, persistent: true, ...(launch ? { launch } : {}) })).toBe(false);
});

// #414 review 36: test -v evaluates an array subscript and the command substitution in it; in a fed script a test or [ with
// -v, -R, an arithmetic operator, or an argument holding [ or a dollar keeps the watch
test("a predicate that evaluates a subscript in a fed script keeps its watch", () => {
  const script = "sleep 30\ntest -v 'BASH_VERSINFO[$(/tmp/inner)]'\n";
  expect([script, "[ -R x ]\n", "[ \"$n\" -eq 1 ]\n", "[ -n \"$x\" ]\n"].map(runsOther)).toEqual([true, true, true, true]);
  expect(["until [ -f /tmp/qa/stop ]; do sleep 2; done\n", "test -s /tmp/x\n"].map(runsOther)).toEqual([false, false]);
  const command = "bash -s < /tmp/outer.sh";
  const launch = launchOf(command, HOME, (path) => (path === "/tmp/outer.sh" ? script : undefined));
  expect(launch?.detached).toBe(true);
  expect(workEnded([{ pid: 7, cmd: "w", pids: [8] }], () => false, () => undefined)({ description: "w", command, persistent: true, ...(launch ? { launch } : {}) })).toBe(false);
});

// lead before the 0a83 review: printf -v NAME assigns, and a NAME with an array subscript runs code; so can export and set
test("printf -v, and export or set naming a subscript, keep a fed script's watch", () => {
  expect(["printf -v x %s y\n", "printf %s -v x\n", "printf -v 'a[$(/tmp/inner)]' %s y\n", "export 'a[$(/tmp/inner)]=1'\n", "export \"$n\"=1\n", "set -- 'a[$(/tmp/inner)]'\n", "set -- \"$x\"\n"].map(runsOther)).toEqual([true, true, true, true, true, true, true]);
  expect(["export PATH=\"$HOME/.bun/bin:$PATH\"\n", "set -u\n", "printf '%s' x\n"].map(runsOther)).toEqual([false, false, false]);
});

// #414 review 38: printf takes options only before its format, so an expanded or dashed first argument can be -v
test("an expanded printf option in a fed script keeps its watch", () => {
  const script = "sleep 30\nopt=-v\nprintf \"$opt\" 'a[$(/tmp/inner)]' %s x\n";
  expect([script].map(runsOther)).toEqual([true]);
  expect([runsOther("printf '%s' \"$x\"\n"), runsOther("printf '%s' 'a[1]'\n"), runsOther("printf 'ok %s' x\n"), runsOther("bun $x\n"), runsOther("bun run ci\n")]).toEqual([true, true, false, true, false]);
  const command = "bash -s < /tmp/outer.sh";
  const launch = launchOf(command, HOME, (path) => (path === "/tmp/outer.sh" ? script : undefined));
  expect(launch?.detached).toBe(true);
  expect(workEnded([{ pid: 7, cmd: "w", pids: [8] }], () => false, () => undefined)({ description: "w", command, persistent: true, ...(launch ? { launch } : {}) })).toBe(false);
});

// lead, review 38 audit: git with an expanded argument can run a command (--upload-pack, -c core.fsmonitor in a variable)
test("git with an expanded argument keeps a fed script's watch; literal git calls do not", () => {
  expect(["git -C \"$SRC\" fetch -q origin \"$REF\"\n", "git $opt log\n"].map(runsOther)).toEqual([true, true]);
  expect(["git -C /home/o/src fetch -q origin feat/x\n", "echo \"CI_HEAD $(git rev-parse HEAD)\"\n"].map(runsOther)).toEqual([false, false]);
});

// #414 review 39: a command substitution became an empty word before the guards, so printf with a quoted substitution of
// echo -v got past them; a word that held a substitution now holds a dollar for every guard
test("a word that held a command substitution counts as expanded for the argument guards", () => {
  const script = "sleep 30\nprintf \"$(echo -v)\" \"$(echo a)\" %s x\n";
  expect([script, "test \"$(echo -v)\" x\n", "git $(echo --upload-pack=x) fetch\n"].map(runsOther)).toEqual([true, true, true]);
  const command = "bash -s < /tmp/outer.sh";
  const launch = launchOf(command, HOME, (path) => (path === "/tmp/outer.sh" ? script : undefined));
  expect(launch?.detached).toBe(true);
  expect(workEnded([{ pid: 7, cmd: "w", pids: [8] }], () => false, () => undefined)({ description: "w", command, persistent: true, ...(launch ? { launch } : {}) })).toBe(false);
});
