import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";

import type { HeavyHelper } from "./config.ts";
import { BACK_MAX_BYTES, backGlobProblem, backPick } from "./heavy-back.ts";
import { newJobDir, onStop, removeTree, stopWithCaller, TarError } from "./heavy-job.ts";
import { canScope, spawnScoped } from "./heavy-mem.ts";
import { helperVerdict, linesOf, type HeavyCtx } from "./heavy-queue.ts";
import { archOf, boxDev, execWords, gitTop, stayHere, hostRefusal, memRefusal, preferredFor, refusals, unsafeRemote, upPaths } from "./heavy-route.ts";
import { acquire, admitOnce, releaseSlot } from "./heavy-slot.ts";
import { sendTar, syncBytes } from "./heavy-send.ts";
import { assetsOptOk, assetsWord, unpackChecked, type Stager } from "./heavy-assets.ts";
import { firstAnswer, killAlive, letGo, readerLines, settle, staleLeft } from "./heavy-settle.ts";
import { aliveOf, heartbeat, markRun, runOf, STALE_EXIT, STALE_GRACE_MS, staleWatch, stopOnHelper, type Stale } from "./heavy-stale.ts";
import { bundleEnv, ensurePlaywright, playwrightVersion, toolBundles, toolOptOk, toolPlan } from "./heavy-tools.ts";
export { toolsHere } from "./heavy-tools.ts";
export { withPipefail } from "./heavy-pipefail.ts";

// dori heavy <label> --kind cpu|browser|gpu --sync PATH... -- <cmd>: a lane's own command (a browser test, a build) runs on
// the less busy PC. When this host is more than SPREAD_MARGIN points busier than a helper, the helper runs it; else it
// waits for this host's heavy slots as before, and a helper still takes it when this host refuses it (load, headroom,
// full slots). On the helper the command runs in a bwrap box: the --sync paths (shipped as tar) are mounted at the same
// absolute paths, so the command and its arguments work unchanged; /home and /tmp are empty, the system is read-only,
// there is no network, and only the job's own folder is writable. Its stdout and stderr stream back live, the files it
// made or changed under the --sync paths are copied back to the same paths here, and its exit code is the exit code.
// Owner 2026-11-01 14:44 KST: "모든 도리들도 리소스 이렇게 분할해서 쓸수있게 해".

export const KINDS = ["cpu", "browser", "gpu"] as const;
export type Kind = (typeof KINDS)[number];
export const isKind = (s: string): s is Kind => (KINDS as readonly string[]).includes(s);

// percentage points this host must be busier than a helper before a job leaves for it (a short job is not worth the trip
// when both are about as busy)
export const SPREAD_MARGIN = 15;
// seconds a cpu or browser job needs before its load shows, so the next one may start beside it under the headroom rule
// (heavySettleSec, 120 by default, is for GPU jobs that load a model; browser tests often end before it)
export const QUICK_SETTLE_SEC = 20;
const settleFor = (kind: Kind): number | undefined => (kind === "gpu" ? undefined : QUICK_SETTLE_SEC);
// a helper run whose files over BACK_MAX_BYTES stayed there in part exits so when its command exited 0 (heavy-back.ts)
const BACK_TOO_BIG_EXIT = 70;

const NAME = /^[\w.-]{1,64}$/;
const ENV_NAME = /^[A-Za-z_]\w{0,63}$/;
// paths a command may name that are the same on every host (read-only in the box)
const SYSTEM = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/opt", "/proc", "/dev", "/sys"];
// the system folders programs live in: a program the job starts from one of them must be on the helper too (need=)
const PROGRAM_DIRS = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/opt"];
// the box's PATH after its own bun and tools folders, and the programs those two folders give every helper (uv: the rv bundle's, tools.sh rv)
const BOX_SYSTEM_PATH = "/usr/local/bin:/usr/bin:/bin";
const BOX_PROGRAMS = new Set(["bun", "bunx", "ffmpeg", "ffprobe", "uv"]);
const NEED_PATH = /^\/[\w.+@-][\w.+@/-]{0,254}$/;
const NEEDS_MAX = 32;
const BOX_PATH_OK = /^[\w.+@/:-]{1,2048}$/;
const inProgramDirs = (p: string): boolean => PROGRAM_DIRS.some((d) => within(p, d));

export const within = (p: string, root: string): boolean => p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);

export type SpreadJob = {
  readonly label: string;
  readonly kind: Kind;
  readonly cmd: readonly string[];
  readonly cwd: string;
  readonly sync: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly needBytes?: number;
  // the helper tool bundles the job needs (dori heavy --tools, heavy-tools.ts), globs of what comes back (--back, heavy-back.ts); helpersOnly: never this host's slot (--helpers-only)
  readonly tools?: readonly string[];
  readonly back?: readonly string[]; readonly helpersOnly?: boolean; readonly out?: Sink; readonly err?: Sink; readonly runner?: Sink; // out, err: where its lines go (a batch item's own files, heavy-batch.ts), else this process's; runner: the helper's own lines (never the command's), else err
  readonly staleAgain?: boolean; readonly assets?: Stager; // --stale-again: a stale helper run goes back to the line instead of ending (heavy-stale.ts); assets: the job's or batch's one archive of its --sync paths (heavy-assets.ts)
};
// needs: the system programs the job starts (its first word, links in its --sync paths that lead into a system folder),
// which the helper must have before it takes the job
// which: the bare command names the helper must find on its box PATH (as here, where they may sit in another folder)
// path: the job's --env PATH, the box's PATH there, on which the helper looks the names up
export type Plan = { readonly ok: true; readonly sync: readonly string[]; readonly needs: readonly string[]; readonly which: readonly string[]; readonly path?: string; readonly playwright?: string; readonly tools?: readonly string[]; readonly toolOpts?: readonly string[]; readonly toolEnv?: Readonly<Record<string, string>>; readonly arch?: string } | { readonly ok: false; readonly why: string; readonly kind?: "ship" | "sync"; readonly path?: string };

// absolute paths inside one argument: the whole argument, or what follows = , or : (not the // of a URL)
export const pathsIn = (arg: string): string[] => [...arg.matchAll(/(?:^|[=,:])(\/(?!\/)[^\s=,:;"'\]}]*)/g)].map((m) => normalize(m[1]!));

export const nearestExisting = (p: string): string => {
  let at = p;
  while (!existsSync(at) && at !== "/") at = dirname(at);
  return at;
};

// symlinks in a synced folder: [link, absolute target]
const linksIn = (root: string): [string, string][] => {
  const p = Bun.spawnSync(["find", root, "-type", "l", "-printf", "%p\\0%l\\0"]);
  const parts = p.stdout.toString().split("\0");
  const out: [string, string][] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const link = parts[i]!;
    const to = parts[i + 1]!;
    out.push([link, normalize(isAbsolute(to) ? to : resolve(dirname(link), to))]);
  }
  return out;
};

// Whether the job can run on another host unchanged: every path it needs travels with --sync, and every --sync path is
// this account's own (home or /tmp, owned, no link on the way, no ..), --tools trees too. Else it runs here (HEAVY_LOCAL).
export const spreadPlan = (job: SpreadJob, who: { readonly uid: number; readonly home: string; readonly path?: string }): Plan => {
  // kind (heavy-ship.ts, #479 r3-4): "ship" sends the working folder; "sync" only --sync may send (no guess, no auto checkout); none: here.
  const no = (why: string, kind?: "ship" | "sync", path?: string): Plan => ({ ok: false, why, ...(kind && path ? { kind, path } : {}) });
  const top = gitTop(job.cwd);
  const outer = job.sync.map((s) => normalize(s).replace(/(.)\/$/, "$1")).filter((s) => within(job.cwd, s)).sort((a, b) => a.length - b.length)[0];
  const stay = stayHere(job.cwd, top ?? outer ?? who.home);
  if (stay) return no(stay);
  const inTop = top && top !== who.home && (within(top, who.home) || within(top, "/tmp")) ? top : undefined;
  if (!job.sync.length) return no("no --sync path (the command's folder travels only with --sync)", inTop ? "sync" : "ship", inTop ?? job.cwd);
  if (backGlobProblem(job.back)) return no(backGlobProblem(job.back)!);
  const tp = toolPlan(job.tools ?? [], { path: who.path ?? process.env["PATH"] ?? "", home: who.home });
  if ("why" in tp) return no(tp.why);
  const roots: string[] = [];
  for (const raw of [...job.sync, ...tp.trees]) {
    if (!isAbsolute(raw) || raw.split("/").includes("..")) return no(`--sync ${raw} must be an absolute path without ..`, "sync", raw);
    const p = normalize(raw).replace(/(.)\/$/, "$1");
    if (!within(p, who.home) && !within(p, "/tmp") || p === who.home || p === "/tmp") return no(`--sync ${p} must be a folder or file inside your home or /tmp`, "sync", p);
    const at = nearestExisting(p);
    if (realpathSync(at) !== at) return no(`--sync ${p} goes through a link (${at} is ${realpathSync(at)}); give the real path`, "sync", p);
    if (at === p) {
      const st = lstatSync(p);
      if (st.uid !== who.uid) return no(`--sync ${p} belongs to another account`, "sync", p);
      if (!st.isDirectory() && !st.isFile()) return no(`--sync ${p} is not a folder or a file`, "sync", p);
    }
    roots.push(p);
  }
  const sync = [...new Set(roots)].sort((a, b) => a.length - b.length).filter((p, i, all) => !all.slice(0, i).some((q) => within(p, q))); // a path inside another travels with it
  const covered = (p: string): boolean => sync.some((s) => within(p, s)) || SYSTEM.some((s) => within(p, s));
  if (inTop && !sync.some((s) => within(inTop, s))) return no(`the working folder is in the git checkout ${inTop}, which --sync carries only in part (its tests read the rest)${sync.some((s) => within(job.cwd, s)) ? `; add --sync ${inTop}` : ""}`, sync.some((s) => within(job.cwd, s)) ? undefined : "sync", inTop);
  if (!sync.some((s) => within(job.cwd, s))) return no(`the working folder ${job.cwd} is not in a --sync path`, "ship", job.cwd);
  // an argument that is one existing path is weighed whole, instead of its pieces: a covered prefix cannot stand for it, nor an uncovered one refuse it
  for (const arg of job.cmd) for (const p of isAbsolute(arg) && existsSync(arg) ? [normalize(arg)] : [...pathsIn(arg), ...upPaths(arg === job.cmd[0] ? "" : arg, job.cwd)]) if (!covered(p)) return no(`${p} (in "${arg.slice(0, 80)}") is not in a --sync path`, "sync", p);
  // A system program the job starts is checked on the helper before it takes the job: a venv's python links to the
  // system python it was made with, and on a helper without that version the link dangles in the box, so the run printed
  // nothing (2026-11-07: a check of two runs on a helper without the venv's python read two empty logs as the same).
  const needs = new Set<string>();
  const which = new Set<string>();
  for (const s of sync) {
    if (!existsSync(s) || !statSync(s).isDirectory()) continue;
    for (const [link, to] of linksIn(s)) {
      if (existsSync(to) && !covered(to)) return no(`the link ${link} points to ${to}, which is not in a --sync path`, "sync", to);
      if (inProgramDirs(to)) needs.add(to);
    }
  }
  const first = job.cmd[0] ?? "";
  if (first.includes("/")) {
    const p = resolve(job.cwd, first);
    if (!covered(p)) return no(`the command ${first} is ${p}, which is not in a --sync path`, "sync", p);
    if (inProgramDirs(p)) needs.add(p);
  } else if (job.env["PATH"] !== undefined) {
    // --env PATH is the box's PATH too: a command in a --sync path travels, one in a system folder is looked up by the
    // helper on that same PATH (it may sit in another of its folders there)
    const at = Bun.which(first, { PATH: job.env["PATH"], cwd: job.cwd });
    if (at && !covered(at)) return no(`the command ${first} is ${at} on the job's --env PATH, which is not in a --sync path`, "sync", at);
    if (at && !sync.some((s) => within(at, s))) which.add(first);
  } else {
    // the box's own bun and tools, a tool bundle the job names, or a system folder: the helper looks the name up on its box PATH
    const here = Bun.which(first, { PATH: who.path ?? process.env["PATH"] ?? "", cwd: job.cwd });
    if (BOX_PROGRAMS.has(first) || job.tools?.length || Bun.which(first, { PATH: BOX_SYSTEM_PATH })) which.add(first);
    else if (here) return no(`the command ${first} is ${here}, which is in no --sync path and no system folder, so a helper has none`);
  }
  // the helper looks the names up from /, the job from its own folder: relative and empty PATH entries go as that folder's,
  // unnormalized (a/../b is not b when a is missing), and absolute ones as written
  const path = which.size && job.env["PATH"] !== undefined ? job.env["PATH"].split(":").map((d) => (d.startsWith("/") ? d : d === "" ? job.cwd : `${job.cwd}/${d}`)).join(":") : undefined;
  if (path !== undefined && !BOX_PATH_OK.test(path)) return no(`the job's --env PATH ${JSON.stringify(path.slice(0, 80))} cannot be sent to a helper for its lookup`);
  const odd = [...needs].find((p) => !NEED_PATH.test(p) || p.split("/").includes(".."));
  if (odd !== undefined) return no(`the job starts ${JSON.stringify(odd)}, a path a helper cannot be asked about`);
  if (needs.size > NEEDS_MAX) return no(`the job starts ${needs.size} system programs, more than the ${NEEDS_MAX} a helper is asked about`);
  const playwright = job.kind === "browser" ? playwrightVersion(sync.filter((s) => existsSync(s))) : undefined;
  return { ok: true, sync, needs: [...needs], which: [...which], ...(path !== undefined ? { path } : {}), ...(playwright ? { playwright } : {}), ...(tp.specs.length ? { tools: tp.specs } : {}), ...(tp.opts.length ? { toolOpts: tp.opts, toolEnv: tp.env } : {}), ...archOf(sync) };
};

// how busy this host is for a job of this kind, in percent (gpu: the GPU or the CPU, whichever is busier)
export const busyOf = async (ctx: HeavyCtx, kind: Kind): Promise<number> => {
  const s = await ctx.deps.headroom?.usage([]);
  if (!s) return 0;
  return Math.round(kind === "gpu" ? Math.max(s.host.gpu ?? 0, s.host.cpu) : s.host.cpu);
};

// Copies the files a helper run sent back (unpacked under back/) to the same paths here: regular files inside a --sync
// path only, never through a link here that leads out of the --sync paths, never onto a link.
export const copyBack = (back: string, sync: readonly string[]): { files: number; bytes: number; skipped: number } => {
  const n = { files: 0, bytes: 0, skipped: 0 };
  const inSync = (p: string) => sync.some((s) => within(p, s));
  const walk = (rel: string): void => {
    for (const e of readdirSync(join(back, rel), { withFileTypes: true })) {
      const r = join(rel, e.name);
      if (e.isDirectory()) {
        walk(r);
        continue;
      }
      const to = `/${r}`;
      if (!e.isFile() || !inSync(to)) {
        n.skipped++;
        continue;
      }
      const at = nearestExisting(dirname(to));
      const real = realpathSync(at);
      if ((real !== at && !inSync(real)) || (existsSync(to) && lstatSync(to).isSymbolicLink())) {
        n.skipped++;
        continue;
      }
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(join(back, r), to);
      n.files++;
      n.bytes += statSync(to).size;
    }
  };
  walk("");
  return n;
};

type Sink = { write(s: string): unknown }; type Started = { readonly helper: string; readonly id: string | undefined; readonly done: Promise<number | null | Stale>; readonly assets?: string };
type HelperTry = { readonly kind: "started"; readonly run: Started } | { readonly kind: "busy" | "down" | "refused" | "old" | "notools"; readonly why: string };
const VERDICT = /^WORKER_(ADMIT|BUSY|REFUSED)\b ?(.*)$/;

export const startExec = async (ctx: HeavyCtx, h: HeavyHelper, job: SpreadJob, plan: Extract<Plan, { ok: true }>, below: number, assets = true): Promise<HelperTry> => {
  const a = assets ? await job.assets?.get(plan.sync) : undefined; // the --sync paths as one archive checked by its sha256 there (heavy-assets.ts); a helper that does not know assets= is asked once more without it
  if (a && "why" in a) return { kind: "refused", why: a.why };
  const args = execWords(job, plan, below, a && assetsWord(a));
  const p = Bun.spawn([...h.ssh, ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe" }); // ssh, tar and untar stay in the caller's process group: a Ctrl-C on its terminal ends them with it
  const reader = p.stderr.getReader();
  const lines = readerLines(reader);
  const staleMs = (ctx.q.staleMin ?? 20) * 60_000;
  // the admission too has staleMin at most: an ssh that connects and never answers is down, not waited on
  const { said: verdict, last, answered } = await firstAnswer(p, lines, VERDICT, staleMs);
  if (verdict?.[1] !== "ADMIT") {
    await letGo(p, reader, answered ? STALE_GRACE_MS : 0);
    if (!answered) return { kind: "down", why: `no answer to the admission within ${staleMs / 60_000} min (heavyQueue.staleMin)` };
    if (!verdict) return { kind: "down", why: last || `ssh exited ${p.exitCode ?? p.signalCode}` };
    if (a && verdict[1] === "REFUSED" && verdict[2]?.startsWith('unknown option "assets=')) return startExec(ctx, h, job, plan, below, false);
    return helperVerdict(verdict[1] ?? "", verdict[2] ?? "");
  }
  const stop = onStop(() => p.kill("SIGKILL"));
  const aliveSec = aliveOf(verdict?.[2] ?? "");
  const watch = staleWatch({ label: job.label, helper: h.name, total: (cut) => syncBytes(plan.sync, cut), staleMs, ...(aliveSec ? { aliveSec } : {}), now: () => ctx.deps.clock.now(), log: (l) => ctx.deps.log?.(l) });
  let stale: string | undefined;
  const kids: Bun.Subprocess[] = [p];
  void watch.stale.then((why) => {
    stale = why;
    for (const x of kids) killAlive(x);
  });
  let exit: number | undefined;
  let tooBig = false;
  // O <line>: the command's stdout, E <line>: its stderr, WORKER_EXIT <code> at the end, WORKER_ALIVE a heartbeat, anything else: the helper's lines
  const forward = (async () => {
    for (let n = await lines.next(); !n.done; n = await lines.next()) {
      const l = n.value;
      watch.heard();
      if (l.startsWith("WORKER_ALIVE")) continue;
      if (l.startsWith("O ")) (job.out ?? process.stdout).write(`${l.slice(2)}\n`);
      else if (l.startsWith("E ")) (job.err ?? process.stderr).write(`${l.slice(2)}\n`);
      else if (/^WORKER_EXIT \d+$/.test(l)) exit = Number(l.slice(12));
      else {
        if (l.startsWith("WORKER_BACK_TOO_BIG")) tooBig = true;
        (job.runner ?? job.err ?? process.stderr).write(`${l}\n`);
      }
    }
  })();
  mkdirSync(ctx.deps.dir, { recursive: true });
  const back = mkdtempSync(join(ctx.deps.dir, "back-"));
  const untar = Bun.spawn(["tar", "-C", back, "--no-same-owner", "-xf", "-"], { stdin: p.stdout, stdout: "ignore", stderr: "pipe" });
  kids.push(untar);
  const done = (async (): Promise<number | null | Stale> => {
    let sent = -1;
    const up = sendTar(p.stdin, plan.toolEnv ? { ...job, env: { ...job.env, ...plan.toolEnv } } : job, plan.sync, watch.sent, watch.stale, kids, (why) => ctx.deps.log?.(`HEAVY_SYNC_CHANGED ${job.label} ${h.name}: ${why}; sent as read (tar exit 1), the job runs on that`), a);
    try {
      sent = await Promise.race([up, watch.stale.then(() => -1)]);
      watch.synced();
    } catch (e) {
      if (stale === undefined) ctx.deps.log?.(`HEAVY_SPREAD_SEND ${job.label} ${h.name}: ${String(e).slice(0, 200)}`);
      p.kill("SIGKILL");
    }
    // after a stale verdict every wait, the upload's too, gets STALE_GRACE_MS (a child in uninterruptible disk I/O, a held pipe)
    const ended = await settle(kids, [reader], Promise.all([p.exited, untar.exited, forward, up.catch(() => undefined)]), watch.stale.then(() => Bun.sleep(STALE_GRACE_MS)));
    const [code, ucode] = ended ? [p.exitCode, untar.exitCode] : [null, null];
    stop();
    watch.stop();
    try {
      if (stale !== undefined) return { stale, abandoned: staleLeft(kids, ended, (l) => ctx.deps.log?.(l), `${job.label} ${h.name}`, STALE_GRACE_MS) };
      if (sent < 0 || code !== 0 || exit === undefined || ucode !== 0) return null;
      const n = copyBack(back, plan.sync);
      ctx.deps.log?.(`HEAVY_BACK ${job.label} ${h.name}: sent ${sent} bytes, ${n.files} file(s) ${n.bytes} bytes back${n.skipped ? `, ${n.skipped} skipped (outside --sync or through a link)` : ""}`);
      return tooBig && exit === 0 ? BACK_TOO_BIG_EXIT : exit;
    } finally {
      rmSync(back, { recursive: true, force: true });
    }
  })();
  return { kind: "started", run: { helper: h.name, done, id: runOf(verdict?.[2] ?? ""), ...(a ? { assets: a.sha } : {}) } };
};

// abandoned: a stale run left something not ended (HEAVY_STALE_LEFT): the caller exits without waiting on it
export type SpreadResult = ({ readonly slot: string } | { readonly code: number }) & { readonly abandoned?: true };

// The caller's side: a helper's exit code, or this host's heavy slot when the job is to run here after all.
export const heavySpread = async (ctx: HeavyCtx, job: SpreadJob, plan: Extract<Plan, { ok: true }>): Promise<SpreadResult> => {
  const log = (line: string) => ctx.deps.log?.(line);
  const seen = new Map<string, string>();
  // a helper that refused this job is not asked again, for good or a while (heavy-route.ts refusals)
  const refused = refusals(() => ctx.deps.clock.now());
  const helpers = async (below: number, why: string, among: readonly HeavyHelper[] = ctx.q.helpers): Promise<Started | null> => {
    for (const h of among) {
      if (refused.has(h.name)) continue;
      const t = unsafeRemote(job, plan) ?? (await startExec(ctx, h, job, plan, below));
      if (t.kind === "started") {
        seen.delete(h.name);
        log(`HEAVY_SPREAD ${job.label} ${h.name}: ${why}`);
        return t.run;
      }
      if (seen.get(h.name) !== `${t.kind} ${t.why}`) log(`HEAVY_HELPER_${t.kind.toUpperCase()} ${job.label} ${h.name}: ${t.why}`);
      seen.set(h.name, `${t.kind} ${t.why}`);
      if (t.kind === "refused" || t.kind === "old" || t.kind === "notools") {
        refused.set(h.name, t.kind, t.why);
        if (refused.all(ctx.q.helpers.map((x) => x.name))) log(job.helpersOnly ? `HEAVY_HELPERS_ONLY ${job.label}: no helper can run it (${refused.list()}); it does not run on this host` : `HEAVY_LOCAL ${job.label}: no helper can run it (${refused.list()}); it waits for this host`);
      }
    }
    return null;
  };
  let run = await helpers(100, `${job.kind} jobs go to this helper first (heavyQueue.helpers prefer)`, preferredFor(ctx.q.helpers, job.kind));
  const busy = run ? 0 : await busyOf(ctx, job.kind);
  if (busy > SPREAD_MARGIN) run = await helpers(busy - SPREAD_MARGIN, `this host is ${busy}% busy (${job.kind}), the helper less than ${busy - SPREAD_MARGIN}%`);
  const since = ctx.deps.clock.now();
  let abandoned = false;
  const end = <R extends { readonly slot: string } | { readonly code: number }>(r: R): SpreadResult => (abandoned ? { ...r, abandoned } : r);
  for (;;) {
    if (!run) {
      const got = await acquire<Started | "nowhere">(ctx.deps, job.label, { since, elsewhere: async (why) => (await helpers(100, why)) ?? (job.helpersOnly && refused.final(ctx.q.helpers.map((x) => x.name)) ? "nowhere" : null), ...(job.helpersOnly ? { helpersOnly: true } : { nowhere: () => refused.all(ctx.q.helpers.map((x) => x.name)) }), elsewhereWhileSettling: true, ...(settleFor(job.kind) ? { settleSec: settleFor(job.kind) } : {}), ...(job.needBytes ? { memKb: job.needBytes / 1024 } : {}) });
      if ("slot" in got || got.elsewhere === "nowhere") return "slot" in got ? end({ slot: got.slot }) : end({ code: 2 });
      run = got.elsewhere;
    }
    const code = await run.done;
    if (code !== null && typeof code === "object") {
      abandoned ||= code.abandoned;
      log(`HEAVY_HELPER_STALE ${job.label} ${run.helper}: ${code.stale}; ${job.staleAgain ? "the job goes back to the line" : `the job ends with exit ${STALE_EXIT} (dori heavy --stale-again sends it again)`}`);
      const h = ctx.q.helpers.find((x) => x.name === run?.helper);
      if (h && (await stopOnHelper(h, job.label, log, run.id, Math.min(30_000, (ctx.q.staleMin ?? 20) * 60_000)))) abandoned = true;
      if (!job.staleAgain) return end({ code: STALE_EXIT });
      refused.set(run.helper, "stale", code.stale);
      run = null;
      continue;
    }
    if (code !== null) {
      log(`HEAVY_DONE ${job.label} ${run.helper}: exit ${code}`);
      return end({ code });
    }
    log(`HEAVY_HELPER_CUT ${job.label} ${run.helper}: the run broke off; nothing came back, the job goes back to the line`);
    run = null;
    await ctx.deps.clock.sleep(15_000);
  }
};

// ---- the helper's side: dori heavy-worker "exec <label> <kind> <below> [playwright=<version>] [mem=<bytes>]"

type ExecSpec = { readonly argv: string[]; readonly cwd: string; readonly sync: string[]; readonly env: Record<string, string>; readonly back?: string[] };

export const specProblem = (x: unknown): string | ExecSpec => {
  const s = x as Partial<ExecSpec> | null;
  if (!s || typeof s !== "object") return "job.json is not an object";
  if (!Array.isArray(s.argv) || !s.argv.length || !s.argv.every((a) => typeof a === "string")) return "argv must be a non-empty list of strings";
  const absOk = (p: unknown): p is string => typeof p === "string" && isAbsolute(p) && !p.split("/").includes("..") && normalize(p) === p;
  if (!Array.isArray(s.sync) || !s.sync.length || !s.sync.every((p) => absOk(p) && (p.startsWith("/home/") || p.startsWith("/tmp/")))) return "sync must be absolute paths under /home/ or /tmp/ without ..";
  if (!absOk(s.cwd) || !s.sync.some((p) => within(s.cwd as string, p))) return "cwd must be inside a sync path";
  if (!s.env || typeof s.env !== "object" || !Object.entries(s.env).every(([k, v]) => ENV_NAME.test(k) && typeof v === "string")) return "env must map variable names to strings";
  if (s.back !== undefined && (!Array.isArray(s.back) || !s.back.every((g) => typeof g === "string") || backGlobProblem(s.back))) return "back must be a list of --back globs";
  return s as ExecSpec;
};

// bundles: the tool bundles a job asked for, by name, each the folder of the version picked at admission (heavy-tools.ts)
export type BoxTools = { readonly bunDir?: string; readonly browsersDir?: string; readonly toolsDir?: string; readonly bundles?: Readonly<Record<string, string>> };
export const BOX_TOOLS = "/run/dori-tools";

// the bwrap argv for one run: from = where each --sync path's copy lives in the job folder
export const sandboxArgv = (kind: Kind, spec: ExecSpec, from: (p: string) => string, tools: BoxTools): string[] => {
  const ro = (src: string | undefined, name: string): string[] => (src && existsSync(src) ? ["--ro-bind", src, `${BOX_TOOLS}/${name}`] : []);
  const env: Record<string, string> = {
    PATH: `${BOX_TOOLS}/bun:${BOX_TOOLS}/tools/bin:/usr/local/bin:/usr/bin:/bin`,
    HOME: "/tmp/home", TMPDIR: "/tmp",
    LANG: "C.UTF-8",
    ...(tools.browsersDir && existsSync(tools.browsersDir) ? { PLAYWRIGHT_BROWSERS_PATH: `${BOX_TOOLS}/ms-playwright` } : {}),
    ...spec.env,
    ...bundleEnv(tools.bundles ?? {}, BOX_TOOLS, spec.env, `${BOX_TOOLS}/bun:${BOX_TOOLS}/tools/bin:/usr/local/bin:/usr/bin:/bin`),
  };
  return [
    "bwrap",
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--ro-bind", "/", "/",
    ...boxDev(kind),
    "--proc", "/proc",
    "--tmpfs", "/home",
    "--tmpfs", "/tmp",
    "--tmpfs", "/var/tmp",
    "--tmpfs", "/run",
    ...ro(tools.bunDir, "bun"),
    ...ro(tools.browsersDir, "ms-playwright"),
    ...ro(tools.toolsDir, "tools"),
    ...Object.entries(tools.bundles ?? {}).flatMap(([n, src]) => ro(src, `bundles/${n}`)),
    "--dir", "/tmp/home",
    ...[...spec.sync].sort((a, b) => a.length - b.length).flatMap((p) => ["--bind", from(p), p]),
    // the empty /home, /var/tmp and /run are read-only too: the job writes only its own --sync copies and /tmp
    "--remount-ro", "/home",
    "--remount-ro", "/var/tmp",
    "--remount-ro", "/run",
    "--chdir", spec.cwd,
    "--clearenv",
    ...Object.entries(env).flatMap(([k, v]) => ["--setenv", k, v]),
    "--",
    // bwrap exits 1 when it cannot start the command; started through sh's exec, as dori heavy starts it here
    // (heavy-mem.ts scopeArgv), a command that is not there ends 127 and one that cannot run 126
    "/bin/sh", "-c", 'exec "$@"', "dori-heavy-job",
    ...spec.argv,
  ];
};

// The programs a job starts, looked for in a box made like the job's (sandboxArgv: same mounts, same PATH), so a program
// the host has but the box hides (/home, /tmp, /run are empty there; a link may lead into them) counts as missing.
// need: a path that must exist; names: commands looked up on the box's PATH. undefined: all there.
// a name counts only as an executable file in a PATH folder, as exec finds it (command -v also takes shell builtins)
const PROBE = 'for p in $PROBE_NEEDS; do [ -e "$p" ] || { printf "%s\\n" "$p"; exit 1; }; done; for n in "$@"; do f=; IFS=:; for d in $PATH; do if [ -n "$d" ] && [ -f "$d/$n" ] && [ -x "$d/$n" ]; then f=1; break; fi; done; unset IFS; [ -n "$f" ] || { printf "%s\\n" "$n"; exit 1; }; done';
export const probeBox = (kind: Kind, tools: BoxTools, needs: readonly string[], names: readonly string[], path?: string): { missing: string } | { failed: string } | undefined => {
  const spec: ExecSpec = { argv: ["/bin/sh", "-c", PROBE, "dori-probe", ...names], cwd: "/", sync: [], env: { PROBE_NEEDS: needs.join(" "), ...(path !== undefined ? { PATH: path } : {}) } };
  const p = Bun.spawnSync(sandboxArgv(kind, spec, () => "/", tools), { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20_000 });
  const out = p.stdout.toString().trim();
  if (p.exitCode === 0) return undefined;
  if (p.exitCode === 1 && (needs.includes(out) || names.includes(out))) return { missing: out };
  return { failed: `exit ${p.exitCode ?? p.signalCode}: ${p.stderr.toString().trim().slice(0, 200)}` };
};

const duBytes = (p: string): number => Number(Bun.spawnSync(["du", "-sb", p]).stdout.toString().split(/\s/)[0]) || 0;

export type ExecDeps = { readonly refuse: (label: string, why: string) => number; readonly caller: string; readonly tools: BoxTools; readonly maxMin: number };

export const heavyExec = async (ctx: HeavyCtx, words: readonly string[], d: ExecDeps): Promise<number> => {
  const [label = "", kind = "", belowS = "", ...opts] = words;
  if (!NAME.test(label)) return d.refuse("-", `label "${label}" must be letters, digits, . _ -`);
  if (!isKind(kind)) return d.refuse(label, `kind "${kind}" is not cpu, browser or gpu`);
  if (!/^\d{1,3}$/.test(belowS) || Number(belowS) > 100) return d.refuse(label, `"${belowS}" is not a busy percent`);
  const needOk = (o: string): boolean => o.startsWith("need=") && NEED_PATH.test(o.slice(5)) && !o.split("/").includes("..") && inProgramDirs(o.slice(5));
  const whichOk = (o: string): boolean => /^which=[\w.+@-]{1,64}$/.test(o) && !/^which=\.+$/.test(o);
  const pathOk = (o: string): boolean => o.startsWith("path=") && BOX_PATH_OK.test(o.slice(5));
  const bad = opts.find((o) => !/^playwright=\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(o) && !/^mem=\d{1,15}$/.test(o) && !/^arch=[\w-]{1,32}$/.test(o) && !needOk(o) && !whichOk(o) && !pathOk(o) && !toolOptOk(o) && !assetsOptOk(o) && o !== "back");
  if (bad !== undefined) return d.refuse(label, `unknown option "${bad}"`);
  const off = !ctx.q.exec ? "exec is off on this host (heavyQueue.exec)" : !Bun.which("bwrap") ? "no bwrap on this host" : (hostRefusal(ctx.q.kinds, kind, opts) ?? memRefusal(opts, ctx.deps.headroom?.free ?? 10));
  if (off) return d.refuse(label, off);
  const got = toolBundles(opts, d.tools.toolsDir);
  if ("why" in got) return d.refuse(label, got.why);
  const tools: BoxTools = { ...d.tools, bundles: got.bundles };
  const needs = opts.filter((o) => o.startsWith("need=")).map((o) => o.slice(5));
  const names = opts.filter((o) => o.startsWith("which=")).map((o) => o.slice(6));
  // the box is tried before every job: AppArmor kept bwrap from making it on the training sparks (2026-11-08)
  const absent = probeBox(kind, tools, needs, names, opts.find((o) => o.startsWith("path="))?.slice(5));
  if (absent && "failed" in absent) return d.refuse(label, needs.length || names.length ? `the check for the programs the job starts failed: ${absent.failed}` : `its box does not start on this host: ${absent.failed}`);
  if (absent) return d.refuse(label, needs.includes(absent.missing) ? `${absent.missing} is not on this host (the job's command or a link in its --sync paths starts it)` : `no ${absent.missing} on this host's box PATH (the job's command)`);
  const noScope = await canScope();
  if (noScope) return d.refuse(label, `no memory/CPU/time caps here: ${noScope}`);
  const playwright = opts.find((o) => o.startsWith("playwright="))?.slice("playwright=".length);
  const mem = Number(opts.find((o) => o.startsWith("mem="))?.slice(4)) || undefined;
  const below = Number(belowS);
  if (below < 100) {
    const b = await busyOf(ctx, kind);
    if (b >= below) {
      console.error(`WORKER_BUSY this host is ${b}% busy (${kind}), not under ${below}%`);
      return 75;
    }
  }
  const t = await admitOnce(ctx.deps, label, settleFor(kind), mem && mem / 1024);
  if (!t || !("slot" in t)) {
    console.error(`WORKER_BUSY ${t?.why ?? "another job is being admitted"}`);
    return 75;
  }
  const log = (l: string) => ctx.deps.log?.(l);
  log(`HEAVY_WORKER_ADMIT ${label} exec ${kind} ${basename(t.slot)} caller=${d.caller}: ${t.why}`);
  stopWithCaller(true);
  const dir = newJobDir(join(ctx.deps.dir, "exec"));
  const runId = markRun(dir, d.caller, label);
  const beat = heartbeat(ctx.q.aliveSec ?? 60);
  // the job's folder may hold read-only folders it was sent (tar -p keeps 0555): removeTree makes them writable first
  const forget = onStop(() => {
    removeTree(dir);
    releaseSlot(t.slot);
  });
  console.error(`WORKER_ADMIT ${basename(t.slot)} alive=${ctx.q.aliveSec ?? 60} run=${runId}`);
  const root = join(dir, "in");
  let cmdName = "-";
  let inBytes = 0;
  try {
    if (!(await unpackChecked(root, opts, log))) return 3;
    inBytes = duBytes(root);
    let raw: unknown = null;
    try {
      raw = JSON.parse(readFileSync(join(root, "job.json"), "utf8"));
    } catch {
      raw = null;
    }
    rmSync(join(root, "job.json"), { force: true });
    const spec = specProblem(raw);
    if (typeof spec === "string") {
      log(`HEAVY_EXEC_BAD ${label} caller=${d.caller}: ${spec}`);
      console.error(`WORKER_REFUSED ${spec}`);
      return 3;
    }
    cmdName = basename(spec.argv[0]!);
    for (const p of spec.sync) if (!existsSync(join(root, p))) mkdirSync(join(root, p), { recursive: true });
    beat.set("playwright");
    if (playwright && kind === "browser" && d.tools.browsersDir) await ensurePlaywright(playwright, d.tools.browsersDir, log);
    beat.set("run");
    const start = join(dir, "start");
    writeFileSync(start, "");
    const pumps: Promise<void>[] = [];
    const ncpu = Math.max(1, cpus().length);
    const code = await spawnScoped(
      { label, cmd: sandboxArgv(kind, spec, (p) => join(root, p), tools), free: ctx.deps.headroom?.free ?? 10, ...(mem ? { needBytes: mem } : {}), ...(kind === "gpu" ? { gpuFreeKb: ctx.deps.headroom?.gpuFreeKb ?? 0 } : {}), props: [`CPUQuota=${ncpu * 90}%`, `RuntimeMaxSec=${d.maxMin * 60}`], log },
      { cwd: dir, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      (_pid, proc) => {
        const pump = async (s: ReadableStream<Uint8Array> | undefined, tag: string) => {
          if (!s) return;
          for await (const l of linesOf(s)) process.stderr.write(`${tag} ${l}\n`);
        };
        pumps.push(pump(proc.stdout as ReadableStream<Uint8Array> | undefined, "O"), pump(proc.stderr as ReadableStream<Uint8Array> | undefined, "E"));
      },
    );
    await Promise.all(pumps);
    beat.set("back");
    // the files the run made or changed (regular files only), as tar on stdout
    const list = join(dir, "back.list");
    const found = Bun.spawnSync(["find", root, "-newer", start, "-type", "f", "-printf", "%P\\0"]);
    const files = found.stdout.toString().split("\0").filter(Boolean).map((n) => ({ path: `/${n}`, bytes: statSync(join(root, n), { throwIfNoEntry: false })?.size ?? 0 }));
    const pick = backPick(files, { cwd: spec.cwd, max: BACK_MAX_BYTES, ...(spec.back ? { globs: spec.back } : {}) });
    const tooBig = pick.left.length > 0;
    if (tooBig) console.error(`WORKER_BACK_TOO_BIG ${files.reduce((a, f) => a + f.bytes, 0)} bytes changed, over ${BACK_MAX_BYTES}; not sent back, and deleted with the run's folder here: ${pick.left.map((l) => `${l.dir} (${l.files} files, ${l.bytes} bytes)`).join(", ")}; the rest is sent back`);
    writeFileSync(list, pick.keep.map((p) => `${p.slice(1)}\0`).join(""));
    const tar = Bun.spawn(["tar", "-C", root, "--null", "--no-recursion", "-T", list, "-cf", "-"], { stdin: "ignore", stdout: "inherit", stderr: "pipe" });
    const tcode = await tar.exited;
    if (tcode !== 0) throw new TarError(`tar -c exited ${tcode}: ${(await new Response(tar.stderr).text()).trim().slice(0, 200)}`);
    console.error(`WORKER_EXIT ${code}`);
    log(`HEAVY_EXEC_DONE ${label} caller=${d.caller} cmd=${cmdName} in=${inBytes} back=${pick.bytes} exit=${code}`);
    return 0;
  } finally {
    beat.stop();
    const left = removeTree(dir);
    if (left) log(`HEAVY_EXEC_LEFT ${label} caller=${d.caller}: the run's folder ${dir} could not be removed (${left})`);
    releaseSlot(t.slot);
    forget();
  }
};
