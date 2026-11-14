import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";

// Each --sync path a job sends goes with its hash (assets=, one per path), and the helper checks what arrived against it
// (owner 2026-11-14 "가용한 모든 리소스를 효율적으로 쓸수있게 해", gongdori's E7: a code tree and a uv environment sent to
// every helper of a batch). The hash is of the tree's contents (review 1 of #477: equal size and mtime said nothing of the
// bytes): the root's name, every path with its type and mode (review 2: a mode-only change is another input), a file's
// bytes, a link's target (a folder's size and mtime differ between file systems and change as tar fills it). A job that
// sends assets= is unpacked with its modes kept (tar -p, heavy-job.ts unpackFrom, review 3), so the helper's umask does
// not change what arrives. Hashing is asynchronous, so a caller's other transfers and a helper's heartbeat go on.
// Nothing is kept between jobs: every job sends its trees into its own folder, which goes when the job ends (review 4 of
// #477 found a shared store's pruning racing a job taking an entry, read-only folders it could not delete and old mtimes
// on a cached copy; lead 2026-11-14: "작업마다 그 작업 폴더로 새로 올리고 해시(ASSET_OK) 확인 ... 캐시 재사용은
// docs/follow-ups.md로. 더 느려도 맞는 게 먼저야").

const HASH = /^[0-9a-f]{32}$/;
const NONE = "-";
export const ASSETS_MAX = 64;
// Hashing reads every byte, so a file whose bytes stop coming (a hung mount) would hold the job before the caller's
// upload watchdog or the helper's run limit starts (review 5 of #477): it gives up after HASH_STALL_MS without progress,
// cancels its reads and its find, and the path counts as not hashed. read: how a file's bytes are read (tests stall it).
export const HASH_STALL_MS = 60_000;
export type HashOpts = { readonly stallMs?: number; readonly read?: (path: string) => ReadableStream<Uint8Array> };
type Watch = { beat: () => void; readonly stalled: Promise<"stalled">; readonly stops: Set<() => void>; isStalled: () => boolean; end: () => void };
const watchFor = (stallMs: number): Watch => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let gone = false;
  let stall!: () => void;
  const stalled = new Promise<"stalled">((r) => {
    stall = () => r("stalled");
  });
  const stops = new Set<() => void>();
  const beat = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      gone = true;
      stall();
      for (const s of stops) s();
    }, stallMs);
  };
  beat();
  return { beat, stalled, stops, isStalled: () => gone, end: () => clearTimeout(timer) };
};
// a stream read to its end, each chunk a sign of progress; false when the watch gave up first (the read is cancelled)
const drain = async (s: ReadableStream<Uint8Array>, w: Watch, take: (c: Uint8Array) => void): Promise<boolean> => {
  const r = s.getReader();
  const stop = (): void => void r.cancel().catch(() => undefined);
  w.stops.add(stop);
  try {
    for (;;) {
      const x = await Promise.race([r.read(), w.stalled]);
      if (x === "stalled" || w.isStalled()) return false;
      if (x.done) return true;
      w.beat();
      take(x.value);
    }
  } finally {
    w.stops.delete(stop);
  }
};

// the hash of one --sync path's tree, or undefined when it is not there, cannot be listed or read, or stalls. Each row is
// a JSON tuple, so no name or link target can move a separator (review 5 of #477: a newline in a link target)
export const assetHash = async (root: string, o: HashOpts = {}): Promise<string | undefined> => {
  if (!existsSync(root)) return undefined;
  const w = watchFor(o.stallMs ?? HASH_STALL_MS);
  const read = o.read ?? ((p: string) => Bun.file(p).stream());
  try {
    const p = Bun.spawn(["find", root, "-printf", "%P\\0%y\\0%m\\0%l\\0"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const kill = (): void => void p.kill("SIGKILL");
    w.stops.add(kill);
    const chunks: Uint8Array[] = [];
    if (!(await drain(p.stdout, w, (c) => chunks.push(c)))) return undefined;
    const code = await Promise.race([p.exited, w.stalled]);
    w.stops.delete(kill);
    if (code !== 0) return undefined;
    const f = Buffer.concat(chunks).toString("utf8").split("\0");
    const rows: string[] = [JSON.stringify(["", "root", basename(root)])];
    for (let i = 0; i + 3 < f.length; i += 4) {
      const [path, type, mode, link] = f.slice(i, i + 4) as [string, string, string, string];
      if (type === "f") {
        const h = createHash("sha256");
        if (!(await drain(read(path ? join(root, path) : root), w, (c) => h.update(c)))) return undefined;
        rows.push(JSON.stringify([path, "f", mode, h.digest("hex")]));
      } else rows.push(JSON.stringify(type === "l" ? [path, "l", link] : [path, type, mode]));
    }
    return createHash("sha256").update(rows.sort().join("\n")).digest("hex").slice(0, 32);
  } catch {
    return undefined;
  } finally {
    w.end();
  }
};
const stallWords = (o: HashOpts): string => `no progress for ${Math.round((o.stallMs ?? HASH_STALL_MS) / 1000)} s, or unreadable`;

// the caller's assets= word for the --sync paths, in their order ("-" for one that is not there, or not hashed: say tells)
export const assetsWord = async (sync: readonly string[], say: (line: string) => void, o: HashOpts = {}): Promise<string> => {
  const hashes: string[] = [];
  for (const p of sync) {
    const h = await assetHash(p, o);
    if (h === undefined && existsSync(p)) say(`${p} could not be hashed (${stallWords(o)}), so it goes without one`);
    hashes.push(h ?? NONE);
  }
  return `assets=${hashes.join(",")}`;
};
export const assetsOptOk = (o: string): boolean => o.startsWith("assets=") && o.slice(7).split(",").length <= ASSETS_MAX && o.slice(7).split(",").every((h) => h === NONE || HASH.test(h));
const hashesOf = (opts: readonly string[]): string[] => opts.find((o) => o.startsWith("assets="))?.slice(7).split(",") ?? [];

// as a helper, after the upload is unpacked under root: each --sync path checked against the hash it was sent as; say gets
// ASSET_OK <hash> <path>, or ASSET_BAD when what arrived is other (it changed while it was sent: the job runs on that, as
// HEAVY_SYNC_CHANGED tells the caller)
export const checkAssets = async (root: string, sync: readonly string[], opts: readonly string[], say: (line: string) => void, o: HashOpts = {}): Promise<void> => {
  const hashes = hashesOf(opts);
  for (const [i, p] of sync.entries()) {
    const h = hashes[i] ?? NONE;
    if (!HASH.test(h)) continue;
    const at = join(root, p);
    const got = await assetHash(at, o);
    if (got === undefined && existsSync(at)) say(`ASSET_BAD ${p}: could not be hashed here (${stallWords(o)}); the job runs on what arrived`);
    else say(got === h ? `ASSET_OK ${h} ${p}` : `ASSET_BAD ${p}: sent as ${h}, ${got ?? "nothing"} arrived; the job runs on what arrived`);
  }
};
