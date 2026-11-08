import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function bridgeWithFakeHc(terminals: object[], args: string[] = [], env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "doriterm-bridge-"));
  dirs.push(dir);
  writeFileSync(join(dir, "ls.json"), JSON.stringify({ terminals }));
  writeFileSync(join(dir, "hc"), `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/calls"
case "$1" in
  ls) cat "$HOME/ls.json";;
  rm|run|server) ;;
  *) exit 1;;
esac
`, { mode: 0o700 });
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "bridge.ts"), ...args], {
    env: { ...Bun.env, HOME: dir, PATH: `${dir}:${Bun.env["PATH"]}`, DORITERM_BRIDGE_NAME: "zzangdori", DORITERM_BRIDGES: "", ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const recorded = Bun.file(join(dir, "calls"));
  const calls = (await recorded.exists()) ? (await recorded.text()).trim().split("\n") : [];
  return { code, out: out.trim(), err, calls };
}

test("starts the herdr client terminal when the account has none", async () => {
  // Given: hc lists another terminal only
  const r = await bridgeWithFakeHc([{ name: "other", state: "live" }]);
  // Then: one hc run of the attach-only herdr client, nothing typed
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  expect(r.out).toBe("zzangdori: started");
  expect(r.calls).toEqual(["ls --all --json", `run --bg --no-parent --name zzangdori -- /bin/sh ${join(import.meta.dir, "attach.sh")}`]);
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
  expect(r.calls).toEqual(["ls --all --json", "rm zzangdori", `run --bg --no-parent --name zzangdori -- /bin/sh ${join(import.meta.dir, "attach.sh")}`]);
});

test("stop stops the hc core, which systemd runs outside this unit", async () => {
  // When: the unit's ExecStopPost runs
  const r = await bridgeWithFakeHc([{ name: "zzangdori", state: "live" }], ["stop"]);
  // Then: one core stop and nothing else (no ls, which would start a core)
  expect(r.code).toBe(0);
  expect(r.out).toBe("bridges: stopped");
  expect(r.calls).toEqual(["server stop"]);
});

test("one row per listed Dori, in order: a live one kept, an ended one replaced, a missing one started as its account", async () => {
  // Given: this host's list, with zzangdori live and okdori ended
  const r = await bridgeWithFakeHc(
    [{ name: "zzangdori", state: "live" }, { name: "okdori", state: "finished" }],
    [],
    { DORITERM_BRIDGES: "zzangdori okdori:okdori yoodori:yoodori" },
  );
  // Then: one hc ls, nothing for zzangdori, okdori removed and started again, yoodori started; each other Dori's row
  // attaches as that account
  expect(r.err).toBe("");
  expect(r.out.split("\n")).toEqual(["zzangdori: kept", "okdori: started", "yoodori: started"]);
  expect(r.calls).toEqual([
    "ls --all --json",
    "rm okdori",
    `run --bg --no-parent --name okdori -- /bin/sh ${join(import.meta.dir, "attach.sh")} okdori`,
    `run --bg --no-parent --name yoodori -- /bin/sh ${join(import.meta.dir, "attach.sh")} yoodori`,
  ]);
});

test("a malformed list starts nothing", async () => {
  // Given: a name hc would refuse and a name listed twice
  for (const spec of ["Okdori:okdori", "okdori:okdori okdori:moodori", "okdori:ok:dori"]) {
    const r = await bridgeWithFakeHc([], [], { DORITERM_BRIDGES: spec });
    // Then: it fails before asking hc anything
    expect(r.code).not.toBe(0);
    expect(r.calls).toEqual([]);
  }
});

test("attach.sh with an account attaches to that account's herdr through sudo -n, never starting a server", async () => {
  // Given: a fake sudo that records its argv on one line and ends the loop on the second call
  const dir = mkdtempSync(join(tmpdir(), "doriterm-attach-acct-"));
  dirs.push(dir);
  writeFileSync(join(dir, "sudo"), `#!/bin/sh
printf '%s' "$*" | tr '\\n' ' ' >> "$HOME/calls"; echo >> "$HOME/calls"
n=$(wc -l < "$HOME/calls")
[ "$n" -ge 2 ] && kill -TERM "$PPID"
exit 1
`, { mode: 0o700 });
  const child = Bun.spawn(["/bin/sh", join(import.meta.dir, "attach.sh"), "okdori"], {
    env: { ...Bun.env, HOME: dir, PATH: `${dir}:${Bun.env["PATH"]}`, DORITERM_RETRY_SECONDS: "0" },
    stdout: "pipe", stderr: "pipe",
  });
  await child.exited;
  // Then: retried, each time as okdori with its own HOME, focusing its lead with its own herdr-web terminal.ts and then
  // running the attach-only client
  const calls = (await Bun.file(join(dir, "calls")).text()).trim().split("\n");
  expect(calls).toHaveLength(2);
  for (const c of calls) {
    expect(c.startsWith("-n -u okdori -H /bin/sh -c ")).toBe(true);
    expect(c).toContain('"$HOME/.bun/bin/bun" "$HOME/.dori/src/skills/dori-mode/setups/herdr-web/terminal.ts"');
    expect(c.trim().endsWith("exec herdr client")).toBe(true);
  }
});

async function attachWithFakes(files: Record<string, string> = {}) {
  // a fake bun (records which config it focused the lead from) and a fake herdr whose server answers on the third attach
  const dir = mkdtempSync(join(tmpdir(), "doriterm-attach-"));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  // bun only under ~/.bun/bin, where the account's own bun lives; the units' PATH does not include it
  mkdirSync(join(dir, ".bun", "bin"), { recursive: true });
  writeFileSync(join(dir, ".bun", "bin", "bun"), `#!/bin/sh
printf 'focus %s %s\\n' "$DORI_CONFIG" "$1" >> "$HOME/calls"
`, { mode: 0o700 });
  writeFileSync(join(dir, "herdr"), `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/calls"
n=$(grep -c '^client$' "$HOME/calls")
[ "$n" -ge 3 ] || exit 1
kill -TERM "$PPID"
`, { mode: 0o700 });
  const child = Bun.spawn(["/bin/sh", join(import.meta.dir, "attach.sh")], {
    env: { ...Bun.env, HOME: dir, PATH: `${dir}:${Bun.env["PATH"]}`, DORITERM_RETRY_SECONDS: "0" },
    stdout: "pipe", stderr: "pipe",
  });
  await child.exited;
  return { dir, calls: (await Bun.file(join(dir, "calls")).text()).trim().split("\n") };
}

test("attach.sh focuses the lead's tab, then keeps trying herdr client until the server is up, and never starts one", async () => {
  // Given: no instance config, so the account's own ~/.dori/config.json
  const { dir, calls } = await attachWithFakes();
  const focus = `focus ${dir}/.dori/config.json ${dir}/.dori/src/skills/dori-mode/setups/herdr-web/terminal.ts`;
  // Then: before every attach the lead is focused; all attaches are `herdr client`, none a plain `herdr`
  expect(calls).toEqual([focus, "client", focus, "client", focus, "client"]);
});

test("attach.sh takes an instance account's ~/.<user>/config.json for the lead", async () => {
  // Given: the account keeps its Dori config under ~/.<its user name>/ (okdori: ~/.okdori/config.json)
  const user = (await Bun.$`id -un`.text()).trim();
  const { dir, calls } = await attachWithFakes({ [`.${user}/config.json`]: "{}" });
  // Then: that config, not ~/.dori/config.json
  expect(calls[0]).toBe(`focus ${dir}/.${user}/config.json ${dir}/.dori/src/skills/dori-mode/setups/herdr-web/terminal.ts`);
});
