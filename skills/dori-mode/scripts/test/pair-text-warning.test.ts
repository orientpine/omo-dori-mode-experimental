import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pairTextWarnings } from "../src/pair-text-warning.ts";
import { run } from "../src/run.ts";
import { viaEnvFile, withState } from "./fakes.ts";

for (const text of ["[REPORT] 끝났어", "  [REPORT] 결과\n근거", "[REPORT]\n확인했어"]) {
  test(`report header warns: ${text}`, () => expect(pairTextWarnings(text).map((w) => [w.token, w.id])).toEqual([["PAIR_REPORT_SHAPE", "report-shape"]]));
}
for (const text of ["받았어", "확인했어.", "알겠어!", "ok", "넵", "OK, 확인했어!", "받았어.\n알겠어.", "got it", "네"]) {
  test(`acknowledgement only warns: ${text}`, () => expect(pairTextWarnings(text).map((w) => [w.token, w.id])).toEqual([["PAIR_ACK_ONLY", "pair-efficient"]]));
}
for (const text of ["끝났어. PR #42에서 확인해. 남은 건 없어.", "받았어. 로그가 필요해", "확인했어, 다음 일을 넘겨줘", "> [REPORT] quoted", "```\n[REPORT] sample\n```", "본문에 [REPORT]를 설명해", "", "PR42", "ok https://example.com", "ok `receipt`"]) {
  test(`substantive or quoted text stays clean: ${text}`, () => expect(pairTextWarnings(text)).toEqual([]));
}
test("an acknowledgement with attachments is not acknowledgement-only", () => expect(pairTextWarnings("받았어", true)).toEqual([]));

for (const [to, configured, text, expected, extra] of [
  ["pair", "pair", "[REPORT] 끝났어", "PAIR_REPORT_SHAPE", []],
  ["pair", "pair", "받았어", "PAIR_ACK_ONLY", []],
  ["pair", "pair", "로그가 필요해", "", []],
  ["owner", "pair", "받았어", "", []],
  ["pair", "", "받았어", "", []],
  ["pair", "pair", "ok", "PAIR_ACK_ONLY", ["--edit", "900"]],
  ["owner", "pair", "받았어", "PAIR_ACK_ONLY", ["--thread", "pair"]],
  ["pair", "pair", "받았어", "", ["--thread", "300000000000000003"]],
] as const) {
  test(`real CLI to=${to} configured=${configured} ${extra.join(" ")} token=${expected}`, async () => {
    const state = withState();
    try {
      const file = join(state.dir, "http.json");
      const watch = join(state.dir, "watch.log");
      const config = join(state.dir, "config.json");
      writeFileSync(config, JSON.stringify({ stateDir: state.dir, watchLog: watch, discord: { locale: "ko-KR" } }));
      const r = await run(viaEnvFile(["env", `DORI_CONFIG=${config}`, `DORI_STATE_DIR=${state.dir}`, `DORI_ENV_FILE=${join(state.dir, "test.env")}`, "DORI_DISCORD_TOKEN=fake",
        "DORI_DISCORD_CHANNEL=owner", `DORI_DISCORD_PAIR_CHANNEL=${configured}`, "DORI_TEST_THREAD_PARENT=other", `DORI_TEST_HTTP=${file}`,
        "bun", "--preload", join(import.meta.dir, "discord-cli-fake.ts"), join(import.meta.dir, "../src/cli.ts"),
        "send", "discord", "--to", to, "--text", text, "--no-typing", ...extra]));
      expect(r.code).toBe(0);
      if (expected) {
        expect(r.err).toContain(`${expected} send:`);
        expect(r.err).toContain(`directive ${expected === "PAIR_REPORT_SHAPE" ? "report-shape" : "pair-efficient"}`);
        expect(readFileSync(watch, "utf8")).toContain(`send ${expected}`);
      } else {
        expect(r.err).not.toContain("PAIR_");
        expect(existsSync(watch) ? readFileSync(watch, "utf8") : "").not.toContain("PAIR_");
      }
      const calls = JSON.parse(readFileSync(file, "utf8")).calls;
      expect(calls.some((c: { method: string; body: { content?: string } }) => ["POST", "PATCH"].includes(c.method) && c.body.content === text)).toBe(true);
    } finally { state.done(); }
  });
}
