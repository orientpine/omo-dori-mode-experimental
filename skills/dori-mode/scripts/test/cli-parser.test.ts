import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { run } from "../src/run.ts";
import { withState } from "./fakes.ts";

const cli = join(import.meta.dir, "../src/cli.ts");
const recorder = join(import.meta.dir, "telegram-cli-fake.ts");

const runCli = async (dir: string, args: readonly string[]) => {
  const log = join(dir, "fetch.jsonl");
  const batch = join(dir, "batch.json");
  writeFileSync(batch, JSON.stringify({ message_id: 99, text: "hello" }));
  const r = await run([
    "env",
    `DORI_CONFIG=${join(dir, "missing.json")}`,
    `DORI_STATE_DIR=${dir}`,
    `DORI_ENV_FILE=${join(dir, "missing.env")}`,
    "DORI_TELEGRAM_TOKEN=fake",
    `DORI_TEST_TG_LOG=${log}`,
    `DORI_TEST_TG_BATCH=${batch}`,
    process.execPath,
    "--preload",
    recorder,
    cli,
    ...args,
  ], { timeoutMs: 20_000 });
  return { ...r, requested: existsSync(log) };
};

test("a value flag left at the end is refused as missing a value before any request", async () => {
  const state = withState();
  try {
    const r = await runCli(state.dir, ["send", "telegram", "--to", "-1001", "--text"]);
    expect({ code: r.code, err: r.err, out: r.out, requested: r.requested }).toEqual({
      code: 1,
      err: "--text needs a value",
      out: "",
      requested: false,
    });
  } finally {
    state.done();
  }
}, 30_000);

test("--help before a command prints usage and runs nothing", async () => {
  const state = withState();
  try {
    const r = await runCli(state.dir, ["--help", "send", "telegram", "--to", "-1001", "--text", "hello"]);
    expect({ code: r.code, usage: r.out.startsWith("dori <command>"), err: r.err, requested: r.requested }).toEqual({
      code: 0,
      usage: true,
      err: "",
      requested: false,
    });
  } finally {
    state.done();
  }
}, 30_000);

test("--help after a command keeps its command-specific boolean behavior", async () => {
  const state = withState();
  try {
    const r = await runCli(state.dir, ["send", "--help"]);
    expect({ code: r.code, usage: r.out.startsWith("dori send "), err: r.err, requested: r.requested }).toEqual({
      code: 0,
      usage: true,
      err: "",
      requested: false,
    });
  } finally {
    state.done();
  }
}, 30_000);

test("a value flag still takes a following flag-shaped token verbatim", async () => {
  const state = withState();
  try {
    const log = join(state.dir, "fetch.jsonl");
    const r = await runCli(state.dir, ["send", "telegram", "--to", "-1001", "--text", "--again"]);
    const rows = r.requested ? readFileSync(log, "utf8").trim().split("\n").map((line) => {
      const row: { readonly body: string } = JSON.parse(line);
      const body: Record<string, unknown> = JSON.parse(row.body);
      return body;
    }) : [];
    expect({ code: r.code, bodies: rows }).toEqual({
      code: 0,
      bodies: [{ chat_id: "-1001", text: "--again" }],
    });
  } finally {
    state.done();
  }
}, 30_000);
