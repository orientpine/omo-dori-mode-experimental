import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigError, loadConfig } from "../src/config.ts";
import { type Lane, Registry, sessionOf } from "../src/registry.ts";
import { type Runner, runtimeChoice, runtimesFor } from "../src/run.ts";
import { closeSession } from "../src/sessions.ts";

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

describe("runtime choice keeps herdr the default (DORI_RUNTIME > config runtime > herdr)", () => {
  test("nothing set: herdr, whatever is on PATH", () => {
    expect(runtimeChoice({}, { PATH: "" })).toEqual({ kind: "herdr", source: "default" });
    expect(runtimeChoice({}, { HC_TERMINAL_ID: "t1" })).toEqual({ kind: "herdr", source: "default" });
  });

  test("the config's runtime, then DORI_RUNTIME over it", () => {
    expect(runtimeChoice({ runtime: "hc" }, {})).toEqual({ kind: "hc", source: "config" });
    expect(runtimeChoice({ runtime: "hc" }, { DORI_RUNTIME: "herdr" })).toEqual({ kind: "herdr", source: "env" });
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
    await expect(loaded).rejects.toThrow(/runtime must be "herdr" or "hc", not "tmux"/);
  });
});
