import { expect, test } from "bun:test";
import { keepConfig, keepTick, linkFrom, type KeepDeps, type KeepOptions, type Link } from "../../setups/moodori-vpn-keep/keep.ts";

const options = (): KeepOptions => {
  const c = keepConfig({ enabled: true, pcSsh: "user@pc.example", vpnUrl: "https://vpn.example.com/", credsCommand: ["creds"], motpFile: "/x/motp.json" });
  if (!c.on) throw new Error("expected on");
  return c.options;
};
const MON_10_KST = new Date("2026-11-02T01:00:00Z");
const DOWN: Link = { up: false, why: "no Completed start after the last stop" };
// a round whose VPN state reads state, whose portal flow answers logins in turn and whose link check answers link;
// sent: every login got as far as the login button (the portal has the account), and a stop pauses the next checks
const deps = (state: "UP" | "DOWN", logins: string[], link: (since: number) => Promise<Link> = async () => DOWN, sent = false) => {
  const calls: string[] = [];
  let stopped = false;
  const d: KeepDeps = {
    paused: async () => stopped,
    state: async () => { calls.push("state"); return state; },
    link: (since) => { calls.push("link"); return link(since); },
    wait: async () => {},
    ensureAgents: async () => { calls.push("agents"); },
    login: async () => { const r = logins.shift() ?? "FAIL"; calls.push(`login:${r}`); return r; },
    sent: () => sent,
    stop: async (why) => { calls.push(`stop:${why}`); stopped = true; },
    restartAgent: async () => {}, restartEdge: async () => {},
    log: (line) => calls.push(`log:${line}`),
  };
  return { d, calls };
};

// The PC's answer to LINK_PS: the last tunnel start or stop line of sslvpn.log (local time), the PC's UTC offset in
// minutes, and whether the portal's port 443 opens from the PC.
test("a relogin counts as connected only by a Completed start in sslvpn.log at or after the round began and the portal's 443 open", () => {
  const since = Date.parse("2026-11-11T08:38:55Z"); // the round's DOWN
  const out = (line: string, open = "True") => `C|${line}\r\n540\r\nT|${open}\r\n`;
  expect(linkFrom(out("2026-11-11 17:43:05 Initialization Sequence Completed"), since)).toEqual({ up: true, at: Date.parse("2026-11-11T08:43:05Z") });
  expect(linkFrom(out("2026-11-11 17:38:55 Initialization Sequence Completed"), since)).toEqual({ up: true, at: since });
  expect(linkFrom(out("2026-11-11 17:08:10 Initialization Sequence Completed"), since)).toEqual({ up: false, why: "last Completed 2026-11-11T08:08:10.000Z is before the round began" });
  expect(linkFrom(out("2026-11-11 17:43:05 SIGTERM[soft,exit-with-notification] received, process exiting"), since)).toEqual({ up: false, why: "no Completed start after the last stop" });
  expect(linkFrom(out("2026-11-11 17:43:05 Initialization Sequence Completed", "False"), since)).toEqual({ up: false, why: "portal 443 closed" });
  expect(linkFrom("NOLOG\r\n540\r\nT|True", since)).toEqual({ up: false, why: "no sslvpn.log" });
  expect(linkFrom("", since)).toEqual({ up: false, why: "no Completed start after the last stop" });
});

// vpn-keep.log 2026-11-11T08:43:36Z and 09:18:15Z: RELOGIN FAIL while sslvpn.log had Completed at 17:43:05 and
// 18:17:46 KST and the portal's 443 was open.
test("a round whose portal flow says FAIL but whose tunnel came up after the round began is RELOGIN OK, judged by sslvpn.log", async () => {
  const o = options();
  const s = { fails: 1 };
  const sinces: number[] = [];
  const r = deps("DOWN", ["FAIL ", "FAIL "], async (since) => { sinces.push(since); return { up: true, at: Date.parse("2026-11-02T01:04:10Z") }; });
  expect(await keepTick(o, s, r.d, MON_10_KST)).toBe(60000);
  expect({ logs: r.calls.filter((c) => c.startsWith("log:")), fails: s.fails, sinces }).toEqual({
    logs: ["log:DOWN", "log:RELOGIN OK connected 2026-11-02T01:04:10.000Z (portal flow: FAIL)"],
    fails: 0,
    sinces: [MON_10_KST.getTime()],
  });
});

// A FAIL after the login button may be a wrong or stale password or MOTP code, which the portal counts toward locking
// the account (owner, 2026-11-25: repeated failures must never leave the account locked).
test("a round that sent the account and did not connect stops: no second login, and no check logs in until the pause file is removed", async () => {
  const o = options();
  const s = { fails: 0 };
  const sent = deps("DOWN", ["FAIL ", "FAIL "], async () => DOWN, true);
  expect(await keepTick(o, s, sent.d, MON_10_KST)).toBe(60000);
  expect(await keepTick(o, s, sent.d, MON_10_KST)).toBe(60000);
  expect({ calls: sent.calls.filter((c) => c !== "link"), links: sent.calls.filter((c) => c === "link").length, fails: s.fails }).toEqual({
    calls: ["state", "log:DOWN", "agents", "login:FAIL ", "log:RELOGIN FAIL ", "stop:RELOGIN FAIL ", `log:STOP the account was sent and the VPN did not come up; no login until ${o.pauseFile} is removed`],
    links: 6,
    fails: 0,
  });
});

test("a round that failed before the login button stays failed, and the next check tries again or says the VPN came up", async () => {
  const o = options();
  const s = { fails: 0 };
  const failed = deps("DOWN", ["ERR no MOTP choice", "ERR no MOTP choice"]);
  expect(await keepTick(o, s, failed.d, MON_10_KST)).toBe(60000);
  expect({ logs: failed.calls.filter((c) => c.startsWith("log:")), logins: failed.calls.filter((c) => c.startsWith("login:")).length, links: failed.calls.filter((c) => c === "link").length, fails: s.fails }).toEqual({ logs: ["log:DOWN", "log:RELOGIN ERR no MOTP choice"], logins: 2, links: 1, fails: 1 });
  const again = deps("DOWN", ["OK"]);
  await keepTick(o, s, again.d, MON_10_KST);
  expect(again.calls.slice(0, 4)).toEqual(["state", "log:DOWN", "agents", "login:OK"]);
  const up = deps("UP", []);
  expect(await keepTick(o, s, up.d, MON_10_KST)).toBe(60000);
  expect({ calls: up.calls, fails: s.fails }).toEqual({ calls: ["state", "log:UP after 2 failed rounds"], fails: 0 });
});
