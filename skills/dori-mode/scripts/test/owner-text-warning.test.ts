import { expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { koreanOwnerProblem, kstOwnerProblem, textWarning } from "../src/owner-text-warning.ts";
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

test("a watch log that cannot be written does not stop the warning's command: the warning and the failure go to stderr (review 1 of #497)", () => {
  const state = withState();
  const blocker = join(state.dir, "not-a-dir");
  writeFileSync(blocker, "a file where the log's folder would be");
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(() => textWarning(join(blocker, "watch.log"), "send discord", "OWNER_NOT_KOREAN", "korean-discord", "prose has no Hangul")).not.toThrow();
    const lines = err.mock.calls.map((c) => String(c[0]));
    expect(lines[0]).toStartWith("OWNER_NOT_KOREAN send discord: prose has no Hangul (directive korean-discord;");
    expect(lines[1]).toStartWith(`OWNER_NOT_KOREAN not written to the watch log ${join(blocker, "watch.log")}: `);
  } finally {
    err.mockRestore();
    state.done();
  }
});

test("a UTC clock with a promise to convert it (KST로) is not a KST time; a real annotation counts (review 1 of #501)", () => {
  expect(kstOwnerProblem("작업은 UTC 10:30 (KST로 바꿀게)에 끝나", "ko-KR")).toBe("UTC time without a KST time");
  expect(kstOwnerProblem("UTC 10:30 (KST로 바꿀게)", "ko-KR")).toBe("UTC time without a KST time");
  expect(kstOwnerProblem("10:30Z에 끝나고 19:30 KST에 알려줄게", "ko-KR")).toBeUndefined();
  expect(kstOwnerProblem("10:30Z에 끝나고 KST 오후 7시 30분에 알려줄게", "ko-KR")).toBeUndefined();
  expect(kstOwnerProblem("10:30Z에 끝나고 KST 19:30에 알려줄게", "ko-KR")).toBeUndefined();
  expect(kstOwnerProblem("오늘 10:30Z에 끝나 (KST)", "ko-KR")).toBe("UTC time without a KST time");
});

test("review 2 of #501: real converted forms with particles count, conversion promises do not", () => {
  expect(kstOwnerProblem("10:30Z / 한국 시간으로 19:30에 시작해", "ko-KR")).toBeUndefined();
  expect(kstOwnerProblem("10:30Z에 끝나고 19:30 KST부터 시작해", "ko-KR")).toBeUndefined();
  expect(kstOwnerProblem("10:30Z에 끝나고 19:30 KST에 시작해", "ko-KR")).toBeUndefined();
  expect(kstOwnerProblem("UTC 10:30 (KST 변환 예정)", "ko-KR")).toBe("UTC time without a KST time");
  expect(kstOwnerProblem("UTC 10:30 (KST로 바꿀게)", "ko-KR")).toBe("UTC time without a KST time");
  expect(kstOwnerProblem("10:30Z에 끝나고 KST는 19:30이야", "ko-KR")).toBeUndefined();
});

test("review 3 of #501: whitespace, newlines and punctuation after a KST time still count; UTC-labelled clocks do not count as the counterpart", () => {
  expect(kstOwnerProblem("10:30Z / 19:30 KST 기준으로 시작해", "ko-KR")).toBeUndefined();
  expect(kstOwnerProblem("10:30Z / 19:30 KST\n작업 시작해", "ko-KR")).toBeUndefined();
  expect(kstOwnerProblem("10:30Z / 19:30 KST.", "ko-KR")).toBeUndefined();
  expect(kstOwnerProblem("UTC 10:30 (KST로 바꿀게)", "ko-KR")).toBe("UTC time without a KST time");
  expect(kstOwnerProblem("UTC 10:30 (KST 변환 예정)", "ko-KR")).toBe("UTC time without a KST time");
  expect(kstOwnerProblem("10:30Z에 끝나", "ko-KR")).toBe("UTC time without a KST time");
  expect(kstOwnerProblem("2026-11-17T10:30:00Z에 끝나", "ko-KR")).toBe("UTC time without a KST time");
  expect(kstOwnerProblem("10:30Z / 2026-11-17T19:30:00+09:00", "ko-KR")).toBeUndefined();
  expect(kstOwnerProblem("10:30Z / 19:30", "ko-KR")).toBe("UTC time without a KST time");
});

test("review 4 of #501: only a clock next to a KST zone counts; UTC suffix, fractional Z and unrelated other-zone clocks do not", () => {
  expect(kstOwnerProblem("10:30 UTC (KST로 바꿀게)", "ko-KR")).toBe("UTC time without a KST time");
  expect(kstOwnerProblem("2026-11-17T10:30:00.123Z (KST로 바꿀게)", "ko-KR")).toBe("UTC time without a KST time");
  expect(kstOwnerProblem("UTC 10:30에 시작해. 11:00 PST에 끝나. KST로 바꿀게.", "ko-KR")).toBe("UTC time without a KST time");
  expect(kstOwnerProblem("10:30Z / 19:30 KST 기준으로 시작해", "ko-KR")).toBeUndefined();
  expect(kstOwnerProblem("10:30Z / 19:30 KST\n작업 시작해", "ko-KR")).toBeUndefined();
  expect(kstOwnerProblem("10:30Z / 한국 시간으로 19:30에 시작해", "ko-KR")).toBeUndefined();
  expect(kstOwnerProblem("10:30Z / KST 19:30", "ko-KR")).toBeUndefined();
});

test("review 5 of #501: fractional KST clocks count, and a punctuated UTC label still marks the UTC clock", () => {
  expect(kstOwnerProblem("10:30:00.123Z / 19:30:00.123 KST", "ko-KR")).toBeUndefined();
  expect(kstOwnerProblem("UTC: 10:30 (KST로 바꿀게)", "ko-KR")).toBe("UTC time without a KST time");
  expect(kstOwnerProblem("UTC: 10:30 / 19:30 KST", "ko-KR")).toBeUndefined();
});

test("review 6 of #501: Korean UTC qualifiers (기준, 시간) mark the UTC clock too", () => {
  expect(kstOwnerProblem("UTC 기준 10:30 (KST로 바꿀게)", "ko-KR")).toBe("UTC time without a KST time");
  expect(kstOwnerProblem("UTC 기준 10:30 / 19:30 KST", "ko-KR")).toBeUndefined();
  expect(kstOwnerProblem("UTC 시간 10:30 (KST로 바꿀게)", "ko-KR")).toBe("UTC time without a KST time");
});

test("review 7 of #501: any Korean qualifier after UTC marks the clock, but UTC contrasted with KST does not steal the KST clock", () => {
  expect(kstOwnerProblem("UTC 기준으로 10:30 (KST로 바꿀게)", "ko-KR")).toBe("UTC time without a KST time");
  expect(kstOwnerProblem("UTC 기준으로 10:30 / 19:30 KST", "ko-KR")).toBeUndefined();
  expect(kstOwnerProblem("UTC와 달리 KST 19:30에 시작해", "ko-KR")).toBeUndefined();
});

test("review 8 of #501: a UTC suffix belongs to its own clock, not to the KST clock after a separator", () => {
  expect(kstOwnerProblem("10:30 UTC / 19:30 KST에 시작해", "ko-KR")).toBeUndefined();
  expect(kstOwnerProblem("10:30 UTC (19:30 KST)", "ko-KR")).toBeUndefined();
  expect(kstOwnerProblem("10:30 UTC (KST로 바꿀게)", "ko-KR")).toBe("UTC time without a KST time");
});
