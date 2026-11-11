import { expect, test } from "bun:test";

import { workEnded } from "../src/handover-monitors.ts";
import { launchOf } from "../src/handover.ts";

const HOME = "/home/test";

// #414 review 40: a reader of fed scripts kept leaking (a subshell inside a substitution, a literal git --upload-pack), so a
// script fed to a shell is never read for what it may start: its monitor keeps its watch, whatever the script says
test("a monitor that feeds any script to a shell keeps its watch", () => {
  const scripts: readonly string[] = [
    "sleep 30\nprintf \"$(echo -v)\" \"$(echo a)\" %s x\n",
    "echo \"$( (true) )\"\n/tmp/inner\n",
    "echo \"$( (echo a) ) b\"; /tmp/inner\n",
    "git --upload-pack=/tmp/inner fetch origin\n",
    "git -c core.fsmonitor=/tmp/inner status\n",
    "sleep 30\ntest -v 'BASH_VERSINFO[$(/tmp/inner)]'\n",
    "sleep 30 &\n",
    "cd /tmp\n/tmp/inner.sh\n",
    "2>&1 bash /tmp/inner.sh\n",
    "git fetch -q\nbun run ci\n",
    "set -u\nexport PATH=\"$HOME/.bun/bin:$PATH\"\ngit -C /home/o/src fetch -q origin feat/x\nenv -u X bun run ci 2>&1\n"
  ];
  for (const script of scripts) {
    for (const command of ["bash -s < /tmp/outer.sh", "node-dori-do oriclaw bash -lc 'ssh -o BatchMode=yes ori4eae bash -s' < /tmp/outer.sh > /tmp/ci.log 2>&1"]) {
      const launch = launchOf(command, HOME, (path) => (path === "/tmp/outer.sh" ? script : undefined));
      expect([script, command, launch?.detached]).toEqual([script, command, true]);
      const monitor = { description: "w", command, persistent: true, ...(launch ? { launch } : {}) };
      expect(workEnded([{ pid: 7, cmd: "w", pids: [8] }], () => false, () => undefined)(monitor)).toBe(false);
    }
  }
  expect(launchOf("bash <<EOF\n/tmp/inner\nEOF", HOME, () => undefined)?.detached).toBe(true);
});

// #414 review 41: detached=false only when every command word is a foreground tool from a fixed list; a path, a script, an
// unknown program or a fed input keeps the watch
test("a monitor keeps its watch unless every command word is a listed foreground tool", () => {
  const read = (path: string) => (path === "/tmp/run.sh" ? "echo $SENPI_MONITOR_RESTORED\nbun test\n" : path === "/tmp/start" ? "#!/bin/sh\nnohup setsid /tmp/worker >/dev/null 2>&1 &\n" : undefined);
  const echoes = launchOf("bash /tmp/run.sh", HOME, read);
  expect(echoes?.detached).toBe(true);
  for (const command of ["/tmp/start; tail -F /tmp/w.log", "/tmp/start", "bun run ci 2>&1 | tail -5", "make all"]) {
    const launch = launchOf(command, HOME, read);
    expect([command, launch?.detached]).toEqual([command, true]);
    const monitor = { description: "w", command, persistent: true, ...(launch ? { launch } : {}) };
    expect(workEnded([{ pid: 7, cmd: "w", pids: [8] }], () => false, () => undefined)(monitor)).toBe(false);
  }
});

// lead before review 42: git runs other programs from literal options (--upload-pack, -c core.fsmonitor, --exec), and gh runs
// extensions and aliases; git is no foreground word, gh only with pr, run, api, release, issue, repo or checks
test("git, and gh with an unlisted subcommand, keep a work monitor's watch", () => {
  for (const command of ["git fetch --upload-pack=/tmp/inner origin > /tmp/f.log", "git -c core.fsmonitor=/tmp/inner status > /tmp/s.log", "gh myext go > /tmp/g.log", "gh alias-run x > /tmp/g.log"]) {
    expect([command, launchOf(command, HOME, () => undefined)?.detached]).toEqual([command, true]);
  }
});

// #414 review 42: a listed tool may start a program through its arguments (awk system, sed e, a pager); only tools that
// cannot, whatever their arguments, are foreground, and an assignment in front of a command (PAGER=...) keeps the watch
test("a tool that can start a program through its arguments keeps a work monitor's watch", () => {
  for (const command of ["awk 'BEGIN{system(\"/tmp/start\")}' > /tmp/o.log", "sed -n '1e /tmp/start' /tmp/x > /tmp/o.log", "journalctl -u x > /tmp/o.log", "PAGER=/tmp/start gh pr view 1 > /tmp/o.log", "export PAGER=/tmp/start; gh pr view 1 > /tmp/o.log"]) {
    expect([command, launchOf(command, HOME, () => undefined)?.detached]).toEqual([command, true]);
  }
});

// lead before review 43: gh pr checkout, repo clone/sync/fork run git (and its hooks), pr create/merge can run an editor;
// gh is foreground only as one of the listed two-word reads, or gh api
test("gh is foreground only as a listed read; checkout, clone and the like keep a work monitor's watch", () => {
  for (const command of ["gh pr checkout 1 > /tmp/o.log", "gh repo clone o/r > /tmp/o.log", "gh repo sync > /tmp/o.log", "gh pr merge 1 > /tmp/o.log", "gh checks x > /tmp/o.log", "gh pr 'view' 1 > /tmp/o.log"]) {
    expect([command, launchOf(command, HOME, () => undefined)?.detached]).toEqual([command, true]);
  }
});

// #414 review 43: test and [ only as [ A OP B ], [ OP A ] or [ A ] with a literal listed OP and no -v or -R, an expanded word
// only as an operand and never split; printf is no foreground word (-v assigns)
test("test and [ are foreground only in plain predicate shapes, and printf not at all", () => {
  for (const command of ["test -v 'BASH_VERSINFO[$(/tmp/start)]' > /tmp/o.log", "op=-v; [ \"$op\" x ] > /tmp/o.log", "[ $x ] > /tmp/o.log", "[ -R x ] > /tmp/o.log", "[ a -a b ] > /tmp/o.log", "[ -v ] > /tmp/o.log", "[ x = -R ] > /tmp/o.log", "printf -v x %s y > /tmp/o.log", "printf 'x\\n' > /tmp/o.log"]) {
    expect([command, launchOf(command, HOME, () => undefined)?.detached]).toEqual([command, true]);
  }
  for (const command of ["until [ \"$n\" -ge 900 ]; do sleep 30; done; echo DONE > /tmp/o.log", "until [ -f /tmp/stop ]; do sleep 2; done; echo X > /tmp/o.log", "[ \"$a\" != \"$b\" ] && echo M > /tmp/o.log", "test -s /tmp/x && echo Y > /tmp/o.log"]) {
    expect([command, launchOf(command, HOME, () => undefined)?.detached]).toEqual([command, false]);
  }
});

// #414 review 44: a standalone assignment can change what later words run (PATH, IFS, BASH_ENV, PAGER...); only a lowercase
// name bash does not read itself leaves a work monitor foreground
test("a standalone assignment keeps the watch unless its name is a plain lowercase one", () => {
  for (const command of ["sleep 30; PATH=/tmp/tools:$PATH; cat /tmp/x > /tmp/o.log", "IFS=/; cat /tmp/x > /tmp/o.log", "BASH_ENV=/tmp/e; cat /tmp/x > /tmp/o.log", "GH_PAGER=/tmp/p; gh pr view 1 > /tmp/o.log", "histchars=x; cat /tmp/x > /tmp/o.log"]) {
    expect([command, launchOf(command, HOME, () => undefined)?.detached]).toEqual([command, true]);
  }
  expect(launchOf("f=/tmp/x; n=1; until [ -s \"$f\" ]; do sleep 2; done; echo DONE > /tmp/o.log", HOME, () => undefined)?.detached).toBe(false);
});
