import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { liveMonitors, missingMonitors, monitorLine } from "../src/handover.ts";

// zzangdori's rv-human-natural lane (2026-11-08 17:04Z and 17:23Z): two lane handovers rolled back with "monitors not
// running" for path watches that had already ended: one whose folder the lane had deleted (omo refused it in the new
// session: "Cannot watch file: parent directory does not exist"), one whose file appeared while the handover checked
// (omo fired it, "watcher completed", and dropped it from the new session's manifest).
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "handover-ended-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const entry = (e: Record<string, unknown>) => ({ persistent: true, suspended: false, expiresAt: null, ...e }) as never;

test("a path watch whose file appeared in the new session counts as done; one still waiting for its file is missing", () => {
  // Given
  const ci = join(dir, "ci23f.done");
  const ab = join(dir, "ab3", "done");
  mkdirSync(join(dir, "ab3"));
  const wanted = [
    { description: "PR23 CI on new main done", path: ci, event: "create", persistent: true },
    { description: "clearance AB done", path: ab, event: "create", persistent: true },
  ];
  writeFileSync(ci, "exit=0\n");
  // When: the new session runs neither watch (omo ended the fired one; the other was never armed)
  const missing = missingMonitors(wanted, [], () => true, "/home/test", 0);
  // Then
  expect(missing).toEqual(["clearance AB done"]);
  // and once the second runs, nothing is missing
  expect(missingMonitors(wanted, [entry({ description: "clearance AB done", path: ab, event: "create" })], () => true, "/home/test", 0)).toEqual([]);
});

test("the note marks a path watch ENDED when its file is there or its folder is gone, and the check skips it", () => {
  // Given
  const gone = join(dir, "heavy", "ab3.done");
  const there = join(dir, "ci.done");
  const waiting = join(dir, "build", "done");
  const changed = join(dir, "log.txt");
  mkdirSync(join(dir, "build"));
  writeFileSync(there, "");
  writeFileSync(changed, "");
  const old = [
    entry({ description: "lane folder", path: gone, event: "create" }),
    entry({ description: "ci", path: there, event: "create" }),
    entry({ description: "build", path: waiting, event: "create" }),
    entry({ description: "log changes", path: changed, event: "modify" }),
  ];
  // When
  const monitors = liveMonitors(old, 0, () => true, "/home/test");
  // Then
  expect(monitors.map((m) => [m.description, m.ended])).toEqual([
    ["lane folder", `its folder ${join(dir, "heavy")} is gone, so omo cannot watch it`],
    ["ci", `its file ${there} is there already`],
    ["build", undefined],
    ["log changes", undefined],
  ]);
  const lines = monitors.map(monitorLine);
  expect(lines[0]).toContain("ENDED");
  expect(lines[1]).toContain("ENDED");
  expect(lines[2]).not.toContain("ENDED");
  // the new session arms only the two that still wait; the ended ones are not asked for
  expect(missingMonitors(monitors, [entry({ description: "build", path: waiting }), entry({ description: "log changes", path: changed, event: "modify" })], () => true, "/home/test", 0)).toEqual([]);
  // a watch that still waits and is not armed keeps the handover from committing, as before
  expect(missingMonitors(monitors, [entry({ description: "log changes", path: changed, event: "modify" })], () => true, "/home/test", 0)).toEqual(["build"]);
  // a modify watch is never ended by its file being there
  expect(missingMonitors(monitors, [entry({ description: "build", path: waiting })], () => true, "/home/test", 0)).toEqual(["log changes"]);
});

test("a command watch is never taken for ended, whatever paths its command names", () => {
  // Given
  writeFileSync(join(dir, "done"), "");
  const old = [entry({ description: "gate", command: `until [ -f ${join(dir, "done")} ]; do sleep 5; done; echo READY`, runtime: { pid: 7 } })];
  // When
  const monitors = liveMonitors(old, 0, () => true, "/home/test");
  // Then
  expect(monitors[0]?.ended).toBeUndefined();
  expect(missingMonitors(monitors, [], () => true, "/home/test", 0)).toEqual(["gate"]);
});
