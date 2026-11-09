import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hcCore } from "../src/hc-lead-core.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const rig = (lead: string): { dir: string; bin: string } => {
  const dir = mkdtempSync(join(tmpdir(), "dori-hc-attach-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(dir, ".dori"));
  writeFileSync(join(dir, ".dori", "dori.env"), "HC_SESSION=agents\n");
  mkdirSync(join(dir, ".bun", "bin"), { recursive: true });
  symlinkSync(process.execPath, join(dir, ".bun", "bin", "bun"));
  symlinkSync(join(import.meta.dir, "../../../.."), join(dir, ".dori", "src"));
  const executable = (name: string, text: string) => writeFileSync(join(bin, name), `#!/bin/sh\n${text}\n`, { mode: 0o700 });
  executable("dori", `if [ "$1" = lead ]; then printf '%s\\n' '${lead}'; else printf 'dori %s\\n' "$*"; fi`);
  executable("systemctl", `printf 'systemctl %s\\n' "$*"`);
  executable("hc", `if [ -n "$HC_SOCKET" ]; then printf 'unexpected socket %s\\n' "$HC_SOCKET"; fi\nprintf 'hc session=%s %s\\n' "\${HC_SESSION:-default}" "$*"`);
  executable("herdr", `printf 'unexpected herdr %s\\n' "$*"`);
  executable("aoe", `printf 'unexpected aoe %s\\n' "$*"`);
  return { dir, bin };
};

const runLauncher = (dir: string, bin: string) => Bun.spawn(["bash", join(import.meta.dir, "../../setups/discord-aoe/dori.sh")], {
  env: { ...process.env, HOME: dir, PATH: `${bin}:${process.env["PATH"]}`, XDG_RUNTIME_DIR: join(dir, "run"), DORI_ENV_FILE: join(dir, ".dori", "dori.env"), HC_SESSION: "inherited-host", HC_SOCKET: "/tmp/inherited.sock" },
  stdout: "pipe", stderr: "pipe",
});

test("dori.sh revives a stopped hc lead and attaches it in the Dori's named core", async () => {
  // Given: a stopped hc lead and its named core's socket
  const { dir, bin } = rig("session hc:t7 stopped");
  mkdirSync(join(dir, "run", "herdr-core"), { recursive: true });
  writeFileSync(join(dir, "run", "herdr-core", "agents.sock"), "");
  const child = runLauncher(dir, bin);
  // When
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  // Then: services start, the recorded lead is revived, and hc attaches it in agents, never herdr or aoe
  expect({ code, err, lines: out.trim().split("\n") }).toEqual({
    code: 0,
    err: "",
    lines: ["systemctl --user start dori-inbound.service dori-google-watch.service", "dori revive hc:t7", "hc session=agents attach t7"],
  });
});

test("dori.sh never starts a missing hc core", async () => {
  // Given: a live hc lead but no named-core socket
  const { dir, bin } = rig("session hc:t7");
  const child = runLauncher(dir, bin);
  // When
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  // Then: the helper refuses before hc attach, and there is no revive of a live lead
  expect(code).not.toBe(0);
  expect(err).toContain("agents");
  expect(err).toContain("not starting one");
  expect(out).not.toContain("hc session=");
  expect(out).not.toContain("dori revive");
});

test("the hc core name uses the dori.env parser: whitespace, quotes and the first value", () => {
  // Given / When / Then
  expect(hcCore("  HC_SESSION= \"agents\"\nHC_SESSION=other\n")).toBe("agents");
  expect(hcCore("HC_SESSION='agents'\n")).toBe("agents");
  expect(hcCore("OTHER=x\n")).toBe("");
});
