import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

import type { HeavyHelper } from "./config.ts";
import { stager } from "./heavy-assets.ts";
import { allowedHost, refusal, shipItems } from "./heavy-batch-check.ts";
import { ownerTakes, ownerWords } from "./heavy-owner-pc.ts";
import { fileSink, pump, watched, type Sink } from "./heavy-batch-sink.ts";
import { NESTED_ENV } from "./heavy-here.ts";
import { fmtMem, spawnScoped } from "./heavy-mem.ts";
import type { HeavyCtx } from "./heavy-queue.ts";
import { unsafeRemote } from "./heavy-route.ts";
import { admitOnce, releaseSlot } from "./heavy-slot.ts";
import { setSlotTree } from "./heavy-slot-store.ts";
import { QUICK_SETTLE_SEC, startExec, withPipefail, type Kind, type Plan, type SpreadJob } from "./heavy-spread.ts";
import { logShip } from "./heavy-ship.ts";
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
// host it ran on, land in one folder here (--out), outside the --sync paths so no upload carries them. Each host is offered one item at a time and on its own, so a helper slow to answer (an ssh that hangs up to staleMin) holds back only itself; an item being offered is out of the line meanwhile and comes back to its front when refused.

export type BatchJob = {
  readonly label: string; readonly kind: Kind; readonly cmd: readonly string[]; readonly cwd: string; readonly sync: readonly string[];
  readonly env: Readonly<Record<string, string>>; readonly items: readonly string[]; readonly out: string;
  readonly memPerWorker?: number; readonly memCap?: number; readonly tools?: readonly string[]; readonly back?: readonly string[];
  // this host's environment for its items (dori heavy --tools: a tool installed off PATH first on it, heavy-tools.ts toolsHere)
  readonly hereEnv?: Readonly<Record<string, string | undefined>>;
  readonly onHosts?: readonly string[]; readonly notOn?: readonly string[]; // --on / --not-on (heavy-batch-check.ts allowedHost)
  readonly ship?: { readonly noShip: readonly string[]; readonly maxBytes: number; readonly heavyLog: string }; // an item's folder or file outside --sync goes along within these, else no item runs (heavy-ship.ts); absent: --local, or no helper
};
type BatchTry = { readonly host: string; readonly result: string }; type Refusal = { readonly host: string; readonly why: string };
// assets: the sha256 of the --sync archive a helper ran it on, one for the whole batch (heavy-assets.ts)
export type BatchReceipt = { readonly n: number; readonly item: string; readonly host: string; readonly exit: number | null; readonly tries: readonly BatchTry[]; readonly refused?: readonly Refusal[]; readonly out: string; readonly err: string; readonly start: string; readonly end: string; readonly assets?: string };

// a helper whose run broke off, or that did not answer, gets no new item for this long
const PAUSE_MS = 60_000;
const POLL_MS = 15_000; // how long a host that turned an item away waits before it is offered one again
export const RETRY_WAIT_MS = 10 * 60_000; // how long a retry waits for another host (busy, full or still answering) before it may go back to the one it failed on
// an item was killed for memory only when its runner says so for its own label (this host's spawnScoped log, a helper's own line, never the command's E lines)
const oomOf = (label: string) => (l: string): boolean => l.startsWith(`HEAVY_OOM ${label}: killed at MemoryMax=`);

type Host = { readonly name: string; readonly helper?: HeavyHelper; running: number; readonly cap: number; gone?: string; until: number; next: number; busy: boolean; offering: boolean; said: string };
type Item = { readonly n: number; readonly text: string; readonly job: SpreadJob; readonly plan: Plan; readonly tries: BatchTry[]; readonly refused: Refusal[]; start?: string; failedAt?: number };
type Outcome = { readonly code: number | null; readonly result: string; readonly assets?: string };
type Offer = { readonly done: Promise<Outcome> } | { readonly kind: string; readonly why: string };

// the items of an --items file: one per line, blank lines and # lines skipped
export const readItems = (file: string): string[] => readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
// {item} and {n} in one pass, the item's text as it is ($& or a {n} in it stays literal)
export const itemCmd = (cmd: readonly string[], text: string, n: number): string[] => cmd.map((a) => a.replace(/\{(item|n)\}/g, (_, k: string) => (k === "item" ? text : String(n))));
// where a batch's files go by default: outside every --sync path, so an upload never carries them
export const defaultOut = (label: string, now: number): string => join(homedir(), "dori-heavy-batches", `${label}-${new Date(now).toISOString().replace(/[:.]/g, "-")}`);

// one item on this host: a slot only if this host's admission takes it now (jobs waiting in its own line go first), held by the batch until the item ran and drained, measured by the item's own process tree (heavy-slot-store.ts setSlotTree); its environment is this host's as for a single job here (the --tools PATH, not the --env copies a helper gets); a GPU item settles and gets its room as a GPU job does
const offerHere = async (ctx: HeavyCtx, b: BatchJob, it: Item, out: Sink, err: Sink, oom: () => void): Promise<Offer> => {
  const t = await admitOnce(ctx.deps, it.job.label, b.kind === "gpu" ? undefined : QUICK_SETTLE_SEC, b.memPerWorker && b.memPerWorker / 1024);
  if (!t || !("slot" in t)) return { kind: "busy", why: t?.why ?? "another job is being admitted" };
  const log = (l: string): void => {
    if (oomOf(it.job.label)(l)) oom();
    ctx.deps.log?.(l);
  };
  const done = (async (): Promise<Outcome> => {
    try {
      const pumps: Promise<void>[] = [];
      const gpu = b.kind === "gpu" ? { gpuFreeKb: ctx.deps.headroom?.gpuFreeKb ?? 0 } : {};
      const run = { label: it.job.label, cmd: it.job.cmd, free: ctx.deps.headroom?.free ?? 10, log, ...gpu, ...(b.memPerWorker ? { needBytes: b.memPerWorker } : {}) };
      const code = await spawnScoped(run, { cwd: it.job.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...(b.hereEnv ?? process.env), DORI_HEAVY_ITEM: it.text, DORI_HEAVY_ITEM_N: String(it.n), [NESTED_ENV]: it.job.label } }, (pid, p) => {
        setSlotTree(t.slot, pid);
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

// one item on a helper (heavy-spread.ts startExec), its lines into the item's own files; a stale run is ended there, and abandon says it left something running (heavy-stale.ts), so the CLI exits once the batch is done, as heavySpread's caller does
const offerHelper = async (ctx: HeavyCtx, h: HeavyHelper, it: Item, plan: Extract<Plan, { ok: true }>, out: Sink, err: Sink, abandon: () => void, oom: () => void): Promise<Offer> => {
  const job = { ...it.job, out, err, runner: watched(err, (l) => oomOf(it.job.label)(l) && oom()), ...(h.owner ? { helperWords: ownerWords(h.owner) } : {}) };
  const t = unsafeRemote(job, plan) ?? (await startExec(ctx, h, job, plan, 100));
  if (t.kind !== "started") return t;
  const done = t.run.done.then(async (code): Promise<Outcome> => {
    if (code === null) return { code: null, result: "cut" };
    if (typeof code === "number") return { code, result: `exit ${code}` };
    if ((await stopOnHelper(h, it.job.label, (l) => ctx.deps.log?.(l), t.run.id, 30_000)) || code.abandoned) abandon();
    return { code: null, result: `stale: ${code.stale}` };
  }).then((o) => (t.run.assets ? { ...o, assets: t.run.assets } : o));
  return { done };
};

export const heavyBatch = async (ctx: HeavyCtx, b: BatchJob, who: { readonly uid: number; readonly home: string; readonly path?: string } = { uid: process.getuid?.() ?? -1, home: homedir() }): Promise<{ readonly code: number; readonly abandoned: boolean }> => {
  let abandoned = false;
  const log = (l: string): void => ctx.deps.log?.(l);
  const now = (): number => ctx.deps.clock.now();
  const iso = (): string => new Date(now()).toISOString();
  // the --sync paths archived once for the whole batch, so every helper gets the same bytes (lead's condition 1 of #477 H334)
  const assets = stager(join(ctx.deps.dir, "assets"), b.label, log, b.ship?.noShip);
  const jobOf = (text: string, n: number): SpreadJob => ({ assets, label: `${b.label}.${n}`, kind: b.kind, cmd: withPipefail(itemCmd(b.cmd, text, n)), cwd: b.cwd, sync: b.sync, env: { ...b.env, DORI_HEAVY_ITEM: text, DORI_HEAVY_ITEM_N: String(n) }, ...(b.memPerWorker ? { needBytes: b.memPerWorker } : {}), ...(b.tools?.length ? { tools: b.tools } : {}), ...(b.back?.length ? { back: b.back } : {}) });
  // each item a single job of its own (its pipefail and plan, as GNU parallel builds each command line apart), one --sync for all (heavy-batch-check.ts shipItems)
  const { items: prepared, stops, shipped } = shipItems(b, b.items.map((text, i) => jobOf(text, i + 1)), who);
  const pending: Item[] = prepared.map(({ job, plan }, i) => ({ n: i + 1, text: b.items[i]!, job, plan, tries: [], refused: [] }));
  if (stops.length) {
    log(`HEAVY_LOCAL_REFUSED ${b.label}: ${stops.length} item(s) would run here, ${stops[0]}; no item ran (--local runs them on this host)`);
    return { code: 2, abandoned };
  }
  const usable = [...ctx.q.helpers.filter((h) => h.batch !== false && ownerTakes(h.owner, b.kind)).map((h) => h.name), hostname()].filter((n) => allowedHost(b, n));
  const why = refusal(b, pending.map((it) => it.plan), { known: [...ctx.q.helpers.map((h) => h.name), hostname()], usable, here: hostname() });
  if (why) {
    log(`HEAVY_BATCH_REFUSED ${b.label}: ${why}`);
    return { code: 2, abandoned };
  }
  if (b.ship && shipped.size) logShip(b.ship.heavyLog, b.label, { shipped: [...shipped.keys()], files: [...shipped.values()].flat() }, log);
  for (const w of new Set(pending.flatMap((it) => (it.plan.ok ? [] : [it.plan.why])))) log(`HEAVY_LOCAL ${b.label}: ${w}; ${pending.filter((it) => !it.plan.ok && it.plan.why === w).length} item(s) run here`);
  mkdirSync(join(b.out, "items"), { recursive: true });
  const receipts = join(b.out, "receipts.jsonl");
  writeFileSync(receipts, "");
  const cap = b.memPerWorker && b.memCap ? Math.floor(b.memCap / b.memPerWorker) : Infinity;
  const helpers = pending.some((it) => it.plan.ok) ? ctx.q.helpers.filter((h) => h.batch !== false && usable.includes(h.name)) : [];
  const hosts: Host[] = [...helpers.map((h) => ({ name: h.name, helper: h })), ...(usable.includes(hostname()) ? [{ name: hostname() }] : [])].map((h) => ({ ...h, running: 0, cap, until: 0, next: 0, busy: false, offering: false, said: "" }));
  log(`HEAVY_BATCH ${b.label}: ${pending.length} item(s) over ${hosts.map((h) => h.name).join(", ")}; out ${b.out}`);
  if (cap !== Infinity) for (const h of hosts) log(`HEAVY_BATCH_HOST ${b.label} ${h.name}: up to ${cap} worker(s) at once (--mem ${fmtMem(b.memCap!)} / --mem-per-worker ${fmtMem(b.memPerWorker!)})`);
  const running = new Map<Item, Promise<void>>();
  const offers = new Set<Promise<void>>();
  const perHost: Record<string, number> = {};
  let ok = 0;
  let failed = 0;
  let retried = 0;
  // a helper leaves the batch only for what holds for every item (old, notools: the batch's --tools); one item's refusal (a program it lacks, an unsafe word) bars only that item from it
  const fits = (h: Host, it: Item): boolean => !h.gone && (h.helper === undefined || it.plan.ok) && !it.refused.some((r) => r.host === h.name);
  const tried = (it: Item, h: Host): boolean => it.tries.some((t) => t.host === h.name);
  // its one retry goes elsewhere (the brief: "다른 곳에서 다시(한 번)"): it waits for another host that may still take it, busy, full or answering an offer now, and goes back to the one it failed on only once every other is gone or paused, or RETRY_WAIT_MS passed
  const elsewhere = (it: Item, h: Host): boolean => hosts.some((o) => o !== h && fits(o, it) && !tried(it, o) && now() >= o.until);
  const pick = (h: Host): Item | undefined => pending.find((it) => fits(h, it) && (!tried(it, h) || !elsewhere(it, h) || now() - (it.failedAt ?? 0) >= RETRY_WAIT_MS));
  const note = (h: Host, kind: string, why: string): void => {
    if (kind === "old" || kind === "notools") {
      h.gone = why;
      log(`HEAVY_BATCH_GONE ${b.label} ${h.name}: ${why}`);
      return;
    }
    if (kind === "down") h.until = now() + PAUSE_MS;
    h.busy = kind === "busy";
    h.next = now() + POLL_MS;
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
      it.failedAt = now();
      pending.unshift(it);
      return;
    }
    if (o.code === 0 && !oom) ok++;
    else failed++;
    perHost[h.name] = (perHost[h.name] ?? 0) + 1;
    const r: BatchReceipt = { n: it.n, item: it.text, host: h.name, exit: o.code, tries: it.tries, ...(it.refused.length ? { refused: it.refused } : {}), ...files, start: it.start ?? iso(), end: iso(), ...(o.assets ? { assets: o.assets } : {}) };
    appendFileSync(receipts, `${JSON.stringify(r)}\n`);
    log(`HEAVY_BATCH_ITEM ${b.label} #${it.n} ${h.name}: ${result}`);
  };
  // an item no host left to the batch may take (each refused it, or left the batch) ends failed instead of waiting for ever (review 1 of #479)
  const stuck = (it: Item): void => {
    pending.splice(pending.indexOf(it), 1);
    failed++;
    const why = [...it.refused.map((r) => `${r.host} refused it (${r.why})`), ...hosts.filter((h) => h.gone).map((h) => `${h.name} left the batch (${h.gone})`)].join(", ");
    appendFileSync(receipts, `${JSON.stringify({ n: it.n, item: it.text, host: "-", exit: null, tries: it.tries, refused: it.refused, out: "", err: "", start: it.start ?? iso(), end: iso() } satisfies BatchReceipt)}\n`);
    log(`HEAVY_BATCH_ITEM ${b.label} #${it.n} -: no host left: ${why}`);
  };
  const offer = async (h: Host, it: Item): Promise<void> => {
    const k = it.tries.length + 1;
    const files = { out: join(b.out, "items", `${it.n}.${k}.out`), err: join(b.out, "items", `${it.n}.${k}.err`) };
    let oom = false;
    const out = fileSink(files.out);
    const err = fileSink(files.err);
    const t = h.helper ? await offerHelper(ctx, h.helper, it, it.plan as Extract<Plan, { ok: true }>, out, err, () => (abandoned = true), () => (oom = true)) : await offerHere(ctx, b, it, out, err, () => (oom = true));
    if (!("done" in t)) {
      out.close();
      err.close();
      rmSync(files.out, { force: true });
      rmSync(files.err, { force: true });
      pending.unshift(it);
      if (t.kind !== "refused") return note(h, t.kind, t.why);
      it.refused.push({ host: h.name, why: t.why });
      log(`HEAVY_BATCH_ITEM_REFUSED ${b.label} #${it.n} ${h.name}: ${t.why}; it goes to another host, ${h.name} stays in the batch`);
      return;
    }
    h.running++;
    h.busy = false;
    h.said = "";
    it.start ??= iso();
    log(`HEAVY_BATCH_START ${b.label} #${it.n} ${h.name}${k > 1 ? ` (try ${k})` : ""}`);
    const p = t.done
      .catch((e: unknown): Outcome => ({ code: null, result: `cut: ${String(e).slice(0, 200)}` }))
      .then((o) => {
        out.close();
        err.close();
        h.running--;
        Object.assign(h, { next: 0, busy: false }); // a slot there just freed: offer it the next item now
        running.delete(it);
        finish(h, it, o, oom, files);
      });
    running.set(it, p);
  };
  // every host not offering, not full and not waiting is offered the next item it may take, the one with the fewest running first
  const kick = (): void => {
    for (const h of [...hosts].sort((x, y) => x.running - y.running)) {
      if (h.offering || h.gone || h.running >= h.cap || now() < h.next || now() < h.until) continue;
      const it = pick(h);
      if (!it) continue;
      pending.splice(pending.indexOf(it), 1);
      h.offering = true;
      const p: Promise<void> = offer(h, it).finally(() => {
        h.offering = false;
        offers.delete(p);
      });
      offers.add(p);
    }
  };
  try {
    for (;;) {
      kick();
      for (const it of pending.filter((x) => !hosts.some((h) => fits(h, x)))) stuck(it);
      if (!pending.length && !running.size && !offers.size) break;
      await Promise.race([...running.values(), ...offers, ctx.deps.clock.sleep(POLL_MS)]);
    }
  } finally {
    assets.drop();
  }
  writeFileSync(join(b.out, "summary.json"), `${JSON.stringify({ label: b.label, items: b.items.length, ok, failed, retried, hosts: perHost }, null, 1)}\n`);
  log(`HEAVY_BATCH_DONE ${b.label}: ${ok}/${b.items.length} items exit 0${failed ? `, ${failed} failed` : ""}; ${Object.entries(perHost).map(([n, c]) => `${n} ${c}`).join(", ")}; ${retried} retried; receipts ${receipts}`);
  return { code: failed ? 1 : 0, abandoned };
};
