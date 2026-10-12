import { expect, test } from "bun:test";
import { join } from "node:path";
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
