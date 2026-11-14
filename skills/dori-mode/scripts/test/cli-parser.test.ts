import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { run } from "../src/run.ts";
import { helpFor } from "../src/cli-context.ts";
import { withState, viaEnvFile } from "./fakes.ts";

const cli = join(import.meta.dir, "../src/cli.ts");
const recorder = join(import.meta.dir, "telegram-cli-fake.ts");

const runCli = async (dir: string, args: readonly string[]) => {
  const log = join(dir, "fetch.jsonl");
  const batch = join(dir, "batch.json");
  writeFileSync(batch, JSON.stringify({ message_id: 99, text: "hello" }));
  const r = await run(viaEnvFile([
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
  ]), { timeoutMs: 20_000 });
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

// a bare --thread or --edit is Telegram's own refusal there; on Slack and Discord it is a value flag without its value
for (const flag of ["--thread", "--edit"]) {
  test(`discord send with a bare ${flag} is refused before any request`, async () => {
    const state = withState();
    try {
      const http = join(state.dir, "http.json");
      const r = await run(viaEnvFile(["env", `DORI_CONFIG=${join(state.dir, "missing.json")}`, `DORI_STATE_DIR=${state.dir}`, `DORI_ENV_FILE=${join(state.dir, "missing.env")}`, "DORI_DISCORD_TOKEN=fake", `DORI_TEST_HTTP=${http}`,
        process.execPath, "--preload", join(import.meta.dir, "discord-cli-fake.ts"), cli, "send", "discord", "--to", "channel", "--text", "hello", "--no-typing", flag]), { timeoutMs: 20_000 });
      expect({ code: r.code, err: r.err, requested: existsSync(http) }).toEqual({ code: 1, err: `${flag} needs a value`, requested: false });
    } finally {
      state.done();
    }
  }, 30_000);

  test(`slack send with a bare ${flag} is refused before any request`, async () => {
    const seen: string[] = [];
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => { seen.push(new URL(req.url).pathname); return Response.json({ ok: true, channel: "C1", ts: "1.2", message: { text: "hello" } }); } });
    const state = withState();
    try {
      const r = await run(viaEnvFile(["env", `DORI_CONFIG=${join(state.dir, "missing.json")}`, `DORI_STATE_DIR=${state.dir}`, `DORI_ENV_FILE=${join(state.dir, "missing.env")}`, "DORI_SLACK_TOKEN=xoxp-fake", `DORI_SLACK_API=http://127.0.0.1:${server.port}/api`,
        process.execPath, cli, "send", "slack", "--to", "C1", "--text", "hello", flag]), { timeoutMs: 20_000 });
      expect({ code: r.code, err: r.err, seen }).toEqual({ code: 1, err: `${flag} needs a value`, seen: [] });
    } finally {
      server.stop(true);
      state.done();
    }
  }, 30_000);
}

test("thread open with a bare --session is refused before the thread is opened or posted to", async () => {
  const state = withState();
  try {
    const http = join(state.dir, "http.json");
    const config = join(state.dir, "config.json");
    writeFileSync(join(state.dir, "ledger.json"), JSON.stringify({ entries: [] }));
    writeFileSync(config, JSON.stringify({ stateDir: state.dir, defaultCwd: state.dir, directives: { common: join(state.dir, "ledger.json"), local: "" } }));
    const r = await run(viaEnvFile(["env", `DORI_CONFIG=${config}`, `DORI_STATE_DIR=${state.dir}`, `DORI_ENV_FILE=${join(state.dir, "missing.env")}`, `DORI_DISCORD_STATE_DIR=${join(state.dir, "cards")}`, "DORI_DISCORD_TOKEN=fake", "DORI_DISCORD_CHANNEL=200000000000000002", `DORI_TEST_HTTP=${http}`,
      process.execPath, "--preload", join(import.meta.dir, "discord-cli-fake.ts"), cli, "thread", "open", "fix login", "--first", "Start here", "--session"]), { timeoutMs: 20_000 });
    expect({ code: r.code, err: r.err, out: r.out, requested: existsSync(http) }).toEqual({ code: 1, err: "--session needs a value", out: "", requested: false });
  } finally {
    state.done();
  }
}, 30_000);

// a repeatable value flag left without its value is refused like a single one, before the command runs (review 2 of #439)
test("serve with a bare --only is refused before it reports ready or writes its log", async () => {
  const state = withState();
  try {
    const log = join(state.dir, "serve.log");
    const r = await run(viaEnvFile(["env", `DORI_CONFIG=${join(state.dir, "missing.json")}`, `DORI_STATE_DIR=${state.dir}`, `DORI_ENV_FILE=${join(state.dir, "missing.env")}`,
      process.execPath, cli, "serve", "--log", log, "--only"]), { timeoutMs: 20_000 });
    expect({ code: r.code, err: r.err, out: r.out, logged: existsSync(log) }).toEqual({ code: 1, err: "--only needs a value", out: "", logged: false });
  } finally {
    state.done();
  }
}, 30_000);

test("a bare --file on send keeps its own refusal", async () => {
  const state = withState();
  try {
    const http = join(state.dir, "http.json");
    const r = await run(viaEnvFile(["env", `DORI_CONFIG=${join(state.dir, "missing.json")}`, `DORI_STATE_DIR=${state.dir}`, `DORI_ENV_FILE=${join(state.dir, "missing.env")}`, "DORI_DISCORD_TOKEN=fake", `DORI_TEST_HTTP=${http}`,
      process.execPath, "--preload", join(import.meta.dir, "discord-cli-fake.ts"), cli, "send", "discord", "--to", "channel", "--text", "hello", "--file"]), { timeoutMs: 20_000 });
    expect({ code: r.code, err: r.err, requested: existsSync(http) }).toEqual({ code: 2, err: "SEND_FILE_REFUSED --file takes a path; nothing was sent", requested: false });
  } finally {
    state.done();
  }
}, 30_000);

// an exemption holds only for the command that checks the bare flag itself (review 3 of #439)
test("thread open with a bare --file is refused before the thread is opened, posted to or mapped", async () => {
  const state = withState();
  try {
    const http = join(state.dir, "http.json");
    const config = join(state.dir, "config.json");
    writeFileSync(join(state.dir, "ledger.json"), JSON.stringify({ entries: [] }));
    writeFileSync(config, JSON.stringify({ stateDir: state.dir, defaultCwd: state.dir, directives: { common: join(state.dir, "ledger.json"), local: "" } }));
    const r = await run(viaEnvFile(["env", `DORI_CONFIG=${config}`, `DORI_STATE_DIR=${state.dir}`, `DORI_ENV_FILE=${join(state.dir, "missing.env")}`, `DORI_DISCORD_STATE_DIR=${join(state.dir, "cards")}`, "DORI_DISCORD_TOKEN=fake", "DORI_DISCORD_CHANNEL=200000000000000002", `DORI_TEST_HTTP=${http}`,
      process.execPath, "--preload", join(import.meta.dir, "discord-cli-fake.ts"), cli, "thread", "open", "fix", "--first", "hi", "--file"]), { timeoutMs: 20_000 });
    expect({ code: r.code, err: r.err, requested: existsSync(http), mapped: existsSync(join(state.dir, "cards", "threads.json")) }).toEqual({ code: 1, err: "--file needs a value", requested: false, mapped: false });
  } finally {
    state.done();
  }
}, 30_000);

test("serve with a bare --loop is refused: only the loop commands check it themselves", async () => {
  const state = withState();
  try {
    const log = join(state.dir, "serve.log");
    const r = await run(viaEnvFile(["env", `DORI_CONFIG=${join(state.dir, "missing.json")}`, `DORI_STATE_DIR=${state.dir}`, `DORI_ENV_FILE=${join(state.dir, "missing.env")}`,
      process.execPath, cli, "serve", "--log", log, "--only", "none", "--loop"]), { timeoutMs: 20_000 });
    expect({ code: r.code, err: r.err, out: r.out, logged: existsSync(log) }).toEqual({ code: 1, err: "--loop needs a value", out: "", logged: false });
  } finally {
    state.done();
  }
}, 30_000);

test("backlog add with a bare --why-new is refused before the item is written", async () => {
  const state = withState();
  try {
    const brief = join(state.dir, "brief.md");
    writeFileSync(brief, "[목표] qa\n");
    const r = await run(viaEnvFile(["env", `DORI_CONFIG=${join(state.dir, "missing.json")}`, `DORI_STATE_DIR=${state.dir}`, `DORI_ENV_FILE=${join(state.dir, "missing.env")}`,
      process.execPath, cli, "backlog", "add", "qa-i", "--title", "t", "--brief", brief, "--done", "merged o/r#1", "--thread", "new", "--why-new"]), { timeoutMs: 20_000 });
    expect({ code: r.code, err: r.err, written: existsSync(join(state.dir, "backlog", "items", "qa-i.json")) }).toEqual({ code: 1, err: "--why-new needs a value", written: false });
  } finally {
    state.done();
  }
}, 30_000);

test("dori heavy --help prints every heavy block, the --items batch too (gongdori 2026-11-14 found none)", () => {
  const h = helpFor("heavy");
  for (const want of ["--items FILE", "--helpers-only", "--job <name>", "heavy hold-local", "--on HOST,..."]) expect(h).toContain(want);
  expect(h.startsWith("dori heavy <label> [--mem SIZE] -- <command ...>")).toBe(true);
  expect(h).not.toContain("gpu-room");
});
