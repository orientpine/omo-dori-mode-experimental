import { accessSync, constants, existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { BoxTools } from "./heavy-spread.ts";

// The tools a job needs on a helper that it does not carry in its --sync paths (heavy-spread.ts).
//
// A tool bundle on a helper is made by setups/heavy-helper/tools.sh <name> <tag>: each install is a generation folder
// with a VERSION file that is never moved or changed after, <tools dir>/<name>@<version> links to the newest
// generation of that version and <name> to the current version. A job asks for one by name (dori heavy --tools rv) and
// goes as tools=<name>@<the caller's version>; at admission the helper resolves that version's link (else the current
// one) to its generation folder, which an install after admission cannot move or change, and binds it read-only in
// the box at /run/dori-tools/bundles/<name> with its bin first on PATH, so a bundle installed again during the run does
// not change what the job runs. A helper without the bundle, or with another version only, refuses the job with the
// line that says how to install it there, so the job runs here instead of failing in the box (2026-11-08: rv renders
// sent to the 4eae helper found no rv, uv or chromium).

const TOOL_NAME = /^[a-z][\w.-]{0,31}$/;
const TOOL_VERSION = /^[\w.+-]{1,32}$/;
const TOOL_OPT = /^tools=([a-z][\w.-]{0,31})(?:@([\w.+-]{1,32}))?$/;

export const toolNameOk = (name: string): boolean => TOOL_NAME.test(name);
export const toolOptOk = (opt: string): boolean => TOOL_OPT.test(opt);

const versionIn = (dir: string): string | undefined => {
  try {
    const v = readFileSync(join(dir, "VERSION"), "utf8").split("\n")[0]?.trim() ?? "";
    return TOOL_VERSION.test(v) ? v : undefined;
  } catch {
    return undefined;
  }
};

const runnable = (p: string): boolean => {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

// The caller's own program of a bundle: the one on PATH, else the one install of it under ~/.local/share, a folder
// <name>-*/ or <name>/*/ holding the program and a VERSION file, as rv's install.sh leaves it without putting anything on
// PATH; the copies it keeps beside (<folder>.bak-<time>) and old-* folders are not installs. Two installs and none on
// PATH: why, never a guess (2026-11-08: gongdori's rv renders left here ended "rv: not found", exit 127).
type CallerTool = { readonly at: string; readonly onPath: boolean; readonly version?: string } | { readonly why: string } | undefined;
export const callerTool = (name: string, who: { readonly path: string; readonly home: string }): CallerTool => {
  const on = Bun.which(name, { PATH: who.path });
  const onVersion = on ? versionIn(dirname(realpathSync(on))) : undefined;
  if (on) return { at: on, onPath: true, ...(onVersion ? { version: onVersion } : {}) };
  const share = join(who.home, ".local", "share");
  const sub = (d: string): string[] => (existsSync(d) && statSync(d).isDirectory() ? readdirSync(d).map((e) => join(d, e)) : []);
  const dirs = [...sub(share).filter((d) => d.startsWith(join(share, `${name}-`))), ...sub(join(share, name))].filter((d) => !/\.bak-|^old-/.test(d.slice(d.lastIndexOf("/") + 1)));
  const found = dirs.filter((d) => runnable(join(d, name)) && versionIn(d) !== undefined);
  if (found.length > 1) return { why: `${name} is not on PATH and ${found.length} installs of it are in ${share} (${found.join(", ")}); put the one you use on PATH` };
  return found[0] ? { at: join(found[0], name), onPath: false, version: versionIn(found[0])! } : undefined;
};

// the caller's side: name@version, the version of the caller's own program of that name (callerTool), or the bare name
export const toolSpec = (name: string, who: { readonly path: string; readonly home: string }): string => {
  const t = callerTool(name, who);
  return t && "version" in t && t.version ? `${name}@${t.version}` : name;
};

// A job naming bundles that runs here runs the caller's own programs of them, the ones whose versions it would send a
// helper: an install not on PATH goes first on the job's PATH (HEAVY_TOOLS_HERE), and two installs are named, not guessed.
export const toolsHere = (label: string, names: readonly string[], log?: (l: string) => void): { env?: Record<string, string | undefined> } => {
  const path = process.env["PATH"] ?? "";
  const dirs: string[] = [];
  for (const name of new Set(names)) {
    const t = callerTool(name, { path, home: homedir() });
    if (t && "why" in t) log?.(`HEAVY_TOOLS_UNCLEAR ${label}: ${t.why}`);
    else if (t && !t.onPath) {
      dirs.push(dirname(t.at));
      log?.(`HEAVY_TOOLS_HERE ${label}: ${name} is ${t.at} (${t.version}), first on the job's PATH here`);
    }
  }
  return dirs.length ? { env: { ...process.env, PATH: [...dirs, path].join(":") } } : {};
};

// the helper's side: the folder of each bundle the job asks for (its version's, else the current one), or why it has none
export const toolBundles = (opts: readonly string[], toolsDir: string | undefined): { readonly bundles: Readonly<Record<string, string>> } | { readonly why: string } => {
  const bundles: Record<string, string> = {};
  for (const opt of opts) {
    const m = TOOL_OPT.exec(opt);
    if (!m) continue;
    const name = m[1]!;
    const want = m[2];
    const pinned = toolsDir && want ? join(toolsDir, `${name}@${want}`) : undefined;
    const current = toolsDir ? join(toolsDir, name) : undefined;
    const link = pinned && existsSync(pinned) ? pinned : current && existsSync(current) ? current : undefined;
    const at = link ? realpathSync(link) : undefined;
    if (!at) return { why: `no tool bundle "${name}" on this host; install it there: setups/heavy-helper/tools.sh ${name} <tag>` };
    const have = versionIn(at) ?? "unknown";
    if (want && have !== want) return { why: `tool bundle "${name}" here is version ${have}, the job's is ${want}; install that one there: setups/heavy-helper/tools.sh ${name} v${want}` };
    bundles[name] = at;
  }
  return { bundles };
};

export const defaultTools = (): BoxTools => ({
  bunDir: dirname(process.execPath),
  browsersDir: process.env["PLAYWRIGHT_BROWSERS_PATH"] || join(homedir(), ".cache", "ms-playwright"),
  toolsDir: join(homedir(), ".local", "share", "dori-heavy", "tools"),
});

export const playwrightVersion = (roots: readonly string[]): string | undefined => {
  for (const r of roots) {
    for (const f of [join(r, "node_modules", "playwright-core", "package.json"), join(r, "playwright-core", "package.json")]) {
      try {
        const v = (JSON.parse(readFileSync(f, "utf8")) as { version?: unknown }).version;
        if (typeof v === "string" && /^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(v)) return v;
      } catch {
        // not here
      }
    }
  }
  return undefined;
};
