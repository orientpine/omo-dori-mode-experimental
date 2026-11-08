import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureTmux, closeAoeSession, isClosedLine, liveSessions, paneLife, sessionFor, tmuxPanePid } from "../src/aoe.ts";
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

const runnerOf = (fake: FakeHc): Runner => async (argv) => {
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
