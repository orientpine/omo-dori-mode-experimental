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

// as a helper, after the upload is unpacked under root: each --sync path checked against the hash it was sent as; say gets
// ASSET_OK <hash> <path>, or ASSET_BAD when what arrived is other (it changed while it was sent: the job runs on that, as
// HEAVY_SYNC_CHANGED tells the caller)
export const checkAssets = async (root: string, sync: readonly string[], opts: readonly string[], say: (line: string) => void): Promise<void> => {
  const hashes = hashesOf(opts);
  for (const [i, p] of sync.entries()) {
    const h = hashes[i] ?? NONE;
    if (!HASH.test(h)) continue;
    const got = await assetHash(join(root, p));
    say(got === h ? `ASSET_OK ${h} ${p}` : `ASSET_BAD ${p}: sent as ${h}, ${got ?? "nothing"} arrived; the job runs on what arrived`);
  }
};
