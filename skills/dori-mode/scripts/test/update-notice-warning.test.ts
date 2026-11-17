import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { updateNoticeProblem } from "../src/update-notice-warning.ts";
import { run } from "../src/run.ts";
import { viaEnvFile, withState } from "./fakes.ts";

for (const text of ["[UPDATE] 새 동작을 반영했어", "앞 문장\n[UPDATE] 새 동작을 반영했어", "Changed guidance:\nskills/a.md\n\nRestarts:\nservice active", "Changed guidance:\nskills/a.md\n\nCONFIG_NEW_KEY: discord.example"]) {
  test(`non-maintainer announcement warns: ${text}`, () => expect(updateNoticeProblem(text, false)).toBe("non-maintainer update summary to its own owner channel"));
  test(`maintainer announcement stays clean: ${text}`, () => expect(updateNoticeProblem(text, true)).toBeUndefined());
}
for (const text of ["작업 끝났어", "설명에는 [UPDATE] 머리를 써", "`[UPDATE] 새 동작`", "> [UPDATE] 새 동작", "```\n[UPDATE] 새 동작\n```", "[UPDATE]", "Changed guidance:\nexample.md", "Restarts:\nactive", ""]) {
  test(`ordinary text or quoted update stays clean: ${text}`, () => expect(updateNoticeProblem(text, false)).toBeUndefined());
}

for (const [to, owner, maintainer, text, expected, extra] of [
  ["owner", "owner", false, "[UPDATE] 새 동작을 반영했어", true, []],
  ["owner", "owner", false, "작업 끝났어", false, []],
  ["owner", "owner", true, "[UPDATE] 새 동작을 반영했어", false, []],
  ["pair", "owner", false, "[UPDATE] 새 동작을 반영했어", false, []],
  ["other", "owner", false, "[UPDATE] 새 동작을 반영했어", false, []],
  ["owner", "", false, "[UPDATE] 새 동작을 반영했어", false, []],
  ["owner", "owner", false, "[UPDATE] 새 동작을 반영했어", true, ["--edit", "900"]],
  ["owner", "owner", false, "[UPDATE] 새 동작을 반영했어", false, ["--thread", "300000000000000003"]],
  ["other", "owner", false, "[UPDATE] 새 동작을 반영했어", true, ["--thread", "owner"]],
  ["owner", "owner", false, "Changed guidance:\nexample.md\n\nRestarts:\nactive", true, []],
] as const) {
  test(`real CLI to=${to} owner=${owner} maintainer=${maintainer} ${extra.join(" ")} warning=${expected}`, async () => {
    const state = withState();
    try {
      const file = join(state.dir, "http.json");
      const watch = join(state.dir, "watch.log");
      const config = join(state.dir, "config.json");
      writeFileSync(config, JSON.stringify({ stateDir: state.dir, watchLog: watch, update: { maintainer }, discord: { locale: "ko-KR" } }));
      const r = await run(viaEnvFile(["env", `DORI_CONFIG=${config}`, `DORI_STATE_DIR=${state.dir}`, `DORI_ENV_FILE=${join(state.dir, "test.env")}`, "DORI_DISCORD_TOKEN=fake",
        `DORI_DISCORD_CHANNEL=${owner}`, "DORI_DISCORD_PAIR_CHANNEL=pair", "DORI_TEST_THREAD_PARENT=owner", `DORI_TEST_HTTP=${file}`,
        "bun", "--preload", join(import.meta.dir, "discord-cli-fake.ts"), join(import.meta.dir, "../src/cli.ts"),
        "send", "discord", "--to", to, "--text", text, "--no-typing", ...extra]));
      expect(r.code).toBe(0);
      expect(r.err.includes("UPDATE_NOTICE_REPEAT send:")).toBe(expected);
      expect(r.err.includes("directive update-notice-once")).toBe(expected);
      expect(existsSync(watch) ? readFileSync(watch, "utf8").includes("send UPDATE_NOTICE_REPEAT") : false).toBe(expected);
      expect(JSON.parse(readFileSync(file, "utf8")).calls.some((c: { method: string; body: { content?: string } }) => ["POST", "PATCH"].includes(c.method) && c.body.content === text)).toBe(true);
    } finally { state.done(); }
  });
}
