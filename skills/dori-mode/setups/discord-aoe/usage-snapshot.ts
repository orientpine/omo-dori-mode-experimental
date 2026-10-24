#!/usr/bin/env bun
// bun usage-snapshot.ts [out.png]: capture omo-usage's ANSI TUI and render with headless Firefox.
// It photographs the omo-usage TUI already running in a tmux pane (the screen the owner reads) and only starts its own
// omo-usage when no such pane shows a loaded frame: a fresh process has no earlier rows, so an account answering 429
// loses its bars, and every fresh query pushes the shared tokens back into Anthropic's 429 window.
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { envFilePath, loadEnvFile } from "../../scripts/src/config.ts";
import { realClock, run, type Clock, type Runner } from "../../scripts/src/run.ts";

const pal = ["#1e1e2e", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#cba6f7", "#94e2d5", "#cdd6f4",
  "#6c7086", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#cba6f7", "#94e2d5", "#ffffff"] as const;
const x256 = (n: number): string => {
  if (n < 16) return pal[n] ?? "";
  if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
  const c = [0, 95, 135, 175, 215, 255];
  const index = n - 16;
  return `rgb(${c[Math.floor(index / 36)]},${c[Math.floor(index / 6) % 6]},${c[index % 6]})`;
};
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export function usageHtml(ansi: string): { readonly html: string; readonly height: number } {
  let st = { fg: "", bg: "", b: false, d: false };
  let html = "";
  for (const part of ansi.replace(/\s+$/, "").split(/(\x1b\[[0-9;]*m)/)) {
    const m = part.match(/^\x1b\[([0-9;]*)m$/);
    if (!m) {
      if (!part) continue;
      const css = [st.fg && `color:${st.fg}`, st.bg && `background:${st.bg}`, st.b && "font-weight:700", st.d && "opacity:.6"].filter(Boolean).join(";");
      html += css ? `<span style="${css}">${esc(part)}</span>` : esc(part);
      continue;
    }
    const p = (m[1] || "0").split(";").map(Number);
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if (c === undefined) continue;
      if (c === 0) st = { fg: "", bg: "", b: false, d: false };
      else if (c === 1) st.b = true;
      else if (c === 2) st.d = true;
      else if (c === 22) { st.b = false; st.d = false; }
      else if (c >= 30 && c <= 37) st.fg = pal[c - 30] ?? "";
      else if (c >= 90 && c <= 97) st.fg = pal[c - 82] ?? "";
      else if (c >= 40 && c <= 47) st.bg = pal[c - 40] ?? "";
      else if (c === 39) st.fg = "";
      else if (c === 49) st.bg = "";
      else if ((c === 38 || c === 48) && p[i + 1] === 5) {
        const col = x256(p[i + 2] ?? 0);
        if (c === 38) st.fg = col; else st.bg = col;
        i += 2;
      } else if ((c === 38 || c === 48) && p[i + 1] === 2) {
        const col = `rgb(${p[i + 2]},${p[i + 3]},${p[i + 4]})`;
        if (c === 38) st.fg = col; else st.bg = col;
        i += 4;
      }
    }
  }
  const lines = html.split("\n");
  while (lines.length && !lines.at(-1)?.replace(/<[^>]+>/g, "").trim()) lines.pop();
  return {
    html: `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#1e1e2e}pre{margin:0;padding:18px 22px;font:15px/1.35 "DejaVu Sans Mono","Noto Sans Mono",monospace;color:#cdd6f4}</style></head><body><pre>${lines.join("\n")}</pre></body></html>`,
    height: 36 + lines.length * 21,
  };
}

const SNAP_SESSION = "omousage-snap-";
const drawn = (s: string) => /\[q\] quit/.test(s) && /updated \d{1,2}:\d{2}/.test(s) && !/loading/.test(s);
// The header's "updated HH:MM:SS"; rows of newer omo-usage carry "updated HH:MM" without seconds.
const frameStamp = (s: string): string => (s.replace(/\x1b\[[0-9;]*m/g, "").match(/updated (\d{1,2}:\d{2}:\d{2})/)?.[1] ?? "").padStart(8, "0");

// Panes whose process tree runs omo-usage, other than this script's own temporary sessions.
export async function usagePanes(runner: Runner): Promise<string[]> {
  const panes = await runner(["tmux", "list-panes", "-a", "-F", "#{pane_id} #{pane_pid} #{session_name}"]);
  if (panes.code !== 0 || !panes.out.trim()) return [];
  const ps = await runner(["ps", "-eo", "pid=,ppid=,args="]);
  if (ps.code !== 0) return [];
  const children = new Map<string, string[]>();
  const args = new Map<string, string>();
  for (const line of ps.out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const [, pid = "", ppid = "", cmd = ""] = m;
    args.set(pid, cmd);
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const found: string[] = [];
  for (const line of panes.out.split("\n")) {
    const [id, pid, session = ""] = line.trim().split(/\s+/);
    if (!id || !pid || session.startsWith(SNAP_SESSION)) continue;
    const queue = [pid];
    for (let p = queue.shift(); p !== undefined; p = queue.shift()) {
      if (/(^|[\s/])omo-usage(\.ts)?(\s|$)/.test(args.get(p) ?? "")) { found.push(id); break; }
      queue.push(...(children.get(p) ?? []));
    }
  }
  return found;
}

export async function usageSnapshot(out: string, env: Record<string, string | undefined>, runner: Runner = run, clock: Clock = realClock): Promise<void> {
  const snapDir = env.DORI_USAGE_SNAP_DIR || join(homedir(), "snap", "firefox", "common", "omo-usage");
  const sh = async (argv: string[]): Promise<string> => {
    const r = await runner(argv);
    if (r.code !== 0) throw new Error(`${argv.slice(0, 3).join(" ")}: ${r.err.slice(0, 300)}`);
    return r.out;
  };
  let ansi = "";
  const panes = await usagePanes(runner);
  // A pane mid-refresh shows "loading…" for a few seconds: give each pane up to 10 s, then take the freshest loaded frame.
  const pending = new Set(panes);
  for (let i = 0; pending.size > 0 && i < 20; i++) {
    if (i > 0) await clock.sleep(500);
    for (const pane of [...pending]) {
      const r = await runner(["tmux", "capture-pane", "-e", "-p", "-t", pane]);
      if (r.code !== 0 || !drawn(r.out)) continue;
      pending.delete(pane);
      if (!ansi || frameStamp(r.out) > frameStamp(ansi)) ansi = r.out;
    }
  }
  if (!ansi) ansi = await freshUsage(env, sh, clock);
  await renderPng(out, snapDir, ansi, sh);
}

// No running omo-usage pane: start one, and say so on the first line of the image.
async function freshUsage(env: Record<string, string | undefined>, sh: (argv: string[]) => Promise<string>, clock: Clock): Promise<string> {
  const dir = env.DORI_USAGE_DIR;
  if (!dir) throw new Error("no running omo-usage pane, and DORI_USAGE_DIR must point to the omo-usage checkout");
  const session = `${SNAP_SESSION}${process.pid}`;
  // tmux accepts an argv command; paths with spaces never become shell source.
  await sh(["tmux", "new-session", "-d", "-s", session, "-x", "112", "-y", "50", "-c", dir, "bun", "run", "bin/omo-usage.ts"]);
  let ansi = "";
  try {
    for (let i = 0; i < 60; i++) {
      ansi = await sh(["tmux", "capture-pane", "-e", "-p", "-t", session]);
      if (drawn(ansi)) break;
      await clock.sleep(500);
    }
  } finally {
    await sh(["tmux", "kill-session", "-t", session]);
  }
  if (!drawn(ansi)) throw new Error("omo-usage did not finish loading within 30 s");
  return `\x1b[33m  ${FRESH_NOTE}\x1b[0m\n${ansi}`;
}

export const FRESH_NOTE = "실행 중인 omo-usage 화면이 없어 새로 조회한 값 (429 계정은 이전 값 없음)";

async function renderPng(out: string, snapDir: string, ansi: string, sh: (argv: string[]) => Promise<string>): Promise<void> {
  mkdirSync(snapDir, { recursive: true, mode: 0o700 });
  const page = join(snapDir, `page-${process.pid}.html`);
  const shot = join(snapDir, `shot-${process.pid}.png`);
  const rendered = usageHtml(ansi);
  try {
    writeFileSync(page, rendered.html, { mode: 0o600 });
    await sh(["firefox", "--headless", "--screenshot", shot, `--window-size=1040,${rendered.height}`, `file://${page}`]);
    if (!existsSync(shot)) throw new Error(`firefox wrote no screenshot at ${shot}`);
    copyFileSync(shot, out);
  } finally {
    rmSync(page, { force: true });
    rmSync(shot, { force: true });
  }
}

if (import.meta.main) {
  await loadEnvFile(envFilePath());
  const out = process.argv[2] ?? join(tmpdir(), "omo-usage.png");
  await usageSnapshot(out, process.env);
  console.log(out);
}
