import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Lane } from "../src/registry.ts";
import { HUNG_MESSAGE, Supervision } from "../src/supervision.ts";
import { takeLock } from "../src/checkpoints.ts";
import { fixture, lane } from "./supervision-setup.ts";

describe("supervision", () => {
  test("caps alert the lead without stopping the lane, support per-lane overrides and deduplicate alerts", async () => {
    const f = fixture({ usageArgv: ["usage", "{key}"], defaults: { wallMinutes: 100, tokens: 1000, costUsd: 10 }, lanes: { "demo-lane": { wallMinutes: 1, tokens: 10, costUsd: 1 } } });
    try {
      f.setUsage('{"tokens":10,"costUsd":1}');
      f.clock.at += 60_000;
      const result = await f.supervisor.sweep(lane, "Working 1m");
      expect(result.usage).toEqual({ key: lane.key, at: new Date(f.clock.at).toISOString(), tokens: 10, costUsd: 1 });
      expect(result.alerts).toEqual(["wallMinutes ceiling reached (1)", "tokens ceiling reached (10)", "costUsd ceiling reached (1)"]);
      expect(f.alerts).toEqual([...result.alerts]);
      f.setUsage('{"tokens":11,"costUsd":2}');
      f.clock.at += 60_000;
      expect((await f.supervisor.sweep(lane, "Working 2m")).alerts).toEqual([]);
      expect(f.calls).toEqual([["usage", lane.key], ["usage", lane.key]]);
      expect(f.calls.some((args) => /kill|send-text|send-keys|close/.test(args.join(" ")))).toBe(false);
    } finally { f.done(); }
  });

  // upstream: "a ceiling reached while the lane waits on a question still appends a durable blocker"
  test("a cap reached while the lane's last report is a question still alerts once, and the record survives a restart", async () => {
    const f = fixture({ defaults: { wallMinutes: 1 } });
    try {
      const asking = { ...lane, lastReport: "[REPORT] demo-lane | question | which branch?" };
      f.clock.at += 60_000;
      expect((await f.supervisor.sweep(asking, "")).alerts).toEqual(["wallMinutes ceiling reached (1)"]);
      const saved = JSON.parse(readFileSync(join(f.dir, "lane-state", lane.key, "supervision.json"), "utf8")) as { alerts: string[] };
      expect(saved.alerts).toEqual(["wallMinutes ceiling reached (1)"]);
      f.clock.at += 60_000;
      expect((await new Supervision(f.deps, f.options).sweep(asking, "")).alerts).toEqual([]);
      expect(f.alerts).toEqual(["wallMinutes ceiling reached (1)"]);
    } finally { f.done(); }
  });

  test("an alert whose delivery failed is sent again on the next sweep, and a delivered one is not", async () => {
    const f = fixture({ defaults: { wallMinutes: 1 } });
    try {
      const sent: string[] = [];
      let mode: "throw" | "false" | "ok" = "throw";
      const supervisor = new Supervision({ ...f.deps, alert: (_lane: Lane, message: string) => {
        if (mode === "throw") throw new Error("messenger down");
        if (mode === "false") return false;
        sent.push(message);
        return true;
      } }, f.options);
      f.clock.at += 60_000;
      expect((await supervisor.sweep(lane, "")).undelivered).toEqual(["wallMinutes ceiling reached (1)"]);
      mode = "false";
      f.clock.at += 60_000;
      expect((await supervisor.sweep(lane, "")).undelivered).toEqual(["wallMinutes ceiling reached (1)"]);
      mode = "ok";
      f.clock.at += 60_000;
      expect((await supervisor.sweep(lane, "")).alerts).toEqual(["wallMinutes ceiling reached (1)"]);
      f.clock.at += 60_000;
      expect((await supervisor.sweep(lane, "")).alerts).toEqual([]);
      expect(sent).toEqual(["wallMinutes ceiling reached (1)"]);
    } finally { f.done(); }
  });

  test("a raised cap is not reached; reaching the new one alerts again", async () => {
    const f = fixture({ defaults: { wallMinutes: 1 } });
    try {
      f.clock.at += 2 * 60_000;
      expect((await f.supervisor.sweep(lane, "")).alerts).toEqual(["wallMinutes ceiling reached (1)"]);
      const raised = { ...lane, budget: { wallMinutes: 5 } };
      f.clock.at += 60_000;
      expect((await f.supervisor.sweep(raised, "")).capped).toEqual([]);
      f.clock.at += 2 * 60_000;
      expect((await f.supervisor.sweep(raised, "")).alerts).toEqual(["wallMinutes ceiling reached (5)"]);
    } finally { f.done(); }
  });

  test("lane caps override defaults and unknown usage stays null in the persisted close snapshot", async () => {
    const f = fixture({ usageArgv: ["usage"], recordCostArgv: ["record", "{key}", "{tokens}", "{costUsd}"], defaults: { wallMinutes: 0, tokens: 0, costUsd: 0 } });
    try {
      f.setUsage('{"tokens":-1,"costUsd":"not-known"}');
      const result = await f.supervisor.sweep({ ...lane, budget: { wallMinutes: null } }, "Working 1m");
      expect(result.capped).toEqual([]);
      expect(result.usage?.tokens).toBeNull();
      expect(result.usage?.costUsd).toBeNull();
      expect(result.alerts).toEqual(["tokens ceiling cannot be checked: usage unavailable", "costUsd ceiling cannot be checked: usage unavailable"]);
      f.setUsage("malformed");
      const snapshot = await f.supervisor.close(lane);
      expect(snapshot.tokens).toBeNull();
      expect(f.calls.some((args) => args[0] === "record")).toBe(false);
      const stored = readFileSync(join(f.dir, "lane-state", lane.key, "cost.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(stored.at(-1)).toEqual(snapshot);
    } finally { f.done(); }
  });

  test("available cumulative usage reaches the optional close recording hook", async () => {
    const f = fixture({ usageArgv: ["usage"], recordCostArgv: ["record", "{key}", "{tokens}", "{costUsd}"] });
    try {
      f.setUsage('{"tokens":1234,"costUsd":0.25}');
      const snapshot = await f.supervisor.close(lane);
      expect(snapshot.tokens).toBe(1234);
      expect(f.calls.at(-1)).toEqual(["record", lane.key, "1234", "0.25"]);
    } finally { f.done(); }
  });

  test("a second close keeps the first final reading and runs the cost hook once, with a stable close key", async () => {
    const f = fixture({ usageArgv: ["usage"], recordCostArgv: ["record", "{closeKey}", "{tokens}"] });
    try {
      f.setUsage('{"tokens":1234,"costUsd":0.25}');
      const first = await f.supervisor.close(lane);
      f.setUsage('{"tokens":9999,"costUsd":9}');
      f.clock.at += 60_000;
      expect(await new Supervision(f.deps, f.options).close(lane)).toEqual(first);
      expect(f.calls.filter((args) => args[0] === "record")).toEqual([["record", `${lane.key}@${lane.openedAt}`, "1234"]]);
    } finally { f.done(); }
  });

  test("a cost record torn by a crash mid-line is skipped: the close still reads the rest and records once", async () => {
    const f = fixture({ usageArgv: ["usage"], recordCostArgv: ["record", "{tokens}"] });
    try {
      f.setUsage('{"tokens":5,"costUsd":0.1}');
      await f.supervisor.sweep(lane, "");
      appendFileSync(join(f.dir, "lane-state", lane.key, "cost.jsonl"), '{"key":"demo-lane","at":"2026-');
      const closed = await f.supervisor.close(lane);
      expect(closed).toMatchObject({ tokens: 5, final: true });
      expect(await f.supervisor.close(lane)).toEqual(closed);
      expect(f.calls.filter((args) => args[0] === "record")).toHaveLength(1);
    } finally { f.done(); }
  });

  test("a failing cost hook keeps a plain reading, so the next close runs it again", async () => {
    const f = fixture({ usageArgv: ["usage"], recordCostArgv: ["record", "{tokens}"] });
    try {
      f.setUsage('{"tokens":7,"costUsd":0.5}');
      let fail = true;
      const supervisor = new Supervision({ ...f.deps, run: async (argv) => {
        f.calls.push([...argv]);
        if (argv[0] === "record" && fail) return { code: 1, out: "", err: "ledger down" };
        return { code: 0, out: argv[0] === "usage" ? '{"tokens":7,"costUsd":0.5}' : "", err: "" };
      } }, f.options);
      await expect(supervisor.close(lane)).rejects.toThrow("recordCost failed for demo-lane: ledger down");
      fail = false;
      expect((await supervisor.close(lane)).final).toBe(true);
      expect(f.calls.filter((args) => args[0] === "record")).toHaveLength(2);
    } finally { f.done(); }
  });

  // upstream: "terminal progress is not overwritten by budget or hung reports"
  test("a lane told about its cap that then hangs is told that too", async () => {
    const f = fixture({ defaults: { wallMinutes: 1 }, staleAfterMinutes: 0 });
    try {
      f.clock.at += 2 * 60_000;
      expect((await f.supervisor.sweep(lane, "Working 25m")).alerts).toEqual(["wallMinutes ceiling reached (1)"]);
      f.clock.at += 60_000;
      expect((await f.supervisor.sweep(lane, "Working 26m")).alerts).toEqual([HUNG_MESSAGE]);
      expect(f.alerts).toEqual(["wallMinutes ceiling reached (1)", HUNG_MESSAGE]);
    } finally { f.done(); }
  });

  test("two closes at once take turns: the one that finds the cost record taken is refused and runs no hook", async () => {
    const f = fixture({ usageArgv: ["usage"], recordCostArgv: ["record", "{tokens}"] });
    try {
      f.setUsage('{"tokens":7,"costUsd":0.5}');
      const dir = join(f.dir, "lane-state", lane.key);
      mkdirSync(dir, { recursive: true });
      const held = takeLock(join(dir, "cost.lock"), f.clock.now(), "cost record", lane.key);
      await expect(f.supervisor.close(lane)).rejects.toThrow(`cost record locked: ${lane.key}`);
      expect(f.calls.some((args) => args[0] === "record")).toBe(false);
      held();
      expect((await f.supervisor.close(lane)).final).toBe(true);
      expect((await f.supervisor.close(lane)).final).toBe(true);
      expect(f.calls.filter((args) => args[0] === "record")).toHaveLength(1);
    } finally { f.done(); }
  });
});
