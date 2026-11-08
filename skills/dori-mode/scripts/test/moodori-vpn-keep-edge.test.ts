import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keepConfig, keepTick, realDeps, type KeepOptions } from "../../setups/moodori-vpn-keep/keep.ts";

// A fake owner's PC behind the real keep path (ssh PowerShell, CDP over a websocket): after a VPN drop MooDori's Edge
// keeps its portal tab on the agent check page (activexloading) until that Edge is started again; a restarted Secuway
// agent does not move it (vpn-keep.log 2026-11-08T23:03:52Z and 23:41:17Z).
const fakePc = (edgeRestartHelps: boolean) => {
  const pc = { stuck: true, stage: "login", focused: "", value: {} as Record<string, number>, agentRestarts: 0, edgeRestarts: [] as string[] };
  const url = () => `https://vpn.example.com/${pc.stuck ? "activexloading" : pc.stage === "login" ? "login" : pc.stage === "cert" ? "flag3_cert" : "bookmark"}.jsp`;
  const val = (value: unknown) => ({ result: { type: typeof value, value } });
  const answer = (method: string, params: Record<string, unknown>): unknown => {
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "top", url: "https://vpn.example.com/" }, childFrames: [{ frame: { id: "f", url: url() } }] } };
    if (method === "Page.navigate") return { frameId: "top" };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
    if (method === "Input.insertText") { pc.value[pc.focused] = String(params["text"]).length; return {}; }
    if (method !== "Runtime.evaluate") return {};
    const x = String(params["expression"]);
    const name = /\[name=(\w+)\]/.exec(x)?.[1] ?? "";
    if (x.includes("vxs") || x.startsWith("!!")) return val(true);
    if (x.includes("e.focus()")) { pc.focused = name; return val(true); }
    if (x.includes("e.value.length")) return val(pc.value[name] ?? 0);
    if (x.includes("go(")) { pc.stage = "cert"; return val(true); }
    if (x.includes("전송")) { pc.stage = "done"; return val(true); }
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
    if (argv[0] !== "ssh") return { code: 0, out: "the-id\nthe-pw\n", err: "" }; // credsCommand
    const ps = Buffer.from(argv.at(-1) ?? "", "base64").toString("utf16le");
    if (ps.includes("Stop-Process -Name SecuwayUPort")) pc.agentRestarts++;
    if (ps.includes("msedge") && ps.includes("Stop-Process")) {
      pc.edgeRestarts.push(ps);
      if (edgeRestartHelps) pc.stuck = false;
    }
    if (ps.startsWith("$p=")) return { code: 0, out: pc.stage === "done" ? "L|Mon Nov 09 08:40:00 2026 Initialization Sequence Completed\r\n1" : "L|Mon Nov 09 08:37:00 2026 SIGTERM[soft]\r\n0", err: "" };
    return { code: 0, out: "", err: "" };
  };
  return { pc, edge, runner };
};

const MON_0841_KST = new Date("2026-11-08T23:41:00Z");
// every wait of the flow is instant; the 10 s CDP timeouts never fire
const clock = { now: () => Date.now(), sleep: (ms: number) => (ms >= 10_000 ? new Promise<void>(() => {}) : Promise.resolve()) };
const tick = async (edgeRestartHelps: boolean) => {
  const { pc, edge, runner } = fakePc(edgeRestartHelps);
  const motp = join(mkdtempSync(join(tmpdir(), "vpn-keep-edge-")), "motp.json");
  writeFileSync(motp, JSON.stringify({ secret: "00112233" }));
  const c = keepConfig({ enabled: true, pcSsh: "user@pc.example", vpnUrl: "https://vpn.example.com/", credsCommand: ["creds"], motpFile: motp, cdpPort: edge.port });
  if (!c.on) throw new Error("expected on");
  const o: KeepOptions = c.options;
  const logs: string[] = [];
  const spawn = () => { throw new Error("the fake Edge answers, no tunnel is started"); };
  try {
    await keepTick(o, { fails: 0 }, { ...realDeps(o, runner, clock, {}, spawn), log: (line) => logs.push(line) }, MON_0841_KST);
  } finally {
    edge.stop(true);
  }
  return { logs, agentRestarts: pc.agentRestarts, edgeRestarts: pc.edgeRestarts };
};

test("a portal tab left on the agent check page after the agent restart gets MooDori's Edge started again, then the login goes on", async () => {
  const r = await tick(true);
  expect({ logs: r.logs, agentRestarts: r.agentRestarts, edgeRestarts: r.edgeRestarts.length }).toEqual({
    logs: ["DOWN", "AGENT_RESTART", "VPN_EDGE_RESTART", "RELOGIN OK"],
    agentRestarts: 1,
    edgeRestarts: 1,
  });
});

test("an Edge restart that does not help is tried once per round and the round fails as before", async () => {
  const r = await tick(false);
  expect({ logs: r.logs, edgeRestarts: r.edgeRestarts.length }).toEqual({ logs: ["DOWN", "AGENT_RESTART", "VPN_EDGE_RESTART", "RELOGIN no login page"], edgeRestarts: 1 });
});

test("the Edge restart stops only the msedge processes of MooDori's profile, never every Edge of the owner", async () => {
  const [ps = ""] = (await tick(true)).edgeRestarts;
  expect({
    byProfile: ps.includes("Win32_Process") && ps.includes("'moodori-edge'"),
    byName: /Stop-Process\s+-Name\s+msedge/i.test(ps) || /taskkill/i.test(ps),
    startsTask: ps.includes("Start-ScheduledTask -TaskName 'moodori-edge'"),
  }).toEqual({ byProfile: true, byName: false, startsTask: true });
});
