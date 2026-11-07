import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function bridgeWithFakeHc(terminals: object[]) {
  const dir = mkdtempSync(join(tmpdir(), "doriterm-bridge-"));
  dirs.push(dir);
  writeFileSync(join(dir, "ls.json"), JSON.stringify({ terminals }));
  writeFileSync(join(dir, "hc"), `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/calls"
case "$1" in
  ls) cat "$HOME/ls.json";;
  rm|run) ;;
  *) exit 1;;
esac
`, { mode: 0o700 });
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "bridge.ts")], {
    env: { ...Bun.env, HOME: dir, PATH: `${dir}:${Bun.env.PATH}`, DORITERM_BRIDGE_NAME: "zzangdori" },
    stdout: "pipe", stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const calls = (await Bun.file(join(dir, "calls")).text()).trim().split("\n");
  return { code, out: out.trim(), err, calls };
}

test("starts the herdr client terminal when the account has none", async () => {
  // Given: hc lists another terminal only
  const r = await bridgeWithFakeHc([{ name: "other", state: "live" }]);
  // Then: one hc run of a plain herdr client, nothing typed
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  expect(r.out).toBe("zzangdori: started");
  expect(r.calls).toEqual(["ls --all --json", "run --bg --no-parent --name zzangdori -- herdr"]);
});

test("leaves a live bridge alone", async () => {
  // Given: the bridge is already attached
  const r = await bridgeWithFakeHc([{ name: "zzangdori", state: "live" }]);
  // Then: no second client is started
  expect(r.out).toBe("zzangdori: kept");
  expect(r.calls).toEqual(["ls --all --json"]);
});

test("replaces a finished bridge after a core restart", async () => {
  // Given: the herdr client ended (the name stays taken until it is removed)
  const r = await bridgeWithFakeHc([{ name: "zzangdori", state: "finished" }]);
  // Then: removed, then started again under the same name
  expect(r.out).toBe("zzangdori: started");
  expect(r.calls).toEqual(["ls --all --json", "rm zzangdori", "run --bg --no-parent --name zzangdori -- herdr"]);
});
