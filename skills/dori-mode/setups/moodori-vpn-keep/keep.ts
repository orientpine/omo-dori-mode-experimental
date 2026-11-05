#!/usr/bin/env bun
// MooDori's workhours VPN keep: on the owner's work PC (Windows, reached over ssh) the Secuway SSL VPN stays logged in
// on weekdays 08-20 KST. Every minute it reads the VPN state from the agent's sslvpn.log; when down it starts the Secuway
// agent and MooDori's Edge through their scheduled tasks (the agent's task runs elevated, so no UAC prompt), opens a CDP
// tunnel to that Edge and logs in again with the account and the MOTP code. Off unless its config file says enabled.
// Secrets never pass through here as text to print: the account comes from credsCommand's stdout, the MOTP key from a file.
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { envFilePath, loadEnvFile } from "../../scripts/src/config.ts";
import { realClock, run, type Clock, type Runner } from "../../scripts/src/run.ts";

export type KeepOptions = {
  readonly pcSsh: string; // ssh destination of the owner's PC, e.g. user@host
  readonly vpnUrl: string; // the VPN portal's login page
  readonly credsCommand: readonly string[]; // argv whose stdout is the VPN id, a newline, the password
  readonly motpFile: string; // JSON file {"secret": "<hex>"} of the MOTP (TOTP HMAC-SHA256, 6 digits, 30 s) key
  readonly secuwayTask: string;
  readonly edgeTask: string;
  readonly edgePort: number; // Edge's remote debugging port on the PC
  readonly cdpPort: number; // the local end of the ssh tunnel to it
  readonly days: readonly number[]; // 0 = Sunday, in timeZone
  readonly hours: readonly [number, number]; // [from, to): 8, 20 = 08:00 to 19:59
  readonly timeZone: string;
  readonly intervalMs: number;
  readonly maxFails: number;
  readonly restMs: number;
  readonly pauseFile: string;
};
export type KeepConfig = { readonly on: false; readonly reason: string } | { readonly on: true; readonly options: KeepOptions };

const tilde = (path: string, home: string): string => (path.startsWith("~/") ? join(home, path.slice(2)) : path);
const str = (doc: Record<string, unknown>, key: string, fallback?: string): string => {
  const v = doc[key] ?? fallback;
  if (typeof v !== "string" || !v) throw new Error(`${key} must be a non-empty string`);
  return v;
};
const num = (doc: Record<string, unknown>, key: string, fallback: number): number => {
  const v = doc[key] ?? fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) throw new Error(`${key} must be a positive integer`);
  return v;
};

// Any config that is not enabled: true is off. An enabled config with a missing or wrong value throws.
export const keepConfig = (raw: unknown, home: string = homedir()): KeepConfig => {
  if (raw === undefined) return { on: false, reason: "no config file" };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("config must be a JSON object");
  const doc = raw as Record<string, unknown>;
  if (doc.enabled !== true) return { on: false, reason: "enabled is not true" };
  const creds = doc.credsCommand;
  if (!Array.isArray(creds) || !creds.length || !creds.every((a) => typeof a === "string")) throw new Error("credsCommand must be a non-empty argv array");
  const days = doc.days ?? [1, 2, 3, 4, 5];
  if (!Array.isArray(days) || !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) throw new Error("days must be weekday numbers 0-6");
  const hours = doc.hours ?? [8, 20];
  if (!Array.isArray(hours) || hours.length !== 2 || !hours.every((h) => Number.isInteger(h) && h >= 0 && h <= 24) || hours[0] >= hours[1]) throw new Error("hours must be [from, to) with 0 <= from < to <= 24");
  const timeZone = str(doc, "timeZone", "Asia/Seoul");
  new Intl.DateTimeFormat("en-US", { timeZone }); // throws on an unknown zone
  return {
    on: true,
    options: {
      pcSsh: str(doc, "pcSsh"),
      vpnUrl: str(doc, "vpnUrl"),
      credsCommand: creds as string[],
      motpFile: tilde(str(doc, "motpFile"), home),
      secuwayTask: str(doc, "secuwayTask", "moodori-secuway"),
      edgeTask: str(doc, "edgeTask", "moodori-edge"),
      edgePort: num(doc, "edgePort", 9222),
      cdpPort: num(doc, "cdpPort", 9224),
      days: days as number[],
      hours: [hours[0], hours[1]],
      timeZone,
      intervalMs: num(doc, "intervalMs", 60_000),
      maxFails: num(doc, "maxFails", 3),
      restMs: num(doc, "restMs", 15 * 60_000),
      pauseFile: tilde(str(doc, "pauseFile", "/tmp/moodori-vpn-keep.pause"), home),
    },
  };
};

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
export const inWindow = (now: Date, o: Pick<KeepOptions, "days" | "hours" | "timeZone">): boolean => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: o.timeZone, weekday: "short", hour: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const day = WEEKDAY[parts.find((p) => p.type === "weekday")?.value ?? ""];
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  return day !== undefined && o.days.includes(day) && hour >= o.hours[0] && hour < o.hours[1];
};

// The PowerShell below prints "NOLOG", or "L|" and the log's last line that is a tunnel start or stop; then the
// number of SecuwaySSL processes. The VPN is up only when that last line is a completed start and the tunnel runs.
export const STATE_PS = `$p="$env:USERPROFILE\\AppData\\LocalLow\\SecuwaySSLU21\\log\\sslvpn.log"; if(-not (Test-Path $p)){'NOLOG'} else { $l=Select-String -Path $p -Pattern "Initialization Sequence Completed|SIGTERM" | select -Last 1; 'L|' + $l.Line }; @(Get-Process SecuwaySSL -ErrorAction SilentlyContinue).Count`;
export type VpnState = "UP" | "DOWN" | "NOLOG";
export const vpnState = (out: string): VpnState => {
  const [line = "", count = ""] = out.trim().split(/\r?\n/);
  if (line === "NOLOG") return "NOLOG";
  return line.startsWith("L|") && line.includes("Initialization Sequence Completed") && Number(count) > 0 ? "UP" : "DOWN";
};

// RFC 6238 TOTP with HMAC-SHA256, 6 digits, 30 s steps
export const totp = (secretHex: string, nowMs: number): string => {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(nowMs / 1000 / 30)));
  const h = createHmac("sha256", Buffer.from(secretHex, "hex")).update(counter).digest();
  const o = (h[h.length - 1] ?? 0) & 15;
  const n = (((h[o] ?? 0) & 127) << 24) | ((h[o + 1] ?? 0) << 16) | ((h[o + 2] ?? 0) << 8) | (h[o + 3] ?? 0);
  return String(n % 1e6).padStart(6, "0");
};

// stdout of credsCommand: the id line, then the password line, kept byte for byte (a password may end in a space)
export const credsFrom = (out: string): [string, string] | null => {
  const [id = "", pw = ""] = out.split(/\r?\n/);
  return id && pw ? [id, pw] : null;
};

export type KeepState = { fails: number };
export type KeepDeps = {
  readonly paused: () => Promise<boolean>;
  readonly state: () => Promise<VpnState>;
  readonly ensureAgents: () => Promise<void>;
  readonly login: () => Promise<string>; // "OK", "no login page", or why it failed
  readonly restartAgent: () => Promise<void>;
  readonly log: (line: string) => void;
};

// One check; returns how long to wait before the next. A login that throws counts as a failed attempt, so a broken
// path (tunnel, page) still stops at maxFails instead of trying the account every minute.
export async function keepTick(o: KeepOptions, s: KeepState, d: KeepDeps, now: Date): Promise<number> {
  if (!inWindow(now, o) || (await d.paused())) return o.intervalMs;
  const state = await d.state();
  if (state === "UP") {
    s.fails = 0; // a recovery (by hand too) ends the run of failed rounds
    return o.intervalMs;
  }
  d.log(state);
  await d.ensureAgents();
  const attempt = () => d.login().catch((e: unknown) => `ERR ${e instanceof Error ? e.message : String(e)}`);
  let r = await attempt();
  if (r === "no login page") {
    d.log("AGENT_RESTART");
    await d.restartAgent();
    r = await attempt();
  } else if (r !== "OK") r = await attempt();
  d.log(`RELOGIN ${r}`);
  s.fails = r === "OK" ? 0 : s.fails + 1;
  if (s.fails < o.maxFails) return o.intervalMs;
  d.log(`GIVEUP after ${s.fails} fails, resting ${Math.round(o.restMs / 60_000)} min`);
  s.fails = 0;
  return o.restMs;
}

type Cdp = { send: (method: string, params?: Record<string, unknown>) => Promise<any>; dialogs: string[]; close: () => void };
const timeout = <T>(p: Promise<T>, ms: number, what: string, clock: Clock): Promise<T> =>
  Promise.race([p, clock.sleep(ms).then((): never => { throw new Error(`timeout ${what}`); })]);

// The ssh tunnel this keep started. A forward keeps the PC and port it started with, so a changed config stops it.
export type TunnelProc = { readonly kill: () => void; readonly exited: Promise<number> };
export type Tunnel = { proc?: TunnelProc; key?: string };
export type Spawn = (argv: readonly string[]) => TunnelProc;
export const stopTunnel = async (t: Tunnel): Promise<void> => {
  const proc = t.proc;
  t.proc = undefined;
  t.key = undefined;
  if (proc) { proc.kill(); await proc.exited; }
};
const spawnTunnel: Spawn = (argv) => Bun.spawn([...argv], { stdout: "ignore", stderr: "ignore" });

export function realDeps(o: KeepOptions, runner: Runner = run, clock: Clock = realClock, tunnel: Tunnel = {}, spawn: Spawn = spawnTunnel): KeepDeps {
  const base = `http://127.0.0.1:${o.cdpPort}`;
  const ps = async (cmd: string): Promise<string> =>
    (await runner(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", o.pcSsh, "powershell", "-NoProfile", "-EncodedCommand", Buffer.from(cmd, "utf16le").toString("base64")], { timeoutMs: 90_000 })).out;
  const tunnelUp = () => fetch(`${base}/json/version`, { signal: AbortSignal.timeout(4000) }).then((r) => r.ok, () => false);
  const ensureAgents = async () => {
    await ps(`if(-not (Get-Process SecuwayUPort -ErrorAction SilentlyContinue)){Start-ScheduledTask -TaskName '${o.secuwayTask}'; Start-Sleep 5}; try{(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:${o.edgePort}/json/version -TimeoutSec 4) | Out-Null}catch{Start-ScheduledTask -TaskName '${o.edgeTask}'; Start-Sleep 8}`);
    const key = `${o.pcSsh} ${o.cdpPort}:127.0.0.1:${o.edgePort}`;
    if (tunnel.key !== undefined && tunnel.key !== key) await stopTunnel(tunnel);
    if (await tunnelUp()) return;
    await stopTunnel(tunnel);
    tunnel.proc = spawn(["ssh", "-N", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30", "-L", `${o.cdpPort}:127.0.0.1:${o.edgePort}`, o.pcSsh]);
    tunnel.key = key;
    await clock.sleep(4000);
  };
  const creds = async (): Promise<[string, string]> => {
    const r = await runner(o.credsCommand, { timeoutMs: 30_000, preserveOutput: true });
    const c = r.code === 0 ? credsFrom(r.out) : null;
    if (!c) throw new Error(`credsCommand gave no id and password (exit ${r.code})`); // never its output
    return c;
  };
  const motp = () => {
    const secret = (JSON.parse(readFileSync(o.motpFile, "utf8").trim()) as { secret?: unknown }).secret;
    if (typeof secret !== "string" || !secret) throw new Error(`motpFile has no secret`);
    return totp(secret, clock.now());
  };
  const cdp = async (): Promise<Cdp> => {
    const host = new URL(o.vpnUrl).host;
    const pages = (await (await fetch(`${base}/json/list`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
    const t = pages.find((x) => x.type === "page" && new URL(x.url || "about:blank").host === host)
      ?? ((await (await fetch(`${base}/json/new?${o.vpnUrl}`, { method: "PUT" })).json()) as { webSocketDebuggerUrl: string });
    const ws = new WebSocket(t.webSocketDebuggerUrl.replace(`127.0.0.1:${o.edgePort}`, `127.0.0.1:${o.cdpPort}`));
    let n = 0;
    const waiting = new Map<number, (m: any) => void>();
    const dialogs: string[] = [];
    await timeout(new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error("cdp socket error")); }), 10_000, "cdp socket", clock);
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.id && waiting.has(m.id)) { waiting.get(m.id)!(m); waiting.delete(m.id); }
      if (m.method === "Page.javascriptDialogOpening") {
        dialogs.push(String(m.params.message));
        ws.send(JSON.stringify({ id: ++n, method: "Page.handleJavaScriptDialog", params: { accept: true } }));
      }
    };
    const send = (method: string, params: Record<string, unknown> = {}) =>
      timeout(new Promise<any>((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); }), 10_000, method, clock);
    return { send, dialogs, close: () => ws.close() };
  };
  const login = async (): Promise<string> => {
    const V = await cdp();
    try {
      await V.send("Page.enable");
      const frame = async (re: RegExp) => {
        const all: { id: string; url: string }[] = [];
        const walk = (f: any) => { all.push(f.frame); (f.childFrames || []).forEach(walk); };
        walk((await V.send("Page.getFrameTree")).result.frameTree);
        return all.find((f) => re.test(f.url));
      };
      await V.send("Page.navigate", { url: o.vpnUrl });
      let fr: { id: string; url: string } | undefined;
      for (let i = 0; i < 45 && !fr; i++) { await clock.sleep(2000); const f = await frame(/login\.jsp/); if (f && !/act=1/.test(f.url)) fr = f; }
      if (!fr) return "no login page"; // the agent check page (activexloading.jsp) did not move on
      await clock.sleep(1500);
      const ctx = (await V.send("Page.createIsolatedWorld", { frameId: fr.id })).result.executionContextId;
      const ev = (x: string) => V.send("Runtime.evaluate", { expression: x, contextId: ctx, returnByValue: true });
      await ev(`document.querySelector("input[name=vxs][value='2']").click()`);
      const [id, pw] = await creds();
      await ev(`var e=document.querySelector('[name=userid]');e.value='';e.focus()`);
      await V.send("Input.insertText", { text: id });
      await ev(`var e=document.querySelector('[name=userpw]');e.value='';e.focus()`);
      await V.send("Input.insertText", { text: pw });
      const left = 30 - (Math.floor(clock.now() / 1000) % 30);
      if (left < 15) await clock.sleep(left * 1000 + 500); // the code must not expire before it is sent
      await ev(`setTimeout(()=>document.querySelector('a[href*="go("]').click(),0);1`);
      let cf: { id: string; url: string } | undefined;
      for (let i = 0; i < 40 && !cf; i++) { await clock.sleep(500); cf = await frame(/flag3_cert/); }
      if (!cf) return `no cert ${V.dialogs.join("|")}`;
      let c2 = 0;
      let ready = false;
      for (let i = 0; i < 20 && !ready; i++) {
        try {
          c2 = (await V.send("Page.createIsolatedWorld", { frameId: cf.id })).result.executionContextId;
          ready = (await V.send("Runtime.evaluate", { expression: "!!document.querySelector('[name=usersms]')", contextId: c2, returnByValue: true })).result.result?.value === true;
        } catch { /* the frame is still loading */ }
        if (!ready) await clock.sleep(300);
      }
      const ce = (x: string) => V.send("Runtime.evaluate", { expression: x, contextId: c2, returnByValue: true });
      await ce(`var e=document.querySelector('[name=usersms]');e.value='';e.focus();1`);
      await V.send("Input.insertText", { text: motp() });
      await ce(`setTimeout(()=>[...document.querySelectorAll('a')].find(a=>a.innerText.trim()==='전송').click(),0);1`);
      for (let i = 0; i < 15; i++) { await clock.sleep(2000); if (await frame(/bookmark/)) return "OK"; }
      return `FAIL ${V.dialogs.join("|")}`;
    } finally {
      V.close();
    }
  };
  return {
    paused: () => Bun.file(o.pauseFile).exists(),
    state: async () => vpnState(await ps(STATE_PS)),
    ensureAgents,
    login,
    restartAgent: async () => { await ps(`Stop-Process -Name SecuwayUPort -Force -ErrorAction SilentlyContinue; Start-Sleep 2; Start-ScheduledTask -TaskName '${o.secuwayTask}'; Start-Sleep 8`); },
    log: (line) => console.log(`${new Date(clock.now()).toISOString()} ${line}`),
  };
}

export const configPath = (env: Record<string, string | undefined>, home: string = homedir()): string =>
  env.DORI_VPN_KEEP_CONFIG || join(home, ".dori", "vpn-keep.json");

export type KeepRunOptions = {
  readonly once: boolean;
  readonly makeDeps: (o: KeepOptions, tunnel: Tunnel) => KeepDeps;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => Date;
  readonly print: (line: string) => void;
};

// The config file is read again before every check, so "enabled": false (or a changed value) takes effect while it
// runs. Returns the exit code: 0 off, 2 a bad config.
export async function keepRun(path: string, r: KeepRunOptions): Promise<number> {
  const state: KeepState = { fails: 0 };
  const tunnel: Tunnel = {};
  let started = false;
  for (;;) {
    let config: KeepConfig;
    try {
      config = keepConfig(existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined);
    } catch (e) {
      r.print(`VPN_KEEP_CONFIG_BAD ${path} ${e instanceof Error ? e.message : String(e)}`);
      await stopTunnel(tunnel);
      return 2;
    }
    if (!config.on) {
      r.print(`VPN_KEEP_OFF ${path} (${config.reason})`);
      await stopTunnel(tunnel);
      return 0;
    }
    const o = config.options;
    const deps = r.makeDeps(o, tunnel);
    if (!started) deps.log(`VPN_KEEP_ON ${path} days=${o.days.join(",")} hours=${o.hours[0]}-${o.hours[1]} ${o.timeZone} every ${o.intervalMs} ms${r.once ? " once" : ""}`);
    started = true;
    let wait = o.intervalMs;
    try { wait = await keepTick(o, state, deps, r.now()); } catch (e) { deps.log(`ERR ${e instanceof Error ? e.message : String(e)}`); }
    if (r.once) {
      await stopTunnel(tunnel);
      return 0;
    }
    await r.sleep(wait);
  }
}

if (import.meta.main) {
  await loadEnvFile(envFilePath());
  process.exit(await keepRun(configPath(process.env), {
    once: process.argv.includes("--once"),
    makeDeps: (o, tunnel) => realDeps(o, run, realClock, tunnel),
    sleep: (ms) => Bun.sleep(ms),
    now: () => new Date(),
    print: (line) => console.log(`${new Date().toISOString()} ${line}`),
  }));
}
