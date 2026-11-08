import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

// The tools a job needs on a helper that it does not carry in its --sync paths (heavy-spread.ts).
//
// A tool bundle is a folder <tools dir>/<name>@<version> on a helper with a VERSION file, made there by
// setups/heavy-helper/tools.sh <name> <tag> and never changed after (a new tag is a new folder), and <name> links to
// the current one. A job asks for one by name (dori heavy --tools rv) and goes as tools=<name>@<the caller's version>;
// the helper picks that version's folder when it has it, else the current one, at admission, and binds it read-only in
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

// the caller's side: name@version, the version from the VERSION file beside the program of that name on PATH here
// (rv's install.sh writes one), or the bare name when there is none
export const toolSpec = (name: string, path: string): string => {
  const at = Bun.which(name, { PATH: path });
  const version = at ? versionIn(dirname(realpathSync(at))) : undefined;
  return version ? `${name}@${version}` : name;
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
    const at = pinned && existsSync(pinned) ? pinned : current && existsSync(current) ? realpathSync(current) : undefined;
    if (!at) return { why: `no tool bundle "${name}" on this host; install it there: setups/heavy-helper/tools.sh ${name} <tag>` };
    const have = versionIn(at) ?? "unknown";
    if (want && have !== want) return { why: `tool bundle "${name}" here is version ${have}, the job's is ${want}; install that one there: setups/heavy-helper/tools.sh ${name} v${want}` };
    bundles[name] = at;
  }
  return { bundles };
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
