import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { edgePids, keepConfig, keepTick, psQuote, realDeps, type KeepDeps, type KeepOptions } from "../../setups/moodori-vpn-keep/keep.ts";

// A fake owner's PC behind the real keep path (ssh PowerShell, CDP over a websocket): after a VPN drop MooDori's Edge
// keeps its portal tab on the agent check page (activexloading) until that Edge is started again; a restarted Secuway
// agent does not move it (vpn-keep.log 2026-11-08T23:03:52Z and 23:41:17Z).
// msedge processes as the PC lists them (pid, a tab, the command line): MooDori's browser and renderer, the owner's own
// Edge, and two other profiles whose names only start like hers
const EDGES = [
  '101\t"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --remote-debugging-port=9222 --user-data-dir="C:\\Users\\orien\\AppData\\Local\\moodori-edge"',
  '102\t"C:\\x\\msedge.exe" --type=renderer --user-data-dir="C:\\Users\\orien\\AppData\\Local\\moodori-edge" --lang=ko',
  '201\t"C:\\x\\msedge.exe" --profile-directory=Default',
  '202\t"C:\\x\\msedge.exe" --user-data-dir="C:\\profiles\\moodori-edge personal"',
  '203\t"C:\\x\\msedge.exe" --user-data-dir=C:\\profiles\\moodori-edge2 --type=gpu-process',
].join("\r\n");
// endsAtBookmark false: after the OTP is sent the portal shows some other page than bookmark, while the tunnel comes up
// (vpn-keep.log 2026-11-11T08:43:36Z RELOGIN FAIL with sslvpn.log Completed at 17:43:05 KST).
// page: the tab is on login.jsp from the start, not on the agent check page (ready); login.jsp reads not complete for
// that many checks (loading); the MOTP choice reads PUSH again right before the login button (reset); the portal
// answers the account on login.jsp, as for a wrong password (noCert); the tunnel never comes up (noTunnel).
type PcPage = { ready?: boolean; loading?: number; reset?: boolean; noCert?: boolean; noTunnel?: boolean };
const fakePc = (edgeRestartHelps: boolean, endsAtBookmark = true, page: PcPage = {}) => {
  const pc = { stuck: !page.ready, stage: "login", focused: "", value: {} as Record<string, number>, agentRestarts: 0, edgeRestarts: [] as string[], loading: page.loading ?? 0, steps: [] as string[], links: 0 };
  const up = () => pc.stage === "done" && !page.noTunnel; // sslvpn.log has a Completed start
  const url = () => `https://vpn.example.com/${pc.stuck ? "activexloading" : pc.stage === "login" ? "login" : pc.stage === "cert" ? "flag3_cert" : endsAtBookmark ? "bookmark" : "main"}.jsp`;
  const val = (value: unknown) => ({ result: { type: typeof value, value } });
  const answer = (method: string, params: Record<string, unknown>): unknown => {
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "top", url: "https://vpn.example.com/" }, childFrames: [{ frame: { id: "f", url: url() } }] } };
    if (method === "Page.navigate") return { frameId: "top" };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
    if (method === "Input.insertText") { pc.value[pc.focused] = String(params["text"]).length; pc.steps.push(pc.focused); return {}; }
    if (method !== "Runtime.evaluate") return {};
    const x = String(params["expression"]);
    const name = /\[name=(\w+)\]/.exec(x)?.[1] ?? "";
    if (x.includes("readyState")) { pc.steps.push("ready?"); return val(pc.loading-- > 0 ? "interactive" : "ready"); }
    if (x.includes("vxs") && x.includes("e.click()")) { pc.steps.push("MOTP"); return val(true); }
    if (x.includes("vxs")) return val(!page.reset); // the choice read again right before the login button
    if (x.startsWith("!!")) return val(true);
    if (x.includes("e.focus()")) { pc.focused = name; return val(true); }
    if (x.includes("e.value.length")) return val(pc.value[name] ?? 0);
    if (x.includes("go(")) { pc.steps.push("login"); if (!page.noCert) pc.stage = "cert"; return val(true); }
    if (x.includes("전송")) { pc.steps.push("OTP"); pc.stage = "done"; return val(true); }
    return val(undefined);
  };
  const edge = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const path = new URL(req.url).pathname;
      if (path === "/json/version") return Response.json({});
      if (path === "/json/list") return Response.json([{ type: "page", url: url(), webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/1" }]);
      return srv.upgrade(req) ? undefined : new Response("not found", { status: 404 });
    },
    websocket: {
      message(ws, data) {
        const m = JSON.parse(String(data)) as { id: number; method: string; params?: Record<string, unknown> };
        ws.send(JSON.stringify({ id: m.id, result: answer(m.method, m.params ?? {}) }));
      },
    },
  });
  const runner = async (argv: readonly string[]) => {
    if (argv[0] !== "ssh") { pc.steps.push("creds"); return { code: 0, out: "the-id\nthe-pw\n", err: "" }; } // credsCommand
    const ps = Buffer.from(argv.at(-1) ?? "", "base64").toString("utf16le");
    if (ps.includes("Stop-Process -Name SecuwayUPort")) pc.agentRestarts++;
    if (ps.includes("Win32_Process")) return { code: 0, out: EDGES, err: "" };
    if (ps.includes("Stop-Process -Id")) {
      pc.edgeRestarts.push(ps);
      if (edgeRestartHelps) pc.stuck = false;
    }
    // sslvpn.log as the PC writes it: local time (KST, offset 540 min); the round began at 08:41:00 KST
    if (ps.startsWith("$q=")) { pc.links++; return { code: 0, out: `C|${up() ? "2026-11-09 08:41:20 Initialization Sequence Completed" : "2026-11-09 08:37:00 SIGTERM[soft]"}\r\n540\r\nT|True\r\n`, err: "" }; }
    if (ps.startsWith("$p=")) return { code: 0, out: up() ? "L|Mon Nov 09 08:40:00 2026 Initialization Sequence Completed\r\n1" : "L|Mon Nov 09 08:37:00 2026 SIGTERM[soft]\r\n0", err: "" };
    return { code: 0, out: "", err: "" };
  };
  return { pc, edge, runner };
};

const MON_0841_KST = new Date("2026-11-08T23:41:00Z");
// every wait of the flow is instant and the 10 s CDP timeouts never fire; at 15 s into a TOTP period the flow
// itself never waits 10 s or more for a fresh code
const clock = { now: () => 15_000, sleep: (ms: number) => (ms >= 10_000 ? new Promise<void>(() => {}) : Promise.resolve()) };
const tick = async (edgeRestartHelps: boolean, endsAtBookmark = true, page: PcPage = {}, ticks = 1) => {
  const { pc, edge, runner } = fakePc(edgeRestartHelps, endsAtBookmark, page);
  const dir = mkdtempSync(join(tmpdir(), "vpn-keep-edge-"));
  const motp = join(dir, "motp.json");
  writeFileSync(motp, JSON.stringify({ secret: "00112233" }));
  const pauseFile = join(dir, "pause"); // never the host's own /tmp/moodori-vpn-keep.pause
  const c = keepConfig({ enabled: true, pcSsh: "user@pc.example", vpnUrl: "https://vpn.example.com/", credsCommand: ["creds"], motpFile: motp, cdpPort: edge.port, pauseFile });
  if (!c.on) throw new Error("expected on");
  const o: KeepOptions = c.options;
  const logs: string[] = [];
  const spawn = () => { throw new Error("the fake Edge answers, no tunnel is started"); };
  const d: KeepDeps = { ...realDeps(o, runner, clock, {}, spawn), log: (line) => logs.push(line) };
  const s = { fails: 0 };
  try {
    for (let i = 0; i < ticks; i++) await keepTick(o, s, d, MON_0841_KST);
  } finally {
    edge.stop(true);
  }
  const pause = existsSync(pauseFile) ? readFileSync(pauseFile, "utf8") : null;
  return { logs, agentRestarts: pc.agentRestarts, edgeRestarts: pc.edgeRestarts, steps: pc.steps, links: pc.links, pauseFile, pause };
};

test("a portal tab left on the agent check page after the agent restart gets MooDori's Edge started again, then the login goes on", async () => {
  const r = await tick(true);
  expect({ logs: r.logs, agentRestarts: r.agentRestarts, edgeRestarts: r.edgeRestarts.length }).toEqual({
    logs: ["DOWN", "AGENT_RESTART", "VPN_EDGE_RESTART", "RELOGIN OK"],
    agentRestarts: 1,
    edgeRestarts: 1,
  });
});

test("a login whose portal never shows bookmark but whose sslvpn.log has a Completed start after the round began is RELOGIN OK", async () => {
  expect((await tick(true, false)).logs).toEqual(["DOWN", "AGENT_RESTART", "VPN_EDGE_RESTART", "RELOGIN OK connected 2026-11-08T23:41:20.000Z (portal flow: FAIL)"]);
});

test("an Edge restart that does not help is tried once per round and the round fails as before", async () => {
  const r = await tick(false);
  expect({ logs: r.logs, edgeRestarts: r.edgeRestarts.length }).toEqual({ logs: ["DOWN", "AGENT_RESTART", "VPN_EDGE_RESTART", "RELOGIN no login page"], edgeRestarts: 1 });
});

test("the Edge restart stops only the msedge processes of MooDori's profile, never every Edge of the owner", async () => {
  const [ps = ""] = (await tick(true)).edgeRestarts;
  expect({ stops: /Stop-Process -Id ([\d,]+) /.exec(ps)?.[1], byName: /-Name\s+msedge|taskkill/i.test(ps), startsTask: ps.includes("Start-ScheduledTask -TaskName 'moodori-edge'") }).toEqual({ stops: "101,102", byName: false, startsTask: true });
});

test("MooDori's Edge is the one whose --user-data-dir ends in exactly edgeProfile, however the argument is quoted", () => {
  expect(edgePids(EDGES, "moodori-edge")).toEqual([101, 102]);
  expect(edgePids(EDGES, "MOODORI-EDGE")).toEqual([101, 102]); // Windows paths ignore case
  expect(edgePids(EDGES, "moodori-edge personal")).toEqual([202]);
  expect(edgePids('7\tmsedge.exe "--user-data-dir=C:\\a b\\moodori-edge\\"\nx\tmsedge.exe --user-data-dir=C:\\moodori-edge\n8', "moodori-edge")).toEqual([7]);
});

test("a PowerShell single-quoted string keeps an apostrophe in a task name, straight or curly", () => {
  expect([psQuote("moodori-edge"), psQuote("MooDori's Edge"), psQuote("MooDori\u2019s")]).toEqual(["'moodori-edge'", "'MooDori''s Edge'", "'MooDori\u2019\u2019s'"]);
});

// vpn-keep.log 2026-11-24T23:43:05Z: right after an agent restart the MOTP choice was clicked 1.5 s after login.jsp
// showed up, before its scripts and its onload (which chooses PUSH) were done, and that error gave up the day.
test("MOTP is chosen only once login.jsp reads complete, and only then is the account read, typed and sent", async () => {
  const r = await tick(true, true, { ready: true, loading: 3 });
  expect({ logs: r.logs, steps: r.steps }).toEqual({
    logs: ["DOWN", "RELOGIN OK"],
    steps: ["ready?", "ready?", "ready?", "ready?", "MOTP", "creds", "userid", "userpw", "login", "usersms", "OTP"],
  });
});

test("a login.jsp that never reads complete fails the round before the account is even read, and is no stop", async () => {
  const r = await tick(true, true, { ready: true, loading: Number.POSITIVE_INFINITY });
  expect({ logs: r.logs, checks: r.steps.filter((x) => x === "ready?").length, other: r.steps.filter((x) => x !== "ready?"), pause: r.pause }).toEqual({
    logs: ["DOWN", "RELOGIN ERR OTP login choice not found or not chosen (login page interactive)"],
    checks: 60, // 30 for the login and 30 for the one more try, 15 s each
    other: [],
    pause: null,
  });
});

test("a MOTP choice read as PUSH again right before the login button stops the login before the account is sent", async () => {
  const r = await tick(true, true, { ready: true, reset: true });
  expect({ logs: r.logs, logins: r.steps.filter((x) => x === "login").length, pause: r.pause }).toEqual({
    logs: ["DOWN", "RELOGIN ERR OTP login choice was set back before the login"],
    logins: 0,
    pause: null,
  });
});

test("a round that sent the account and did not connect is a stop: no second login, the pause file says why, no check logs in while it is there", async () => {
  const r = await tick(true, false, { ready: true, noTunnel: true }, 2);
  expect({ logs: r.logs, logins: r.steps.filter((x) => x === "login").length, links: r.links, pause: r.pause }).toEqual({
    logs: ["DOWN", "RELOGIN FAIL ", `STOP the account was sent and the VPN did not come up; no login until ${r.pauseFile} is removed`],
    logins: 1,
    links: 6,
    pause: "1970-01-01T00:00:15.000Z RELOGIN FAIL \n",
  });
});

test("an account the portal answers on login.jsp (no MOTP page, as for a wrong password) is a stop too, after the 30 s link check", async () => {
  const r = await tick(true, true, { ready: true, noCert: true });
  expect({ logs: r.logs, logins: r.steps.filter((x) => x === "login").length, links: r.links }).toEqual({
    logs: ["DOWN", "RELOGIN no cert ", `STOP the account was sent and the VPN did not come up; no login until ${r.pauseFile} is removed`],
    logins: 1,
    links: 6,
  });
});

test("a bookmark page whose tunnel does not come up is a failed round, not a stop: the portal took the account and the code", async () => {
  const r = await tick(true, true, { ready: true, noTunnel: true });
  expect({ logs: r.logs, pause: r.pause }).toEqual({ logs: ["DOWN", "RELOGIN OK portal, VPN still down after 30 s (no Completed start after the last stop)"], pause: null });
});
