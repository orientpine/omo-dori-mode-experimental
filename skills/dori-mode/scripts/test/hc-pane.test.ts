import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureTmux, closeAoeSession, currentTmuxSession, isClosedLine, liveSessions, paneLife, sessionFor, tmuxPanePid } from "../src/aoe.ts";
import { useConfiguredRuntime } from "../src/run.ts";
import { hcType, paneGroup } from "../src/hc-pane.ts";
import { closeFrozen, readFrozen, writeFrozen } from "../src/frozen.ts";
import { sessionOf } from "../src/registry.ts";
import { openHerdrSession } from "../src/herdr.ts";
import { listPanes, submitToPane } from "../src/panes.ts";
import type { Runner } from "../src/run.ts";
import { FakeHc, terminal } from "./fake-hc.ts";
import { depsFor, fakeClock, newWorld, RUNNING } from "./fakes.ts";

// An hc terminal is the pane "hc:t<n>" in the fork's records (formatRef): every session primitive answers it through hc and
// never reaches herdr or tmux, which would read "hc:t1" as a pane or session of their own.
let dir: string;
let others: string[][];
const saved = process.env["DORI_RUNTIME"];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hc-pane-"));
  others = [];
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (saved === undefined) delete process.env["DORI_RUNTIME"];
  else process.env["DORI_RUNTIME"] = saved;
});

const runnerOf = (fake: FakeHc, ps = ""): Runner => async (argv) => {
  if (argv[0] === "ps" && ps) return { code: 0, out: ps, err: "" };
  if (argv[0] === "hc") {
    const r = await fake.exec("hc", argv.slice(1));
    return { code: r.code, out: r.stdout.trim(), err: r.stderr.trim() };
  }
  others.push([...argv]);
  return argv[0] === "aoe" ? { code: 0, out: "[]", err: "" } : { code: 1, out: "", err: "not here" };
};
// an hc pane sent to tmux or herdr: any tmux call, or a herdr call naming an "hc:" pane (a herdr listing of its own panes
// stays, while lanes still on herdr are moved)
const touched = (): string[][] => others.filter((c) => c[0] === "tmux" || (c[0] === "herdr" && c.some((a) => a.startsWith("hc:"))));

test("an hc pane is live while its agent reports, dead with only its shell in front, gone when hc has no such terminal", async () => {
  const fake = new FakeHc({
    t1: terminal({ screen: "hello from t1", pid: 900 }),
    t2: terminal({ status: null, reported: false, foreground: { name: "bash", argv: ["bash"], pid: 77 } }),
  });
  const run = runnerOf(fake);
  expect([await paneLife(run, "hc:t1"), await paneLife(run, "hc:t2"), await paneLife(run, "hc:t3")]).toEqual([{ live: true }, { live: false, how: "dead", status: -1 }, { live: false, how: "gone" }]);
  expect(await captureTmux(run, "hc:t1")).toBe("hello from t1");
  expect(await tmuxPanePid(run, "hc:t1")).toBe(900);
  expect(touched()).toEqual([]);
});

test("text for an hc omo pane goes in through hc send and reads SUBMITTED; a gone or dead one is named and nothing is sent", async () => {
  const fake = new FakeHc({
    t1: terminal({ screen: `${RUNNING}\n─────\n❯ \n─────` }),
    t2: terminal({ status: null, reported: false, foreground: { name: "bash", argv: ["bash"], pid: 77 } }),
  });
  const deps = depsFor(newWorld(), fakeClock(0), dir, { backend: "herdr" });
  const run = runnerOf(fake);
  expect(await submitToPane(run, deps.clock, deps.config, "hc:t3", "[LEAD] hi")).toMatchObject({ status: "NOT_SUBMITTED", reason: expect.stringContaining("PANE_GONE") });
  expect(await submitToPane(run, deps.clock, deps.config, "hc:t2", "[LEAD] hi")).toMatchObject({ status: "NOT_SUBMITTED", reason: expect.stringContaining("PANE_DEAD") });
  expect(fake.sent).toEqual([]);
  expect((await submitToPane(run, deps.clock, deps.config, "hc:t1", "[LEAD] hi")).status).toBe("SUBMITTED");
  expect(fake.sent).toEqual([{ id: "t1", text: "[LEAD] hi" }]);
  expect(touched()).toEqual([]);
});

test("an open omo question in an hc pane gets nothing typed", async () => {
  const fake = new FakeHc({ t1: terminal({ screen: "Ask user · pick one\n─────\n❯ \n─────" }) });
  const deps = depsFor(newWorld(), fakeClock(0), dir, { backend: "herdr" });
  expect(await submitToPane(runnerOf(fake), deps.clock, deps.config, "hc:t1", "[LEAD] hi")).toMatchObject({ status: "NOT_SUBMITTED", reason: expect.stringContaining("PANE_BLOCKED") });
  expect(fake.sent).toEqual([]);
});

test("a lane opened while hc is the runtime is an hc terminal, listed and found as hc:<id>, and closed through hc", async () => {
  process.env["DORI_RUNTIME"] = "hc";
  const fake = new FakeHc();
  const run = runnerOf(fake);
  const opened = await openHerdrSession(run, fakeClock(0), { title: "k1", cwd: "/w", argv: ["omo", "--model", "m"], env: { A: "1" } });
  expect(opened).toEqual({ pane: "hc:t1" });
  expect(fake.calls.find((c) => c[0] === "run")).toEqual(expect.arrayContaining(["--label", "dori.lane=k1"]));
  expect(fake.calls.find((c) => c[0] === "send")?.at(-1)).toBe("env A=1 omo --model m");
  expect(sessionFor(await liveSessions(run), "hc:t1")?.path).toBe("/w");
  const line = await closeAoeSession(run, "hc:t1");
  expect(isClosedLine(line)).toBe(true);
  expect(fake.terminals.has("t1")).toBe(false);
  expect(touched()).toEqual([]);
});

test("the sweeps' pane rows name an hc terminal hc:<id>, so the dead-pane sweep reads it through hc", async () => {
  const fake = new FakeHc({ t1: terminal() });
  expect((await listPanes(runnerOf(fake), { backend: "herdr", runtime: "hc" })).map((p) => p.pane_id)).toEqual(["hc:t1"]);
});

test("a Dori on herdr never calls hc for its listing, so no hc core is started where none is used", async () => {
  delete process.env["DORI_RUNTIME"];
  const fake = new FakeHc({ t1: terminal() });
  await liveSessions(runnerOf(fake));
  expect(fake.calls).toEqual([]);
});

test("a shell in front that runs a command (bash -c reading stdin) gets nothing typed, whatever status hc kept (review 1 of #404)", async () => {
  const fake = new FakeHc({ t1: terminal({ foreground: { name: "bash", argv: ["bash", "-c", "while read -r l; do eval \"$l\"; done"], pid: 50 } }) });
  const deps = depsFor(newWorld(), fakeClock(0), dir, { backend: "herdr" });
  expect((await submitToPane(runnerOf(fake), deps.clock, deps.config, "hc:t1", "[LEAD] hi")).status).toBe("NOT_SUBMITTED");
  expect(fake.sent).toEqual([]);
});

test("a stopped agent under an hc terminal gets nothing typed even with a working screen kept (review 1 of #404)", async () => {
  const fake = new FakeHc({ t1: terminal({ pid: 900, screen: `${RUNNING}\n─────\n❯ \n─────` }) });
  const deps = depsFor(newWorld(), fakeClock(0), dir, { backend: "herdr" });
  const ps = "900 1 900 Ss bash\n4242 900 900 T omo --session-id x";
  expect(await submitToPane(runnerOf(fake, ps), deps.clock, deps.config, "hc:t1", "[LEAD] hi")).toMatchObject({ status: "NOT_SUBMITTED", reason: expect.stringContaining("stopped") });
  expect(fake.sent).toEqual([]);
});

test("the caller inside an hc terminal is the pane hc:<id>, the shape its lane record keeps (review 1 of #404)", async () => {
  const kept = process.env["HC_TERMINAL_ID"];
  process.env["HC_TERMINAL_ID"] = "t7";
  try {
    expect(await currentTmuxSession(runnerOf(new FakeHc()))).toBe("hc:t7");
  } finally {
    if (kept === undefined) delete process.env["HC_TERMINAL_ID"];
    else process.env["HC_TERMINAL_ID"] = kept;
  }
});

test("the sweeps list hc terminals by the configured workspaces' dori.group, so a workspace filter keeps them (review 1 of #404)", async () => {
  const fake = new FakeHc({ t1: terminal({ labels: { "dori.group": "lanes" } }), t2: terminal({ labels: { "dori.group": "other" } }) });
  const rows = await listPanes(runnerOf(fake), { backend: "herdr", runtime: "hc", workspaces: ["lanes"] });
  expect(rows.map((p) => [p.pane_id, p.workspace_id])).toEqual([["hc:t1", "lanes"], ["hc:t2", ""]]);
});

test("a config that names hc is what an entrypoint's openers and listings follow once it is handed over, with no DORI_RUNTIME (review 1 of #404)", async () => {
  delete process.env["DORI_RUNTIME"];
  useConfiguredRuntime("hc");
  try {
    const fake = new FakeHc({ t1: terminal() });
    expect(sessionFor(await liveSessions(runnerOf(fake)), "hc:t1")).toBeDefined();
  } finally {
    useConfiguredRuntime(undefined);
  }
});

test("an hc pane's group: its dori.group label when hc answers; gone and unreadable both refuse, never the default group (review 3 of #404)", async () => {
  const fake = new FakeHc({ t1: terminal({ labels: { "dori.group": "lanes" } }) });
  expect(await paneGroup(runnerOf(fake), "hc:t1")).toBe("lanes");
  await expect(paneGroup(runnerOf(fake), "hc:t9")).rejects.toThrow(/no hc terminal/);
  fake.knobs = { getError: "unavailable" };
  await expect(paneGroup(runnerOf(fake), "hc:t1")).rejects.toThrow(/could not be read/);
});

test("a lead handover started with DORI_RUNTIME=hc and no runtime in the config hands the runtime to its detached run (review 4 of #404)", async () => {
  // Given: the caller is the lead's hc terminal, the config names no runtime, and a systemd-run that records its argv
  const home = mkdtempSync(join(tmpdir(), "hc-detach-"));
  try {
    writeFileSync(join(home, "systemd-run"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${home}/argv"\n`);
    chmodSync(join(home, "systemd-run"), 0o700);
    writeFileSync(join(home, "config.json"), JSON.stringify({ stateDir: join(home, "state"), leadPane: "hc:t9" }));
    const env = { HOME: home, PATH: `${home}:${process.env["PATH"]}`, DORI_CONFIG: join(home, "config.json"), DORI_ENV_FILE: join(home, "dori.env"), DORI_STATE_DIR: join(home, "state"), DORI_RUNTIME: "hc", HC_TERMINAL_ID: "t9", HC_SESSION: "named" };
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "handover", "--approved-by", "test"], { env, stdout: "pipe", stderr: "pipe" });
    const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    // Then: it detached, and the unit gets DORI_RUNTIME, so the replacement lead opens on hc
    expect(`${code} ${out.split(" ")[0]}`).toBe("0 HANDOVER_DETACHED");
    // and HC_SESSION, the named core its sessions live in (review 6 of #404), never this terminal's own HC_TERMINAL_ID
    const argv = readFileSync(join(home, "argv"), "utf8").split("\n");
    expect(argv).toContain("--setenv=DORI_RUNTIME");
    expect(argv).toContain("--setenv=HC_SESSION");
    expect(argv.some((a) => a.includes("HC_TERMINAL_ID"))).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an hc Dori's pane listing needs no herdr, even after liveSessions built a herdr adapter (review 5 of #404)", async () => {
  delete process.env["DORI_RUNTIME"];
  useConfiguredRuntime("hc");
  try {
    const run = runnerOf(new FakeHc({ t1: terminal() }));
    await liveSessions(run);
    expect((await listPanes(run, { backend: "herdr", runtime: "hc" })).map((p) => p.pane_id)).toEqual(["hc:t1"]);
  } finally {
    useConfiguredRuntime(undefined);
  }
});

test("an hc listing that fails on an hc Dori is no empty list, so frozen cleanup keeps its record (review 5 of #404)", async () => {
  delete process.env["DORI_RUNTIME"];
  useConfiguredRuntime("hc");
  try {
    const base = runnerOf(new FakeHc({ t1: terminal() }));
    const lsDown: Runner = async (argv) => (argv[0] === "hc" && argv.includes("ls") ? { code: 5, out: "", err: JSON.stringify({ error: { kind: "unavailable", message: "core down" } }) } : base(argv));
    await expect(liveSessions(lsDown)).rejects.toThrow();
  } finally {
    useConfiguredRuntime(undefined);
  }
});

test("a frozen hc session whose terminal still runs after the close is kept and stopped again, not removed (review 6 of #404)", async () => {
  // Given: hc's kill does not end the program, so rm keeps answering live and hc's close gives up without throwing
  delete process.env["DORI_RUNTIME"];
  useConfiguredRuntime("hc");
  try {
    const fake = new FakeHc({ t1: terminal() });
    const base = runnerOf(fake);
    const run: Runner = async (argv) => (argv[0] === "hc" && argv.includes("kill") ? { code: 0, out: "{}", err: "" } : base(argv));
    const rec = { pane: "hc:t1", aoeId: "hc:t1", at: "2026-11-08T00:00:00.000Z", agentPid: 11, pids: [11], closeAt: "2026-11-08T01:00:00.000Z", to: "hc:t2" };
    writeFrozen(dir, rec);
    const sigs: string[] = [];
    const line = await closeFrozen({ run, procs: async () => [], signal: (pid, sig) => (sigs.push(`${sig} ${pid}`), true) }, dir, rec, Date.parse("2026-11-08T02:00:00Z"));
    // Then: a close failure, the agent stopped again and the record kept for the next try
    expect(line).toStartWith("HANDOVER_OLD_CLOSE_FAIL hc:t1");
    expect(sigs).toEqual(["SIGCONT 11", "SIGSTOP 11"]);
    expect(readFrozen(dir).map((r) => r.pane)).toEqual(["hc:t1"]);
  } finally {
    useConfiguredRuntime(undefined);
  }
});

test("an hc address past t19 (t1b: hc counts in digits and consonants) is a pane the records keep, and an old question in history blocks nothing (review 7 of #404)", async () => {
  expect(sessionOf({ key: "k", title: "t", thread: "none", brief: "/b", done: "file /x", openedAt: "2026-01-01T00:00:00Z", cwd: "/w", pane: "hc:t1b" } as never)?.id).toBe("t1b");
  // Given: the agent is idle on screen, an answered Ask user question only in the history above it
  const fake = new FakeHc({ t1b: terminal({ screen: "omo idle\n> ", history: "Ask user · pick one" }) });
  expect(await hcType(runnerOf(fake), "hc:t1b", "PING")).toBeUndefined();
  expect(fake.sent).toEqual([{ id: "t1b", text: "PING" }]);
});

test("an omo lead that hc reads as working while only its monitors are live still gets dori type's text (upstream issue #178)", async () => {
  // Given: hc's word is working ("7 monitors live"), the screen is omo's idle input
  const fake = new FakeHc({ t1: terminal({ status: { state: "working", app: "omo" }, screen: "omo idle\n> " }) });
  // Then: the fork's dori type sends with no --if gate, so the text lands; nothing waits on hc's word turning idle
  expect(await hcType(runnerOf(fake), "hc:t1", "[REPORT] x")).toBeUndefined();
  expect(fake.calls.find((c) => c[0] === "send")?.includes("--if")).toBe(false);
});

test("doubt is no verdict on hc: a failed hc get leaves the lane live, a failed screen read holds the text (plan-r8, challenge)", async () => {
  const fake = new FakeHc({ t1: terminal({ status: { state: "working", app: "omo" }, screen: "Ask user · pick one" }) });
  const base = runnerOf(fake);
  const down = (verb: string): Runner => async (argv) => (argv[0] === "hc" && argv.includes(verb) ? { code: 5, out: "", err: JSON.stringify({ error: { kind: "unavailable", message: "core busy" } }) } : base(argv));
  expect(await paneLife(down("get"), "hc:t1")).toEqual({ live: true });
  expect(await hcType(base, "hc:t1", "x")).toStartWith("PANE_BLOCKED");
  expect(await hcType(down("read"), "hc:t1", "x")).toContain("could not be read");
  expect(fake.sent).toEqual([]);
});
