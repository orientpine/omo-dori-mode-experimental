import { expect, test } from "bun:test";

import { launchOf, missingMonitors, monitorWork } from "../src/handover.ts";
import { run } from "../src/run.ts";
import { procTable } from "../src/session-id.ts";
import { procStart, workEnded } from "../src/handover-monitors.ts";

// After three reviews of #414 found new ways around reading omo's notice text (a watch's own lines can forge it, and omo
// writes no run id or exit code to the session), a monitor that starts work counts as done from processes, not text: the
// note records the monitor's process and the work under it with their start times (/proc), and once all of them ended
// (port-hc-runtime's 4eae ci 2026-11-08 22:35Z, its dori review 23:06Z) nothing is left to wait for.
const HOME = "/home/test";
const gone = () => undefined;
const launched = (command: string) => {
  const launch = launchOf(command, HOME, () => "bun run ci\n");
  if (!launch) throw new Error(`not work: ${command}`);
  return { description: "ci on 4eae", command, persistent: true, launch };
};
const ci = launched("node-dori-do oriclaw bash -lc 'ssh ori4eae bash -s' < /tmp/ci.sh > /tmp/ci.log 2>&1; echo CI_DONE");
const work = [{ pid: 100, start: "s100", cmd: "ci on 4eae", pids: [101, 102], starts: ["s101", "s102"] }];
const startOf = (live: Record<number, string>) => (pid: number) => live[pid];

test("a monitor that feeds its work a script keeps its watch even after its own process and the work under it ended (#414 review 40)", () => {
  // the whole command (the work and the lines after it) ended
  expect(missingMonitors([ci], [], () => true, HOME, 0, workEnded(work, () => true, gone))).toHaveLength(1);
  // the work ended, but the monitor still runs its own lines (a grep, an echo) or a worker the note never saw
  expect(missingMonitors([ci], [], () => true, HOME, 0, workEnded(work, () => true, startOf({ 100: "s100" })))).toEqual(["ci on 4eae (starts work: arm a watch-only one with the same description)"]);
  // the monitor's pid now belongs to another process (another start time): the monitor ended
  expect(missingMonitors([ci], [], () => true, HOME, 0, workEnded(work, () => true, startOf({ 100: "s999" })))).toHaveLength(1);
  // a recorded worker still runs
  expect(missingMonitors([ci], [], () => true, HOME, 0, workEnded(work, () => true, startOf({ 102: "s102" })))).toEqual(["ci on 4eae (starts work: arm a watch-only one with the same description)"]);
});

test("a monitor whose work runs detached, or whose work the note did not record, is still asked for", () => {
  const chain = launched("nohup setsid bash /tmp/chain.sh 400 > /tmp/chain.out 2>&1 & tail -F /tmp/chain.out");
  expect(missingMonitors([chain], [], () => true, HOME, 0, workEnded(work, () => true, gone))).toEqual(["ci on 4eae (starts work: arm a watch-only one with the same description)"]);
  expect(missingMonitors([ci], [], () => true, HOME, 0, workEnded([], () => true, gone))).toEqual(["ci on 4eae (starts work: arm a watch-only one with the same description)"]);
  // no start times recorded (no /proc): the pids alone decide, and a live pid keeps it asked for
  const bare = [{ pid: 100, cmd: "ci on 4eae", pids: [101] }];
  expect(missingMonitors([ci], [], () => true, HOME, 0, workEnded(bare, () => true, gone))).toEqual(["ci on 4eae (starts work: arm a watch-only one with the same description)"]);
  expect(missingMonitors([ci], [], () => true, HOME, 0, workEnded(bare, () => false, gone))).toHaveLength(1);
});

test("two monitors with one description are judged by their own process, not by the first record with that name", () => {
  // foreground monitors (#414 review 44): a fed script would keep its watch before any process is matched
  const monitor = (pid: number) => {
    const command = `sleep 30 > /tmp/ci-${pid}.out`;
    const launch = launchOf(command, HOME, () => undefined);
    if (!launch || launch.detached) throw new Error("not foreground work");
    return { description: "ci on 4eae", command, persistent: true, pid, launch };
  };
  const first = { pid: 100, start: "s100", cmd: "ci on 4eae", pids: [101], starts: ["s101"] };
  const second = { pid: 200, start: "s200", cmd: "ci on 4eae", pids: [201], starts: ["s201"] };
  const done = workEnded([first, second], () => true, (pid) => ({ 100: "s999", 101: "s999", 200: "s200", 201: "s201" } as Record<number, string>)[pid]);
  // the first monitor's processes ended, the second's still run: only the first is not asked for
  expect(done(monitor(100) as never)).toBe(true);
  expect(done(monitor(200) as never)).toBe(false);
});

test("a process's start time comes from /proc, and a zombie has none", () => {
  const stat = (state: string) => () => `4242 (ba sh) ${state} 1 4242 4242 0 -1 4194304 100 0 0 0 0 0 0 0 20 0 1 0 987654 1000 10`;
  expect(procStart(4242, stat("S"))).toBe("987654");
  expect(procStart(4242, stat("Z"))).toBeUndefined();
  expect(procStart(4242, () => { throw new Error("ENOENT"); })).toBeUndefined();
});

test("a shell with no -c and no script reads its script from stdin and starts work, here or over ssh", () => {
  for (const c of ["bash < /tmp/job.sh", "ssh ori4eae bash < /tmp/job.sh", "ssh ori4eae 'bash' < /tmp/job.sh > /tmp/job.log 2>&1", "sudo -n -u oriclaw -H bash -l < /tmp/job.sh"]) {
    expect([c, launchOf(c, HOME)?.why]).toEqual([c, "a script run by a shell from its input (bash -s < file)"]);
  }
  for (const c of ["grep -c PASS < /tmp/x.log", "ssh ori4eae tail -F /tmp/x.log"]) {
    expect([c, launchOf(c, HOME)]).toEqual([c, undefined]);
  }
  // a shell given a string is not a plain watch shape (#414 after review 21): work that keeps its watch
  for (const c of ["bash -lc 'tail -F /tmp/x.log' < /dev/null"]) {
    expect([c, launchOf(c, HOME)?.why]).toEqual([c, "a script the handover cannot read"]);
  }
});


// #414 review 45: a foreground monitor whose work is its own process (the shell execs sleep) has no worker children, and
// monitorWork kept no record of it, so once it ended workEnded found nothing and the handover asked for it again
test("a foreground monitor whose work is its own root process is done once that process ended", async () => {
  const command = "sleep 30 > /tmp/root-only.out";
  const launch = launchOf(command, HOME, () => undefined);
  if (!launch || launch.detached) throw new Error("not foreground work");
  const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
  try {
    const entry = { description: "root only", command, persistent: true, suspended: false, expiresAt: null, runtime: { pid: child.pid } };
    const work = monitorWork([entry as never], await procTable(run), Date.now(), () => true, HOME);
    expect(work.map((w) => [w.pid, w.pids.length])).toEqual([[child.pid, 0]]);
    const monitor = { description: "root only", command, persistent: true, pid: child.pid, launch };
    expect(missingMonitors([monitor], [], () => true, HOME, 0, workEnded(work))).toHaveLength(1);
    child.kill();
    await child.exited;
    expect(missingMonitors([monitor], [], () => true, HOME, 0, workEnded(work))).toEqual([]);
  } finally {
    child.kill();
  }
});
