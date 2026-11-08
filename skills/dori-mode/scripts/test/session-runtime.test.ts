import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigError, loadConfig } from "../src/config.ts";
import { type Lane, Registry, sessionOf } from "../src/registry.ts";
import { type Runner, runtimeChoice, runtimesFor } from "../src/run.ts";
import { closeSession, listSessions } from "../src/sessions.ts";
import { openHerdrSession } from "../src/herdr.ts";

const scratch = (): string => mkdtempSync(join(tmpdir(), "dori-session-runtime-"));
const base = { title: "t", thread: "none", brief: "/b", done: "d", openedAt: "2026-11-08T00:00:00.000Z" };

const stored = (dir: string, lane: Record<string, unknown>): void => {
  const reg = new Registry(dir);
  writeFileSync(reg.path(String(lane["key"])), JSON.stringify(lane));
};

describe("lane records carry their session (upstream #154 sessionRef)", () => {
  test("a record written before runtimes (herdr pane and tab) reads with its herdr sessionRef", async () => {
    const dir = scratch();
    await new Registry(dir).list();
    stored(dir, { key: "old-herdr", ...base, pane: "w1:p3", tab: "w1:t3" });
    const lane = await new Registry(dir).read("old-herdr");
    expect(lane?.sessionRef).toEqual({ runtime: "herdr", id: "w1:p3", container: "w1:t3" });
  });

  test("an aoe (tmux) session name gets no sessionRef: tmux is no runtime", async () => {
    const dir = scratch();
    await new Registry(dir).list();
    stored(dir, { key: "old-aoe", ...base, pane: "dori-old-aoe" });
    expect((await new Registry(dir).read("old-aoe"))?.sessionRef).toBeUndefined();
  });

  test("a pane changed without its sessionRef (a handover spread) follows the pane, written and read", async () => {
    const dir = scratch();
    const reg = new Registry(dir);
    await reg.write({ key: "moved", ...base, pane: "w1:p3", sessionRef: { runtime: "herdr", id: "w1:p3" } } as Lane);
    const before = await reg.read("moved");
    await reg.write({ ...before!, pane: "w1:p9", tab: "w1:t9" });
    expect((await Bun.file(reg.path("moved")).json()).sessionRef).toEqual({ runtime: "herdr", id: "w1:p9", container: "w1:t9" });
    expect(sessionOf({ key: "x", ...base, pane: "w2:p1" } as Lane)).toEqual({ runtime: "herdr", id: "w2:p1" });
  });

  test("bySession finds the open lane of the caller's own session (selfAny)", async () => {
    const dir = scratch();
    const reg = new Registry(dir);
    await reg.write({ key: "mine", ...base, pane: "w1:p4G" } as Lane);
    const self = runtimesFor({}, { HERDR_PANE_ID: "w1:p4G", HERDR_WORKSPACE_ID: "w1" }).selfAny({ HERDR_PANE_ID: "w1:p4G", HERDR_WORKSPACE_ID: "w1" });
    expect((await reg.bySession(self))?.key).toBe("mine");
    expect(await reg.bySession(undefined)).toBeNull();
  });
});

test("a lane session closes through its runtime: its tab when it has one, else its pane, and a failed close is named", async () => {
  const calls: string[][] = [];
  const run: Runner = async (argv) => {
    calls.push([...argv]);
    return argv[2] === "close" && argv[3] === "w1:p4" ? { code: 1, out: "", err: "pane_not_found" } : { code: 0, out: '{"result":{}}', err: "" };
  };
  const rts = runtimesFor({}, {}, run);
  expect(await closeSession(rts, { runtime: "herdr", id: "w1:p3", container: "w1:t3" })).toBe("tab w1:t3 closed");
  expect(await closeSession(rts, { runtime: "herdr", id: "w1:p4" })).toBe("pane w1:p4 not closed");
  expect(calls).toEqual([["herdr", "tab", "close", "w1:t3"], ["herdr", "pane", "close", "w1:p4"]]);
});

test("a refused runtime opens nothing: a DORI_RUNTIME that names no runtime makes no tab create or start for launch and handover (review 3 of #393)", async () => {
  const calls: string[][] = [];
  const run: Runner = async (argv) => {
    calls.push([...argv]);
    return { code: 0, out: JSON.stringify({ result: { root_pane: { pane_id: "w1:p9", tab_id: "w1:t9" } } }), err: "" };
  };
  process.env["DORI_RUNTIME"] = "tmux";
  try {
    await expect(openHerdrSession(run, { now: () => 0, sleep: async () => {} }, { title: "x", cwd: "/tmp", argv: ["omo"] })).rejects.toThrow(/DORI_RUNTIME must be "herdr" or "hc"/);
  } finally {
    delete process.env["DORI_RUNTIME"];
  }
  expect(calls).toEqual([]);
});

describe("runtime choice follows upstream #177: DORI_RUNTIME > config runtime > HC_TERMINAL_ID > HERDR_PANE_ID > hc on PATH > herdr on PATH > herdr", () => {
  const on = (...names: string[]) => (path: string): boolean => names.some((n) => path === `/bin/${n}`);
  test("nothing chooses and neither binary is installed: herdr, where upstream refuses (an aoe Dori runs neither)", () => {
    expect(runtimeChoice({}, { PATH: "" }, on())).toEqual({ kind: "herdr", source: "default" });
  });

  test("inside an hc terminal hc, inside a herdr pane herdr", () => {
    expect(runtimeChoice({}, { HC_TERMINAL_ID: "t1", PATH: "/bin" }, on("herdr"))).toEqual({ kind: "hc", source: "detect:HC_TERMINAL_ID" });
    expect(runtimeChoice({}, { HERDR_PANE_ID: "w1:p1", PATH: "/bin" }, on("hc"))).toEqual({ kind: "herdr", source: "detect:HERDR_PANE_ID" });
  });

  test("on PATH: hc when it is installed, else herdr", () => {
    expect(runtimeChoice({}, { PATH: "/bin" }, on("herdr", "hc"))).toEqual({ kind: "hc", source: "detect:path" });
    expect(runtimeChoice({}, { PATH: "/bin" }, on("herdr"))).toEqual({ kind: "herdr", source: "detect:path" });
  });

  test("the config's runtime holds a Dori on herdr whatever is installed or wraps it, and DORI_RUNTIME is over it", () => {
    expect(runtimeChoice({ runtime: "herdr" }, { HC_TERMINAL_ID: "t1", PATH: "/bin" }, on("hc"))).toEqual({ kind: "herdr", source: "config" });
    expect(runtimeChoice({ runtime: "hc" }, { DORI_RUNTIME: "herdr" }, on("hc"))).toEqual({ kind: "herdr", source: "env" });
  });

  test("hc is chosen by DORI_RUNTIME or the config's runtime now that the fork's paths address an hc terminal as hc:<id>", () => {
    expect(runtimeChoice({}, { DORI_RUNTIME: "hc" })).toEqual({ kind: "hc", source: "env" });
    expect(runtimeChoice({ runtime: "hc" }, {})).toEqual({ kind: "hc", source: "config" });
    expect(runtimesFor({ runtime: "hc" }, {}).default.kind).toBe("hc");
  });

  test("a DORI_RUNTIME that names no runtime is refused where a session would open", () => {
    expect(() => runtimeChoice({}, { DORI_RUNTIME: "tmux" })).toThrow(/DORI_RUNTIME must be "herdr" or "hc"/);
    const rts = runtimesFor({}, { DORI_RUNTIME: "tmux" });
    expect(() => rts.default).toThrow(/DORI_RUNTIME/);
    expect(rts.for({ runtime: "herdr", id: "w1:p1" }).kind).toBe("herdr");
  });

  test("a config runtime that names no runtime is a config error", async () => {
    const dir = scratch();
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ runtime: "tmux", stateDir: dir }));
    const loaded = loadConfig(path, dir, () => {});
    await expect(loaded).rejects.toThrow(ConfigError);
    await expect(loaded).rejects.toThrow(`runtime must be "herdr" or "hc" (unset: detected), not "tmux"`);
    writeFileSync(path, JSON.stringify({ runtime: "hc", stateDir: dir }));
    expect((await loadConfig(path, dir, () => {})).runtime).toBe("hc");
  });
});

test("a failed runtime choice still lists a stored herdr lane; with no lane the failure is thrown (upstream #159)", async () => {
  const calls: string[][] = [];
  const run: Runner = async (argv) => {
    calls.push([...argv]);
    return { code: 0, out: JSON.stringify({ result: { panes: [{ pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "idle" }] } }), err: "" };
  };
  const listed = await listSessions(runtimesFor({}, { DORI_RUNTIME: "tmux" }, run), { lanes: [{ sessionRef: { runtime: "herdr", id: "w:p1" } }] });
  expect(listed.map((s) => `${s.ref.runtime}:${s.ref.id}`)).toEqual(["herdr:w:p1"]);
  expect(calls.some((c) => c[0] === "hc")).toBe(false);
  await expect(listSessions(runtimesFor({}, { DORI_RUNTIME: "tmux" }, run))).rejects.toThrow(/DORI_RUNTIME/);
});
