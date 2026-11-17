import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { koreanOwnerProblem } from "../src/owner-text-warning.ts";
import { defaultConfig } from "../src/config.ts";
import { makeDiscordDeps } from "../src/cli-deps-discord.ts";
import type { FlowDeps } from "../src/done-flow.ts";
import { run } from "../src/run.ts";
import { viaEnvFile, withState } from "./fakes.ts";

for (const text of ["Finished the work", "La tâche est finie", "作業完了"]) {
  test(`Korean owner prose warns: ${text}`, () => expect(koreanOwnerProblem(text, "ko-KR")).toBe("prose has no Hangul"));
}
for (const text of ["끝났어", "한글 and English", "`hello`", "```\nhello\n```", "> hello", '"hello"', "https://example.com", "123456789012345678 deadbeef TOKEN_ID", "$ git status", "bun test", "", "✅"]) {
  test(`non-prose or Korean stays clean: ${text}`, () => expect(koreanOwnerProblem(text, "ko-KR")).toBeUndefined());
}
test("non-Korean owner stays clean", () => expect(koreanOwnerProblem("Finished", "en-US")).toBeUndefined());

test("thread opens and renames warn without blocking, even through once()", async () => {
  const state = withState();
  const before = process.env["DORI_DISCORD_CHANNEL"];
  const api = process.env["DORI_DISCORD_API"];
  const error = console.error;
  const lines: string[] = [];
  const calls: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (req) => {
    calls.push(req.method);
    return Response.json(req.method === "GET" ? { type: 11, parent_id: "owner" } : { id: "thread" });
  } });
  try {
    process.env["DORI_DISCORD_CHANNEL"] = "owner";
    process.env["DORI_DISCORD_API"] = `http://127.0.0.1:${server.port}`;
    console.error = (line: string) => { lines.push(line); };
    const defaults = defaultConfig();
    const config = { ...defaults, discord: { ...defaults.discord, locale: "ko-KR" }, watchLog: join(state.dir, "watch.log") };
    const dc = makeDiscordDeps({ config, deps: {} as FlowDeps }).ownDiscord("fake");
    expect(await dc.startThread("owner", undefined, "Finished")).toBe("thread");
    await dc.once().setThread("thread", { name: "Finished" });
    await dc.setThread("thread", { name: "끝났어" });
    expect(lines.length).toBe(2);
    expect(lines.every((line) => line.includes("OWNER_NOT_KOREAN thread name:") && line.includes("directive korean-discord"))).toBe(true);
    expect(calls).toEqual(["POST", "GET", "PATCH", "PATCH"]);
  } finally {
    console.error = error;
    if (before === undefined) delete process.env["DORI_DISCORD_CHANNEL"]; else process.env["DORI_DISCORD_CHANNEL"] = before;
    if (api === undefined) delete process.env["DORI_DISCORD_API"]; else process.env["DORI_DISCORD_API"] = api;
    server.stop(true);
    state.done();
  }
});

for (const [text, locale, pair, warn] of [["Finished", "ko-KR", false, true], ["끝났어", "ko-KR", false, false], ["Finished", "en-US", false, false], ["Finished", "ko-KR", true, false]] as const) {
  test(`real send preserves success and logs warning=${warn}: ${text} ${locale} pair=${pair}`, async () => {
    const state = withState();
    try {
      const config = join(state.dir, "config.json");
      const watch = join(state.dir, "watch.log");
      writeFileSync(config, JSON.stringify({ stateDir: state.dir, watchLog: watch, discord: { locale } }));
      const http = join(state.dir, "http.json");
      const r = await run(viaEnvFile(["env", `DORI_CONFIG=${config}`, `DORI_STATE_DIR=${state.dir}`, `DORI_ENV_FILE=${join(state.dir, "test.env")}`,
        "DORI_DISCORD_TOKEN=fake", "DORI_DISCORD_CHANNEL=owner", "DORI_DISCORD_PAIR_CHANNEL=pair", `DORI_TEST_HTTP=${http}`,
        "bun", "--preload", join(import.meta.dir, "discord-cli-fake.ts"), join(import.meta.dir, "../src/cli.ts"),
        "send", "discord", "--to", pair ? "pair" : "owner", "--text", text, "--no-typing"]));
      expect(r.code).toBe(0);
      expect(r.out).toContain("SENT 900");
      expect(r.err.includes("OWNER_NOT_KOREAN")).toBe(warn);
      expect(r.err.includes("directive korean-discord")).toBe(warn);
      expect(existsSync(watch) ? readFileSync(watch, "utf8").includes("send OWNER_NOT_KOREAN") : false).toBe(warn);
      expect(JSON.parse(readFileSync(http, "utf8")).calls.at(-1).body.content).toBe(text);
    } finally { state.done(); }
  });
}
