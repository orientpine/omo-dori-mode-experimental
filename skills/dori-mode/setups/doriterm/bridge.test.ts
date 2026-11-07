import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    env: { ...Bun.env, HOME: dir, PATH: `${dir}:${Bun.env.PATH}`, DORITERM_BRIDGE_NAME: "zzangdori", DORITERM_BRIDGES: "", ...env },
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
  // Given: a fake sudo that records its argv and ends the loop on the second call
  const dir = mkdtempSync(join(tmpdir(), "doriterm-attach-acct-"));
  dirs.push(dir);
  writeFileSync(join(dir, "sudo"), `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/calls"
n=$(wc -l < "$HOME/calls")
[ "$n" -ge 2 ] && kill -TERM "$PPID"
exit 1
`, { mode: 0o700 });
  const child = Bun.spawn(["/bin/sh", join(import.meta.dir, "attach.sh"), "okdori"], {
    env: { ...Bun.env, HOME: dir, PATH: `${dir}:${Bun.env.PATH}`, DORITERM_RETRY_SECONDS: "0" },
    stdout: "pipe", stderr: "pipe",
  });
  await child.exited;
  // Then: retried, each time as okdori with its own HOME, and the command it runs is the attach-only client
  const calls = (await Bun.file(join(dir, "calls")).text()).trim().split("\n");
  expect(calls).toHaveLength(2);
  for (const c of calls) {
    expect(c.startsWith("-n -u okdori -H /bin/sh -c ")).toBe(true);
    expect(c.endsWith("exec herdr client")).toBe(true);
  }
});

test("attach.sh keeps trying herdr client until the server is up, and never starts one", async () => {
  // Given: a fake herdr whose server answers only on the third attach (the third call ends the loop for the test)
  const dir = mkdtempSync(join(tmpdir(), "doriterm-attach-"));
  dirs.push(dir);
  writeFileSync(join(dir, "herdr"), `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/calls"
n=$(wc -l < "$HOME/calls")
[ "$n" -ge 3 ] || exit 1
kill -TERM "$PPID"
`, { mode: 0o700 });
  // When
  const child = Bun.spawn(["/bin/sh", join(import.meta.dir, "attach.sh")], {
    env: { ...Bun.env, HOME: dir, PATH: `${dir}:${Bun.env.PATH}`, DORITERM_RETRY_SECONDS: "0" },
    stdout: "pipe", stderr: "pipe",
  });
  await child.exited;
  // Then: three attach attempts, all `herdr client`, none a plain `herdr` that would start a server
  expect((await Bun.file(join(dir, "calls")).text()).trim().split("\n")).toEqual(["client", "client", "client"]);
});
