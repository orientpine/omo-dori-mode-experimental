import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// A helper keeps the --sync paths a caller sent, by hash, and the next job that sends the same tree takes its copy there
// instead of the upload (owner 2026-11-14 "가용한 모든 리소스를 효율적으로 쓸수있게 해", gongdori's E7: a code tree and a uv
// environment shipped again with every job of a batch). The hash is of the tree's contents (review 1 of #477: equal size
// and mtime said nothing of the bytes): the root's name, every path with its type and mode (review 2: a mode-only change is
// another input), a file's bytes, a link's target (a folder's size and mtime differ between file systems and change as tar
// fills it). Hashing and copying are asynchronous, so a caller's other transfers and a helper's heartbeat go on meanwhile.
// The caller sends one hash per --sync path (assets=); the helper copies each one it holds into the job's own folder
// (pin/) before it answers, and names only those (WORKER_ADMIT ... have=), so nothing the store does after (pruning,
// another job) takes a tree from a job it was offered to, and an entry that cannot be copied is dropped, not offered
// (review 2 of #477). The caller leaves those out of the upload (HEAVY_ASSET), the helper moves each into place
// (ASSET_OK <hash> <path> cached) or, for one that came,
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

// as a helper, before it answers: each hash of this job it holds copied into the job's pin/ folder (marked used now); the
// ones copied are offered, an entry whose copy failed is dropped so the caller sends that tree again
export const assetsHave = async (dir: string, caller: string, opts: readonly string[], pin: string): Promise<string[]> => {
  const store = storeOf(dir, caller);
  const held: string[] = [];
  for (const h of new Set(hashesOf(opts))) {
    if (!HASH.test(h) || !existsSync(join(store, h, "ok"))) continue;
    if (existsSync(join(store, h, "tree")) && (await cp(join(store, h, "tree"), join(pin, h)))) {
      const now = new Date();
      utimesSync(join(store, h, "ok"), now, now);
      held.push(h);
    } else {
      rmSync(join(pin, h), { recursive: true, force: true });
      rmSync(join(store, h), { recursive: true, force: true });
    }
  }
  return held;
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

// as a helper, after the upload is unpacked under root (the job's in/, beside its pin/): each --sync path it was offered moved
// from pin/, each that came checked against its hash and kept; say gets the ASSET_ lines. false: an offered tree is not in
// pin/, so the job must not run on a part of its inputs (the worker ends without WORKER_EXIT: the caller sends it again)
export const settleAssets = async (root: string, sync: readonly string[], opts: readonly string[], dir: string, caller: string, have: readonly string[], say: (line: string) => void): Promise<boolean> => {
  const hashes = hashesOf(opts);
  if (!hashes.length) return true;
  const store = privateStore(dir, caller);
  // one --sync path: false only when a held copy could not be put in place
  const one = async (p: string, h: string): Promise<boolean> => {
    const at = join(root, p);
    if (!HASH.test(h)) return true;
    if (have.includes(h)) {
      const pinned = join(dirname(root), "pin", h);
      const ok = existsSync(pinned);
      if (ok) {
        mkdirSync(dirname(at), { recursive: true });
        rmSync(at, { recursive: true, force: true });
        renameSync(pinned, at);
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
  prune(store, hashes);
  return whole;
};
