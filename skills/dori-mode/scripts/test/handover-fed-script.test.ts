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
