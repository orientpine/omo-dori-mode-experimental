import { expect, test } from "bun:test";

import { launchOf } from "../src/handover.ts";

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
  expect(launchOf("bash -s >/tmp/log; cat < /tmp/result", HOME, read)?.detached ?? true).toBe(true);
  // the remote ci of port-hc-runtime (2026-11-08 22:35Z): one absolute input, read, and its plain work ends with the watch
  const ci = launchOf("node-dori-do oriclaw bash -lc 'ssh -o BatchMode=yes ori4eae bash -s' < /tmp/ci.sh > /tmp/ci.log 2>&1; echo CI4EAE_DONE", HOME, (path) => (path === "/tmp/ci.sh" ? "git worktree add -q --detach /tmp/w x\nbun run ci\n" : undefined));
  expect(ci?.detached).toBe(false);
});

