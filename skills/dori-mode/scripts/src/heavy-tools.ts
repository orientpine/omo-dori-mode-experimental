import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

// The tools a job needs on a helper that it does not carry in its --sync paths (heavy-spread.ts).
//
// A tool bundle is a folder <tools dir>/<name> on a helper, made there by setups/heavy-helper/tools.sh <name> <tag>,
// with a VERSION file; the box mounts the tools dir read-only with its bin on PATH, where the bundle links its
// programs. A job asks for one by name (dori heavy --tools rv) and goes as tools=<name>@<the caller's version>; a helper
// without that bundle, or with another version, refuses it with the line that says how to install it there, so the job
// runs here instead of failing in the box (2026-11-08: rv renders sent to the 4eae helper found no rv, uv or chromium).

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

// the caller's side: name@version, the version from the VERSION file beside the program of that name on PATH here
// (rv's install.sh writes one), or the bare name when there is none
export const toolSpec = (name: string, path: string): string => {
  const at = Bun.which(name, { PATH: path });
  const version = at ? versionIn(dirname(realpathSync(at))) : undefined;
  return version ? `${name}@${version}` : name;
};

// the helper's side: why it cannot give the job a bundle it asks for, or undefined
export const missingTool = (opts: readonly string[], toolsDir: string | undefined): string | undefined => {
  for (const opt of opts) {
    const m = TOOL_OPT.exec(opt);
    if (!m) continue;
    const name = m[1]!;
    const want = m[2];
    const at = toolsDir ? join(toolsDir, name) : undefined;
    if (!at || !existsSync(at)) return `no tool bundle "${name}" on this host; install it there: setups/heavy-helper/tools.sh ${name} <tag>`;
    const have = versionIn(at) ?? "unknown";
    if (want && have !== want) return `tool bundle "${name}" here is version ${have}, the job's is ${want}; install that one there: setups/heavy-helper/tools.sh ${name} v${want}`;
  }
  return undefined;
};

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
