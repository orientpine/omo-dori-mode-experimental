import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// A helper keeps the --sync paths a caller sent, by hash, and the next job that sends the same tree takes its copy there
// instead of the upload (owner 2026-11-14 "가용한 모든 리소스를 효율적으로 쓸수있게 해", gongdori's E7: a code tree and a uv
// environment shipped again with every job of a batch). The hash is of the tree's contents (review 1 of #477: equal size
// and mtime said nothing of the bytes): the root's name, every path with its type and mode (review 2: a mode-only change
// is another input; review 3: a job sending assets= is unpacked with its modes kept, tar -p, heavy-job.ts unpackFrom, so
// the helper's umask does not change what arrives and a cached copy has the modes a fresh upload would), a file's bytes, a link's target (a folder's size and mtime
// differ between file systems and change as tar fills it). Hashing and copying are asynchronous, so a caller's other
// transfers and a helper's heartbeat go on meanwhile. The caller sends one hash per --sync path (assets=); before it
// answers, the helper moves each entry it holds out of the store into the job's own folder (pin/, one rename: instant and
// atomic, so a second job asking at once is not offered it and nothing the store does after - pruning, another job - can
// touch it) and names only those (WORKER_ADMIT ... have=); an entry without its tree is dropped, not offered (review 2
// and 3 of #477). The caller leaves those out of the upload (HEAVY_ASSET), the helper copies the pinned tree into every
// --sync path of that hash (ASSET_OK <hash> <path> cached) and moves the pin back into the store; a job that ends before
// that loses the entry (the next job sends the tree again). For a tree that came,
// lists what arrived and keeps it only when that gives the hash it was sent as (ASSET_OK ... kept; else ASSET_BAD, and the
// job runs on what arrived). A tree a job changes gets a new hash, so the next job sends it again.

const HASH = /^[0-9a-f]{32}$/;
const NONE = "-";
export const ASSETS_MAX = 64;
// a store entry not used for this long is deleted when the same caller keeps a new one, and at most this many are kept
const KEEP_MS = 24 * 3600_000;
const KEEP_MAX = 8;
// a file's bytes, streamed (each chunk lets the event loop run)
const fileHash = async (path: string): Promise<string> => {
  const h = createHash("sha256");
  for await (const chunk of Bun.file(path).stream()) h.update(chunk);
  return h.digest("hex");
};
const run = async (argv: string[]): Promise<{ code: number; out: string }> => {
  const p = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const out = await new Response(p.stdout).text();
  return { code: await p.exited, out };
};

// the hash of one --sync path's tree, or undefined when it is not there or cannot be listed
export const assetHash = async (root: string): Promise<string | undefined> => {
  if (!existsSync(root)) return undefined;
  const p = await run(["find", root, "-printf", "%P\\0%y\\0%m\\0%l\\0"]);
  if (p.code !== 0) return undefined;
  const f = p.out.split("\0");
  const rows: string[] = [`\0root\0${basename(root)}`];
  try {
    for (let i = 0; i + 3 < f.length; i += 4) {
      const [path, type, mode, link] = f.slice(i, i + 4) as [string, string, string, string];
      rows.push(type === "f" ? `${path}\0f\0${mode}\0${await fileHash(path ? join(root, path) : root)}` : type === "l" ? `${path}\0l\0${link}` : `${path}\0${type}\0${mode}`);
    }
  } catch {
    return undefined;
  }
  return createHash("sha256").update(rows.sort().join("\n")).digest("hex").slice(0, 32);
};

// the caller's assets= word for the --sync paths, in their order ("-" for one that is not there)
export const assetsWord = async (sync: readonly string[]): Promise<string> => {
  const hashes: string[] = [];
  for (const p of sync) hashes.push((await assetHash(p)) ?? NONE);
  return `assets=${hashes.join(",")}`;
};
export const assetsOptOk = (o: string): boolean => o.startsWith("assets=") && o.slice(7).split(",").length <= ASSETS_MAX && o.slice(7).split(",").every((h) => h === NONE || HASH.test(h));
const hashesOf = (opts: readonly string[]): string[] => opts.find((o) => o.startsWith("assets="))?.slice(7).split(",") ?? [];
// the hashes a helper said it holds, from its WORKER_ADMIT line
export const haveOf = (admit: string): ReadonlySet<string> => new Set(/(?:^| )have=([0-9a-f,]+)/.exec(admit)?.[1]?.split(",").filter((h) => HASH.test(h)) ?? []);
// the --sync paths of an upload a helper already holds (its have=), left out of the upload
export const skipOf = (sync: readonly string[], word: string | undefined, have: ReadonlySet<string>): readonly string[] => {
  const hashes = word?.slice(7).split(",") ?? [];
  return sync.filter((_, i) => have.has(hashes[i] ?? NONE));
};

const storeOf = (dir: string, caller: string): string => join(dir, "assets", caller);
// the store and its parent owner-only whatever the umask (review 1 of #477: a job dir is private, so its kept copy must be)
const privateStore = (dir: string, caller: string): string => {
  const store = storeOf(dir, caller);
  mkdirSync(store, { recursive: true, mode: 0o700 });
  for (const d of [join(dir, "assets"), store]) chmodSync(d, 0o700);
  return store;
};
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const cp = async (from: string, to: string): Promise<boolean> => {
  mkdirSync(dirname(to), { recursive: true });
  return (await run(["cp", "-a", "--reflink=auto", from, to])).code === 0;
};

// as a helper, before it answers: each entry of this job's hashes it holds moved out of the store into the job's pin/
// folder (a rename: a job that lost the race to another is not offered it); an entry without its tree is dropped
export const assetsHave = (dir: string, caller: string, opts: readonly string[], pin: string): string[] => {
  const store = storeOf(dir, caller);
  const held: string[] = [];
  for (const h of new Set(hashesOf(opts))) {
    const at = join(store, h);
    if (!HASH.test(h) || !existsSync(join(at, "ok"))) continue;
    try {
      if (!existsSync(join(at, "tree"))) throw new Error("no tree");
      mkdirSync(pin, { recursive: true, mode: 0o700 });
      renameSync(at, join(pin, h));
      held.push(h);
    } catch {
      if (!existsSync(join(at, "tree"))) rmSync(at, { recursive: true, force: true });
    }
  }
  return held;
};

// a pinned entry back into the store once the job's trees are in place (marked used now); dropped when the store got one
// of that hash meanwhile
const unpin = (pinned: string, at: string): void => {
  try {
    if (!existsSync(at)) {
      renameSync(pinned, at);
      const now = new Date();
      utimesSync(join(at, "ok"), now, now);
    }
  } catch {
    // the store keeps whatever it has; this job's trees are already in place
  } finally {
    rmSync(pinned, { recursive: true, force: true });
  }
};

// the store's oldest entries past KEEP_MS, and past KEEP_MAX, go, one of this job's hashes never (a job offered one has its
// own copy in pin/); a .tmp of a worker that is gone goes too
const prune = (store: string, keep: readonly string[]): void => {
  for (const t of readdirSync(store)) {
    const pid = /^[0-9a-f]{32}\.(\d+)\.tmp$/.exec(t)?.[1];
    if (pid && !alive(Number(pid))) rmSync(join(store, t), { recursive: true, force: true });
  }
  const at = (h: string): number => statSync(join(store, h, "ok"), { throwIfNoEntry: false })?.mtimeMs ?? 0;
  const entries = readdirSync(store).filter((h) => HASH.test(h) && !keep.includes(h)).sort((a, b) => at(b) - at(a));
  entries.forEach((h, i) => {
    if (i + keep.length >= KEEP_MAX || Date.now() - at(h) > KEEP_MS) rmSync(join(store, h), { recursive: true, force: true });
  });
};

// as a helper, after the upload is unpacked under root (the job's in/, beside its pin/): each --sync path it was offered
// copied from pin/ (every path of that hash), each that came checked against its hash and kept, then the pins go back;
// say gets the ASSET_ lines. false: an offered tree could not be put in place, so the job must not run on a part of its
// inputs (the worker ends without WORKER_EXIT: the caller sends it again)
export const settleAssets = async (root: string, sync: readonly string[], opts: readonly string[], dir: string, caller: string, have: readonly string[], say: (line: string) => void): Promise<boolean> => {
  const hashes = hashesOf(opts);
  if (!hashes.length) return true;
  const store = privateStore(dir, caller);
  // one --sync path: false only when a held copy could not be put in place
  const one = async (p: string, h: string): Promise<boolean> => {
    const at = join(root, p);
    if (!HASH.test(h)) return true;
    if (have.includes(h)) {
      const tree = join(dirname(root), "pin", h, "tree");
      let ok = existsSync(tree);
      try {
        rmSync(at, { recursive: true, force: true });
        ok = ok && (await cp(tree, at));
      } catch {
        ok = false;
      }
      say(ok ? `ASSET_OK ${h} ${p} cached` : `ASSET_BAD ${p}: the copy of ${h} offered to this job is gone; the job does not run`);
      return ok;
    }
    const got = await assetHash(at);
    if (got !== h) {
      say(`ASSET_BAD ${p}: sent as ${h}, ${got ?? "nothing"} arrived; the job runs on what arrived, which is not kept`);
      return true;
    }
    const tmp = join(store, `${h}.${process.pid}.tmp`);
    try {
      rmSync(tmp, { recursive: true, force: true });
      mkdirSync(tmp, { mode: 0o700 });
      if (!(await cp(at, join(tmp, "tree")))) throw new Error("copy");
      writeFileSync(join(tmp, "ok"), "");
      // two jobs that sent one tree at once: the first to publish it wins, the other keeps nothing and runs on what came
      if (!existsSync(join(store, h))) renameSync(tmp, join(store, h));
      say(`ASSET_OK ${h} ${p} kept`);
    } catch {
      say(existsSync(join(store, h, "ok")) ? `ASSET_OK ${h} ${p} kept` : `ASSET_BAD ${p}: ${h} arrived but could not be kept`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    return true;
  };
  let whole = true;
  for (const [i, p] of sync.entries()) whole = (await one(p, hashes[i] ?? NONE)) && whole;
  for (const h of have) unpin(join(dirname(root), "pin", h), join(store, h));
  prune(store, hashes);
  return whole;
};
