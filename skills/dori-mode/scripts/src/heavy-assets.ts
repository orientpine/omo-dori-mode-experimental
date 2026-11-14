import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// A helper keeps the --sync paths a caller sent, by hash, and the next job that sends the same tree takes its copy there
// instead of the upload (owner 2026-11-14 "가용한 모든 리소스를 효율적으로 쓸수있게 해", gongdori's E7: a code tree and a uv
// environment shipped again with every job of a batch). The hash is of the tree's listing, not its bytes: every path with
// its type, and a file's size, mtime (seconds, as tar keeps it) and owner-execute bit, a link's target; folders count by
// name only (their size and mtime differ between file systems and change as tar fills them). The caller sends one hash per
// --sync path (assets=), the helper answers the ones it holds (WORKER_ADMIT ... have=), the caller leaves those out of the
// upload (HEAVY_ASSET), and the helper copies each from its store (ASSET_OK <hash> <path> cached) or, for one that came,
// lists what arrived and keeps it only when that gives the hash it was sent as (ASSET_OK ... kept; else ASSET_BAD, and the
// job runs on what arrived). A tree a job changes gets a new hash, so the next job sends it again.

const HASH = /^[0-9a-f]{32}$/;
const NONE = "-";
export const ASSETS_MAX = 64;
// a store entry not used for this long is deleted when the same caller keeps a new one, and at most this many are kept
const KEEP_MS = 24 * 3600_000;
const KEEP_MAX = 8;

// the hash of one --sync path's tree, or undefined when it is not there or cannot be listed
export const assetHash = (root: string): string | undefined => {
  if (!existsSync(root)) return undefined;
  const p = Bun.spawnSync(["find", root, "-printf", "%P\\0%y\\0%s\\0%T@\\0%m\\0%l\\0"], { stdout: "pipe", stderr: "ignore" });
  if (p.exitCode !== 0) return undefined;
  const f = p.stdout.toString().split("\0");
  const rows: string[] = [];
  for (let i = 0; i + 5 < f.length; i += 6) {
    const [path, type, size, mtime, mode, link] = f.slice(i, i + 6) as [string, string, string, string, string, string];
    rows.push(type === "f" ? `${path}\0f\0${size}\0${mtime.split(".")[0]}\0${Number.parseInt(mode, 8) & 0o100 ? "x" : "-"}` : type === "l" ? `${path}\0l\0${link}` : `${path}\0${type}`);
  }
  return createHash("sha256").update(rows.sort().join("\n")).digest("hex").slice(0, 32);
};

// the caller's assets= word for the --sync paths, in their order ("-" for one that is not there)
export const assetsWord = (sync: readonly string[]): string => `assets=${sync.map((s) => assetHash(s) ?? NONE).join(",")}`;
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

// as a helper: the hashes of this job it holds (each marked used now)
export const assetsHave = (dir: string, caller: string, opts: readonly string[]): string[] => {
  const store = storeOf(dir, caller);
  return [...new Set(hashesOf(opts))].filter((h) => {
    const ok = join(store, h, "ok");
    if (!HASH.test(h) || !existsSync(ok)) return false;
    const now = new Date();
    utimesSync(ok, now, now);
    return true;
  });
};

const cp = (from: string, to: string): boolean => {
  mkdirSync(dirname(to), { recursive: true });
  return Bun.spawnSync(["cp", "-a", "--reflink=auto", from, to], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
};

// the store's oldest entries past KEEP_MS, and past KEEP_MAX, go; one of this job's hashes never
const prune = (store: string, keep: readonly string[]): void => {
  const at = (h: string): number => statSync(join(store, h, "ok"), { throwIfNoEntry: false })?.mtimeMs ?? 0;
  const entries = readdirSync(store).filter((h) => HASH.test(h) && !keep.includes(h)).sort((a, b) => at(b) - at(a));
  entries.forEach((h, i) => {
    if (i + keep.length >= KEEP_MAX || Date.now() - at(h) > KEEP_MS) rmSync(join(store, h), { recursive: true, force: true });
  });
};

// as a helper, after the upload is unpacked under root: each --sync path it holds copied from its store, each that came
// checked against its hash and kept; say gets the ASSET_ lines
export const settleAssets = (root: string, sync: readonly string[], opts: readonly string[], dir: string, caller: string, have: readonly string[], say: (line: string) => void): void => {
  const hashes = hashesOf(opts);
  if (!hashes.length) return;
  const store = storeOf(dir, caller);
  mkdirSync(store, { recursive: true });
  sync.forEach((p, i) => {
    const h = hashes[i] ?? NONE;
    const at = join(root, p);
    if (!HASH.test(h)) return;
    if (have.includes(h)) {
      say(cp(join(store, h, "tree"), at) ? `ASSET_OK ${h} ${p} cached` : `ASSET_BAD ${p}: the copy of ${h} kept here could not be copied`);
      return;
    }
    const got = assetHash(at);
    if (got !== h) {
      say(`ASSET_BAD ${p}: sent as ${h}, ${got ?? "nothing"} arrived; the job runs on what arrived, which is not kept`);
      return;
    }
    const tmp = join(store, `${h}.${process.pid}.tmp`);
    rmSync(tmp, { recursive: true, force: true });
    if (!cp(at, join(tmp, "tree"))) {
      say(`ASSET_BAD ${p}: ${h} arrived but could not be kept`);
      return;
    }
    writeFileSync(join(tmp, "ok"), "");
    if (existsSync(join(store, h))) rmSync(tmp, { recursive: true, force: true });
    else renameSync(tmp, join(store, h));
    say(`ASSET_OK ${h} ${p} kept`);
  });
  prune(store, hashes);
};
