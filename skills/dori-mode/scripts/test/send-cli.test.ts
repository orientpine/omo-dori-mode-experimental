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
