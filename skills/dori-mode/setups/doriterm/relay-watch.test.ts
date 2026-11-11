import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const SELF = "5fdvklsv6ew2s5getenmuhnvxu";
const STATUS = JSON.stringify({ v: 1, meshId: "zuonoy2jvj3mfrav2stgoytjfa", self: SELF, members: [] }, null, 2);
type Fake = { probe?: "ok" | "offline" | "hang"; active?: boolean; status?: string; state?: string; env?: Record<string, string> };

async function watch(fake: Fake = {}) {
  const dir = mkdtempSync(join(tmpdir(), "doriterm-relay-watch-"));
  dirs.push(dir);
  writeFileSync(join(dir, "status.json"), fake.status ?? STATUS);
  if (fake.state !== undefined) writeFileSync(join(dir, "watch.state"), fake.state);
  // the host: mesh status prints the status file, connect is the relay round trip to itself
  writeFileSync(join(dir, "doriface-host"), `#!/bin/sh
printf 'host %s\\n' "$*" >> "$HOME/calls"
case "$1" in
  mesh) cat "$HOME/status.json";;
  connect) case "${fake.probe ?? "ok"}" in
    ok) exit 0;;
    offline) echo "doriface-host connect: ori0a83 is offline (4404 x2); next try in 30 s" >&2; exit 1;;
    hang) exec sleep 30;;
  esac;;
  *) exit 1;;
esac
`, { mode: 0o700 });
  writeFileSync(join(dir, "systemctl"), `#!/bin/sh
printf 'systemctl %s\\n' "$*" >> "$HOME/calls"
[ "$2" = is-active ] && exit ${fake.active === false ? 3 : 0}
exit 0
`, { mode: 0o700 });
  const child = Bun.spawn(["/bin/sh", join(import.meta.dir, "relay-watch.sh")], {
    env: {
      HOME: dir, PATH: `${dir}:/usr/bin:/bin`, DORIFACE_HOST: join(dir, "doriface-host"), DORIFACE_HOST_STATE_DIR: join(dir, "host-state"),
      DORITERM_RELAY_WATCH_STATE: join(dir, "watch.state"), ...fake.env,
    },
    stdout: "pipe", stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const read = async (name: string) => { const f = Bun.file(join(dir, name)); return (await f.exists()) ? await f.text() : ""; };
  const calls = (await read("calls")).trim().split("\n").filter(Boolean);
  return { code, out: out.trim(), err, calls, state: await read("watch.state") };
}

const now = () => Math.floor(Date.now() / 1000);
const restarted = (calls: string[]) => calls.filter((c) => c.startsWith("systemctl --user restart"));

test("an answered round trip through the relay to itself is up and clears a recorded drop", async () => {
  // Given: a drop recorded a minute ago, and the round trip answers now
  const r = await watch({ probe: "ok", state: `down_since=${now() - 60}\nrestarts=""\n` });
  // Then: up again, the drop forgotten, nothing restarted; the probe went to the host's own hostId
  expect(r.code).toBe(0);
  expect(r.out).toMatch(/^RELAY_WATCH_UP again after 6\d s down$/);
  expect(r.calls.find((c) => c.startsWith("host connect"))).toMatch(new RegExp(`^host connect --mesh --state-dir \\S+/host-state ${SELF}$`));
  expect(r.state).toContain("down_since=\n");
  expect(restarted(r.calls)).toEqual([]);
});

test("a first failed round trip is a drop being timed, not a restart", async () => {
  const r = await watch({ probe: "offline" });
  expect(r.code).toBe(0);
  expect(r.out).toMatch(/^RELAY_WATCH_DOWN since \S+Z \(0 s\): doriface-host connect: ori0a83 is offline/);
  expect(r.state).toContain(`down_since=${now()}`.slice(0, -1));
  expect(restarted(r.calls)).toEqual([]);
});

test("a round trip that kept failing for the down minutes restarts the host's unit once and records it", async () => {
  // Given: failing since 200 s ago (past 3 minutes)
  const r = await watch({ probe: "offline", state: `down_since=${now() - 200}\nrestarts=""\n` });
  expect(r.out).toMatch(/^RELAY_WATCH_RESTART doriface-host\.service, down since \S+Z \(20\d s\)/);
  expect(restarted(r.calls)).toEqual(["systemctl --user restart doriface-host.service"]);
  expect(r.state).toMatch(/^down_since=\nrestarts="\d+"\n$/);
});

test("a drop still under the down minutes is not restarted", async () => {
  const r = await watch({ probe: "offline", state: `down_since=${now() - 170}\nrestarts=""\n` });
  expect(r.out).toStartWith("RELAY_WATCH_DOWN since");
  expect(restarted(r.calls)).toEqual([]);
});

test("after the hour's restarts are spent it only says so; a restart older than an hour no longer counts", async () => {
  const t = now();
  const capped = await watch({ probe: "offline", state: `down_since=${t - 600}\nrestarts="${t - 3000} ${t - 2000} ${t - 1000}"\n` });
  expect(capped.out).toStartWith("RELAY_WATCH_CAPPED 3 restarts in the last hour");
  expect(restarted(capped.calls)).toEqual([]);
  const aged = await watch({ probe: "offline", state: `down_since=${t - 600}\nrestarts="${t - 4000} ${t - 2000} ${t - 1000}"\n` });
  expect(aged.out).toStartWith("RELAY_WATCH_RESTART");
  expect(restarted(aged.calls)).toEqual(["systemctl --user restart doriface-host.service"]);
  expect(aged.state).not.toContain(String(t - 4000));
});

test("with restarts off it says what it would do and restarts nothing", async () => {
  const r = await watch({ probe: "offline", state: `down_since=${now() - 600}\nrestarts=""\n`, env: { DORITERM_RELAY_WATCH_RESTART: "0" } });
  expect(r.out).toStartWith("RELAY_WATCH_WOULD_RESTART doriface-host.service, down since");
  expect(restarted(r.calls)).toEqual([]);
});

test("a round trip that never answers counts as down after the probe seconds", async () => {
  const r = await watch({ probe: "hang", env: { DORITERM_RELAY_WATCH_PROBE_SECONDS: "1" } });
  expect(r.out).toMatch(/^RELAY_WATCH_DOWN since \S+ \(0 s\): no answer in 1 s$/);
});

test("a stopped host is left to its own unit: no mesh call, no probe, no restart", async () => {
  const r = await watch({ active: false, state: `down_since=${now() - 600}\nrestarts=""\n` });
  expect(r.out).toBe("RELAY_WATCH_SKIP doriface-host.service is not running; its own unit brings it back");
  expect(r.calls).toEqual(["systemctl --user is-active --quiet doriface-host.service"]);
  expect(r.state).toContain("down_since=\n");
});

test("a running host that gives no mesh status is down too, so a wedged host is restarted in time", async () => {
  const r = await watch({ status: "doriface-host mesh status: no host is running on this state dir", state: `down_since=${now() - 200}\nrestarts=""\n` });
  expect(r.out).toMatch(/^RELAY_WATCH_RESTART .*: mesh status: doriface-host mesh status: no host is running/);
  expect(r.calls.some((c) => c.startsWith("host connect"))).toBe(false);
});

test("a value that is not a whole number is refused before anything runs", async () => {
  const r = await watch({ env: { DORITERM_RELAY_WATCH_DOWN_MINUTES: "3m" } });
  expect(r.code).toBe(2);
  expect(r.out).toStartWith("RELAY_WATCH_CONFIG_BAD");
  expect(r.calls).toEqual([]);
});
