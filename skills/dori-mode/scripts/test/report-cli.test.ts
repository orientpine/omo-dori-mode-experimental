import { expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Registry } from "../src/registry.ts";
import { run } from "../src/run.ts";
import { withState } from "./fakes.ts";

const cli = join(import.meta.dir, "../src/cli.ts");
setDefaultTimeout(30_000);
const cliIn = (dir: string) => {
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ stateDir: dir, defaultCwd: dir, hooks: {} }));
  return (...args: string[]) =>
    run([
      "env", "-u", "HC_TERMINAL_ID", "-u", "HERDR_PANE_ID", "-u", "TMUX",
      `DORI_CONFIG=${config}`, `DORI_STATE_DIR=${dir}`, `DORI_ENV_FILE=${join(dir, "none.env")}`,
      process.execPath, cli, ...args,
    ], { timeoutMs: 40_000 });
};

const register = async (dir: string) => {
  await new Registry(dir).write({
    key: "report-lane",
    title: "reports",
    thread: "none",
    brief: "/b.md",
    done: "file /done.md",
    openedAt: "2026-01-01T12:00:00.000Z",
  });
};

test("CLI report persists a durable event and prints its human line", async () => {
  const state = withState();
  try {
    await register(state.dir);
    const result = await cliIn(state.dir)("report", "report-lane", "--kind", "milestone", "--text", "isolated report QA");
    expect(result.code).toBe(0);
    expect(result.out.trim()).toBe("[REPORT] report-lane | milestone | isolated report QA");
    const event = JSON.parse(readFileSync(join(state.dir, "lanes", "report-lane", "reports.jsonl"), "utf8").trim());
    expect(event).toMatchObject({ type: "report", key: "report-lane", kind: "milestone", text: "isolated report QA" });
  } finally {
    state.done();
  }
});

test("CLI report rejects an invalid kind without writing a journal", async () => {
  const state = withState();
  try {
    await register(state.dir);
    const result = await cliIn(state.dir)("report", "report-lane", "--kind", "unknown", "--text", "must not persist");
    expect(result.code).toBe(1);
    expect(result.err).toContain("--kind must be milestone, blocker, question, halted or done");
    expect(existsSync(join(state.dir, "lanes", "report-lane", "reports.jsonl"))).toBe(false);
  } finally {
    state.done();
  }
});

test("CLI report rejects an unknown lane without writing a journal", async () => {
  const state = withState();
  try {
    const result = await cliIn(state.dir)("report", "missing-lane", "--kind", "milestone", "--text", "must not persist");
    expect(result.code).toBe(1);
    expect(result.err).toContain('no registered lane "missing-lane"');
    expect(existsSync(join(state.dir, "lanes", "missing-lane", "reports.jsonl"))).toBe(false);
  } finally {
    state.done();
  }
});
