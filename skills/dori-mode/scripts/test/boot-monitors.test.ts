import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { monitorCleanup, readMonitorManifests } from "../src/boot-monitors.ts";
import { reconcilePanes } from "../src/reconcile.ts";
import { Reports } from "../src/reports.ts";
import { lane, manifest, T0 } from "./boot-fixtures.ts";
import { withState } from "./fakes.ts";

let state: ReturnType<typeof withState>;
beforeEach(() => { state = withState(); });
afterEach(() => state.done());

test("reconcilePanes matches registered lanes to live sessions without changing their records", () => {
  const lanes = [lane("vanished"), lane("live", "working", "w2:p2"), lane("adopted", "working", "")];
  const before = JSON.stringify(lanes);
  const result = reconcilePanes(lanes, [
    { ref: { runtime: "herdr", id: "w2:p1", group: "w2" } },
    { ref: { runtime: "herdr", id: "w2:p2", group: "w2" } },
  ]);
  expect(result.lanes.map((l) => l.paneState)).toEqual(["vanished", "live", "unassigned"]);
  expect(result.unregistered).toEqual(["w2:p1"]);
  expect(JSON.stringify(lanes)).toBe(before);
});

test("a lane whose journal says done qualifies for cleanup", () => {
  const reports = new Reports(state.dir);
  const key = "done-lane";
  reports.report(key, "done", "finished", T0);
  expect(monitorCleanup([{ ...lane(key), reportProtocol: "jsonl-v1", reportState: "done" }], [manifest([{ command: `dori watch ${key}`, monitorId: "mon_DONE" }])]).map((m) => m.monitorId)).toEqual(["mon_DONE"]);
});

test("persistent watches on closed or verified lanes become owner-scoped stop calls", async () => {
  const lanes = [lane("closed", "closed", "w1:closed"), lane("verified", "verified-done", "w1:verified"), lane("claimed", "done-claimed", "w1:claimed")];
  const input = manifest([
    { command: "dori watch closed", monitorId: "mon_CLOSED" },
    { command: "herdr pane read w1:verified", monitorId: "mon_VERIFIED" },
    { command: "dori watch claimed", monitorId: "mon_CLAIMED" },
    { command: "dori watch closed", monitorId: "mon_EPHEMERAL", persistent: false },
  ]);
  const result = monitorCleanup(lanes, [input]);
  expect(result.map((m) => m.monitorId)).toEqual(["mon_CLOSED", "mon_VERIFIED"]);
  expect(result[0]?.stop).toBe('kill_bash({"bash_id":"mon_CLOSED"})');
  expect(result[0]?.sessionId).toBe("owner");
  expect(result[0]?.metadata).toBe(input.path);
});

test("shared, prefix-matched, unknown and foreign-owner watches are preserved", () => {
  const lanes = [lane("api", "closed"), lane("api-release"), lane("closed", "closed")];
  const result = monitorCleanup(lanes, [
    manifest([
      { command: "dori watch api-release", monitorId: "mon_ACTIVE" },
      { command: "dori watch closed api-release", monitorId: "mon_SHARED" },
      { description: "unrelated presence", command: "bun presence.ts", monitorId: "mon_UNKNOWN" },
      { command: "dori watch closed", sessionId: "other", monitorId: "mon_WRONGOWNER" },
    ]),
  ]);
  expect(result).toEqual([]);
});

test("an active lane named after a colon or before a period or colon still keeps a shared watch", () => {
  const lanes = [lane("closed", "closed"), lane("api-release"), lane("v2", "closed")];
  const result = monitorCleanup(lanes, [
    manifest([
      { command: "dori watch closed", description: "closed reports; lane:api-release", monitorId: "mon_COLON" },
      { command: "dori watch closed", description: "closed reports, then api-release.", monitorId: "mon_PERIOD" },
      { command: "dori watch closed", path: "/logs/api-release: both", monitorId: "mon_TRAILCOLON" },
      { command: "dori watch api.v2", monitorId: "mon_DOTTED" },
      { command: "dori watch closed", monitorId: "mon_CLOSED" },
    ]),
  ]);
  expect(result.map((m) => m.monitorId)).toEqual(["mon_CLOSED"]);
});

test("a common-word key ties a watch to its lane only as a command or target token, never in prose or a path", () => {
  const lanes = [lane("docs", "closed", "w1:docs")];
  const result = monitorCleanup(lanes, [
    manifest([
      { description: "CI for the docs site on main", command: "gh run watch 4242", monitorId: "mon_PROSE" },
      { description: "build log", command: "tail -F build/docs/out.log", monitorId: "mon_PATH" },
      { description: "lane reports", command: "dori report-watch 'docs'", monitorId: "mon_KEY" },
      { description: "lane screen", target: "w1:docs", monitorId: "mon_PANE" },
    ]),
  ]);
  expect(result.map((m) => [m.monitorId, m.match])).toEqual([
    ["mon_KEY", ["docs:command:key"]],
    ["mon_PANE", ["docs:target:pane"]],
  ]);
});

test("metadata discovery reads only terminal JSON, never transcripts or nested state", () => {
  const root = join(state.dir, "sessions");
  const terminal = join(root, "project", "extensions", "terminal");
  mkdirSync(join(terminal, "state"), { recursive: true });
  writeFileSync(join(root, "project", "session.jsonl"), "not JSON: never inspect");
  writeFileSync(join(terminal, "state", "private.json"), "not JSON: never inspect");
  writeFileSync(join(terminal, "owner.json"), JSON.stringify(manifest([]).data));
  const read = readMonitorManifests(root);
  expect(read.manifests.map((m) => m.path)).toEqual([join(terminal, "owner.json")]);
  expect(read.errors).toEqual([]);
});
