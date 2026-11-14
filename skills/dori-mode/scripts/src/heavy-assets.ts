import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

// A job's --sync paths go to a helper as one tar archive made once, here, and checked there by its sha256 (owner
// 2026-11-14 "가용한 모든 리소스를 효율적으로 쓸수있게 해", gongdori's E7: a code tree and a uv environment sent to every helper
// of a batch). ASSET_OK means the archive's bytes arrived as they left and tar -x took them; the unpacked tree is not
// walked again (lead 2026-11-14, #477 H334: reviews 1-6 found one canonical-tree-hash edge after another - modes, umask,
// newlines, stalls, memory, UTF-8 - while checking one upload needs no canonical form, F405-F409). A batch archives its
// --sync once and every helper gets the same bytes, so its receipts show one digest per item (lead's condition 1).
// The archive is made into a private file under a watch: no bytes for STAGE_STALL_MS (a file on a hung mount) and tar is
// killed; tar exit 1 (a file changed while read) is sent as read, as an upload always was; any other exit offers the job
// to no helper (it runs here). The helper reads its stdin itself: the archive's bytes, hashed as they pass, then the job's
// own small job.json archive, both into one tar -i -x, and the job runs only when tar ended well and the digest matched.
// Nothing is kept between jobs (review 4 of #477; reuse is a follow-up, docs/follow-ups.md).

export const STAGE_STALL_MS = 60_000;
export type Assets = { readonly path: string; readonly sha: string; readonly bytes: number };
// argv: what makes the archive (tests give one that stalls or fails)
export type StageOpts = { readonly stallMs?: number; readonly argv?: readonly string[] };
type Staged = { readonly assets: Assets; readonly changed?: string } | { readonly why: string };

const WORD = /^assets=([0-9a-f]{64}):(\d{1,15})$/;
export const assetsWord = (a: Assets): string => `assets=${a.sha}:${a.bytes}`;
export const assetsOptOk = (o: string): boolean => WORD.test(o);

// the watch kills tar when it gives up, which ends the read; a read is awaited alone, never raced against a promise that
// stays pending (review 6 of #477: each race kept its chunk until the end)
const watchFor = (stallMs: number, stop: () => void): { beat: () => void; isStalled: () => boolean; end: () => void } => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let gone = false;
  const beat = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      gone = true;
      stop();
    }, stallMs);
  };
  beat();
  return { beat, isStalled: () => gone, end: () => clearTimeout(timer) };
};

// the job's --sync paths as one archive in a private folder under dir, with its sha256 and size
export const stageAssets = async (sync: readonly string[], dir: string, o: StageOpts = {}): Promise<Staged | undefined> => {
  const have = sync.filter((s) => existsSync(s)).map((s) => s.slice(1));
  if (!have.length && !o.argv) return undefined;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const at = mkdtempSync(join(dir, "assets-"));
  const path = join(at, "sync.tar");
  // tar's stderr goes to a file, not a pipe: a child of it that holds its pipes cannot keep this waiting on them
  const p = Bun.spawn([...(o.argv ?? ["tar", "-cf", "-", "-C", "/", ...have])], { stdin: "ignore", stdout: "pipe", stderr: Bun.file(join(at, "tar.err")) });
  const r = p.stdout.getReader();
  const stallMs = o.stallMs ?? STAGE_STALL_MS;
  // on a stall the read is cancelled too: tar may be gone while a child of it still holds its stdout
  const w = watchFor(stallMs, () => {
    p.kill("SIGKILL");
    r.cancel().catch(() => undefined);
  });
  const h = createHash("sha256");
  const file = Bun.file(path).writer();
  let bytes = 0;
  const fail = (why: string): Staged => {
    rmSync(at, { recursive: true, force: true });
    return { why };
  };
  try {
    for (let x = await r.read(); !x.done && !w.isStalled(); x = await r.read()) {
      w.beat();
      h.update(x.value);
      file.write(x.value);
      await file.flush();
      bytes += x.value.byteLength;
    }
    await file.end();
    if (w.isStalled()) return fail(`the --sync paths gave no bytes for ${stallMs / 1000} s while they were archived (a hung mount?)`);
    const code = await p.exited;
    const first = (await Bun.file(join(at, "tar.err")).text()).trim().split("\n")[0]?.slice(0, 200) ?? "";
    if (code !== 0 && code !== 1) return fail(`archiving the --sync paths failed (exit ${code}: ${first})`);
    return { assets: { path, sha: h.digest("hex"), bytes }, ...(code === 1 ? { changed: first } : {}) };
  } catch (e) {
    return fail(`archiving the --sync paths failed: ${String(e).slice(0, 200)}`);
  } finally {
    w.end();
  }
};

// one job's or one batch's archives, made on first use for a --sync list and removed by drop; a why when it failed
export type Stager = { readonly get: (sync: readonly string[]) => Promise<Assets | { readonly why: string } | undefined>; readonly drop: () => void };
export const stager = (dir: string, label: string, log: (l: string) => void, o: StageOpts = {}): Stager => {
  const made = new Map<string, Promise<Assets | { readonly why: string } | undefined>>();
  const paths: string[] = [];
  const get: Stager["get"] = (sync) => {
    const key = JSON.stringify(sync);
    let p = made.get(key);
    if (!p) {
      p = stageAssets(sync, dir, o).then((r) => {
        if (!r) return undefined;
        if ("why" in r) {
          log(`HEAVY_ASSET_UNSENT ${label}: ${r.why}; no helper is offered it`);
          return { why: r.why };
        }
        paths.push(r.assets.path);
        if (r.changed) log(`HEAVY_SYNC_CHANGED ${label}: ${r.changed}; archived as read (tar exit 1), the job runs on that`);
        log(`HEAVY_ASSET ${label}: --sync archived once, sha256 ${r.assets.sha}, ${r.assets.bytes} bytes; every helper gets these bytes`);
        return r.assets;
      });
      made.set(key, p);
    }
    return p;
  };
  return {
    get,
    drop: () => {
      for (const p of paths.splice(0)) rmSync(dirname(p), { recursive: true, force: true });
    },
  };
};

// as a helper: stdin unpacked under dir; with assets=, its first bytes are the caller's archive, hashed as they pass, and
// then the job's own archive, both through one tar -i -x with modes kept (tar -p: the helper's umask does not change them).
// say gets ASSET_OK or ASSET_BAD; false: the job must not run (tar failed, or the bytes are not the ones sent)
export const unpackChecked = async (dir: string, opts: readonly string[], say: (l: string) => void, from: ReadableStream<Uint8Array> = Bun.stdin.stream()): Promise<boolean> => {
  const m = opts.map((x) => WORD.exec(x)).find((x) => x);
  const want = m ? { sha: m[1]!, bytes: Number(m[2]) } : undefined;
  const tar = Bun.spawn(["tar", "-C", dir, "--no-same-owner", ...(want ? ["-p", "-i"] : []), "-xf", "-"], { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
  const said = new Response(tar.stderr).text();
  const h = createHash("sha256");
  let seen = 0;
  let open = true;
  // read to the end on its own, whatever tar does: a tar that stops early cannot leave the check undone
  for await (const c of from) {
    if (want && seen < want.bytes) h.update(c.subarray(0, Math.min(c.byteLength, want.bytes - seen)));
    seen += c.byteLength;
    if (!open) continue;
    try {
      tar.stdin.write(c);
      await tar.stdin.flush();
    } catch {
      open = false;
    }
  }
  try {
    await tar.stdin.end();
  } catch {
    // tar has gone; its exit says why
  }
  const code = await tar.exited;
  const why = code !== 0 ? `tar -x exited ${code}: ${(await said).trim().slice(0, 200)}` : undefined;
  if (!want) {
    if (why) say(`HEAVY_EXEC_UNPACK ${why}`);
    return !why;
  }
  const got = h.digest("hex");
  const bad = why ?? (seen < want.bytes || got !== want.sha ? `sent as ${want.sha} (${want.bytes} bytes), ${got} arrived (${Math.min(seen, want.bytes)} bytes)` : undefined);
  say(bad ? `ASSET_BAD ${bad}; the job does not run` : `ASSET_OK ${want.sha} ${want.bytes}`);
  return !bad;
};
