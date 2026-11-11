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
  readonly edgeProfile: string; // the folder name of MooDori's Edge --user-data-dir, so only that Edge is restarted
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
  if (doc["enabled"] !== true) return { on: false, reason: "enabled is not true" };
  const creds = doc["credsCommand"];
  if (!Array.isArray(creds) || !creds.length || !creds.every((a) => typeof a === "string")) throw new Error("credsCommand must be a non-empty argv array");
  const days = doc["days"] ?? [1, 2, 3, 4, 5];
  if (!Array.isArray(days) || !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) throw new Error("days must be weekday numbers 0-6");
  const hours = doc["hours"] ?? [8, 20];
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
      edgeProfile: str(doc, "edgeProfile", "moodori-edge"),
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

// A relogin is judged by the connection itself, not by the portal page: the PowerShell below prints "C|" and
// sslvpn.log's last tunnel start or stop line ("NOLOG" without a log), the PC's UTC offset in minutes (the log's
// times are the PC's local time), and "T|True" when the portal's port 443 opens from the PC.
export const linkPs = (host: string): string => `$q="$env:USERPROFILE\\AppData\\LocalLow\\SecuwaySSLU21\\log\\sslvpn.log"; if(-not (Test-Path $q)){'NOLOG'} else { $l=Select-String -Path $q -Pattern "Initialization Sequence Completed|SIGTERM" | select -Last 1; 'C|' + $l.Line }; [int][TimeZoneInfo]::Local.GetUtcOffset((Get-Date)).TotalMinutes; $c=New-Object Net.Sockets.TcpClient; try{$ok=$c.ConnectAsync(${psQuote(host)},443).Wait(4000)}catch{$ok=$false}; $c.Close(); 'T|' + $ok`;
export type Link = { readonly up: true; readonly at: number } | { readonly up: false; readonly why: string };
// Up when that last line is a Completed start written at or after since (the round's start, in ms) and 443 opens.
export const linkFrom = (out: string, since: number): Link => {
  const [line = "", offset = "", port = ""] = out.trim().split(/\r?\n/);
  if (line === "NOLOG") return { up: false, why: "no sslvpn.log" };
  const m = /^C\|(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d) Initialization Sequence Completed/.exec(line);
  if (!m || !/^-?\d+$/.test(offset)) return { up: false, why: "no Completed start after the last stop" };
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const at = Date.UTC(y, mo - 1, d, h, mi, s) - Number(offset) * 60_000;
  if (at < Math.floor(since / 1000) * 1000) return { up: false, why: `last Completed ${new Date(at).toISOString()} is before the round began` };
  return port === "T|True" ? { up: true, at } : { up: false, why: "portal 443 closed" };
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
  readonly link: (since: number) => Promise<Link>;
  readonly ensureAgents: () => Promise<void>;
  readonly login: () => Promise<string>; // "OK", "no login page", or why it failed
  readonly restartAgent: () => Promise<void>;
  readonly restartEdge: () => Promise<void>;
  readonly wait: (ms: number) => Promise<void>;
  readonly log: (line: string) => void;
};

// A round counts by the connection, whatever the portal page said: once the MOTP code was sent (the flow ended OK or
// FAIL) the link is checked every 5 s for 30 s, else once.
export const UP_CHECKS = 6;
export const UP_EVERY_MS = 5000;
const linkBack = async (d: KeepDeps, since: number, sent: boolean): Promise<Link> => {
  let link: Link = { up: false, why: "not checked" };
  for (let i = 0; i < (sent ? UP_CHECKS : 1); i++) {
    if (sent) await d.wait(UP_EVERY_MS);
    link = await d.link(since).catch((e: unknown): Link => ({ up: false, why: `ERR ${e instanceof Error ? e.message : String(e)}` }));
    if (link.up) return link;
  }
  return link;
};

// One check; returns how long to wait before the next. A login that throws counts as a failed attempt, so a broken
// path (tunnel, page) still stops at maxFails instead of trying the account every minute.
export async function keepTick(o: KeepOptions, s: KeepState, d: KeepDeps, now: Date): Promise<number> {
  if (!inWindow(now, o) || (await d.paused())) return o.intervalMs;
  const state = await d.state();
  if (state === "UP") {
    if (s.fails) d.log(`UP after ${s.fails} failed round${s.fails > 1 ? "s" : ""}`);
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
    // An Edge that was open before the drop keeps its portal tab on the agent check page (activexloading) after the
    // agent restart; only that Edge started again moves on to login.jsp. Once a round, so maxFails still bounds it.
    if (r === "no login page") {
      d.log("VPN_EDGE_RESTART");
      await d.restartEdge();
      r = await attempt();
    }
  } else if (r !== "OK") r = await attempt();
  const link = await linkBack(d, now.getTime(), r === "OK" || r.startsWith("FAIL"));
  if (link.up) r = r === "OK" ? "OK" : `OK connected ${new Date(link.at).toISOString()} (portal flow: ${r.trim()})`;
  else if (r === "OK") r = `OK portal, VPN still down after ${(UP_CHECKS * UP_EVERY_MS) / 1000} s (${link.why})`;
  d.log(`RELOGIN ${r}`);
  s.fails = link.up ? 0 : s.fails + 1;
  if (s.fails < o.maxFails) return o.intervalMs;
  d.log(`GIVEUP after ${s.fails} fails, resting ${Math.round(o.restMs / 60_000)} min`);
  s.fails = 0;
  return o.restMs;
}

export type Send = (method: string, params?: Record<string, unknown>) => Promise<any>;
export type Cdp = { readonly send: Send; readonly dialogs: string[]; readonly close: () => void };
type Frame = { readonly id: string; readonly url: string };

// A page script that throws comes back as exceptionDetails, not as an error: make it one.
export const evalIn = async (send: Send, contextId: number, expression: string): Promise<unknown> => {
  const r = (await send("Runtime.evaluate", { expression, contextId, returnByValue: true }))?.result;
  if (!r || r.exceptionDetails) throw new Error(`page script failed: ${r?.exceptionDetails?.exception?.description ?? r?.exceptionDetails?.text ?? "no result"}`);
  return r.result?.value;
};
const world = async (send: Send, frame: Frame): Promise<number> => {
  const id = (await send("Page.createIsolatedWorld", { frameId: frame.id }))?.result?.executionContextId;
  if (typeof id !== "number") throw new Error("no script context in the login frame");
  return id;
};
// Types text only into the named field once it is found, emptied and focused, then checks the field holds that many
// characters; any miss throws before (or right after) typing, so a secret never goes into another field or the next step.
export const typeInto = async (send: Send, contextId: number, name: string, text: string): Promise<void> => {
  const focused = await evalIn(send, contextId, `(()=>{const e=document.querySelector('[name=${name}]');if(!e)return false;e.value='';e.focus();return document.activeElement===e&&e.value===''})()`);
  if (focused !== true) throw new Error(`${name} field not found or not focused`);
  await send("Input.insertText", { text });
  const length = await evalIn(send, contextId, `(()=>{const e=document.querySelector('[name=${name}]');return e&&document.activeElement===e?e.value.length:-1})()`);
  if (length !== text.length) throw new Error(`${name} field holds ${length} characters, not ${text.length}`);
};
const clickIn = async (send: Send, contextId: number, what: string, find: string): Promise<void> => {
  const found = await evalIn(send, contextId, `(()=>{const e=${find};if(!e)return false;setTimeout(()=>e.click(),0);return true})()`);
  if (found !== true) throw new Error(`${what} not found`);
};

// The Secuway portal: agent check page -> login.jsp (account) -> flag3_cert (MOTP) -> bookmark. "OK" only at the
// bookmark page; "no login page" when the agent check page never moves on (the caller restarts the agent, then Edge).
export async function loginFlow(V: Cdp, vpnUrl: string, creds: () => Promise<[string, string]>, motp: () => string, clock: Clock): Promise<string> {
  const frames = async (): Promise<Frame[]> => {
    const all: Frame[] = [];
    const walk = (f: any) => { all.push(f.frame); (f.childFrames || []).forEach(walk); };
    walk((await V.send("Page.getFrameTree")).result.frameTree);
    return all;
  };
  const waitFrame = async (re: RegExp, tries: number, everyMs: number, skip: RegExp | null = null): Promise<Frame | undefined> => {
    for (let i = 0; i < tries; i++) {
      await clock.sleep(everyMs);
      const f = (await frames()).find((x) => re.test(x.url) && !(skip && skip.test(x.url)));
      if (f) return f;
    }
    return undefined;
  };
  await V.send("Page.enable");
  const nav = (await V.send("Page.navigate", { url: vpnUrl }))?.result;
  if (nav?.errorText) throw new Error(`navigate: ${nav.errorText}`);
  const fr = await waitFrame(/login\.jsp/, 45, 2000, /act=1/);
  if (!fr) return "no login page";
  await clock.sleep(1500);
  const ctx = await world(V.send, fr);
  const otpChoice = await evalIn(V.send, ctx, `(()=>{const e=document.querySelector("input[name=vxs][value='2']");if(!e)return false;e.click();return e.checked===true})()`);
  if (otpChoice !== true) throw new Error("OTP login choice not found or not chosen");
  const [id, pw] = await creds();
  await typeInto(V.send, ctx, "userid", id);
  await typeInto(V.send, ctx, "userpw", pw);
  const left = 30 - (Math.floor(clock.now() / 1000) % 30);
  if (left < 15) await clock.sleep(left * 1000 + 500); // the code must not expire before it is sent
  await clickIn(V.send, ctx, "login button", `document.querySelector('a[href*="go("]')`);
  const cf = await waitFrame(/flag3_cert/, 40, 500);
  if (!cf) return `no cert ${V.dialogs.join("|")}`;
  let c2 = 0;
  for (let i = 0; i < 20 && !c2; i++) {
    try {
      const c = await world(V.send, cf);
      if ((await evalIn(V.send, c, "!!document.querySelector('[name=usersms]')")) === true) c2 = c;
    } catch { /* the frame is still loading */ }
    if (!c2) await clock.sleep(300);
  }
  if (!c2) return "no otp field";
  await typeInto(V.send, c2, "usersms", motp());
  await clickIn(V.send, c2, "OTP send button", `[...document.querySelectorAll('a')].find(a=>a.innerText.trim()==='전송')`);
  return (await waitFrame(/bookmark/, 15, 2000)) ? "OK" : `FAIL ${V.dialogs.join("|")}`;
}
const timeout = <T>(p: Promise<T>, ms: number, what: string, clock: Clock): Promise<T> =>
  Promise.race([p, clock.sleep(ms).then((): never => { throw new Error(`timeout ${what}`); })]);

// The ssh tunnel this keep started. A forward keeps the PC and port it started with, so a changed config stops it.
export type TunnelProc = { readonly kill: () => void; readonly exited: Promise<number> };
export type Tunnel = { proc?: TunnelProc | undefined; key?: string | undefined };
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
    await ps(`if(-not (Get-Process SecuwayUPort -ErrorAction SilentlyContinue)){Start-ScheduledTask -TaskName ${psQuote(o.secuwayTask)}; Start-Sleep 5}; try{(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:${o.edgePort}/json/version -TimeoutSec 4) | Out-Null}catch{Start-ScheduledTask -TaskName ${psQuote(o.edgeTask)}; Start-Sleep 8}`);
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
      timeout(new Promise<any>((r, j) => {
        const id = ++n;
        waiting.set(id, (m) => (m.error ? j(new Error(`${method}: ${m.error.message ?? "protocol error"}`)) : r(m)));
        ws.send(JSON.stringify({ id, method, params }));
      }), 10_000, method, clock);
    return { send, dialogs, close: () => ws.close() };
  };
  const login = async (): Promise<string> => {
    const V = await cdp();
    try {
      return await loginFlow(V, o.vpnUrl, creds, motp, clock);
    } finally {
      V.close();
    }
  };
  return {
    paused: () => Bun.file(o.pauseFile).exists(),
    state: async () => vpnState(await ps(STATE_PS)),
    link: async (since) => linkFrom(await ps(linkPs(new URL(o.vpnUrl).hostname)), since),
    ensureAgents,
    login,
    wait: (ms) => clock.sleep(ms),
    restartAgent: async () => { await ps(`Stop-Process -Name SecuwayUPort -Force -ErrorAction SilentlyContinue; Start-Sleep 2; Start-ScheduledTask -TaskName ${psQuote(o.secuwayTask)}; Start-Sleep 8`); },
    // Lists the msedge processes, stops only those edgePids picks (pids, never a name), starts edgeTask again and
    // waits up to 20 s for its debugging port.
    restartEdge: async () => {
      const pids = edgePids(await ps(EDGE_LIST_PS), o.edgeProfile);
      await ps(`${pids.length ? `Stop-Process -Id ${pids.join(",")} -Force -ErrorAction SilentlyContinue; Start-Sleep 3; ` : ""}Start-ScheduledTask -TaskName ${psQuote(o.edgeTask)}; for($i=0;$i -lt 20;$i++){Start-Sleep 1; try{(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:${o.edgePort}/json/version -TimeoutSec 2) | Out-Null; break}catch{}}`);
    },
    log: (line) => console.log(`${new Date(clock.now()).toISOString()} ${line}`),
  };
}

// A PowerShell single-quoted string: every quote PowerShell reads as one (straight and curly) is doubled.
export const psQuote = (text: string): string => `'${text.replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&")}'`;

// One line per msedge process: its pid, a tab, its command line.
export const EDGE_LIST_PS = `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | ForEach-Object { "$($_.ProcessId)\`t$($_.CommandLine)" }`;
// The pids of the msedge processes whose --user-data-dir (quoted or not, the whole argument quoted too) has exactly
// profile as its last folder, compared without case like Windows paths; the owner's own Edge and any other profile stay.
export const edgePids = (list: string, profile: string): number[] =>
  list.split(/\r?\n/).flatMap((line) => {
    const tab = line.indexOf("\t");
    const pid = line.slice(0, tab);
    const m = /"--user-data-dir=([^"]*)"|--user-data-dir="([^"]*)"|--user-data-dir=(\S+)/.exec(line.slice(tab + 1));
    const dir = (m?.[1] ?? m?.[2] ?? m?.[3] ?? "").replace(/[\\/]+$/, "");
    const leaf = dir.split(/[\\/]/).at(-1) ?? "";
    return tab > 0 && /^\d+$/.test(pid) && leaf && leaf.toLowerCase() === profile.toLowerCase() ? [Number(pid)] : [];
  });

export const configPath = (env: Record<string, string | undefined>, home: string = homedir()): string =>
  env["DORI_VPN_KEEP_CONFIG"] || join(home, ".dori", "vpn-keep.json");

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
