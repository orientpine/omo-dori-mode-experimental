import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";

import type { ArgvTemplate } from "./config.ts";
import { type MemInfo, neverFits, readMeminfo } from "./heavy-mem.ts";
import type { OwnerPc } from "./heavy-owner-pc.ts";
import type { Kind, Plan, SpreadJob } from "./heavy-spread.ts";

// a helper asked for a job with its own estimate (exec mem=, dori heavy --mem) that it can never fit refuses it, so the
// caller asks the next one: a --helpers-only caller does not check the estimate against its own memory (review 2 of #413)
export const memRefusal = (opts: readonly string[], free: number, m: MemInfo | undefined = readMeminfo()): string | undefined => {
  const mem = Number(opts.find((o) => o.startsWith("mem="))?.slice(4)) || 0;
  return mem && m ? neverFits(mem, m, free) : undefined;
};

// a host the queue host hands jobs to: ssh argv to its `dori heavy-worker`; prefer: the --kind kinds it takes first;
// batch: false keeps it out of dori heavy --items batches; owner: an owner's own PC, which takes a batch's items only while he is away (heavy-owner-pc.ts)
export type HeavyHelper = { readonly name: string; readonly ssh: ArgvTemplate; readonly prefer?: readonly string[]; readonly batch?: boolean; readonly owner?: OwnerPc };

// Which helper a dori heavy --kind job may go to, beyond "the less busy PC" (heavy-spread.ts).
// Owner 2026-11-08: "우리 학습용 spark 있는데 자율 굴착 시험왜 여기서 돌리고 있어?" and "doriterm에 연결된 모든 기기들 확인해서,
// 리소스 분배해서 사용하도록 해줘": training, simulation and GPU tests go to the training sparks first, and every machine
// that can take a job is a helper, x86_64 ones included.

// the helpers a job of this kind is offered first, before this host however idle it is (heavyQueue.helpers prefer)
export const preferredFor = (helpers: readonly HeavyHelper[], kind: string): readonly HeavyHelper[] => helpers.filter((h) => h.prefer?.includes(kind));

// uname -m of this host, as a helper compares it with a job's arch=
const NODE_MACHINES: Readonly<Record<string, string>> = { arm64: "aarch64", x64: "x86_64" };
export const hostMachine = (): string => NODE_MACHINES[process.arch] ?? process.arch;
const ELF_MACHINES: Readonly<Record<number, string>> = { 62: "x86_64", 183: "aarch64" };

// a job whose --sync paths hold programs of more than one machine: no helper takes it, it stays on the host that sent it
const MIXED = "mixed";

// the machine of a file's ELF header, or undefined for a file that is not ELF or cannot be read (gone, no permission)
const elfMachine = (f: string, head: Buffer): string | undefined => {
  let n = 0;
  try {
    const fd = openSync(f, "r");
    try {
      n = readSync(fd, head, 0, 20, 0);
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
  if (n < 20 || head.readUInt32BE(0) !== 0x7f454c46) return undefined;
  const m = head[5] === 2 ? head.readUInt16BE(18) : head.readUInt16LE(18);
  return ELF_MACHINES[m] ?? `elf-${m}`;
};

// The machine of the ELF programs and libraries in the --sync paths, "mixed" when they are of more than one, or undefined
// when they hold none. A venv's compiled modules and node_modules' native addons run only on a helper of that machine:
// cha-system-product-name (x86_64) became a helper beside the aarch64 sparks on 2026-11-08, and a venv from 0a83 would
// fail there at its first import.
export const syncedMachine = (sync: readonly string[]): string | undefined => {
  const head = Buffer.alloc(20);
  const machines = new Set<string>();
  for (const s of sync) {
    if (!existsSync(s)) continue;
    const found = Bun.spawnSync(["find", s, "-type", "f", "(", "-perm", "-u+x", "-o", "-name", "*.so", "-o", "-name", "*.so.*", "-o", "-name", "*.node", ")", "-print0"], { stdout: "pipe", stderr: "ignore" });
    for (const f of found.stdout.toString().split("\0")) {
      const m = f ? elfMachine(f, head) : undefined;
      if (m) machines.add(m);
      if (machines.size > 1) return MIXED;
    }
  }
  return [...machines][0];
};

// the plan's arch: the machine a helper must be for the --sync paths' programs, when they hold any
export const archOf = (sync: readonly string[]): { readonly arch?: string } => {
  const arch = syncedMachine(sync);
  return arch ? { arch } : {};
};

// the words after the helper's ssh argv: dori heavy-worker "exec <label> <kind> <below> [options]"
export const execWords = (job: SpreadJob, plan: Extract<Plan, { ok: true }>, below: number, assets?: string): string[] => ["exec", job.label, job.kind, String(Math.max(0, Math.min(100, Math.floor(below)))), ...(plan.playwright ? [`playwright=${plan.playwright}`] : []), ...(job.needBytes ? [`mem=${Math.round(job.needBytes)}`] : []), ...plan.needs.map((p) => `need=${p}`), ...plan.which.map((n) => `which=${n}`), ...(plan.path !== undefined ? [`path=${plan.path}`] : []), ...(plan.tools ?? []).map((t) => `tools=${t}`), ...(job.back?.length ? ["back"] : []), ...(plan.toolOpts ?? []), ...(plan.arch ? [`arch=${plan.arch}`] : []), ...(assets ? [assets] : []), ...(job.helperWords ?? [])];

// ssh hands those words to the helper's login shell, which reads them before the worker checks them: a helper reached
// without a forced command (cha, Tailscale SSH, 2026-11-08) would run a label like `t; touch x` outside its box. Only
// words of these characters leave this host; a job with any other stays here.
const SHELL_SAFE = /^[\w.,:=+@%/-]+$/;
export const unsafeRemote = (job: SpreadJob, plan: Extract<Plan, { ok: true }>): { readonly kind: "refused"; readonly why: string } | undefined => {
  const bad = execWords(job, plan, 0).find((w) => !SHELL_SAFE.test(w));
  return bad === undefined ? undefined : { kind: "refused", why: `"${bad.slice(0, 80)}" would reach the helper's shell; only letters, digits and . , : = + @ % / - _ go to a helper, so it runs on this host` };
};

// this host's GPU device nodes: the DRM nodes, NVIDIA's, and WSL2's /dev/dxg
export const gpuNodes = (): string[] => [...["/dev/dri", "/dev/dxg"].filter((n) => existsSync(n)), ...readdirSync("/dev").filter((n) => n.startsWith("nvidia")).map((n) => `/dev/${n}`)];

// The /dev of a job's box (sandboxArgv): a gpu job gets this host's whole /dev; a browser job a new /dev with this host's GPU
// nodes in it, so its headless chrome draws on the GPU, not in software (cha 2026-11-08: llvmpipe in the box, RTX 3090
// outside, and an rv render 30+ minutes there against 23 on 0a83); a cpu job a new /dev.
export const boxDev = (kind: Kind, nodes: readonly string[] = gpuNodes()): string[] =>
  kind === "gpu" ? ["--dev-bind", "/dev", "/dev"] : ["--dev", "/dev", ...(kind === "browser" ? nodes.flatMap((n) => ["--dev-bind", n, n]) : [])];

// the helper's refusal of a job of a kind it does not take (heavyQueue.kinds), or else of its machine (archRefusal)
export const hostRefusal = (kinds: readonly string[] | undefined, kind: string, opts: readonly string[]): string | undefined =>
  kinds && !kinds.includes(kind) ? `this host takes only ${kinds.join(", ")} jobs (heavyQueue.kinds)` : archRefusal(opts);

const KINDS = ["cpu", "browser", "gpu"];
const isArgv = (v: unknown): boolean => Array.isArray(v) && v.length > 0 && v.every((p) => typeof p === "string");
// what is wrong with one heavyQueue.helpers entry, or undefined
export const helperProblem = (h: HeavyHelper): string | undefined => {
  if (typeof h.name !== "string" || !/^[\w.-]{1,64}$/.test(h.name) || !isArgv(h.ssh)) return "heavyQueue.helpers: each needs a name (letters, digits, . _ -) and an ssh argv";
  if (h.prefer !== undefined && (!Array.isArray(h.prefer) || !h.prefer.every((k) => KINDS.includes(k)))) return `heavyQueue.helpers.${h.name}.prefer must list kinds of ${KINDS.join(", ")}`;
  if (h.batch !== undefined && typeof h.batch !== "boolean") return `heavyQueue.helpers.${h.name}.batch must be true or false`;
  // the owner's PC entry: no default fills a missing number, so a malformed one never turns the idle check off (review 4 of #480)
  if (h.owner !== undefined) {
    const o = h.owner as Record<string, unknown> | null;
    const int = (v: unknown, lo: number, hi: number): boolean => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
    const kindsOk = o?.["kinds"] === undefined || (Array.isArray(o["kinds"]) && o["kinds"].length > 0 && o["kinds"].every((k) => KINDS.includes(k)));
    if (!o || typeof o !== "object" || !int(o["idleMin"], 1, 1440) || !int(o["cpuPct"], 1, 100) || !int(o["memPct"], 1, 100) || !kindsOk) return `heavyQueue.helpers.${h.name}.owner needs idleMin (1-1440), cpuPct and memPct (1-100) as whole numbers, and kinds of ${KINDS.join(", ")} if given`;
  }
  return undefined;
};

// the helper's refusal of a job whose arch= is not this host's machine, or undefined
export const archRefusal = (opts: readonly string[]): string | undefined => {
  const arch = opts.find((o) => o.startsWith("arch="))?.slice(5);
  if (arch === MIXED) return "the job's --sync paths hold programs or libraries of more than one machine, so it stays on the host that sent it";
  return arch && arch !== hostMachine() ? `this host is ${hostMachine()} and the job's --sync paths hold ${arch} programs or libraries, which do not run here` : undefined;
};

// The helpers that refused a waiting job (heavy-spread.ts heavySpread). A refusal for good (exec off, no bwrap, a program
// missing there) holds for the job; one that an install or a pull can end (a missing tool bundle, a dori too old) holds
// REASK_MS, then the helper is asked again (2026-11-08: still jobs refused by four helpers before their rv bundles were
// installed kept waiting for 4eae alone).
export const REASK_MS = 10 * 60_000;
export const refusals = (now: () => number) => {
  const m = new Map<string, { readonly kind: string; readonly why: string; readonly until: number }>();
  const live = (name: string): boolean => {
    const r = m.get(name);
    if (r && now() >= r.until) m.delete(name);
    return m.has(name);
  };
  return {
    has: live,
    set: (name: string, kind: string, why: string): void => void m.set(name, { kind, why, until: kind === "refused" ? Infinity : now() + REASK_MS }),
    all: (names: readonly string[]): boolean => names.length > 0 && names.every(live),
    // every helper turned the job away, not only paused after a stale run of it (--stale-again waits that pause out)
    final: (names: readonly string[]): boolean => names.length > 0 && names.every((n) => live(n) && m.get(n)?.kind !== "stale"),
    list: (): string => [...m].map(([n, r]) => `${n}: ${r.why}`).join("; "),
  };
};

// the git checkout a folder is in, or undefined
// the git checkout a folder is in, or undefined
// the paths one argument names, by the lead's rule after review 17 of #479 (no exception that weighs less): the word
// itself when it is path-shaped, and every path-shaped piece of it cut at = : or , - all of them must be covered. The
// one exception is a URL word (https://..., s3://...), whole or as the value after a key's =. A bare name (out.txt,
// lib) is in the working folder, so already covered.
const pathShaped = (w: string): boolean => w === ".." || /^(\/|\.\/|\.\.\/|~)/.test(w) || w.includes("/");
const URL_WORD = /^[a-z][a-z0-9+.-]*:\/\//i;
const tilde = (w: string): string => (w === "~" || w.startsWith("~/") ? join(homedir(), w.slice(1)) : w);
// every run of pieces between separators is weighed (of=/w:out.txt names /w:out.txt), not only single pieces
const runs = (arg: string): string[] => {
  const t = arg.split(/([=:,])/);
  const n = (t.length + 1) / 2;
  // past the budget no run is dropped: the word fails closed as "/", which no --sync covers (review 18)
  if (n > 256) return ["/"];
  const out: string[] = [];
  for (let i = 0; i < n; i++) for (let j = i; j < n; j++) out.push(t.slice(2 * i, 2 * j + 1).join(""));
  return out.sort((x, y) => y.length - x.length); // the whole word first, so a refusal names it
};
export const argPaths = (arg: string, cwd: string): string[] => {
  if (URL_WORD.test(arg)) return [];
  const eq = arg.indexOf("=");
  const words = eq >= 0 && URL_WORD.test(arg.slice(eq + 1)) ? [arg] : runs(arg);
  return [...new Set(words.filter((w) => w && pathShaped(w)).map((w) => resolve(cwd, tilde(w))))];
};

export const gitTop = (dir: string): string | undefined => {
  const p = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "ignore" });
  const top = p.exitCode === 0 ? p.stdout.toString().trim() : "";
  return top && isAbsolute(top) ? normalize(top) : undefined;
};

// STAY_FILE in the working folder or a folder above it up to `root`: its first line says why the job runs here only
const STAY_FILE = ".dori-heavy-local";
export const stayHere = (cwd: string, root: string): string | undefined => {
  for (let at = cwd; ; at = dirname(at)) {
    const f = join(at, STAY_FILE);
    if (existsSync(f)) return `${f}: ${readFileSync(f, "utf8").split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 200) ?? "runs here only"}`;
    if (at === root || !`${at}/`.startsWith(`${root}/`) || at === "/") return undefined;
  }
};
