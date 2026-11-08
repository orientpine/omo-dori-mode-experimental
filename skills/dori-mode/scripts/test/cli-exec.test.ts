import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// bun link points `dori` at src/cli.ts and dori update --pull never restores a mode, so the file itself must stay
// executable: run it by its path (its shebang), as the linked command and dori-lanes.sh do, not as `bun src/cli.ts`.
test("src/cli.ts runs by its own path and prints the usage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dori-cli-exec-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ stateDir: join(dir, "state") }));
  const env: Record<string, string | undefined> = { ...process.env, DORI_CONFIG: join(dir, "config.json"), DORI_ENV_FILE: join(dir, "none.env") };
  delete env["DORI_STATE_DIR"];
  const proc = Bun.spawn([join(import.meta.dir, "../src/cli.ts")], { env, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  expect(out.startsWith("dori <command>")).toBe(true);
}, 30_000);
