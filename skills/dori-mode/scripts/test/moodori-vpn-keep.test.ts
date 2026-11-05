import { expect, test } from "bun:test";
import { inWindow, keepConfig, keepTick, totp, vpnState, type KeepDeps, type KeepOptions, type VpnState } from "../../setups/moodori-vpn-keep/keep.ts";

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

test("three failed rounds in a row rest 15 minutes and start counting again; a login that throws is a failed round", async () => {
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
  expect(logs).toEqual(["log:RELOGIN FAIL y", "log:RELOGIN FAIL z", "log:RELOGIN FAIL w", "log:GIVEUP after 3 fails, resting 15 min", "log:RELOGIN FAIL u"]);
  expect(s.fails).toBe(1);
});
