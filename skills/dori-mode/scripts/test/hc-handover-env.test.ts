import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a lead handover started with DORI_RUNTIME=hc and no runtime in the config hands the runtime to its detached run (review 4 of #404)", async () => {
  // Given: the caller is the lead's hc terminal, the config names no runtime, and a systemd-run that records its argv
  const home = mkdtempSync(join(tmpdir(), "hc-detach-"));
  try {
    writeFileSync(join(home, "systemd-run"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${home}/argv"\n`);
    chmodSync(join(home, "systemd-run"), 0o700);
    writeFileSync(join(home, "config.json"), JSON.stringify({ stateDir: join(home, "state"), leadPane: "hc:t9" }));
    const env = { HOME: home, PATH: `${home}:${process.env["PATH"]}`, DORI_CONFIG: join(home, "config.json"), DORI_ENV_FILE: join(home, "dori.env"), DORI_STATE_DIR: join(home, "state"), DORI_RUNTIME: "hc", HC_TERMINAL_ID: "t9" };
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "handover", "--approved-by", "test"], { env, stdout: "pipe", stderr: "pipe" });
    const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    // Then: it detached, and the unit gets DORI_RUNTIME, so the replacement lead opens on hc
    expect(`${code} ${out.split(" ")[0]}`).toBe("0 HANDOVER_DETACHED");
    expect(readFileSync(join(home, "argv"), "utf8").split("\n")).toContain("--setenv=DORI_RUNTIME");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
