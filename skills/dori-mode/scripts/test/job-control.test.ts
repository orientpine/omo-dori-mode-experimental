import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

const lockDir = (): string => mkdtempSync(join(tmpdir(), "resume-lock-"));

import { holdOf, type JobStat, jobSignal, type ResumeIO, resumeAgent } from "../src/job-control.ts";

// A herdr pane as measured on 2026-11-04 (pane w2:p2): its interactive bash 100 leads session 100 on the tty, and omo 200
// is that shell's foreground job (its own process group 200), with a child 201 in the same group.
type Row = { -readonly [K in keyof JobStat]: JobStat[K] };
const pane = (): Map<number, Row> =>
  new Map([
    [100, { pid: 100, state: "S", ppid: 50, pgrp: 100, session: 100, tpgid: 200 }],
    [200, { pid: 200, state: "S", ppid: 100, pgrp: 200, session: 100, tpgid: 200 }],
    [201, { pid: 201, state: "S", ppid: 200, pgrp: 200, session: 100, tpgid: 200 }],
  ]);

// The kernel's job control in a few lines: a stopped foreground job hands the tty back to its shell, unless the shell is
// stopped itself and cannot take it; SIGCONT resumes a process and leaves the tty where it is.
const kernel = (rows: Map<number, Row>) => {
  const sent: string[] = [];
  const setTpgid = (g: number) => {
    for (const r of rows.values()) r.tpgid = g;
  };
  const signal = (pid: number, sig: "SIGSTOP" | "SIGCONT"): boolean => {
    sent.push(`${sig} ${pid}`);
    const group = pid < 0 ? [...rows.values()].filter((r) => r.pgrp === -pid) : [rows.get(pid)].filter((r): r is Row => !!r);
    if (!group.length) return false;
    for (const r of group) r.state = sig === "SIGSTOP" ? "T" : "S";
    const shell = rows.get(100);
    const job = rows.get(200);
    if (sig === "SIGSTOP" && job?.state === "T" && shell && shell.state !== "T" && job.tpgid === job.pgrp) setTpgid(shell.pgrp);
    return true;
  };
  return { sent, signal, stat: (pid: number) => (rows.get(pid) ? { ...rows.get(pid)! } : undefined), setTpgid };
};

test("a freeze of a shell's foreground job stops the shell first and resumes it last, so the tty stays with the job", () => {
  // Given: omo is the foreground job of the pane's interactive shell
  const rows = pane();
  const k = kernel(rows);
  const signal = jobSignal(k.signal, k.stat);
  // When: it is frozen and thawed as a handover does (children last on the way in, first on the way out)
  expect(signal(200, "SIGSTOP")).toBe(true);
  expect(signal(201, "SIGSTOP")).toBe(true);
  expect(rows.get(200)?.tpgid).toBe(200);
  expect(signal(201, "SIGCONT")).toBe(true);
  expect(signal(200, "SIGCONT")).toBe(true);
  // Then: the shell never took the tty, and everything runs again
  expect(k.sent).toEqual(["SIGSTOP 100", "SIGSTOP 200", "SIGSTOP 201", "SIGCONT 201", "SIGCONT 200", "SIGCONT 100"]);
  expect([...rows.values()].map((r) => `${r.pid} ${r.state} ${r.tpgid}`)).toEqual(["100 S 200", "200 S 200", "201 S 200"]);
  expect(holdOf(k.stat, 200)).toBeUndefined();
});

test("without the shell bracket the same freeze leaves omo a background job (the 2026-11-03 handover-simplify state)", () => {
  const rows = pane();
  const k = kernel(rows);
  k.signal(200, "SIGSTOP");
  k.signal(200, "SIGCONT");
  expect(rows.get(200)?.tpgid).toBe(100);
  expect(holdOf(k.stat, 200)).toBe("background");
  rows.get(200)!.state = "T";
  expect(holdOf(k.stat, 200)).toBe("stopped");
});

test("an agent that leads its own session (a tmux pane running it directly) gets no bracket: its parent is no job shell", () => {
  const rows = new Map<number, Row>([
    [10, { pid: 10, state: "S", ppid: 1, pgrp: 10, session: 10, tpgid: -1 }],
    [20, { pid: 20, state: "S", ppid: 10, pgrp: 20, session: 20, tpgid: 20 }],
  ]);
  const sent: string[] = [];
  const signal = jobSignal((pid, sig) => (sent.push(`${sig} ${pid}`), true), (pid) => rows.get(pid));
  signal(20, "SIGSTOP");
  signal(20, "SIGCONT");
  expect(sent).toEqual(["SIGSTOP 20", "SIGCONT 20"]);
});

test("a failed stop of the agent resumes the shell it stopped first", () => {
  const rows = pane();
  const sent: string[] = [];
  const signal = jobSignal((pid, sig) => (sent.push(`${sig} ${pid}`), pid !== 200), (pid) => rows.get(pid));
  expect(signal(200, "SIGSTOP")).toBe(false);
  expect(sent).toEqual(["SIGSTOP 100", "SIGSTOP 200", "SIGCONT 100"]);
});

const io = (rows: Map<number, Row>, k: ReturnType<typeof kernel>, opts: { jobs?: number; cooked?: boolean; fgWorks?: boolean } = {}) => {
  const calls: string[][] = [];
  let cooked = opts.cooked ?? true;
  const r: ResumeIO = {
    clock: { now: () => 0, sleep: async () => {} },
    signal: k.signal,
    stat: k.stat,
    tty: () => "/dev/pts/17",
    lockDir: lockDir(),
    jobs: () => Array.from({ length: opts.jobs ?? 1 }, (_, i) => 200 + i * 100),
    run: async (argv) => {
      calls.push([...argv]);
      if (argv[0] === "herdr" && argv[2] === "run" && argv[4] === "fg" && opts.fgWorks !== false) {
        k.setTpgid(200);
        rows.get(200)!.state = "S";
      }
      if (argv[0] === "stty" && argv[3] === "-a") return { code: 0, out: cooked ? "isig icanon iexten echo" : "-isig -icanon -iexten -echo", err: "" };
      if (argv[0] === "stty" && argv[3] === "size") return { code: 0, out: "40 119\n", err: "" };
      if (argv[0] === "stty" && argv.includes("-icanon")) cooked = false;
      return { code: 0, out: "", err: "" };
    },
  };
  return { r, calls };
};

test("resume brings a background omo back: drops the shell's pending input, types fg, gives back raw mode and redraws", async () => {
  // Given: the unbracketed freeze left omo stopped in the background and bash cooked the tty
  const rows = pane();
  const k = kernel(rows);
  k.signal(200, "SIGSTOP");
  k.signal(200, "SIGCONT");
  rows.get(200)!.state = "T";
  const { r, calls } = io(rows, k);
  // When
  const line = await resumeAgent(r, "w2:p2", 200);
  // Then: bash's pending input is dropped (ctrl-C) before fg, the tty is raw again and omo is the running foreground job
  expect(line).toBe("AGENT_RESUMED w2:p2 agent 200: fg typed into the shell, raw tty mode given back, redrawn");
  expect(calls.slice(0, 2)).toEqual([["herdr", "pane", "send-text", "w2:p2", "\x03"], ["herdr", "pane", "run", "w2:p2", "fg"]]);
  expect(calls.some((c) => c[0] === "stty" && c.includes("-icanon") && c.includes("-echo"))).toBe(true);
  expect(calls.filter((c) => c[0] === "stty" && c[3] === "cols").map((c) => c[4])).toEqual(["118", "119"]);
  expect(holdOf(k.stat, 200)).toBeUndefined();
});

test("resume of a stopped foreground omo only continues it; a running one is left alone", async () => {
  const rows = pane();
  const k = kernel(rows);
  rows.get(200)!.state = "T";
  rows.get(201)!.state = "T";
  const { r, calls } = io(rows, k);
  expect(await resumeAgent(r, "w2:p2", 200)).toBe("AGENT_RESUMED w2:p2 agent 200: its process group continued");
  expect(calls).toEqual([]);
  expect(k.sent).toEqual(["SIGCONT -200"]);
  expect(await resumeAgent(r, "w2:p2", 200)).toBe("AGENT_RUNNING w2:p2 agent 200");
});

test("resume types nothing when the shell holds more than one job, and says what is left to do", async () => {
  const rows = pane();
  const k = kernel(rows);
  k.signal(200, "SIGSTOP");
  k.signal(200, "SIGCONT");
  const { r, calls } = io(rows, k, { jobs: 2 });
  expect(await resumeAgent(r, "w2:p2", 200)).toBe("AGENT_RESUME_FAIL w2:p2 agent 200: the shell 100 holds 2 jobs, so fg could pick another; type fg with the job of pid 200 in the pane (state S, tty foreground group 100, its group 200)");
  expect(calls).toEqual([]);
});

test("resume that fg could not bring forward says so", async () => {
  const rows = pane();
  const k = kernel(rows);
  k.signal(200, "SIGSTOP");
  k.signal(200, "SIGCONT");
  const { r } = io(rows, k, { fgWorks: false });
  expect(await resumeAgent(r, "w2:p2", 200)).toBe("AGENT_RESUME_FAIL w2:p2 agent 200: stopped so that only the shell reads the line, fg typed into the shell, still not the running foreground job (state T, tty foreground group 100, its group 200)");
});

test("resume stops a background omo that still runs before it types fg, so the shell and not omo reads the line", async () => {
  // Given: thawed into the background and running (no key typed yet)
  const rows = pane();
  const k = kernel(rows);
  k.signal(200, "SIGSTOP");
  k.signal(200, "SIGCONT");
  const { r, calls } = io(rows, k);
  // When
  const line = await resumeAgent(r, "w2:p2", 200);
  // Then: its group is stopped before anything is typed
  expect(k.sent.slice(2)).toEqual(["SIGSTOP -200"]);
  expect(calls[0]).toEqual(["herdr", "pane", "send-text", "w2:p2", "\x03"]);
  expect(line).toBe("AGENT_RESUMED w2:p2 agent 200: stopped so that only the shell reads the line, fg typed into the shell, raw tty mode given back, redrawn");
});

test("resume types nothing more when the ctrl-C that drops the shell's pending input could not be sent", async () => {
  const rows = pane();
  const k = kernel(rows);
  k.signal(200, "SIGSTOP");
  k.signal(200, "SIGCONT");
  rows.get(200)!.state = "T";
  const { r, calls } = io(rows, k);
  const failing: ResumeIO = { ...r, run: async (argv, opts) => (argv[0] === "herdr" && argv[2] === "send-text" ? (calls.push([...argv]), { code: 1, out: "", err: "send failed" }) : r.run(argv, opts)) };
  const line = await resumeAgent(failing, "w2:p2", 200);
  expect(line).toBe("AGENT_RESUME_FAIL w2:p2 agent 200: could not drop the shell's pending input (ctrl-C not sent); nothing more typed (state T, tty foreground group 100, its group 200)");
  expect(calls).toEqual([["herdr", "pane", "send-text", "w2:p2", "\x03"]]);
});

test("a second repair of the same agent while one runs types nothing (watch and revive at once)", async () => {
  const rows = pane();
  const k = kernel(rows);
  k.signal(200, "SIGSTOP");
  k.signal(200, "SIGCONT");
  const { r, calls } = io(rows, k);
  writeFileSync(join(r.lockDir!, `dori-resume-${process.getuid?.() ?? 0}-200.lock`), "4242");
  const busy: ResumeIO = { ...r, alive: (pid) => pid === 4242 };
  expect(await resumeAgent(busy, "w2:p2", 200)).toBe("AGENT_RESUME_BUSY w2:p2 agent 200: another repair of it runs; nothing typed");
  expect(calls).toEqual([]);
  // a lock whose holder ended is taken over
  expect(await resumeAgent({ ...r, alive: () => false }, "w2:p2", 200)).toStartWith("AGENT_RESUMED w2:p2 agent 200:");
});

test("fg is not typed when the tty changed hands after the ctrl-C (another process brought the agent forward)", async () => {
  const rows = pane();
  const k = kernel(rows);
  k.signal(200, "SIGSTOP");
  k.signal(200, "SIGCONT");
  rows.get(200)!.state = "T";
  const { r, calls } = io(rows, k);
  const racing: ResumeIO = { ...r, run: async (argv, opts) => {
    const got = await r.run(argv, opts);
    if (argv[0] === "herdr" && argv[2] === "send-text") {
      k.setTpgid(200);
      rows.get(200)!.state = "S";
    }
    return got;
  } };
  expect(await resumeAgent(racing, "w2:p2", 200)).toContain("the tty changed hands before fg; fg not typed");
  expect(calls.some((c) => c[2] === "run")).toBe(false);
});
