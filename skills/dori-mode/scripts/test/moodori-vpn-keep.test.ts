import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credsFrom, inWindow, keepConfig, keepRun, keepTick, realDeps, totp, vpnState, type KeepDeps, type KeepOptions, type Tunnel, type TunnelProc, type VpnState } from "../../setups/moodori-vpn-keep/keep.ts";

const KEEP = join(import.meta.dir, "../../setups/moodori-vpn-keep/keep.ts");

const BASE = { enabled: true, pcSsh: "user@pc.example", vpnUrl: "https://vpn.example.com/", credsCommand: ["printf", "id\\npw\\n"], motpFile: "~/motp.json" };
const options = (over: Record<string, unknown> = {}): KeepOptions => {
  const c = keepConfig({ ...BASE, ...over }, "/home/x");
  if (!c.on) throw new Error("expected on");
  return c.options;
};

test("vpn keep is off without a config file or without enabled: true, and an enabled config fills MooDori's defaults", () => {
  expect(keepConfig(undefined)).toEqual({ on: false, reason: "no config file" });
  expect(keepConfig({ ...BASE, enabled: "yes" })).toEqual({ on: false, reason: "enabled is not true" });
  expect(() => keepConfig({ enabled: true, vpnUrl: "https://vpn.example.com/" })).toThrow("credsCommand must be a non-empty argv array");
  expect(options()).toEqual({
    pcSsh: "user@pc.example", vpnUrl: "https://vpn.example.com/", credsCommand: ["printf", "id\\npw\\n"], motpFile: "/home/x/motp.json",
    secuwayTask: "moodori-secuway", edgeTask: "moodori-edge", edgePort: 9222, cdpPort: 9224,
    days: [1, 2, 3, 4, 5], hours: [8, 20], timeZone: "Asia/Seoul", intervalMs: 60000, maxFails: 3, restMs: 900000, pauseFile: "/tmp/moodori-vpn-keep.pause",
  });
});

test("the VPN is up only when sslvpn.log's last start/stop line is a completed start and a SecuwaySSL process runs", () => {
  expect(vpnState("L|Thu Nov 05 08:01:02 2026 Initialization Sequence Completed\r\n1")).toBe("UP");
  expect(vpnState("L|Thu Nov 05 12:15:00 2026 SIGTERM[soft,exit-with-notification] received, process exiting\r\n1")).toBe("DOWN");
  expect(vpnState("L|Thu Nov 05 08:01:02 2026 Initialization Sequence Completed\r\n0")).toBe("DOWN");
  expect(vpnState("L|\r\n0")).toBe("DOWN");
  expect(vpnState("NOLOG\r\n0")).toBe("NOLOG");
  expect(vpnState("")).toBe("DOWN");
});

test("the window is weekdays 08:00-19:59 in Seoul time, whatever the host's zone", () => {
  const o = options();
  const at = (iso: string) => inWindow(new Date(iso), o);
  expect(at("2026-11-01T22:59:00Z")).toBe(false); // Mon 07:59 KST
  expect(at("2026-11-01T23:00:00Z")).toBe(true); // Mon 08:00 KST (still Sunday in UTC)
  expect(at("2026-11-05T10:59:00Z")).toBe(true); // Thu 19:59 KST
  expect(at("2026-11-05T11:00:00Z")).toBe(false); // Thu 20:00 KST
  expect(at("2026-11-06T23:30:00Z")).toBe(false); // Sat 08:30 KST
  expect(at("2026-11-07T23:30:00Z")).toBe(false); // Sun 08:30 KST
});

test("the account lines keep every byte but the line ends: a password may start or end in a space", () => {
  expect(credsFrom("id\n pw with spaces \n")).toEqual(["id", " pw with spaces "]);
  expect(credsFrom("id\r\npw \r\n")).toEqual(["id", "pw "]);
  expect(credsFrom("id\n")).toBeNull();
  expect(credsFrom("")).toBeNull();
});

test("a running keep reads its config before every check and exits 0 once enabled is no longer true", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vpn-keep-"));
  const path = join(dir, "vpn-keep.json");
  writeFileSync(path, JSON.stringify({ ...BASE, days: [0, 1, 2, 3, 4, 5, 6], hours: [0, 24] }));
  const printed: string[] = [];
  let checks = 0;
  let sleeps = 0;
  let killed = 0;
  const code = await keepRun(path, {
    once: false,
    makeDeps: (_o, tunnel) => {
      tunnel.proc ??= { kill: () => { killed++; }, exited: Promise.resolve(0) };
      return deps("UP", [], { state: async () => { checks++; return "UP"; } }).d;
    },
    sleep: async () => {
      if (++sleeps > 1) throw new Error(`still checking after enabled: false (${checks} checks)`);
      writeFileSync(path, JSON.stringify({ ...BASE, enabled: false }));
    },
    now: () => MON_10_KST,
    print: (line) => printed.push(line),
  });
  expect({ code, checks, killed, printed }).toEqual({ code: 0, checks: 1, killed: 1, printed: [`VPN_KEEP_OFF ${path} (enabled is not true)`] });
});

test("the tunnel keeps its PC: a config naming another PC or port stops the old tunnel even while it answers", async () => {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("{}") });
  const port = probe.port;
  probe.stop(true);
  const spawned: string[] = [];
  let kills = 0;
  const spawn = (argv: readonly string[]): TunnelProc => { spawned.push(argv.slice(-2).join(" ")); return { kill: () => { kills++; }, exited: Promise.resolve(0) }; };
  const tunnel: Tunnel = {};
  const clock = { now: () => Date.now(), sleep: async () => {} };
  const quiet = async () => ({ code: 0, out: "", err: "" });
  const ensure = (over: Record<string, unknown>) => realDeps(options({ cdpPort: port, ...over }), quiet, clock, tunnel, spawn).ensureAgents();
  await ensure({ pcSsh: "a@pc-one" }); // nothing answers: start the tunnel
  const old = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("{}") }); // the started tunnel answers
  try {
    await ensure({ pcSsh: "a@pc-one" });
    const before = { spawned: [...spawned], kills };
    await ensure({ pcSsh: "b@pc-two" });
    expect({ before, after: { spawned, kills, key: tunnel.key } }).toEqual({
      before: { spawned: [`${port}:127.0.0.1:9222 a@pc-one`], kills: 0 },
      after: { spawned: [`${port}:127.0.0.1:9222 a@pc-one`], kills: 1, key: undefined },
    });
  } finally {
    old.stop(true);
  }
});

test("keep.ts takes DORI_VPN_KEEP_CONFIG from dori.env (DORI_ENV_FILE) like the other setups", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vpn-keep-env-"));
  writeFileSync(join(dir, "dori.env"), `DORI_VPN_KEEP_CONFIG=${join(dir, "from-env-file.json")}\n`);
  const env: Record<string, string | undefined> = { ...process.env, DORI_ENV_FILE: join(dir, "dori.env") };
  delete env.DORI_VPN_KEEP_CONFIG;
  const p = Bun.spawn([process.execPath, KEEP, "--once"], { env: env as Record<string, string>, stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  expect({ code, off: out.includes(`VPN_KEEP_OFF ${join(dir, "from-env-file.json")} (no config file)`) }).toEqual({ code: 0, off: true });
});

test("MOTP is RFC 6238 TOTP-SHA256 with 6 digits", () => {
  const secret = Buffer.from("12345678901234567890123456789012").toString("hex");
  expect(totp(secret, 59_000)).toBe("119246");
  expect(totp(secret, 1111111109_000)).toBe("084774");
});

const MON_10_KST = new Date("2026-11-02T01:00:00Z");
const deps = (state: VpnState, logins: string[], over: Partial<KeepDeps> = {}) => {
  const calls: string[] = [];
  const d: KeepDeps = {
    paused: async () => false,
    state: async () => { calls.push("state"); return state; },
    ensureAgents: async () => { calls.push("agents"); },
    login: async () => { const r = logins.shift() ?? "FAIL"; calls.push(`login:${r}`); if (r.startsWith("throw")) throw new Error(r); return r; },
    restartAgent: async () => { calls.push("restart"); },
    log: (line) => calls.push(`log:${line}`),
    ...over,
  };
  return { d, calls };
};

test("an up VPN, a pause file or the time outside the window does nothing but wait the interval", async () => {
  const o = options();
  const up = deps("UP", []);
  expect(await keepTick(o, { fails: 0 }, up.d, MON_10_KST)).toBe(60000);
  expect(up.calls).toEqual(["state"]);
  const paused = deps("DOWN", ["OK"], { paused: async () => true });
  expect(await keepTick(o, { fails: 0 }, paused.d, MON_10_KST)).toBe(60000);
  expect(paused.calls).toEqual([]);
  const evening = deps("DOWN", ["OK"]);
  expect(await keepTick(o, { fails: 0 }, evening.d, new Date("2026-11-02T11:00:00Z"))).toBe(60000);
  expect(evening.calls).toEqual([]);
});

test("a down VPN starts the agents and logs in; a login page that never comes restarts the agent once", async () => {
  const o = options();
  const ok = deps("DOWN", ["OK"]);
  const s = { fails: 2 };
  expect(await keepTick(o, s, ok.d, MON_10_KST)).toBe(60000);
  expect(ok.calls).toEqual(["state", "log:DOWN", "agents", "login:OK", "log:RELOGIN OK"]);
  expect(s.fails).toBe(0);
  const stuck = deps("NOLOG", ["no login page", "OK"]);
  await keepTick(o, { fails: 0 }, stuck.d, MON_10_KST);
  expect(stuck.calls).toEqual(["state", "log:NOLOG", "agents", "login:no login page", "log:AGENT_RESTART", "restart", "login:OK", "log:RELOGIN OK"]);
});

test("three failed rounds in a row rest 15 minutes and start counting again; a login that throws is a failed round; an up VPN ends the run", async () => {
  const o = options();
  const s = { fails: 0 };
  const waits: number[] = [];
  const logs: string[] = [];
  for (const pair of [["FAIL x", "FAIL y"], ["throw tunnel", "FAIL z"], ["no cert", "FAIL w"], ["FAIL v", "FAIL u"]]) {
    const r = deps("DOWN", pair);
    waits.push(await keepTick(o, s, r.d, MON_10_KST));
    logs.push(...r.calls.filter((c) => c.startsWith("log:RELOGIN") || c.startsWith("log:GIVEUP")));
  }
  expect(waits).toEqual([60000, 60000, 900000, 60000]);
  await keepTick(o, s, deps("UP", []).d, MON_10_KST);
  expect(s.fails).toBe(0); // an up VPN in between: the next failure is the first of a new run
  s.fails = 2;
  await keepTick(o, s, deps("UP", []).d, MON_10_KST);
  expect(await keepTick(o, s, deps("DOWN", ["FAIL a", "FAIL b"]).d, MON_10_KST)).toBe(60000);
  expect(logs).toEqual(["log:RELOGIN FAIL y", "log:RELOGIN FAIL z", "log:RELOGIN FAIL w", "log:GIVEUP after 3 fails, resting 15 min", "log:RELOGIN FAIL u"]);
  expect(s.fails).toBe(1);
});
