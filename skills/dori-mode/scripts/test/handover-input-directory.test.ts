import { expect, test } from "bun:test";

import { launchOf, missingMonitors } from "../src/handover.ts";
import { workEnded } from "../src/handover-monitors.ts";
import { runsOther } from "../src/handover-script-runs.ts";

const HOME = "/home/test";


// #414 review 11: a relative input was read in the handover process's directory, not in the directory the command changes to.
test("a relative input is read in the directory the command changes to", () => {
  const command = "cd /tmp/work && bash -s < ci.sh";
  const seen: string[] = [];
  const read = (path: string) => { seen.push(path); return path === "/tmp/work/ci.sh" ? "sleep 30\nnohup setsid /tmp/job.sh &\n" : "sleep 30\nbun run ci\n"; };
  const launch = launchOf(command, HOME, read);
  if (!launch) throw new Error(`not work: ${command}`);
  expect(launch.detached).toBe(true);
  expect(seen).toContain("/tmp/work/ci.sh");
  // #414 review 15: a relative script is never pinned exactly (quoted cd, cd -, pushd, $VAR), so even a plain one keeps its watch
  const plain = launchOf(command, HOME, (path) => (path === "/tmp/work/ci.sh" ? "sleep 30\nbun run ci\n" : "bun run build\n"));
  if (!plain) throw new Error(`not work: ${command}`);
  expect(plain.detached).toBe(true);
  // a directory the command never names stays uncertain: an unreadable relative input is detached
  const uncertain = launchOf("bash -s < ci.sh", HOME, () => "bun run ci\n");
  if (!uncertain) throw new Error("not work");
  expect(uncertain.detached).toBe(true);
});

// #414 review 12: the first cd supplied one directory for every relative script regardless of order, so a script run
// before a cd was read in the later directory. Directory changes apply only from where they happen.
test("a cd changes only the scripts that come after it", () => {
  const command = "bash -s < ./start.sh; cd /tmp/other";
  const seen: string[] = [];
  const read = (path: string) => { seen.push(path); return path === "./start.sh" ? "nohup setsid /tmp/job.sh &\n" : "nohup setsid /tmp/other.sh &\n"; };
  const launch = launchOf(command, HOME, read);
  if (!launch) throw new Error(`not work: ${command}`);
  expect(launch.detached).toBe(true);
  expect(seen).not.toContain("/tmp/other/./start.sh");
  // after the cd the same relative name resolves there
  const after = launchOf("cd /tmp/other && bash -s < ci.sh", HOME, (path) => (path === "/tmp/other/ci.sh" ? "nohup setsid /tmp/job.sh &\n" : "sleep 30\nbun run ci\n"));
  if (!after) throw new Error("not work after cd");
  expect(after.detached).toBe(true);
});

// #414 review 12: a relative input in a lane whose directory the handover does not know must not be read in the
// handover process's own directory and judged from that file.
test("a relative input in an unknown directory is not judged from the caller's file", () => {
  const command = "bash -s < ci.sh";
  const seen: string[] = [];
  const read = (path: string) => { seen.push(path); return "nohup setsid /tmp/job.sh &\n"; };
  const launch = launchOf(command, HOME, read);
  if (!launch) throw new Error(`not work: ${command}`);
  expect(seen).not.toContain("ci.sh");
  // unresolved relative input: the watch stays
  expect(launch.detached).toBe(true);
});

// #414 review 13: an unresolved relative script a shell runs returned no launch at all, so the same command could be
// re-armed and start its work twice. It stays work and detached when its directory cannot be resolved.
test("an unresolved script a shell runs is work, never a watch-only command", () => {
  for (const command of ["bash ./start.sh", "bash ./start.sh; cd /tmp/other", "./start.sh"]) {
    const seen: string[] = [];
    const read = (path: string) => { seen.push(path); return "nohup setsid /tmp/job.sh &\n"; };
    const launch = launchOf(command, HOME, read);
    if (!launch) throw new Error(`not work: ${command}`);
    expect([command, launch.detached]).toEqual([command, true]);
    expect(seen).toEqual([]);
  }
  // a resolved absolute script still uses its contents, and a read-only mention is not work
  const absolute = launchOf("bash /tmp/start.sh", HOME, () => "nohup setsid /tmp/job.sh &\n");
  if (!absolute) throw new Error("not work absolute");
  expect(absolute.detached).toBe(true);
  expect(launchOf("cat ./start.sh", HOME, () => undefined)).toBeUndefined();
});

// #414 review 13: only absolute cd targets were tracked, so cd /tmp/work && cd sub read the parent's ci.sh instead of
// the child's. Relative directory changes compose from the last absolute directory.
test("a relative cd composes with the last absolute directory", () => {
  const command = "cd /tmp/work && cd sub && bash -s < ci.sh";
  const seen: string[] = [];
  const read = (path: string) => { seen.push(path); return path === "/tmp/work/sub/ci.sh" ? "sleep 30\nnohup setsid /tmp/job.sh &\n" : "sleep 30\nbun run ci\n"; };
  const launch = launchOf(command, HOME, read);
  if (!launch) throw new Error(`not work: ${command}`);
  expect(launch.detached).toBe(true);
  expect(seen).toEqual(["/tmp/work/sub/ci.sh"]);
  const plain = launchOf(command, HOME, (path) => (path === "/tmp/work/sub/ci.sh" ? "sleep 30\nbun run ci\n" : "nohup setsid /tmp/job.sh &\n"));
  if (!plain) throw new Error(`not work: ${command}`);
  expect(plain.detached).toBe(true);
  // a relative cd with no absolute base is unresolved, not a path in the caller's directory
  expect(launchOf("cd sub && bash -s < ci.sh", HOME, () => "bun run ci\n")?.detached).toBe(true);
});

// #414 review 14: a cd inside a subshell changed the directory used for a later input, although the parent shell never
// changed. Unsupported execution scopes make resolution uncertain instead of selecting a real-looking wrong file.
test("a directory change inside a subshell does not resolve the parent shell's input", () => {
  const command = "cd /tmp/work && (cd sub && pwd) && bash -s < ci.sh";
  const seen: string[] = [];
  const read = (path: string) => { seen.push(path); return path === "/tmp/work/ci.sh" ? "sleep 30\nnohup setsid /tmp/job.sh &\n" : "sleep 30\nbun run ci\n"; };
  const launch = launchOf(command, HOME, read);
  if (!launch) throw new Error(`not work: ${command}`);
  expect(launch.detached).toBe(true);
  expect(seen).toEqual([]);
});

// #414 review 15: a quoted cd target was skipped, so the parent's harmless ci.sh decided for the child's detaching one.
// Root cause of reviews 4-15: detached=false came from guessing which file a shell reads. Now only an absolute script
// path in a command with one input redirection is read for that; anything else keeps the watch.
test("a relative script after a quoted cd keeps its watch whatever the parent's script says", () => {
  const read = (path: string) => (path === "/tmp/work/sub/ci.sh" ? "sleep 30\nnohup setsid /tmp/job.sh &\n" : "sleep 30\nbun run ci\n");
  expect(launchOf("cd /tmp/work && cd 'sub' && bash -s < ci.sh", HOME, read)?.detached).toBe(true);
});

// #414 review 15: the output operand of bash -s>/tmp/log ran on past the < and the ;, so cat's /tmp/result was taken for
// the shell's script and its harmless text hid /tmp/start's delayed job.
test("an input redirection of a later command is not the shell's script", () => {
  const read = (path: string) => (path === "/tmp/start" ? "sleep 30\nnohup setsid /tmp/job.sh &\n" : "done\n");
  const launch = launchOf("bash -s>/tmp/log</tmp/start; cat < /tmp/result", HOME, read);
  if (!launch) throw new Error("not work");
  expect(launch.detached).toBe(true);
  // one < that belongs to the later command: the shell's own input is unknown, so nothing says it ends with the watch
  const seen: string[] = [];
  expect(launchOf("bash -s >/tmp/log; cat < /tmp/result", HOME, (path) => { seen.push(path); return read(path); })?.detached ?? true).toBe(true);
  expect(seen).not.toContain("/tmp/result");
  // the remote ci of port-hc-runtime (2026-11-08 22:35Z): one absolute input, read, and its plain work ends with the watch
  const ci = launchOf("node-dori-do oriclaw bash -lc 'ssh -o BatchMode=yes ori4eae bash -s' < /tmp/ci.sh > /tmp/ci.log 2>&1; echo CI4EAE_DONE", HOME, (path) => (path === "/tmp/ci.sh" ? "git worktree add -q --detach /tmp/w x\nbun run ci\n" : undefined));
  expect(ci?.detached).toBe(false);
});


// #414 review 16: a script a shell runs by a bare name that the handover cannot read ((cd /tmp/work && bash start.sh),
// bash start) returned no launch, so the same command could be armed again and start its work a second time.
test("a script a shell runs by a bare name that cannot be read is work and keeps its watch", () => {
  for (const command of ["(cd /tmp/work && bash start.sh)", "bash start", "cd /tmp/work && bash 'start.sh'"]) {
    const launch = launchOf(command, HOME, () => undefined);
    if (!launch) throw new Error(`not work: ${command}`);
    expect([command, launch.detached]).toEqual([command, true]);
    const rearmed = [{ description: "chain", command, persistent: true, runtime: { pid: 7 } }];
    expect(missingMonitors([{ description: "chain", command, persistent: true, launch }], rearmed, () => true, HOME, 0)).toEqual(["chain (armed again with the command that starts work; arm a watch-only one instead)"]);
  }
  // the arguments of bash -s are not scripts, and a -c string is not one either
  expect(launchOf("ssh h bash -s -- rv v0.2.1 < /tmp/tools.sh", HOME, (path) => (path === "/tmp/tools.sh" ? "bun run ci\n" : undefined))?.detached).toBe(false);
  expect(launchOf("bash -lc 'tail -F /tmp/ci.log'", HOME, () => undefined)?.why).toBe("a command that is not one of the plain watch shapes");
});

// #414 review 17: the operand after a shell was found by a regex, so bash -o pipefail -c took pipefail for a script (a
// watch read as work) and /bin/bash start.sh was no shell at all (work read as a watch). Shell words decide it now.
test("a shell's script operand comes from its words: options with operands, -c strings, wrappers, a shell by its path", () => {
  const rearmed = (command: string) => [{ description: "w", command, persistent: true, runtime: { pid: 7 } }];
  for (const command of ["bash -o pipefail -c 'tail -F /tmp/ci.log'", "bash -O extglob -c 'tail -F /tmp/ci.log'", "bash --rcfile /etc/x -c 'tail -F /tmp/ci.log'"]) {
    expect([command, launchOf(command, HOME, () => undefined)?.detached]).toEqual([command, false]);
    // a shell given a string is work (#414 after review 21): the same command armed again does not count
    expect(missingMonitors([{ description: "w", command, persistent: true }], rearmed(command), () => true, HOME, 0)).toEqual(["w (armed again with the command that starts work; arm a watch-only one instead)"]);
  }
  for (const command of ["/bin/bash start.sh", "/usr/bin/env bash start.sh", "bash -O extglob start.sh", "sudo -u oriclaw bash start.sh", "sudo -n -u oriclaw -H bash start.sh", "nice -n 5 bash start.sh", "bash -c 'bash start.sh'", "ssh h 'bash start.sh'", "node-dori-do oriclaw bash start.sh"]) {
    const launch = launchOf(command, HOME, () => undefined);
    if (!launch) throw new Error(`not work: ${command}`);
    expect([command, launch.detached]).toEqual([command, true]);
    expect(missingMonitors([{ description: "w", command, persistent: true, launch }], rearmed(command), () => true, HOME, 0)).toEqual(["w (armed again with the command that starts work; arm a watch-only one instead)"]);
  }
});

// #414 review 18: a script run on another host was read from the local file of that name, so a harmless local copy hid
// remote work; and combined short options (-euo pipefail) took the value of o for a script, so a watch read as work.
test("a script a remote shell runs is never judged by a local file, and combined options keep their values", () => {
  const harmless = () => "sleep 30\nbun run ci\n";
  for (const command of ["ssh host bash /tmp/start", "ssh host bash /tmp/start.sh", "ssh -p 22 host 'bash -c \"bash /tmp/start.sh\"'"]) {
    const launch = launchOf(command, HOME, harmless);
    if (!launch) throw new Error(`not work: ${command}`);
    expect([command, launch.detached]).toEqual([command, true]);
  }
  const rearmed = (command: string) => [{ description: "w", command, persistent: true, runtime: { pid: 7 } }];
  for (const command of ["bash -euo pipefail -c 'tail -F /tmp/ci.log'", "bash -eO extglob -c 'tail -F /tmp/ci.log'", "bash +o history -c 'tail -F /tmp/ci.log'"]) {
    expect([command, launchOf(command, HOME, () => undefined)?.detached]).toEqual([command, false]);
    expect(missingMonitors([{ description: "w", command, persistent: true }], rearmed(command), () => true, HOME, 0)).toEqual(["w (armed again with the command that starts work; arm a watch-only one instead)"]);
  }
});

// dori challenge of the review 18 plan: a remote shell's input redirection names a file on the other host; the local file
// of that name is neither read nor trusted, while a local input to a local ssh client still is
test("a remote shell's input file is not read here, and a local input to ssh still is", () => {
  const reads: string[] = [];
  const result = launchOf("ssh host 'bash -s < /tmp/start'", HOME, (path) => { reads.push(path); return "sleep 30\n"; });
  expect(reads).not.toContain("/tmp/start");
  expect(result?.detached).toBe(true);
  const local = launchOf("ssh host bash -s < /tmp/ci.sh", HOME, (path) => (path === "/tmp/ci.sh" ? "bun run ci\n" : undefined));
  expect(local?.detached).toBe(false);
  // a remote word that is no script (tail -F of a .sh file) is still only a watch
  expect(launchOf("ssh host tail -F /tmp/progress.sh", HOME, () => undefined)).toBeUndefined();
});

// #414 review 30: a script can run another script that detaches its work, and the handover reads only the named one; a
// script run by name keeps its watch whatever it says, and a script fed to a shell does when its text runs another one
test("a script that runs another script keeps its watch, whatever the scripts say", () => {
  const files: Record<string, string> = { "/tmp/abs.sh": "cd /tmp\n/tmp/inner.sh\n", "/tmp/path.sh": "cd /tmp\n/opt/job/run --go\n", "/tmp/wrap.sh": "x=1 timeout 60 /tmp/inner\n", "/tmp/var.sh": "J=/tmp/inner.sh\n$J\n", "/tmp/bg.sh": "sleep 30 &\n", "/tmp/outer.sh": "bash /tmp/inner.sh\n", "/tmp/inner.sh": "nohup setsid /tmp/job > /tmp/job.log 2>&1 &\n", "/tmp/ci.sh": "bash /tmp/inner.sh\n", "/tmp/plain.sh": "git fetch -q\nbun run ci\n" };
  const read = (path: string) => files[path];
  // #414 review 31: per command word of the fed script: a path, a .sh, a shell or exec-like word, an expanded command
  // word, a wrapper that runs another command, or a background job
  for (const command of ["bash /tmp/outer.sh", "sh /tmp/outer.sh > /tmp/o.log", "bash -s < /tmp/ci.sh", "ssh host bash -s < /tmp/ci.sh", "bash -s < /tmp/abs.sh", "bash -s < /tmp/path.sh", "bash -s < /tmp/wrap.sh", "bash -s < /tmp/var.sh", "bash -s < /tmp/bg.sh"]) {
    expect([command, launchOf(command, HOME, read)?.detached]).toEqual([command, true]);
  }
  // a plain script fed to a shell from one absolute input still ends with its watch (the remote ci of 2026-11-08)
  expect(launchOf("node-dori-do oriclaw bash -lc 'ssh -o BatchMode=yes ori4eae bash -s' < /tmp/plain.sh > /tmp/ci.log 2>&1", HOME, read)?.detached).toBe(false);
});

test("a fed script runs another command when a command word is a path, expanded, a runner, or a job goes to the background", () => {
  expect(["sleep 30 &\n", "/opt/job/run\n", "$J\n", "nohup x\n", "env /tmp/x\n", "echo \"$(bash x)\"\n", "env -S 'bash /tmp/x'\n", "env -C /tmp bun run ci\n", "env --split-string='sh x'\n", "env -i bun run ci\n", "2>&1 bash /tmp/inner.sh\n", ">/dev/null /tmp/inner\n", "python3 job.py\n", "make all\n", "echo 'unclosed\n", "echo \"x `bash /tmp/inner` y\"\n", "echo 'x ` y'\n", "echo \"a $(python3 job.py) b\"\n"].map(runsOther)).toEqual([true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true]);
  expect(["git fetch -q\nbun run ci\n", "env -u X FOO=1 bun run ci 2>&1\n", "echo \"a $(date) b\" >> /tmp/c\n", "until [ -f /tmp/s ]; do sleep 2; done\n", "git -C \"$SRC\" fetch -q origin x || { echo F; exit 90; }\ncode=$?\nbun run ci 2>&1 >/tmp/l\n"].map(runsOther)).toEqual([false, false, false, false, false]);
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
  expect([script, "printf -- x\n"].map(runsOther)).toEqual([true, true]);
  expect(runsOther("printf '%s' \"$x\"\n")).toBe(false);
  const command = "bash -s < /tmp/outer.sh";
  const launch = launchOf(command, HOME, (path) => (path === "/tmp/outer.sh" ? script : undefined));
  expect(launch?.detached).toBe(true);
  expect(workEnded([{ pid: 7, cmd: "w", pids: [8] }], () => false, () => undefined)({ description: "w", command, persistent: true, ...(launch ? { launch } : {}) })).toBe(false);
});
