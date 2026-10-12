#!/usr/bin/env bun
// bun usage-snapshot.ts [out.png]: capture omo-usage's ANSI TUI and render with headless Firefox.
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

export async function usageSnapshot(out: string, env: Record<string, string | undefined>, runner: Runner = run, clock: Clock = realClock): Promise<void> {
  const dir = env.DORI_USAGE_DIR;
  if (!dir) throw new Error("DORI_USAGE_DIR must point to the omo-usage checkout");
  const snapDir = env.DORI_USAGE_SNAP_DIR || join(homedir(), "snap", "firefox", "common", "omo-usage");
  const session = `omousage-snap-${process.pid}`;
  const sh = async (argv: string[]): Promise<string> => {
    const r = await runner(argv);
    if (r.code !== 0) throw new Error(`${argv.slice(0, 3).join(" ")}: ${r.err.slice(0, 300)}`);
    return r.out;
  };
  // tmux accepts an argv command; paths with spaces never become shell source.
  await sh(["tmux", "new-session", "-d", "-s", session, "-x", "112", "-y", "50", "-c", dir, "bun", "run", "bin/omo-usage.ts"]);
  let ansi = "";
  const drawn = (s: string) => /\[q\] quit/.test(s) && /updated \d{1,2}:\d{2}/.test(s) && !/loading/.test(s);
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
