import { expect, test } from "bun:test";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { run } from "../src/run.ts";
import { withState } from "./fakes.ts";

test("Discord CLI enables typing by default, skips it on request, and leaves edits alone", async () => {
  const state = withState();
  try {
    const results = [];
    for (const extra of [[], ["--no-typing"], ["--edit", "fake-message"]]) {
      results.push(await run(["env", `DORI_CONFIG=${join(state.dir, "missing.json")}`, `DORI_STATE_DIR=${state.dir}`, `DORI_ENV_FILE=${join(state.dir, "missing.env")}`, "DORI_DISCORD_TOKEN=fake",
        "bun", "--preload", join(import.meta.dir, "fixtures/discord-send-preload.ts"), join(import.meta.dir, "../src/cli.ts"), "send", "discord", "--to", "channel", "--thread", "thread", "--text", "hello", ...extra]));
    }
    expect(results.map((r) => ({ code: r.code, out: r.out }))).toEqual([
      { code: 0, out: "REQUEST typing\nREQUEST messages\nSENT fake-message" },
      { code: 0, out: "REQUEST messages\nSENT fake-message" },
      { code: 0, out: "REQUEST fake-message" },
    ]);
  } finally {
    state.done();
  }
});

for (const [text, ping, content] of [
  ["hello @everyone <@456>", "123", "<@123> hello @everyone <@456>"],
  ["hello <@123>", "123", "hello <@123>"],
  ["hello <@123>", undefined, "hello <@123>"],
] as const) {
  test(`Discord CLI request body with ping ${ping} and text ${text}`, async () => {
    const state = withState();
    try {
      const file = join(state.dir, "http.json");
      const result = await run(["env", `DORI_CONFIG=${join(state.dir, "missing.json")}`, `DORI_STATE_DIR=${state.dir}`, `DORI_ENV_FILE=${join(state.dir, "missing.env")}`, "DORI_DISCORD_TOKEN=fake", `DORI_TEST_HTTP=${file}`,
        "bun", "--preload", join(import.meta.dir, "discord-cli-fake.ts"), join(import.meta.dir, "../src/cli.ts"), "send", "discord", "--to", "channel", "--thread", "thread", "--text", text, "--no-typing", ...(ping === undefined ? [] : ["--ping", ping])]);
      expect({ code: result.code, out: result.out, calls: JSON.parse(readFileSync(file, "utf8")).calls }).toEqual({
        code: 0, out: "SENT 900", calls: [{ method: "POST", path: "/channels/thread/messages", body: { content, allowed_mentions: { parse: [], ...(ping === undefined ? {} : { users: [ping] }) } } }],
      });
    } finally {
      state.done();
    }
  });
}

test("Discord CLI sends to DORI_DISCORD_API when it is set (a Dori behind an egress gate), and to Discord when it is not", async () => {
  const seen: string[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => { seen.push(`${req.method} ${new URL(req.url).pathname} ${req.headers.get("authorization")}`); return Response.json({ id: "901" }); } });
  const state = withState();
  try {
    const base = ["env", `DORI_CONFIG=${join(state.dir, "missing.json")}`, `DORI_STATE_DIR=${state.dir}`, `DORI_ENV_FILE=${join(state.dir, "missing.env")}`, "DORI_DISCORD_TOKEN=fake"];
    const gated = await run([...base, `DORI_DISCORD_API=http://127.0.0.1:${server.port}/api/v10`, "bun", join(import.meta.dir, "../src/cli.ts"), "send", "discord", "--to", "channel", "--text", "hello", "--no-typing"]);
    const file = join(state.dir, "http.json");
    const direct = await run([...base, `DORI_TEST_HTTP=${file}`, "bun", "--preload", join(import.meta.dir, "discord-cli-fake.ts"), join(import.meta.dir, "../src/cli.ts"), "send", "discord", "--to", "channel", "--text", "hello", "--no-typing"]);
    expect({ gated: gated.out, seen, direct: direct.out, calls: JSON.parse(readFileSync(file, "utf8")).calls.map((c: { path: string }) => c.path) }).toEqual({
      gated: "SENT 901", seen: ["POST /api/v10/channels/channel/messages Bot fake"], direct: "SENT 900", calls: ["/channels/channel/messages"],
    });
  } finally {
    server.stop(true);
    state.done();
  }
});

for (const ping of ["abc", "123x", "", " 123", "123\n"]) {
  test(`Discord CLI refuses invalid ping ${JSON.stringify(ping)} before HTTP`, async () => {
    const state = withState();
    try {
      const file = join(state.dir, "http.json");
      const result = await run(["env", `DORI_CONFIG=${join(state.dir, "missing.json")}`, `DORI_STATE_DIR=${state.dir}`, `DORI_ENV_FILE=${join(state.dir, "missing.env")}`, "DORI_DISCORD_TOKEN=fake", `DORI_TEST_HTTP=${file}`,
        "bun", "--preload", join(import.meta.dir, "discord-cli-fake.ts"), join(import.meta.dir, "../src/cli.ts"), "send", "discord", "--to", "channel", "--text", "hello", "--ping", ping]);
      expect({ code: result.code, sent: existsSync(file) }).toEqual({ code: 1, sent: false });
    } finally {
      state.done();
    }
  });
}

// 2026-10-19: "line one\nline two" in shell double quotes reached Discord as a backslash and an n (E7 thread 1561758859717115997)
const sendCli = async (dir: string, args: readonly string[]) => {
  const file = join(dir, "http.json");
  const r = await run(["env", `DORI_CONFIG=${join(dir, "missing.json")}`, `DORI_STATE_DIR=${dir}`, `DORI_ENV_FILE=${join(dir, "missing.env")}`, "DORI_DISCORD_TOKEN=fake", `DORI_TEST_HTTP=${file}`,
    "bun", "--preload", join(import.meta.dir, "discord-cli-fake.ts"), join(import.meta.dir, "../src/cli.ts"), ...args]);
  const calls = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")).calls as { path: string; body?: { content?: string } }[]) : [];
  return { code: r.code, out: r.out, err: r.err, posted: calls.filter((c) => c.path.endsWith("/messages")).map((c) => c.body?.content) };
};

for (const args of [
  ["send", "discord", "--to", "channel", "--no-typing", "--text", "E7 끝났어\\n남은 건 없어"],
  ["thread", "reply", "discord:300000000000000003", "E7 끝났어\\n남은 건 없어"],
  ["thread", "done", "discord:300000000000000003", "E7 끝났어\\n남은 건 없어"],
]) {
  test(`${args.slice(0, 2).join(" ")} refuses a literal \\n with no real line break before anything is sent (SEND_LITERAL_NEWLINE)`, async () => {
    const state = withState();
    try {
      const r = await sendCli(state.dir, args);
      expect({ code: r.code, refused: r.err.includes("SEND_LITERAL_NEWLINE") && r.err.includes("--text-file FILE"), posted: r.posted }).toEqual({ code: 2, refused: true, posted: [] });
    } finally {
      state.done();
    }
  });
}

test("a literal \\n inside code, or beside real line breaks, is sent as written", async () => {
  const state = withState();
  try {
    const texts = ["split it with `printf 'a\\nb'`", "```\nprintf 'a\\nb'\n```", "first line\nthen a \\n in the second"];
    const out = [];
    for (const text of texts) out.push(await sendCli(state.dir, ["send", "discord", "--to", "channel", "--no-typing", "--text", text]));
    expect(out.map((r) => r.code)).toEqual([0, 0, 0]);
    expect(out.at(-1)?.posted).toEqual(texts);
  } finally {
    state.done();
  }
});

test("send --text-file posts the file's text with its real line breaks, like --text; both at once are refused", async () => {
  const state = withState();
  try {
    const file = join(state.dir, "post.txt");
    await Bun.write(file, "E7 끝났어\n남은 건 없어\n");
    const sent = await sendCli(state.dir, ["send", "discord", "--to", "channel", "--no-typing", "--text-file", file]);
    expect({ code: sent.code, out: sent.out, posted: sent.posted }).toEqual({ code: 0, out: "SENT 900", posted: ["E7 끝났어\n남은 건 없어"] });
    const both = await sendCli(state.dir, ["send", "discord", "--to", "channel", "--no-typing", "--text-file", file, "--text", "x"]);
    expect(both.code).toBe(1);
  } finally {
    state.done();
  }
});
