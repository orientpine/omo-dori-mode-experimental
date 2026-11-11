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
