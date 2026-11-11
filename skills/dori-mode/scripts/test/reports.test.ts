// Upstream #30 durable lane reports, adapted from https://github.com/sisyphuslabs/dori-superagent/pull/30.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseEvent, ReportError, Reports, reportLine } from "../src/reports.ts";
import { statusOf, type Lane } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00Z");
const lane: Lane = {
  key: "report-lane",
  title: "reports",
  thread: "chat:team/1",
  pane: "w:p7",
  brief: "/b.md",
  done: "file /done.md",
  openedAt: new Date(T0).toISOString(),
  reportProtocol: "jsonl-v1",
};

let state: ReturnType<typeof withState>;
let reports: Reports;
beforeEach(() => {
  state = withState();
  reports = new Reports(state.dir);
});
afterEach(() => state.done());

test("report transitions survive restarting the reader without changing done protocol", async () => {
  // Given an open lane with an independent completion status.
  const deps = depsFor(newWorld(), fakeClock(T0), state.dir);
  await deps.registry.write(lane);
  // When each report kind is appended in order.
  for (const [kind, expected] of [
    ["milestone", "running"], ["blocker", "blocked"], ["milestone", "running"],
    ["halted", "halted"], ["milestone", "running"], ["done", "done"],
  ] as const) {
    reports.report(lane.key, kind, `state ${expected}`, T0);
    // Then fresh readers recover the persisted state, not a memory cache.
    expect(new Reports(state.dir).read(lane.key)?.state).toBe(expected);
  }
  expect(statusOf((await deps.registry.read(lane.key)) ?? lane)).toBe("working");
  expect(readFileSync(reports.path(lane.key), "utf8").trim().split("\n")).toHaveLength(6);
});

test("report text round trips quotes and newlines but prints one human line", () => {
  // Given untrusted text that must remain data.
  const text = 'tests passed\npush "abc123"; $(not a command)';
  // When recorded and rendered.
  const report = reports.report(lane.key, "milestone", text, T0);
  // Then JSON preserves text while terminal output stays a single line.
  expect(new Reports(state.dir).read(lane.key)?.lastReport?.text).toBe(text);
  expect(reportLine(report)).toBe(`[REPORT] ${lane.key} | milestone | tests passed push "abc123"; $(not a command)`);
});

test("the printed line carries no terminal controls, while the journal keeps the raw text", () => {
  // Given text with a carriage return, a CSI erase, an OSC title and a bell.
  const text = "tests passed\r\u001b[2Kall green\u001b]0;owned\u0007 done\u0008";
  // When recorded and rendered.
  const report = reports.report(lane.key, "milestone", text, T0);
  // Then only printable text reaches the terminal, and the record is unchanged.
  expect(reportLine(report)).toBe(`[REPORT] ${lane.key} | milestone | tests passed all green done`);
  expect(new Reports(state.dir).read(lane.key)?.lastReport?.text).toBe(text);
});

test.each(["../escape", "/root", "x", "bad key"])("rejects invalid lane path %s", (key) => {
  // Given an unsafe key; when selecting storage; then no path is accepted.
  expect(() => reports.path(key)).toThrow(ReportError);
});

test.each([
  '{"type":"report","key":"other","at":"2026-01-01","kind":"done","text":"ok"}',
  '{"type":"report","key":"report-lane","at":"bad","kind":"done","text":"ok"}',
  '{"type":"report","key":"report-lane","at":"2026-01-01","kind":"unknown","text":"ok"}',
  '{"type":"report","key":"report-lane","at":"2026-01-01","kind":"done","text":" "}',
])("rejects malformed report records %#", (line) => {
  // Given an invalid record; when parsed; then it cannot assert progress.
  expect(() => parseEvent(line, lane.key)).toThrow(ReportError);
});

test("a corrupt journal fails with its line number instead of hiding a lost report", () => {
  // Given a valid report followed by corruption.
  reports.report(lane.key, "milestone", "first", T0);
  appendFileSync(reports.path(lane.key), "{partial\n");
  // When the journal is read; then corruption is explicit.
  expect(() => reports.read(lane.key)).toThrow("reports.jsonl:2:");
});

test("the lane journal directory is private (0700), like the 0600 journal", () => {
  // Given the host's normal umask.
  const umask = process.umask(0o022);
  try {
    // When a report is appended; then both the directory and file are private.
    reports.report("private-lane", "milestone", "first", T0);
    expect(statSync(join(state.dir, "lanes", "private-lane")).mode & 0o777).toBe(0o700);
    expect(statSync(reports.path("private-lane")).mode & 0o777).toBe(0o600);
  } finally {
    process.umask(umask);
  }
});

test("a lane directory created earlier with wider permissions is made 0700 on the next report", () => {
  // Given a pre-existing wide lane directory.
  const dir = join(state.dir, "lanes", lane.key);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  chmodSync(dir, 0o755);
  // When a report is appended; then the directory is narrowed too.
  reports.report(lane.key, "milestone", "first", T0);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
});
