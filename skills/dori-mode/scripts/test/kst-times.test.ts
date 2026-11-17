import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { kstOwnerProblem } from "../src/owner-text-warning.ts";
import { run } from "../src/run.ts";
import { viaEnvFile, withState } from "./fakes.ts";

for (const text of ["10:30Z에 시작해", "UTC 10:30에 시작해", "2026-11-17T10:30:00.123Z에 시작해", "10:30Z (KST로 바꿀게)"]) {
  test(`UTC without a converted time warns: ${text}`, () => expect(kstOwnerProblem(text, "ko-KR")).toBe("UTC time without a KST time"));
}
for (const text of ["10:30Z / 19:30 KST", "10:30Z / KST 19:30", "UTC 10:30 / 19:30 (KST)", "UTC 10:30 / 한국 시간 19:30", "UTC 10:30 / 19시 30분 KST", "UTC 10:30 / 2026-11-17T19:30:00+09:00", "19:30 KST에 시작해", "시작해", "`10:30Z`", "```\nUTC 10:30\n```", "> UTC 10:30", '"UTC 10:30"', "https://example.com/10:30Z", ""]) {
  test(`converted, absent or quoted UTC stays clean: ${text}`, () => expect(kstOwnerProblem(text, "ko-KR")).toBeUndefined());
}
test("non-Korean locale stays clean", () => expect(kstOwnerProblem("10:30Z", "en-US")).toBeUndefined());

for (const [place, thread, text, warning] of [
  ["owner", false, "10:30Z에 시작해", true],
  ["owner", false, "10:30Z / 19:30 KST에 시작해", false],
  ["300000000000000003", false, "UTC 10:30에 시작해", true],
  ["owner", true, "2026-11-17T10:30:00Z에 시작해", true],
  ["pair", false, "UTC 10:30에 시작해", false],
] as const) {
  test(`real CLI ${thread ? "thread reply" : "send"} ${place} warning=${warning}`, async () => {
    const state = withState();
    try {
      const file = join(state.dir, "http.json");
      const watch = join(state.dir, "watch.log");
      const config = join(state.dir, "config.json");
      writeFileSync(config, JSON.stringify({ stateDir: state.dir, watchLog: watch, discord: { locale: "ko-KR" } }));
      const r = await run(viaEnvFile(["env", `DORI_CONFIG=${config}`, `DORI_STATE_DIR=${state.dir}`, `DORI_ENV_FILE=${join(state.dir, "test.env")}`, "DORI_DISCORD_TOKEN=fake",
        "DORI_DISCORD_CHANNEL=owner", "DORI_DISCORD_PAIR_CHANNEL=pair", "DORI_TEST_THREAD_PARENT=owner", `DORI_TEST_HTTP=${file}`,
        "bun", "--preload", join(import.meta.dir, "discord-cli-fake.ts"), join(import.meta.dir, "../src/cli.ts"),
        ...(thread ? ["thread", "reply", "discord:300000000000000003", text] : ["send", "discord", "--to", place, "--text", text, "--no-typing"])]));
      expect(r.code).toBe(0);
      expect(r.out).toContain(thread ? "POSTED 900" : "SENT 900");
      expect(r.err.includes("OWNER_TIME_NOT_KST")).toBe(warning);
      expect(r.err.includes("directive kst-times")).toBe(warning);
      expect(existsSync(watch) ? readFileSync(watch, "utf8").includes(`${thread ? "thread" : "send"} OWNER_TIME_NOT_KST`) : false).toBe(warning);
      const posts = JSON.parse(readFileSync(file, "utf8")).calls.filter((c: { method: string; path: string }) => c.method === "POST" && c.path.endsWith("/messages"));
      expect(posts[0].body.content).toBe(text);
    } finally { state.done(); }
  });
}
