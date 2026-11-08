import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveSessions, sessionFor } from "../src/aoe.ts";
import { type Runner, useConfiguredRuntime } from "../src/run.ts";
import { useDoriState } from "../src/hc-pane.ts";
import { Registry } from "../src/registry.ts";
import { listPanes } from "../src/panes.ts";
import { FakeHc, terminal } from "./fake-hc.ts";

// A Dori with sessions on both runtimes (a dori migrate in progress): what its open lanes, lead and frozen records live on
// is listed and looked up at each listing (hc-pane.ts storedRuntimes), split off hc-pane.test.ts by the 250-line rule.
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

const HERDR_PANE = JSON.stringify({ result: { panes: [{ pane_id: "w1:p2", workspace_id: "w1", agent: "pi", agent_status: "idle" }] } });
// herdr: undefined (not on this host: every call fails, as by default), or the JSON every herdr call answers
const runnerOf = (fake: FakeHc, ps = "", herdr?: string): Runner => async (argv) => {
  if (argv[0] === "ps" && ps) return { code: 0, out: ps, err: "" };
  if (argv[0] === "herdr" && herdr !== undefined) return { code: 0, out: herdr, err: "" };
  if (argv[0] === "hc") {
    const r = await fake.exec("hc", argv.slice(1));
    return { code: r.code, out: r.stdout.trim(), err: r.stderr.trim() };
  }
  others.push([...argv]);
  return argv[0] === "aoe" ? { code: 0, out: "[]", err: "" } : { code: 1, out: "", err: "not here" };
};

describe("the runtimes the Dori's open sessions live on are read at each listing (reviews 2 and 3 of #404)", () => {
  const LANE = { title: "t", thread: "none", brief: "/b", done: "file /x", openedAt: "2026-01-01T00:00:00Z", cwd: "/w" };
  const lanesAt = async (lanes: { key: string; pane: string; status?: string }[]) => {
    const reg = new Registry(dir);
    for (const l of lanes) await reg.write({ ...LANE, ...l } as never);
  };
  const leadIs = (pane: string) => writeFileSync(join(dir, "config.json"), JSON.stringify({ leadPane: pane }));
  const dori = (lead: string) => {
    leadIs(lead);
    useDoriState({ stateDir: dir, configPath: join(dir, "config.json") });
  };
  afterEach(() => {
    useConfiguredRuntime(undefined);
    useDoriState(undefined);
  });

  test("a Dori moved to hc still lists its open herdr lanes for sync and the dead-pane sweep", async () => {
    delete process.env["DORI_RUNTIME"];
    useConfiguredRuntime("hc");
    await lanesAt([{ key: "a", pane: "w1:p2" }, { key: "b", pane: "hc:t1" }]);
    dori("");
    const rows = await listPanes(runnerOf(new FakeHc({ t1: terminal() }), "", HERDR_PANE), { backend: "herdr", runtime: "hc" });
    expect(rows.map((p) => p.pane_id).sort()).toEqual(["hc:t1", "w1:p2"]);
  });

  test("a Dori back on herdr still finds its hc lead for handover, revive and frozen cleanup", async () => {
    process.env["DORI_RUNTIME"] = "herdr";
    dori("hc:t1");
    expect(sessionFor(await liveSessions(runnerOf(new FakeHc({ t1: terminal() }))), "hc:t1")).toBeDefined();
  });

  test("a closed herdr lane, a tmux-named lane and a herdr adapter built on the way require no herdr of an hc-only Dori", async () => {
    delete process.env["DORI_RUNTIME"];
    useConfiguredRuntime("hc");
    await lanesAt([{ key: "old", pane: "w1:p2", status: "closed" }, { key: "aoe", pane: "aoe_x_1" }, { key: "b", pane: "hc:t1" }]);
    dori("hc:t1");
    const run = runnerOf(new FakeHc({ t1: terminal() }));
    await liveSessions(run);
    expect((await listPanes(run, { backend: "herdr", runtime: "hc" })).map((p) => p.pane_id)).toEqual(["hc:t1"]);
  });

  test("the lead moved to hc after the watcher started is listed on its next tick with herdr gone (challenge of plan-r3)", async () => {
    delete process.env["DORI_RUNTIME"];
    useConfiguredRuntime("hc");
    dori("w1:p1");
    const fake = new FakeHc({ t1: terminal() });
    await listPanes(runnerOf(fake, "", HERDR_PANE), { backend: "herdr", runtime: "hc" });
    leadIs("hc:t1");
    expect((await listPanes(runnerOf(fake), { backend: "herdr", runtime: "hc" })).map((p) => p.pane_id)).toEqual(["hc:t1"]);
  });

  test("the first hc lane opened after a long-running watcher started is listed on its next tick", async () => {
    process.env["DORI_RUNTIME"] = "herdr";
    dori("w1:p1");
    const fake = new FakeHc({ t1: terminal() });
    expect(sessionFor(await liveSessions(runnerOf(fake)), "hc:t1")).toBeUndefined();
    expect(fake.calls).toEqual([]);
    await lanesAt([{ key: "k", pane: "hc:t1" }]);
    expect(sessionFor(await liveSessions(runnerOf(fake)), "hc:t1")).toBeDefined();
  });

  test("an hc listing that fails while a stored session lives on hc is no empty list, so frozen cleanup keeps its record", async () => {
    process.env["DORI_RUNTIME"] = "herdr";
    dori("hc:t1");
    const fake = new FakeHc({ t1: terminal() });
    const base = runnerOf(fake);
    const lsDown: Runner = async (argv) => (argv[0] === "hc" && argv[2] === "ls" ? { code: 5, out: "", err: JSON.stringify({ error: { kind: "unavailable", message: "core down" } }) } : base(argv));
    await expect(liveSessions(lsDown)).rejects.toThrow();
  });

  test("a lead DORI_LEAD_PANE names is the lead whatever the file says, both ways, with no lane records (review 4 of #404)", async () => {
    const fake = new FakeHc({ t1: terminal() });
    try {
      // herdr chosen, the file's lead a herdr pane, DORI_LEAD_PANE an hc terminal: that terminal is listed for revive
      process.env["DORI_RUNTIME"] = "herdr";
      dori("w1:p1");
      process.env["DORI_LEAD_PANE"] = "hc:t1";
      expect(sessionFor(await liveSessions(runnerOf(fake, "", HERDR_PANE)), "hc:t1")).toBeDefined();
      // hc chosen, the file still naming an old herdr lead, DORI_LEAD_PANE the hc lead: herdr is no required runtime
      delete process.env["DORI_RUNTIME"];
      useConfiguredRuntime("hc");
      const herdrDown: Runner = async (argv) => (argv[0] === "herdr" ? { code: 1, out: "", err: "no herdr" } : runnerOf(fake)(argv));
      expect((await listPanes(herdrDown, { backend: "herdr", runtime: "hc" })).map((p) => p.pane_id)).toEqual(["hc:t1"]);
    } finally {
      delete process.env["DORI_LEAD_PANE"];
    }
  });

});
