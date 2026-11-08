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
// the job sent the caller's own tree of that tool, which asks for these runtime packages (toolPlan)
const TOOL_TREE = /^tooltree=([a-z][\w.-]{0,31})$/;
const TOOL_PKGS = /^toolpkgs=([a-z][\w.-]{0,31}):([\w.,-]{0,1024})$/;

const toolNameOk = (name: string): boolean => TOOL_NAME.test(name);
export const toolOptOk = (opt: string): boolean => TOOL_OPT.test(opt) || TOOL_TREE.test(opt) || TOOL_PKGS.test(opt);

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

// the runtime packages a tool's tree asks for, as tools.sh reads them for a bundle's wheels: every uv run --with, as uv
// takes it (--with p or --with=p, quoted or not, a comma list, a version after the name)
const PKG = /--with(?:\s+|=)['"]?([A-Za-z0-9_.,<>=!~-]+)/g;
// the --with specs of a tree that name a version (numpy>=1,<2): no bundle is matched by version, so such a tree stays here
const pinnedIn = (tree: string): string[] => [...new Set(filesOf(tree).flatMap((f) => [...readFileSync(f, "latin1").matchAll(PKG)].map((m) => m[1]!).filter((x) => /[<>=!~]/.test(x))))];
const pkgNames = (spec: string): string[] => spec.split(",").map((p) => /^\s*([A-Za-z0-9_.-]+)/.exec(p)?.[1] ?? "").filter(Boolean);
const filesOf = (tree: string): string[] => readdirSync(tree, { withFileTypes: true }).flatMap((e) => {
  const p = join(tree, e.name);
  if (e.isDirectory()) return [".git", "__pycache__", "node_modules"].includes(e.name) ? [] : filesOf(p);
  return e.isFile() && statSync(p).size < 1_000_000 ? [p] : [];
});
const packagesIn = (tree: string): string[] => [...new Set(filesOf(tree).flatMap((f) => [...readFileSync(f, "latin1").matchAll(PKG)].flatMap((m) => pkgNames(m[1]!))))].sort();
const inside = (p: string, root: string): boolean => p.startsWith(`${root}/`);
export const treeEnvName = (name: string): string => `DORI_TOOL_TREE_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;

// The caller's side. Each bundle goes as tools=<name>@<the version of the caller's own program of it> (callerTool), and
// the caller's own tree of it (the program's folder with VERSION, in your home or /tmp) goes with the job, so the job runs
// the caller's code on the bundle's runtime, never the bundle's copy of a version with other code: tooltree=<name>, the
// packages its uv lines ask for as toolpkgs=<name>:<a,b>, its path as DORI_TOOL_TREE_<NAME> (2026-11-08: zzangdori's rv
// said 0.2.1 with code no tag has, and 4eae would have run the 0.2.1 tag's).
export type ToolPlan = { readonly specs: string[]; readonly trees: string[]; readonly opts: string[]; readonly env: Record<string, string> };
export const toolPlan = (names: readonly string[], who: { readonly path: string; readonly home: string }): ToolPlan | { readonly why: string } => {
  const bad = names.find((t) => !toolNameOk(t));
  if (bad !== undefined) return { why: `--tools ${JSON.stringify(bad)} is not a tool bundle name (lower-case letters, digits, . _ -)` };
  const plan: ToolPlan = { specs: [], trees: [], opts: [], env: {} };
  for (const name of new Set(names)) {
    const t = callerTool(name, who);
    const version = t && "version" in t ? t.version : undefined;
    plan.specs.push(version ? `${name}@${version}` : name);
    const tree = t && "at" in t && version ? dirname(realpathSync(t.at)) : undefined;
    if (!tree || !(inside(tree, who.home) || inside(tree, "/tmp"))) continue;
    const pinned = pinnedIn(tree);
    if (pinned.length) return { why: `your ${name} tree (${tree}) asks for ${pinned.join(", ")} by version, which no bundle is matched by; it runs here` };
    plan.trees.push(tree);
    plan.opts.push(`tooltree=${name}`, `toolpkgs=${name}:${packagesIn(tree).join(",")}`);
    plan.env[treeEnvName(name)] = tree;
  }
  if (plan.trees.length) plan.env["PYTHONDONTWRITEBYTECODE"] = "1";
  return plan;
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

const realOr = (p: string): string | undefined => {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
};
// the bundles a tools folder holds: <name> linking to a generation with VERSION (not <name>@<version>, bin or <name>-gens)
const bundlesIn = (toolsDir: string | undefined): string[] => (toolsDir && existsSync(toolsDir) ? readdirSync(toolsDir).filter((n) => TOOL_NAME.test(n) && versionIn(realOr(join(toolsDir, n)) ?? "/") !== undefined).sort() : []);
const noBundle = (name: string, toolsDir: string | undefined): string => {
  const here = bundlesIn(toolsDir);
  const has = here.find((b) => runnable(join(toolsDir!, b, "bin", name)));
  if (has) return `no tool bundle "${name}" on this host; ${name} comes in the bundle "${has}" here: use --tools ${has}`;
  return `no tool bundle "${name}" on this host (bundles here: ${here.join(", ") || "none"}); setups/heavy-helper/tools.sh makes the bundle rv: tools.sh rv <tag or commit>`;
};
const packagesOf = (gen: string): string[] | undefined => {
  try {
    return readFileSync(join(gen, "PACKAGES"), "utf8").split(/\s+/).filter(Boolean);
  } catch {
    return undefined;
  }
};

// The helper's side: the folder of each bundle the job asks for (its version's, else the current one), or why it has none.
// A job that sent its own tree of the tool takes the bundle for its runtime only: any version whose PACKAGES (written by
// tools.sh) holds every package the tree asks for.
export const toolBundles = (opts: readonly string[], toolsDir: string | undefined): { readonly bundles: Readonly<Record<string, string>> } | { readonly why: string } => {
  const bundles: Record<string, string> = {};
  const trees = new Set(opts.flatMap((o) => TOOL_TREE.exec(o)?.[1] ?? []));
  const pkgs = new Map(opts.flatMap((o) => { const m = TOOL_PKGS.exec(o); return m ? [[m[1]!, m[2]!.split(",").filter(Boolean)] as const] : []; }));
  for (const opt of opts) {
    const m = TOOL_OPT.exec(opt);
    if (!m) continue;
    const name = m[1]!;
    const want = m[2];
    const pinned = toolsDir && want ? join(toolsDir, `${name}@${want}`) : undefined;
    const current = toolsDir ? join(toolsDir, name) : undefined;
    const link = pinned && existsSync(pinned) ? pinned : current && existsSync(current) ? current : undefined;
    let at = link ? realpathSync(link) : undefined;
    if (!at) return { why: noBundle(name, toolsDir) };
    const have = versionIn(at) ?? "unknown";
    if (trees.has(name)) {
      // the version's own link, then the current one, then every other version installed here (newest name first)
      const need = pkgs.get(name) ?? [];
      const others = readdirSync(toolsDir!).filter((n) => n.startsWith(`${name}@`)).sort().reverse().map((n) => join(toolsDir!, n));
      const fits = [link!, ...others].map((l) => realOr(l)).find((g) => g !== undefined && packagesOf(g) !== undefined && need.every((x) => packagesOf(g)!.includes(x)));
      const runtime = packagesOf(at);
      if (!fits && !runtime) return { why: `tool bundle "${name}" here (${have}) was made before jobs sent their own ${name}; install it again there: setups/heavy-helper/tools.sh ${name} v${have}` };
      if (!fits) return { why: `tool bundle "${name}" here (${have}) lacks ${need.filter((x) => !(runtime ?? []).includes(x)).join(" ")}, which the job's ${name} asks for; install one with them there: setups/heavy-helper/tools.sh ${name} <tag or commit>` };
      at = fits;
    } else if (want && have !== want) return { why: `tool bundle "${name}" here is version ${have}, the job's is ${want}; install that one there: setups/heavy-helper/tools.sh ${name} v${want}` };
    bundles[name] = at;
  }
  return { bundles };
};

// The runtime of the bundles a job runs on, in the box, whatever starts their programs (the bundle's bin/rv, the caller's
// tree by path, a job's own --env PATH): each bundle's bin first on PATH, its py/ on PYTHONPATH, its ms-playwright for
// playwright, as tools.sh lays a bundle out
export const bundleEnv = (bundles: Readonly<Record<string, string>>, root: string, env: Readonly<Record<string, string>>, path: string): Record<string, string> => {
  const names = Object.keys(bundles);
  const sub = (d: string): string[] => names.flatMap((n) => (existsSync(join(bundles[n]!, d)) ? [`${root}/bundles/${n}/${d}`] : []));
  if (!names.length) return {};
  const py = [...sub("py"), ...(env["PYTHONPATH"] ? [env["PYTHONPATH"]] : [])];
  return { PATH: [...names.map((n) => `${root}/bundles/${n}/bin`), env["PATH"] ?? path].join(":"), ...(py.length ? { PYTHONPATH: py.join(":") } : {}), ...(sub("ms-playwright")[0] ? { PLAYWRIGHT_BROWSERS_PATH: sub("ms-playwright")[0]! } : {}) };
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
