import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

import type { HeavyHelper } from "./config.ts";
import { NESTED_ENV } from "./heavy-here.ts";
import { fmtMem, spawnScoped } from "./heavy-mem.ts";
import type { HeavyCtx } from "./heavy-queue.ts";
import { unsafeRemote } from "./heavy-route.ts";
import { admitOnce, releaseSlot } from "./heavy-slot.ts";
import { pathsIn, QUICK_SETTLE_SEC, spreadPlan, startExec, within, type Kind, type Plan, type SpreadJob } from "./heavy-spread.ts";
import { stopOnHelper } from "./heavy-stale.ts";

// dori heavy <label> --kind cpu|browser|gpu --sync PATH ... --items FILE [--mem-per-worker SIZE [--mem SIZE]] [--out DIR]
// -- <command with {item} and {n}>: one batch of items spread over this host and every helper at once (heavyQueue.helpers
// without batch: false). Owner 2026-11-14: "가용한 모든 리소스를 효율적으로 쓸수있게 해" - gongdori's E7 runs had used 0a83 alone
// with 1-3 workers while ori644d and ori4b69 sat idle, and one of them died at its 30G cap (HEAVY_OOM e2e-collection-supply18).
// Each item is one job of its own (its own scope, MemoryMax = --mem-per-worker): a host takes one more only while its own
// admission says it fits (CPU and memory headroom, the per-worker memory beside what its running jobs still claim, its
// own line of waiting jobs first), and never more than --mem / --mem-per-worker of them at once. A host short of memory
// starts no new item (HEAVY_BATCH_SHRINK); its running ones go on. An item whose helper dies or that is killed for memory
// runs once more on another host (HEAVY_BATCH_RETRY). Every item's stdout and stderr, and one receipt per item naming the
// host it ran on, land in one folder here (--out).

export type BatchJob = {
  readonly label: string; readonly kind: Kind; readonly cmd: readonly string[]; readonly cwd: string; readonly sync: readonly string[];
  readonly env: Readonly<Record<string, string>>; readonly items: readonly string[]; readonly out: string;
  readonly memPerWorker?: number; readonly memCap?: number; readonly tools?: readonly string[]; readonly back?: readonly string[];
};
type BatchTry = { readonly host: string; readonly result: string };
export type BatchReceipt = { readonly n: number; readonly item: string; readonly host: string; readonly exit: number | null; readonly tries: readonly BatchTry[]; readonly out: string; readonly err: string; readonly start: string; readonly end: string };

// a helper whose run broke off gets no new item for this long
const PAUSE_MS = 60_000;
// how long the batch waits for a running item before it asks the hosts again
const POLL_MS = 15_000;
const OOM = /^HEAVY_OOM \S+: killed at MemoryMax=/m;

type Host = { readonly name: string; readonly helper?: HeavyHelper; running: number; readonly cap: number; gone?: string; until: number; said: string };
type Item = { readonly n: number; readonly text: string; readonly job: SpreadJob; readonly remote: boolean; readonly tries: BatchTry[]; start?: string };
type Outcome = { readonly code: number | null; readonly result: string };
type Sink = { write(s: string | Uint8Array): unknown; close(): void };
type Offer = { readonly done: Promise<Outcome> } | { readonly kind: string; readonly why: string };

// the items of an --items file: one per line, blank lines and # lines skipped
export const readItems = (file: string): string[] => readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
const itemCmd = (cmd: readonly string[], text: string, n: number): string[] => cmd.map((a) => a.replaceAll("{item}", text).replaceAll("{n}", String(n)));

const fileSink = (path: string, watch?: (s: string) => void): Sink => {
  const fd = openSync(path, "w");
  let open = true;
  return {
    write: (s) => {
      if (!open) return 0;
      if (typeof s !== "string") return writeSync(fd, s);
      watch?.(s);
      return writeSync(fd, s);
    },
    close: () => {
      if (open) closeSync(fd);
      open = false;
    },
  };
};

const pump = async (s: ReadableStream<Uint8Array> | undefined, sink: Sink): Promise<void> => {
  if (s) for await (const c of s) sink.write(c);
};

// one item on this host: a slot only if this host's admission takes it now (jobs waiting in its own line go first)
const offerHere = async (ctx: HeavyCtx, b: BatchJob, it: Item, out: Sink, err: Sink, oom: () => void): Promise<Offer> => {
  const t = await admitOnce(ctx.deps, it.job.label, QUICK_SETTLE_SEC, b.memPerWorker && b.memPerWorker / 1024);
  if (!t || !("slot" in t)) return { kind: "busy", why: t?.why ?? "another job is being admitted" };
  const log = (l: string): void => {
    if (OOM.test(l)) oom();
    ctx.deps.log?.(l);
  };
  const done = (async (): Promise<Outcome> => {
    try {
      const pumps: Promise<void>[] = [];
      const run = { label: it.job.label, cmd: it.job.cmd, free: ctx.deps.headroom?.free ?? 10, log, ...(b.memPerWorker ? { needBytes: b.memPerWorker } : {}) };
      const code = await spawnScoped(run, { cwd: it.job.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, ...it.job.env, [NESTED_ENV]: it.job.label } }, (_pid, p) => {
        pumps.push(pump(p.stdout as ReadableStream<Uint8Array>, out), pump(p.stderr as ReadableStream<Uint8Array>, err));
      });
      await Promise.all(pumps);
      return { code, result: `exit ${code}` };
    } finally {
      releaseSlot(t.slot);
    }
  })();
  return { done };
};

// one item on a helper (heavy-spread.ts startExec), its lines into the item's own files; a stale run is ended there
const offerHelper = async (ctx: HeavyCtx, h: HeavyHelper, it: Item, plan: Extract<Plan, { ok: true }>, out: Sink, err: Sink): Promise<Offer> => {
  const job = { ...it.job, out, err };
  const t = unsafeRemote(job, plan) ?? (await startExec(ctx, h, job, plan, 100));
  if (t.kind !== "started") return t;
  const done = t.run.done.then(async (code): Promise<Outcome> => {
    if (code === null) return { code: null, result: "cut" };
    if (typeof code === "number") return { code, result: `exit ${code}` };
    await stopOnHelper(h, it.job.label, (l) => ctx.deps.log?.(l), t.run.id, 30_000);
    return { code: null, result: `stale: ${code.stale}` };
  });
  return { done };
};

export const heavyBatch = async (ctx: HeavyCtx, b: BatchJob, who = { uid: process.getuid?.() ?? -1, home: homedir() }): Promise<number> => {
  const log = (l: string): void => ctx.deps.log?.(l);
  const now = (): number => ctx.deps.clock.now();
  const iso = (): string => new Date(now()).toISOString();
  mkdirSync(join(b.out, "items"), { recursive: true });
  const receipts = join(b.out, "receipts.jsonl");
  writeFileSync(receipts, "");
  const jobOf = (text: string, n: number): SpreadJob => ({ label: `${b.label}.${n}`, kind: b.kind, cmd: itemCmd(b.cmd, text, n), cwd: b.cwd, sync: b.sync, env: { ...b.env, DORI_HEAVY_ITEM: text, DORI_HEAVY_ITEM_N: String(n) }, ...(b.memPerWorker ? { needBytes: b.memPerWorker } : {}), ...(b.tools?.length ? { tools: b.tools } : {}), ...(b.back?.length ? { back: b.back } : {}) });
  // what can go to a helper is weighed once, on the first item; another item's own paths must lie in the --sync paths too
  const plan = spreadPlan(jobOf(b.items[0] ?? "", 1), who);
  if (!plan.ok) log(`HEAVY_LOCAL ${b.label}: ${plan.why}; every item runs here`);
  const pending: Item[] = b.items.map((text, i) => ({ n: i + 1, text, job: jobOf(text, i + 1), remote: plan.ok && pathsIn(text).every((p) => plan.sync.some((s) => within(p, s))), tries: [] }));
  const cap = b.memPerWorker && b.memCap ? Math.max(1, Math.floor(b.memCap / b.memPerWorker)) : Infinity;
  const helpers = plan.ok ? ctx.q.helpers.filter((h) => h.batch !== false) : [];
  const hosts: Host[] = [...helpers.map((h) => ({ name: h.name, helper: h })), { name: hostname() }].map((h) => ({ ...h, running: 0, cap, until: 0, said: "" }));
  log(`HEAVY_BATCH ${b.label}: ${pending.length} item(s) over ${hosts.map((h) => h.name).join(", ")}; out ${b.out}`);
  if (cap !== Infinity) for (const h of hosts) log(`HEAVY_BATCH_HOST ${b.label} ${h.name}: up to ${cap} worker(s) at once (--mem ${fmtMem(b.memCap!)} / --mem-per-worker ${fmtMem(b.memPerWorker!)})`);
  const running = new Map<Item, Promise<void>>();
  const perHost: Record<string, number> = {};
  let ok = 0;
  let failed = 0;
  let retried = 0;
  const fits = (h: Host, it: Item): boolean => !h.gone && (h.helper === undefined || it.remote);
  // an item that failed on a host goes elsewhere, unless no other host can take it at all
  const pick = (h: Host): Item | undefined => pending.find((it) => fits(h, it) && (!it.tries.some((t) => t.host === h.name) || !hosts.some((o) => o !== h && fits(o, it) && !it.tries.some((t) => t.host === o.name))));
  const note = (h: Host, kind: string, why: string): void => {
    if (kind === "refused" || kind === "old" || kind === "notools") {
      h.gone = why;
      log(`HEAVY_BATCH_GONE ${b.label} ${h.name}: ${why}`);
      return;
    }
    if (kind === "down") h.until = now() + PAUSE_MS;
    const key = why.startsWith("memory:") ? "memory" : kind;
    if (key === h.said) return;
    h.said = key;
    if (key === "memory" && h.running > 0) log(`HEAVY_BATCH_SHRINK ${b.label} ${h.name}: ${why}; its ${h.running} running there go on, no new one starts there until memory frees`);
    else log(`HEAVY_BATCH_WAIT ${b.label} ${h.name}: ${kind}: ${why}`);
  };
  const finish = (h: Host, it: Item, o: Outcome, oom: boolean, files: { out: string; err: string }): void => {
    const result = oom ? "oom" : o.result;
    it.tries.push({ host: h.name, result });
    if (o.code === null && h.helper) h.until = now() + PAUSE_MS;
    if ((o.code === null || oom) && it.tries.length < 2) {
      retried++;
      log(`HEAVY_BATCH_RETRY ${b.label} #${it.n} ${h.name}: ${result}; once more on another host`);
      pending.unshift(it);
      return;
    }
    const good = o.code === 0 && !oom;
    if (good) ok++;
    else failed++;
    perHost[h.name] = (perHost[h.name] ?? 0) + 1;
    const r: BatchReceipt = { n: it.n, item: it.text, host: h.name, exit: oom ? (o.code ?? null) : o.code, tries: it.tries, ...files, start: it.start ?? iso(), end: iso() };
    appendFileSync(receipts, `${JSON.stringify(r)}\n`);
    log(`HEAVY_BATCH_ITEM ${b.label} #${it.n} ${h.name}: ${result}`);
  };
  const tryOne = async (h: Host): Promise<boolean> => {
    if (h.gone || h.running >= h.cap || now() < h.until) return false;
    const it = pick(h);
    if (!it) return false;
    const k = it.tries.length + 1;
    const files = { out: join(b.out, "items", `${it.n}.${k}.out`), err: join(b.out, "items", `${it.n}.${k}.err`) };
    let oom = false;
    const out = fileSink(files.out);
    const err = fileSink(files.err, (s) => {
      if (OOM.test(s)) oom = true;
    });
    const t = h.helper ? await offerHelper(ctx, h.helper, it, plan as Extract<Plan, { ok: true }>, out, err) : await offerHere(ctx, b, it, out, err, () => (oom = true));
    if (!("done" in t)) {
      out.close();
      err.close();
      rmSync(files.out, { force: true });
      rmSync(files.err, { force: true });
      note(h, t.kind, t.why);
      return false;
    }
    h.running++;
    h.said = "";
    pending.splice(pending.indexOf(it), 1);
    it.start ??= iso();
    log(`HEAVY_BATCH_START ${b.label} #${it.n} ${h.name}${k > 1 ? ` (try ${k})` : ""}`);
    const p = t.done
      .catch((e: unknown): Outcome => ({ code: null, result: `cut: ${String(e).slice(0, 200)}` }))
      .then((o) => {
        out.close();
        err.close();
        h.running--;
        running.delete(it);
        finish(h, it, o, oom, files);
      });
    running.set(it, p);
    return true;
  };
  while (pending.length || running.size) {
    // one item per host per round, the host with the fewest running first, until no host takes one
    for (let placed = true; placed; ) {
      placed = false;
      for (const h of [...hosts].sort((x, y) => x.running - y.running)) if (pending.length && (await tryOne(h))) placed = true;
    }
    if (!pending.length && !running.size) break;
    await Promise.race([...running.values(), ctx.deps.clock.sleep(POLL_MS)]);
  }
  writeFileSync(join(b.out, "summary.json"), `${JSON.stringify({ label: b.label, items: b.items.length, ok, failed, retried, hosts: perHost }, null, 1)}\n`);
  log(`HEAVY_BATCH_DONE ${b.label}: ${ok}/${b.items.length} items exit 0${failed ? `, ${failed} failed` : ""}; ${Object.entries(perHost).map(([n, c]) => `${n} ${c}`).join(", ")}; ${retried} retried; receipts ${receipts}`);
  return failed ? 1 : 0;
};
