import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import type { HeavyHelper, HeavyQueue } from "../src/config.ts";
import { heavyBatch, itemCmd, type BatchJob, type BatchReceipt } from "../src/heavy-batch.ts";
import type { HeavyCtx } from "../src/heavy-queue.ts";
import type { SlotDeps } from "../src/heavy-slot.ts";
import { withState } from "./fakes.ts";

// dori heavy <label> --items FILE: the items of one batch spread over this host and the helpers. Real helpers are the real
// CLI (`dori heavy-worker`) behind an argv that stands in for ssh, as in heavy-spread.test.ts; a helper that dies or
// whose item is killed for memory is a script speaking the worker's lines.
const CLI = join(import.meta.dir, "../src/cli.ts");
const HOLDER = 4243;
let state: ReturnType<typeof withState>;
let logs: string[];
let work: string;

const realHelper = (name: string, slots = 3): HeavyHelper => {
  const dir = join(state.dir, name);
  mkdirSync(dir, { recursive: true });
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ stateDir: join(dir, "state"), heavyHoldDir: join(dir, "hold"), heavySlots: slots, heavyMaxLoad: 1e9, heavyQueue: { exec: true, execMaxMin: 5, jobDir: join(dir, "jobs") } }));
  const own = Object.entries(process.env).map(([k, v]) => `${k}=${v}`);
  return { name, ssh: ["env", "-i", ...own, `DORI_CONFIG=${config}`, `DORI_ENV_FILE=${join(dir, "none.env")}`, process.execPath, CLI, "heavy-worker", "--caller", "tester"] };
};

// a helper that speaks the worker's lines: script reads the upload (cat), then says what it says
const fakeHelper = (name: string, script: string): HeavyHelper => {
  const f = join(state.dir, `${name}.sh`);
  writeFileSync(f, `#!/bin/sh\n${script}\n`);
  chmodSync(f, 0o755);
  return { name, ssh: [f] };
};

// here: this host's slots; full: slot.1 held by another job, so no item runs here
// skip: each sleep of the batch moves the clock on by all it asked for, so a 15 s wait for a busy host takes 50 ms
const ctxWith = (helpers: HeavyHelper[], full = true, staleMin?: number, skip = false): HeavyCtx => {
  let ahead = 0;
  const usage = async () => ({ host: { gpu: null, gpuMem: null, cpu: 0, mem: 10 }, unified: false, jobs: [], memTotalKb: 1e8 });
  if (full) {
    mkdirSync(join(state.dir, "heavy", "slot.1"), { recursive: true });
    writeFileSync(join(state.dir, "heavy", "slot.1", "owner"), `${HOLDER} other-job ${new Date().toISOString()}`);
  }
  const deps: SlotDeps = { dir: join(state.dir, "heavy"), slots: 1, maxLoad: 80, clock: { now: () => Date.now() + ahead, sleep: (ms) => {
        if (skip) ahead += ms;
        return Bun.sleep(Math.min(ms, 50));
      } }, pid: process.pid, load: async () => 10, alive: (p) => p === HOLDER || p === process.pid, headroom: { maxSlots: 1, free: 10, settleSec: 0, usage }, log: (l) => logs.push(l) };
  return { q: { jobs: {}, helpers, queue: [], rl: true, jobDir: join(state.dir, "jobs"), exec: false, execMaxMin: 240, ...(staleMin ? { staleMin } : {}) } satisfies HeavyQueue, deps };
};

const batchOf = (items: string[], cmd: string[], extra: Partial<BatchJob> = {}): BatchJob => ({ label: "b", kind: "cpu", cmd, cwd: work, sync: [work], env: {}, items, out: join(state.dir, "out"), ...extra });
const receipts = (): BatchReceipt[] => readFileSync(join(state.dir, "out", "receipts.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as BatchReceipt);
const outOf = (r: BatchReceipt): string => readFileSync(r.out, "utf8");

beforeEach(() => {
  state = withState();
  logs = [];
  work = join(state.dir, "work");
  mkdirSync(work);
});
afterEach(() => state.done());

test("every item of the batch runs once, on this host or a helper, and its output and the host it ran on come back to one folder", async () => {
  const items = ["a", "b", "c", "d", "e", "f"];
  const code = await heavyBatch(ctxWith([realHelper("h1"), realHelper("h2")], false), batchOf(items, ["sh", "-c", "echo item=$0 n=$DORI_HEAVY_ITEM_N; echo made > out-$0.txt", "{item}"]));
  expect(code).toBe(0);
  const rs = receipts();
  expect(rs.map((r) => r.item).sort()).toEqual(items);
  for (const r of rs) {
    expect(r.exit).toBe(0);
    expect(outOf(r)).toBe(`item=${r.item} n=${r.n}\n`);
    expect(readFileSync(join(work, `out-${r.item}.txt`), "utf8")).toBe("made\n");
  }
  // all three hosts took items: this host's one slot, and each helper's three
  expect(new Set(rs.map((r) => r.host))).toEqual(new Set([hostname(), "h1", "h2"]));
  expect(JSON.parse(readFileSync(join(state.dir, "out", "summary.json"), "utf8"))).toMatchObject({ items: 6, ok: 6, failed: 0 });
  expect(logs.some((l) => l.startsWith("HEAVY_BATCH_DONE b: 6/6 items exit 0"))).toBe(true);
});

const fresh = (): void => {
  logs = [];
  state.done();
  state = withState();
  work = join(state.dir, "work");
  mkdirSync(work);
};

test("an item whose helper dies, or that is killed for memory, runs once more on another host; a second failure is final", async () => {
  const fails = { cut: 'echo "WORKER_ADMIT slot.1 alive=60 run=1-x" >&2; cat >/dev/null; exit 255', oom: 'echo "WORKER_ADMIT slot.1 alive=60 run=1-x" >&2; cat >/dev/null; echo "HEAVY_OOM b.1: killed at MemoryMax=1.0G" >&2; echo "WORKER_EXIT 137" >&2; tar -cf - -T /dev/null' };
  for (const [result, script] of Object.entries(fails)) {
    fresh();
    // the failing helper is first in line, so the item goes there first
    const code = await heavyBatch(ctxWith([fakeHelper("bad", script), realHelper("ok")]), batchOf(["x"], ["sh", "-c", "echo ran $0", "{item}"]));
    expect(code).toBe(0);
    expect(receipts()).toMatchObject([{ item: "x", host: "ok", exit: 0, tries: [{ host: "bad", result }, { host: "ok", result: "exit 0" }] }]);
    expect(logs.some((l) => l.startsWith("HEAVY_BATCH_RETRY b #1 bad: "))).toBe(true);
  }
  // only failing hosts: the item tries twice and ends failed
  fresh();
  const again = await heavyBatch(ctxWith([fakeHelper("dead", 'echo "WORKER_ADMIT slot.1" >&2; cat >/dev/null; exit 255'), fakeHelper("dead2", 'echo "WORKER_ADMIT slot.1" >&2; cat >/dev/null; exit 255')]), batchOf(["z"], ["true"]));
  expect(again).toBe(1);
  expect(receipts()).toMatchObject([{ item: "z", exit: null, tries: [{ result: "cut" }, { result: "cut" }] }]);
});

test("--mem over --mem-per-worker caps the items running at once on each host; a host short of memory starts no new one while its own go on", async () => {
  // admits one item, then answers that memory is short while that one still runs
  const tight = fakeHelper("tight", `if mkdir ${join(state.dir, "tight.lock")} 2>/dev/null; then echo "WORKER_ADMIT slot.1" >&2; cat >/dev/null; sleep 1; echo "O ran on tight" >&2; echo "WORKER_EXIT 0" >&2; tar -cf - -T /dev/null; else echo "WORKER_BUSY memory: needs 15.0G, 20.0G available -> 4% free (needs 10% free)" >&2; exit 75; fi`);
  const capped = realHelper("capped", 4);
  const code = await heavyBatch(ctxWith([tight, capped]), batchOf(["1", "2", "3", "4", "5"], ["sh", "-c", "date +%s%N; sleep 0.4; date +%s%N"], { memPerWorker: 1024 ** 3, memCap: 2 * 1024 ** 3 }));
  expect(code).toBe(0);
  expect(logs).toContain("HEAVY_BATCH_HOST b capped: up to 2 worker(s) at once (--mem 2.0G / --mem-per-worker 1.0G)");
  expect(logs.some((l) => l.startsWith("HEAVY_BATCH_SHRINK b tight: memory: needs 15.0G") && l.includes("1 running there go on"))).toBe(true);
  // capped (four slots of its own) ran two at once, never three
  const spans = receipts().filter((r) => r.host === "capped").map((r) => outOf(r).trim().split("\n").map(Number) as [number, number]);
  expect(spans.length).toBe(4);
  const most = Math.max(...spans.map(([at]) => spans.filter(([s, e]) => s <= at && at < e).length));
  expect(most).toBe(2);
});

test("an item here runs in a slot its own process owns, so admission measures that item and not the whole batch (review 1 of #476)", async () => {
  const code = await heavyBatch(ctxWith([], false), batchOf(["a", "b"], ["sh", "-c", `echo pid=$$; cat ${join(state.dir, "heavy")}/slot.*/owner`]));
  expect(code).toBe(0);
  for (const r of receipts()) {
    const [first = "", owner = ""] = outOf(r).trim().split("\n");
    expect(owner.startsWith(`${first.slice(4)} b.${r.n} `)).toBe(true);
  }
});

test("a helper that does not answer holds back only itself: the other hosts run the items meanwhile (review 1 of #476)", async () => {
  const hang = fakeHelper("hang", "sleep 30");
  const code = await heavyBatch(ctxWith([hang, realHelper("ok")], true, 0.05), batchOf(["1", "2", "3"], ["true"]));
  expect(code).toBe(0);
  expect(receipts().every((r) => r.host === "ok")).toBe(true);
  const down = logs.findIndex((l) => l.startsWith("HEAVY_BATCH_WAIT b hang: down"));
  expect(down).toBeGreaterThan(logs.findIndex((l) => l.startsWith("HEAVY_BATCH_START b #2 ok")));
});

test("an item that failed goes back to the same host when the only other one is down, and the batch ends (review 1 of #476)", async () => {
  const oom = fakeHelper("oom", 'echo "WORKER_ADMIT slot.1" >&2; cat >/dev/null; echo "HEAVY_OOM b.1: killed at MemoryMax=1.0G" >&2; echo "WORKER_EXIT 137" >&2; tar -cf - -T /dev/null');
  const code = await heavyBatch(ctxWith([oom, { name: "down", ssh: ["false"] }]), batchOf(["x"], ["true"]));
  expect(code).toBe(1);
  expect(receipts()).toMatchObject([{ item: "x", exit: 137, tries: [{ host: "oom", result: "oom" }, { host: "oom", result: "oom" }] }]);
});

test("a batch whose --out lies in a --sync path, or whose --mem holds less than one worker, is refused before any item (review 1 of #476)", async () => {
  expect(await heavyBatch(ctxWith([]), batchOf(["x"], ["true"], { out: join(work, "out") }))).toBe(2);
  expect(await heavyBatch(ctxWith([]), batchOf(["x"], ["true"], { memPerWorker: 2 * 1024 ** 3, memCap: 1024 ** 3 }))).toBe(2);
  expect(logs.filter((l) => l.startsWith("HEAVY_BATCH_REFUSED b: "))).toHaveLength(2);
  expect(logs.some((l) => l.startsWith("HEAVY_BATCH_START"))).toBe(false);
});

test("an item whose own command names a path outside the --sync paths runs here; the item text stays literal (review 1 of #476)", async () => {
  writeFileSync(join(work, "a.txt"), "inside\n");
  writeFileSync(join(state.dir, "b.txt"), "outside\n");
  // this host is full for a second, so only its own path keeps the third item off the helper, which takes the first two
  const ctx = ctxWith([realHelper("h1")], true, undefined, true);
  setTimeout(() => rmSync(join(state.dir, "heavy", "slot.1"), { recursive: true, force: true }), 1000);
  const code = await heavyBatch(ctx, batchOf(["a.txt", "a.txt", "../b.txt"], ["cat", `${work}/{item}`]));
  expect(code).toBe(0);
  const two = receipts().find((r) => r.n === 3)!;
  expect(two.host).toBe(hostname());
  expect(outOf(two)).toBe("outside\n");
  expect(itemCmd(["x={item}-{n}"], "a$&b{n}", 3)).toEqual(["x=a$&b{n}-3"]);
});

test("an item here runs with the --tools PATH this host found (review 1 of #476)", async () => {
  const bin = join(state.dir, "offpath");
  mkdirSync(bin);
  writeFileSync(join(bin, "mytool"), "#!/bin/sh\necho tool ran\n");
  chmodSync(join(bin, "mytool"), 0o755);
  const code = await heavyBatch(ctxWith([], false), batchOf(["x"], ["mytool"], { hereEnv: { ...process.env, PATH: `${bin}:${process.env["PATH"]}` } }));
  expect(code).toBe(0);
  expect(outOf(receipts()[0]!)).toBe("tool ran\n");
});
