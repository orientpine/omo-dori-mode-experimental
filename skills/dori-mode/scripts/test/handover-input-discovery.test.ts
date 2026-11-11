import { expect, test } from "bun:test";

import { launchOf, missingMonitors } from "../src/handover.ts";
import { workEnded } from "../src/handover-monitors.ts";

const HOME = "/home/test";
const gone = () => undefined;
const work = [{ pid: 100, start: "s100", cmd: "ci on 4eae", pids: [101, 102], starts: ["s101", "s102"] }];

// #414 review 4: the detached check read only launch.why, the first reason found, so a script fed to a shell that sleeps
// and then detaches its job (nohup setsid ... &) after the note's process snapshot counted as ended with its shell.
test("a script fed to a shell that detaches its job after the note's snapshot, or that cannot be read, is still asked for", () => {
  const asked = ["ci on 4eae (starts work: arm a watch-only one with the same description)"];
  const detaching = (path: string) => (path === "/tmp/start.sh" ? "sleep 30\nnohup setsid /tmp/job.sh > /tmp/job.log 2>&1 &\n" : undefined);
  const monitor = (command: string, read: (path: string) => string | undefined) => {
    const launch = launchOf(command, HOME, read);
    if (!launch) throw new Error(`not work: ${command}`);
    return { description: "ci on 4eae", command, persistent: true, launch };
  };
  for (const command of ["bash -s < /tmp/start.sh", "ssh ori4eae bash -s < /tmp/start.sh > /tmp/start.log 2>&1", "bash</tmp/start.sh"]) {
    // the shell and the sleep the note saw ended, but the job they detached runs on
    expect([command, missingMonitors([monitor(command, detaching)], [], () => true, HOME, 0, workEnded(work, () => true, gone))]).toEqual([command, asked]);
    // a script the handover cannot read may detach as well
    expect([command, missingMonitors([monitor(command, gone)], [], () => true, HOME, 0, workEnded(work, () => true, gone))]).toEqual([command, asked]);
  }
  // the same script with no detached job ends with its processes
  expect(missingMonitors([monitor("bash -s < /tmp/start.sh", () => "sleep 30\nbun run ci\n")], [], () => true, HOME, 0, workEnded(work, () => true, gone))).toEqual([]);
});

// #414 review 5: a quoted or relative script path was never read (detached false), a job backgrounded with its output
// thrown away (>/dev/null 2>&1 &) was not detached, and two monitors sharing a description shared the first one's work.
test("a script fed to a shell by a quoted or relative path, or a job backgrounded to /dev/null, is still asked for", () => {
  const asked = ["ci on 4eae (starts work: arm a watch-only one with the same description)"];
  const detaching = (path: string) => (path === "/tmp/start.sh" || path === "start.sh" ? "sleep 30\nnohup setsid /tmp/job.sh > /tmp/job.log 2>&1 &\n" : undefined);
  for (const command of ['bash -s < "/tmp/start.sh"', "bash -s < '/tmp/start.sh'", "bash -s < start.sh"]) {
    const launch = launchOf(command, HOME, detaching);
    if (!launch) throw new Error(`not work: ${command}`);
    expect([command, missingMonitors([{ description: "ci on 4eae", command, persistent: true, launch }], [], () => true, HOME, 0, workEnded(work, () => true, gone))]).toEqual([command, asked]);
  }
  // a background job whose output is thrown away still outlives the recorded sleep
  const withLaunch = (command: string, text: string) => {
    const launch = launchOf(command, HOME, () => text);
    if (!launch) throw new Error(`not work: ${command}`);
    return { description: "ci on 4eae", command, persistent: true, launch };
  };
  expect(missingMonitors([withLaunch("bash -s < /tmp/start.sh", "sleep 30\nbun run build >/dev/null 2>&1 &\n")], [], () => true, HOME, 0, workEnded(work, () => true, gone))).toEqual(asked);
  // a job the monitor command itself backgrounds (not a script it feeds) outlives the watch too
  expect(launchOf("bun run build >/dev/null 2>&1 & tail -F /tmp/build.log", HOME, () => undefined)?.detached).toBe(true);
  // the same script with nothing backgrounded ends with its processes
  expect(missingMonitors([withLaunch("bash -s < /tmp/start.sh", "sleep 30\nbun run build >/dev/null 2>&1\n")], [], () => true, HOME, 0, workEnded(work, () => true, gone))).toEqual([]);
});

// #414 review 6: a script fed to a shell from its input was read only when its name ended in .sh, so bash -s < /tmp/start
// was detached: false even when the script slept and then detached its job; an extensionless input is read the same way.
test("a script fed to a shell from its input is read whatever its name, and an unreadable one is detached", () => {
  const asked = ["ci on 4eae (starts work: arm a watch-only one with the same description)"];
  const detaching = (path: string) => (path === "/tmp/start" ? "sleep 30\nnohup setsid /tmp/job.sh > /tmp/job.log 2>&1 &\n" : undefined);
  for (const command of ["bash -s < /tmp/start", "ssh ori4eae bash -s < /tmp/start > /tmp/start.log 2>&1", "bash</tmp/start"]) {
    const launch = launchOf(command, HOME, detaching);
    if (!launch) throw new Error(`not work: ${command}`);
    expect([command, launch.detached]).toEqual([command, true]);
    expect([command, missingMonitors([{ description: "ci on 4eae", command, persistent: true, launch }], [], () => true, HOME, 0, workEnded(work, () => true, gone))]).toEqual([command, asked]);
    // an extensionless input the handover cannot read may detach as well
    const unreadable = launchOf(command, HOME, gone);
    if (!unreadable) throw new Error(`not work: ${command}`);
    expect([command, unreadable.detached]).toEqual([command, true]);
  }
  // the same extensionless script with nothing detached ends with its processes
  const plain = launchOf("bash -s < /tmp/start", HOME, () => "sleep 30\nbun run ci\n");
  if (!plain) throw new Error("not work");
  expect(plain.detached).toBe(false);
  expect(missingMonitors([{ description: "ci on 4eae", command: "bash -s < /tmp/start", persistent: true, launch: plain }], [], () => true, HOME, 0, workEnded(work, () => true, gone))).toEqual([]);
  // a word that is not an input is still left alone: an unreadable .sh argument keeps its old meaning
  expect(launchOf("cat /tmp/notes.txt", HOME, gone)).toBeUndefined();
});

// #414 review 7: launch detection allowed arguments and other redirections before the input, but discovery did not, so
// bash -s -- arg < /tmp/start and bash -s > /tmp/log < /tmp/start were detached: false with an unreadable input.
test("a shell's input is discovered past its arguments and its other redirections", () => {
  const asked = ["ci on 4eae (starts work: arm a watch-only one with the same description)"];
  const detaching = (path: string) => (path === "/tmp/start" ? "sleep 30\nnohup setsid /tmp/job.sh > /tmp/job.log 2>&1 &\n" : undefined);
  for (const command of ["bash -s -- arg < /tmp/start", "bash -s > /tmp/log < /tmp/start", "ssh ori4eae bash -s -- ci 4eae < /tmp/start > /tmp/out.log 2>&1", "bash -s -- \"ci 4eae\" < /tmp/start", "bash -s -- 'ci 4eae' < /tmp/start", "bash -s -- \"ci 4eae\" > /tmp/log < /tmp/start"]) {
    for (const read of [detaching, () => undefined]) {
      const launch = launchOf(command, HOME, read);
      if (!launch) throw new Error(`not work: ${command}`);
      expect([command, launch.detached]).toEqual([command, true]);
      expect([command, missingMonitors([{ description: "ci on 4eae", command, persistent: true, launch }], [], () => true, HOME, 0, workEnded(work, () => true, gone))]).toEqual([command, asked]);
    }
    // the same form with nothing detached ends with its processes
    const plain = launchOf(command, HOME, () => "sleep 30\nbun run ci\n");
    if (!plain) throw new Error(`not work: ${command}`);
    expect([command, plain.detached]).toEqual([command, false]);
  }
});

// #414 review 9: bash -s < /tmp/empty < /tmp/start runs the last input, but discovery read only the first, so a
// harmless first file hid the delayed detachment in the second. The effective source is the last one.
test("with several input redirections the shell's effective source is the last one", () => {
  const asked = ["ci on 4eae (starts work: arm a watch-only one with the same description)"];
  const detaching = (path: string) => (path === "/tmp/start" ? "sleep 30\nnohup setsid /tmp/job.sh > /tmp/job.log 2>&1 &\n" : "");
  for (const command of ["bash -s < /tmp/empty < /tmp/start", "bash -s < /tmp/empty < /tmp/also-empty < /tmp/start", "ssh ori4eae bash -s < /tmp/empty < /tmp/start > /tmp/out.log 2>&1"]) {
    for (const read of [detaching, () => undefined]) {
      const launch = launchOf(command, HOME, read);
      if (!launch) throw new Error(`not work: ${command}`);
      expect([command, launch.detached]).toEqual([command, true]);
      expect([command, missingMonitors([{ description: "ci on 4eae", command, persistent: true, launch }], [], () => true, HOME, 0, workEnded(work, () => true, gone))]).toEqual([command, asked]);
    }
    // #414 review 15: with several < the shell's script is not pinned exactly, so even a plain last input keeps its watch
    const plain = launchOf(command, HOME, (path) => (path === "/tmp/start" ? "sleep 30\nbun run ci\n" : "nohup setsid /tmp/job.sh &\n"));
    if (!plain) throw new Error(`not work: ${command}`);
    expect([command, plain.detached]).toEqual([command, true]);
  }
});

// #414 review 10: the blanket .sh scan also read a superseded input, so old.sh with nohup kept detached true when the
// effective current.sh ran only foreground work; and a quoted input name with a space was cut at the space.
test("a superseded .sh input is not read, and a quoted input name with a space is read whole", () => {
  const command = "bash -s < /tmp/old.sh < /tmp/current.sh";
  const read = (path: string) => (path === "/tmp/old.sh" ? "nohup setsid /tmp/job.sh &\n" : "sleep 30\nbun run ci\n");
  const launch = launchOf(command, HOME, read);
  if (!launch) throw new Error(`not work: ${command}`);
  // #414 review 15: several < keep the watch even when the effective input is plain
  const asked = ["ci on 4eae (starts work: arm a watch-only one with the same description)"];
  expect(launch.detached).toBe(true);
  expect(missingMonitors([{ description: "ci on 4eae", command, persistent: true, launch }], [], () => true, HOME, 0, workEnded(work, () => true, gone))).toEqual(asked);
  for (const r of [(path: string) => (path === "/tmp/current.sh" ? "sleep 30\nnohup setsid /tmp/job.sh &\n" : ""), () => undefined]) {
    const l2 = launchOf(command, HOME, r);
    if (!l2) throw new Error(`not work: ${command}`);
    expect(l2.detached).toBe(true);
    expect(missingMonitors([{ description: "ci on 4eae", command, persistent: true, launch: l2 }], [], () => true, HOME, 0, workEnded(work, () => true, gone))).toEqual(asked);
  }
  // a quoted input name with a space: the harmless prefix file must not hide the real input
  const spaced = 'bash -s < "/tmp/start job"';
  const real = (path: string) => (path === "/tmp/start job" ? "sleep 30\nnohup setsid /tmp/job.sh &\n" : "sleep 30\nbun run ci\n");
  const l3 = launchOf(spaced, HOME, real);
  if (!l3) throw new Error(`not work: ${spaced}`);
  expect(l3.detached).toBe(true);
  const l4 = launchOf(spaced, HOME, () => undefined);
  if (!l4) throw new Error(`not work: ${spaced}`);
  expect(l4.detached).toBe(true);
  const l5 = launchOf(spaced, HOME, (path) => (path === "/tmp/start job" ? "sleep 30\nbun run ci\n" : "nohup setsid /tmp/job.sh &\n"));
  if (!l5) throw new Error(`not work: ${spaced}`);
  expect(l5.detached).toBe(false);
});

// #414 review 11: excluding a filename wherever it appeared as an input also excluded a script another command ran, so
// bash /tmp/start.sh; cat < /tmp/start.sh stopped launching work at all. The exclusion is per redirection token, not per name.
test("a script run by one command is still read when another command reads the same file as its input", () => {
  const command = "bash /tmp/start.sh; cat < /tmp/start.sh";
  const read = (path: string) => (path === "/tmp/start.sh" ? "nohup setsid /tmp/job.sh > /tmp/job.log 2>&1 &\n" : undefined);
  const launch = launchOf(command, HOME, read);
  if (!launch) throw new Error(`not work: ${command}`);
  expect(launch.detached).toBe(true);
  // the same two commands with a foreground-only script still run a script, which is no plain watch shape
  expect(launchOf(command, HOME, () => "bun run build\n")?.why).toBe("a command that is not one of the plain watch shapes");
});
// #414 review 14: bash -s>/tmp/log < /tmp/start launched work, but discovery required whitespace before the output
// redirection and found no input. Output redirections may touch the shell's options.
test("an output redirection next to the shell options does not hide the input", () => {
  for (const command of ["bash -s>/tmp/log < /tmp/start", "bash -s>/tmp/log< /tmp/start"]) {
    for (const read of [(path: string) => (path === "/tmp/start" ? "sleep 30\nnohup setsid /tmp/job.sh &\n" : undefined), () => undefined]) {
      const launch = launchOf(command, HOME, read);
      if (!launch) throw new Error(`not work: ${command}`);
      expect([command, launch.detached]).toEqual([command, true]);
    }
    const plain = launchOf(command, HOME, () => "sleep 30\nbun run ci\n");
    if (!plain) throw new Error(`not work: ${command}`);
    expect([command, plain.detached]).toEqual([command, false]);
  }
  // any recognized stdin execution whose input discovery finds nothing stays uncertain
  expect(launchOf("bash -s > /tmp/log <", HOME, () => "bun run ci\n")?.detached).toBe(true);
});


