import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchOf, missingMonitors } from "../src/handover.ts";

const HOME = "/home/test";
const rearmed = (command: string) => [{ description: "w", command, persistent: true, runtime: { pid: 7 } }];
const rejectsSameCommand = (command: string) => {
  const launch = launchOf(command, HOME, () => undefined);
  if (!launch) throw new Error(`not work: ${command}`);
  expect(missingMonitors([{ description: "w", command, persistent: true, launch }], rearmed(command), () => true, HOME, 0)).toEqual(["w (armed again with the command that starts work; arm a watch-only one instead)"]);
};

// #414, lead decision after review 21: a monitor command is a plain watch only when every command in it is one of the
// plain poll shapes the real handover notes use (38 commands from 77 notes, 2026-11-11); anything else is work and keeps
// its watch, so a new session never arms it again. One case per shape.
test("the plain poll shapes of real monitors stay watches the new session may arm again", () => {
  for (const command of [
    "tail -n 0 -F /home/test/.soodori/state/lanes.log | grep --line-buffered -E 'handover-launch-watch|#414'",
    "until [ $(date -u +%s) -ge $(date -u -d '2026-11-08T23:15:00Z' +%s) ]; do sleep 60; done; printf 'SLOT_CHECK\\n'",
    "until grep -q REVIEW_EXIT /tmp/r/review.log 2>/dev/null; do sleep 10; done; printf 'READY\\n'; grep -E 'verdict=|REVIEW_' /tmp/r/review.log | tail -4",
    "until [ \"$(gh pr view 436 --repo o/r --json state -q .state)\" = \"MERGED\" ] || [ \"$(gh pr view 436 --repo o/r --json state -q .state)\" = \"CLOSED\" ]; do sleep 15; done; gh pr view 436 --repo o/r --json state,headRefOid,url",
    "while true; do state=$(gh pr view 435 --repo o/r --json state --jq .state 2>/dev/null); if [ \"$state\" != \"OPEN\" ] && [ -n \"$state\" ]; then printf 'PR_STATE %s\\n' \"$state\"; break; fi; sleep 15; done",
    "export GH_CONFIG_DIR=$HOME/.config/gh; sleep 20; until gh pr checks 232 -R o/r --json name,state -q '[.[]|select(.state==\"PENDING\")]|length' 2>/dev/null | grep -qx 0; do sleep 30; done; gh pr checks 232 -R o/r --json name,state -q '.[]|.name' | tr '\\n' ' '; printf '\\nCHECKS_SETTLED\\n'",
    "until gh pr view 42 -R o/r --json headRefOid -q .headRefOid | grep -q ^bea2357; do sleep 10; done; sleep 20; gh pr checks 42 -R o/r --watch --interval 30 >/dev/null 2>&1; echo \"CI5 $(gh pr checks 42 -R o/r 2>&1 | cut -f1,2 | tr '\\t\\n' '= ')\"",
    "cd /home/test/src; b=\"$SENPI_MONITOR_STATE_DIR/base\"; p=$(cat \"$b\" 2>/dev/null || git rev-parse origin/main | tee \"$b\"); while sleep 60; do git fetch -q origin main 2>/dev/null || true; n=$(git rev-parse origin/main); [ \"$n\" != \"$p\" ] && { echo \"MOVED $p..$n $(git log -1 --format=%s $n | cut -c1-80)\"; p=$n; echo \"$p\" > \"$b\"; }; done",
    "p=$(git -C /tmp/wt rev-parse origin/main); while sleep 60; do git -C /tmp/wt fetch -q origin 2>/dev/null || continue; n=$(git -C /tmp/wt rev-parse origin/main); [ \"$n\" != \"$p\" ] && { echo \"MOVED $p..$n\"; p=$n; }; done",
    // the watch-only form a new session arms for work the old one started: wait on its pid
    "while kill -0 3636161 2>/dev/null; do sleep 2; done; echo QA_JOB_DONE",
    "until test -e /tmp/qa/stop; do sleep 2; done; stat -c %s /tmp/qa/stop; printf 'STOPPED\\n'",
    // the shapes of the other real lane and lead notes: another account or host, a service, a gh read, a filter
    "until node-dori-do okdori test -s /home/okdori/s.log 2>/dev/null; do sleep 120; done; echo X $(node-dori-do okdori tail -3 /home/okdori/s.log | tr '\\n' ' ' | cut -c1-300)",
    "ssh ori644d 'tail -n +1 -F logs/bs_chain.out | grep --line-buffered -E \"BS_CHAIN_|Traceback\" | sed -u \"/BS_CHAIN_DONE/q\"'",
    "until [ \"$(sha256sum /opt/g/gate.py | cut -d' ' -f1)\" = a231 ]; do sleep 30; done; echo G $(systemctl is-active g.service) $(journalctl -u g -n 20 --no-pager | grep -c READY)",
    "while true; do a=$(GH_PAGER=cat gh pr view 1 -R o/r --json state -q .state 2>/dev/null); if [ \"$a\" = MERGED ]; then echo M; break; fi; sleep 1800; done",
    "last=\"\"; while true; do r=$(gh api repos/o/r/pulls/435/reviews --jq length 2>/dev/null); if [ -z \"$last\" ]; then last=\"$r\"; elif [ \"$r\" != \"$last\" ]; then break; fi; sleep 15; done",
    "gh run list -R o/r --branch b --limit 5 --json databaseId -q '.[0].databaseId'; gh run watch 7 -R o/r --interval 30 >/dev/null 2>&1; gh pr checks 42 -R o/r 2>&1 | awk '{print $1\"=\"$2}' | sed 's/^/R5: /'",
    "until ! kill -0 1234; do sleep 5; done; grep -c PASS < /tmp/x.log",
  ]) {
    expect([command, launchOf(command, HOME, () => undefined)]).toEqual([command, undefined]);
    expect(missingMonitors([{ description: "w", command, persistent: true }], rearmed(command), () => true, HOME, 0)).toEqual([]);
  }
});

// dori challenge of plan-414-r22: an allowed command can hide work in an argument, an option or an output target, and
// the two real monitors the deny-list took for watches (a bun test run, a dori challenge) start work
test("work hidden in a substitution, an option, an output target or an unlisted command is work", () => {
  for (const command of [
    "printf '%s\\n' \"$(bun test)\"",
    "until grep -q X /tmp/f; do sleep 5; done; echo \"$(dori review o/r#1)\"",
    "printf READY > /tmp/outside",
    "until grep -q X /tmp/f; do sleep 5; done; grep X /tmp/f | tee /tmp/copy",
    "sort -o /tmp/result /tmp/input",
    "date -s 2026-01-01",
    "gh pr merge 42 -R o/r",
    "gh api -X POST repos/o/r/issues/1/comments -f body=x",
    "git -C /tmp/wt push origin HEAD",
    "grep --include=x -r X /tmp",
    "tail -F /tmp/x.log | sh",
    "$CMD /tmp/x",
    "until grep -q X /tmp/f; do sleep 5; done; echo `bun test`",
    "until grep -q X /tmp/f; do sleep 5; done & echo started",
    "cd /tmp/hs-b/scripts && env -u DORI_STATE_DIR TMPDIR=/tmp/t timeout 500 bun test > /tmp/t/suite.txt 2>&1; echo \"SUITE_EXIT $?\"",
    "dori challenge lane --plan /tmp/t/plan.md > /tmp/t/challenge.txt 2>&1; echo \"CHALLENGE_EXIT $?\"",
    // a shell that runs a string or reads a script is not a plain poll, whatever the string or input holds
    "bash -lc 'tail -F /tmp/ci.log'",
    "bash -c 'if test -f /tmp/ci; then bash -o pipefail; fi' < /tmp/ci",
    "{ bash -o pipefail; } < /tmp/ci",
    "curl -s https://example.com/x | bash",
    // the filters and remote forms on the list only in their plain shape
    "tail -F /tmp/x | sed -n 'w /tmp/copy'",
    "tail -F /tmp/x | awk '{system(\"bun test\")}'",
    "ssh host",
    "ssh host 'bun test'",
    "node-dori-do oriclaw bash -s",
    "GH_PAGER=less gh pr view 1",
    "until [ $(( $(date +%s) - 5 )) -ge 9 ]; do sleep 20; done",
    "grep X <<< \"$(bun test)\"",
    // #414 review 22: an expansion the shell splits into options, and an ssh option that runs a command
    "opts='-X POST -f body=done'; gh api repos/o/r/issues/414/comments $opts; tail -F /tmp/watch.log",
    "gh api repos/o/r/issues/414/comments \"$opts\"",
    "ssh -o PermitLocalCommand=yes -o 'LocalCommand=dori review o/r#414' host tail -F /tmp/watch.log",
    "ssh -o ProxyCommand='bun test' host tail -F /tmp/watch.log",
    "node-dori-do okdori tail -F $log",
    // #414 review 23: a read-only substitution's output can still be options
    "opts=$(printf '%s' '-X POST -f body=done'); gh api repos/o/r/issues/414/comments $opts; tail -F /tmp/watch.log",
    "gh api repos/o/r/issues/414/comments $(printf '%s' '-X POST')",
    "x=$(cat /tmp/f); git log -1 --format=$x",
    "id=$(gh run list -R o/r --json databaseId -q '.[0].databaseId'); gh run watch $id -R o/r",
    "x=$(git rev-parse --output=/tmp/f HEAD); git log $x",
    "x=$(git rev-parse HEAD); x=$(cat /tmp/f); git log $x",
    "x=$(git rev-parse HEAD); gh api repos/o/r $x",
  ]) rejectsSameCommand(command);
});

// the remote ci of port-hc-runtime (2026-11-08 22:35Z) stays work whose watch ends with it, and a shell fed a script
// with options before the redirection (#414 review 19) is work too
test("the remote ci is work that ends with its watch; a script fed to a shell after options is work", () => {
  const read = (path: string) => (path === "/tmp/ci.sh" ? "git worktree add -q --detach /tmp/w x\nbun run ci\n" : undefined);
  const ci = launchOf("node-dori-do oriclaw bash -lc 'ssh -o BatchMode=yes ori4eae bash -s' < /tmp/ci.sh > /tmp/ci.log 2>&1; echo CI4EAE_DONE", HOME, read);
  expect([ci?.why, ci?.detached]).toEqual(["a script run by a shell from its input (bash -s < file)", false]);
  for (const command of ["bash -o pipefail < /tmp/ci.sh", "bash -euo pipefail < /tmp/ci.sh", "sudo -u oriclaw bash -o pipefail -s < /tmp/ci.sh"]) {
    expect([command, launchOf(command, HOME, read)?.detached]).toEqual([command, false]);
    rejectsSameCommand(command);
  }
});

// #414 review 21: the handover read a shell's input with readFileSync, so a FIFO input took bytes from the running shell
// or blocked the handover. Only a regular file is read; any other input is unreadable work that keeps its watch. Run in a
// child process so a regression that blocks on the FIFO fails within the bound instead of hanging the suite.
test("a FIFO input is never read: it is work that keeps its watch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hlw-fifo-"));
  try {
    const fifo = join(dir, "ci.fifo");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    const src = join(import.meta.dir, "..", "src", "handover.ts");
    const proc = Bun.spawn([process.execPath, "-e", `const { launchOf } = await import(${JSON.stringify(src)}); console.log(JSON.stringify(launchOf(${JSON.stringify(`bash -s < ${fifo}`)}, "/home/test") ?? null));`], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), 10_000);
    const code = await proc.exited;
    clearTimeout(timer);
    const out = await new Response(proc.stdout).text();
    expect([code, (JSON.parse(out.trim() || "null") as { detached?: boolean } | null)?.detached]).toEqual([0, true]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

// #414 review 22: an unquoted carriage return made the lexer loop forever, so a copied CRLF command hung the handover.
// Run in a child process so a regression fails within the bound instead of hanging the suite.
test("a command with a carriage return or other unusual blank is work, decided at once", async () => {
  const src = join(import.meta.dir, "..", "src", "handover.ts");
  const commands = ["tail -F /tmp/x.log\r\n", "sleep\v5", "tail\u00a0-F /tmp/x.log"];
  const proc = Bun.spawn([process.execPath, "-e", `const { launchOf } = await import(${JSON.stringify(src)}); console.log(JSON.stringify(${JSON.stringify(commands)}.map((c) => !!launchOf(c, "/home/test", () => undefined))));`], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), 10_000);
  const code = await proc.exited;
  clearTimeout(timer);
  expect([code, (await new Response(proc.stdout).text()).trim()]).toEqual([0, JSON.stringify([true, true, true])]);
}, 20_000);
