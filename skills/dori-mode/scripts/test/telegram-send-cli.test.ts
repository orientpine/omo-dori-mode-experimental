import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { run } from "../src/run.ts";
import { viaEnvFile, withState } from "./fakes.ts";

const cli = join(import.meta.dir, "../src/cli.ts");
const recorder = join(import.meta.dir, "telegram-cli-fake.ts");

type RecordedRequest = { readonly url: string; readonly body: Record<string, unknown> };

const send = async (dir: string, flags: readonly string[]) => {
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
    "send",
    "telegram",
    "--to",
    "-1001",
    "--text",
    "hello",
    ...flags,
  ]), { timeoutMs: 20_000 });
  const requests: RecordedRequest[] = existsSync(log)
    ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => {
        const row: { readonly url: string; readonly body: string } = JSON.parse(line);
        const body: Record<string, unknown> = JSON.parse(row.body);
        return { url: row.url, body };
      })
    : [];
  return { ...r, requests };
};

for (const flags of [
  ["--thread", "telegram:-1001/42"],
  ["--thread", "abc"],
  ["--thread", "4.5"],
  ["--thread", "-3"],
  ["--thread", "0"],
  ["--thread", "0x2A"],
  ["--thread", "1e1"],
  ["--thread", "9007199254740993"],
  ["--thread", ""],
  ["--thread", " "],
  ["--thread"],
  ["--edit", "last"],
  ["--edit", "4.5"],
  ["--edit", "9007199254740993"],
  ["--edit", ""],
  ["--edit"],
] as const) {
  test(`send telegram refuses ${JSON.stringify(flags)} before any request`, async () => {
    const state = withState();
    try {
      const r = await send(state.dir, flags);
      const flag = flags[0] === "--edit" ? "--edit" : "--thread";
      expect({ code: r.code, err: r.err, out: r.out, requests: r.requests }).toEqual({
        code: 1,
        err: `${flag} must be a Telegram ${flag === "--thread" ? "topic" : "message"} id, a whole number above 0`,
        out: "",
        requests: [],
      });
    } finally {
      state.done();
    }
  }, 30_000);
}

test("send telegram accepts a positive thread id and sends it to that topic", async () => {
  const state = withState();
  try {
    const r = await send(state.dir, ["--thread", "42"]);
    expect({ code: r.code, sent: r.out.startsWith("SENT 99 "), requests: r.requests.map((q) => [q.url.split("/").at(-1), q.body]) }).toEqual({
      code: 0,
      sent: true,
      requests: [["sendMessage", { chat_id: "-1001", message_thread_id: 42, text: "hello" }]],
    });
  } finally {
    state.done();
  }
}, 30_000);

test("send telegram accepts a positive edit id and edits that message", async () => {
  const state = withState();
  try {
    const r = await send(state.dir, ["--edit", "7"]);
    expect({ code: r.code, out: r.out, requests: r.requests.map((q) => [q.url.split("/").at(-1), q.body]) }).toEqual({
      code: 0,
      out: "",
      requests: [["editMessageText", { chat_id: "-1001", message_id: 7, text: "hello" }]],
    });
  } finally {
    state.done();
  }
}, 30_000);

test("send telegram without a thread sends to General deliberately", async () => {
  const state = withState();
  try {
    const r = await send(state.dir, []);
    expect({ code: r.code, requests: r.requests.map((q) => [q.url.split("/").at(-1), q.body]) }).toEqual({
      code: 0,
      requests: [["sendMessage", { chat_id: "-1001", text: "hello" }]],
    });
  } finally {
    state.done();
  }
}, 30_000);
