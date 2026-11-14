import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

// A job's --sync paths go to a helper as one tar archive made once, here, and checked there by its sha256 (owner
// 2026-11-14 "가용한 모든 리소스를 효율적으로 쓸수있게 해", gongdori's E7: a code tree and a uv environment sent to every helper
// of a batch). ASSET_OK means the archive's bytes arrived as they left and tar -x took them; the unpacked tree is not
// walked again (lead 2026-11-14, #477 H334: reviews 1-6 found one canonical-tree-hash edge after another - modes, umask,
// newlines, stalls, memory, UTF-8 - while checking one upload needs no canonical form, F405-F409). A batch archives its
// --sync once and every helper gets the same bytes, so its receipts show one digest per item (lead's condition 1).
// The archive is made into a file with no name on disk, under a watch: no bytes for STAGE_STALL_MS (a file on a hung mount) and tar is
// killed; tar exit 1 (a file changed while read) is sent as read, as an upload always was; any other exit offers the job
// to no helper (it runs here). The helper reads its stdin itself: the archive's bytes, hashed as they pass, then the job's
// own small job.json archive, both into one tar -i -x, and the job runs only when tar ended well and the digest matched.
// Nothing is kept between jobs (review 4 of #477; reuse is a follow-up, docs/follow-ups.md).

export const STAGE_STALL_MS = 60_000;
// path: where it is read again (/proc/self/fd/<fd>), fd: what keeps it
export type Assets = { readonly path: string; readonly fd: number; readonly sha: string; readonly bytes: number };
// argv: what makes the archive (tests give one that stalls or fails); write: how a chunk goes into it (tests make it fail)
export type StageOpts = { readonly stallMs?: number; readonly argv?: readonly string[]; readonly write?: (fd: number, b: Uint8Array) => void };
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

const writeAll = (fd: number, b: Uint8Array): void => {
  for (let at = 0; at < b.byteLength; ) at += writeSync(fd, b, at);
};
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === "EPERM";
  }
};
// a file with no name: opened, then unlinked at once, and read again through /proc/self/fd (each open there reads from
// its start); the kernel frees it when its last descriptor closes, so no end of this process - Ctrl-C, SIGKILL, an OOM
// kill - leaves it on disk (review 7 of #477). A process killed between the open and the unlink leaves an empty file
// named for its pid, which the next stager removes once that pid is gone.
const nameless = (dir: string): number => {
  for (const n of readdirSync(dir)) {
    const pid = Number(/^assets-(\d+)-/.exec(n)?.[1]);
    if (pid && !alive(pid)) rmSync(join(dir, n), { force: true });
  }
  const name = join(dir, `assets-${process.pid}-${randomUUID()}.tar`);
  const fd = openSync(name, "wx", 0o600);
  unlinkSync(name);
  return fd;
};

// the job's --sync paths as one archive with no name on disk (under dir only for a moment), with its sha256 and size;
// every failure, of setup, of tar or of a write, ends tar, cancels its read and closes what was opened
export const stageAssets = async (sync: readonly string[], dir: string, o: StageOpts = {}): Promise<Staged | undefined> => {
  const have = sync.filter((s) => existsSync(s)).map((s) => s.slice(1));
  if (!have.length && !o.argv) return undefined;
  const fds: number[] = [];
  let p: Bun.Subprocess<"ignore", "pipe", number> | undefined;
  let r: { cancel: () => Promise<void> } | undefined;
  let w: ReturnType<typeof watchFor> | undefined;
  const stallMs = o.stallMs ?? STAGE_STALL_MS;
  const close = (): void => {
    for (const fd of fds.splice(0)) closeSync(fd);
  };
  const fail = async (why: string): Promise<Staged> => {
    w?.end();
    if (p) {
      p.kill("SIGKILL");
      p.unref();
    }
    await r?.cancel().catch(() => undefined);
    if (p) await Promise.race([p.exited, Bun.sleep(5_000)]);
    close();
    return { why };
  };
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const fd = nameless(dir);
    fds.push(fd);
    // tar's stderr goes to a nameless file too, not a pipe: a child of it that holds its pipes cannot keep this waiting
    const err = nameless(dir);
    fds.push(err);
    const tar = Bun.spawn([...(o.argv ?? ["tar", "-cf", "-", "-C", "/", ...have])], { stdin: "ignore", stdout: "pipe", stderr: err });
    p = tar;
    const reader = tar.stdout.getReader();
    r = reader;
    // on a stall the read is cancelled too: tar may be gone while a child of it still holds its stdout
    w = watchFor(stallMs, () => {
      tar.kill("SIGKILL");
      reader.cancel().catch(() => undefined);
    });
    const write = o.write ?? writeAll;
    const h = createHash("sha256");
    let bytes = 0;
    for (let x = await reader.read(); !x.done && !w.isStalled(); x = await reader.read()) {
      w.beat();
      write(fd, x.value);
      h.update(x.value);
      bytes += x.value.byteLength;
    }
    if (w.isStalled()) return await fail(`the --sync paths gave no bytes for ${stallMs / 1000} s while they were archived (a hung mount?)`);
    const code = await tar.exited;
    const first = (await Bun.file(`/proc/self/fd/${err}`).text()).trim().split("\n")[0]?.slice(0, 200) ?? "";
    if (code !== 0 && code !== 1) return await fail(`archiving the --sync paths failed (exit ${code}: ${first})`);
    // the archive's descriptor goes to the caller (Stager.drop closes it); tar's stderr is done with
    fds.length = 0;
    closeSync(err);
    return { assets: { path: `/proc/self/fd/${fd}`, fd, sha: h.digest("hex"), bytes }, ...(code === 1 ? { changed: first } : {}) };
  } catch (e) {
    return await fail(`archiving the --sync paths failed: ${String(e).slice(0, 200)}`);
  } finally {
    w?.end();
  }
};

// one job's or one batch's archives, made on first use for a --sync list and closed by drop (one made after drop is
// closed as it comes); a why when it failed
export type Stager = { readonly get: (sync: readonly string[]) => Promise<Assets | { readonly why: string } | undefined>; readonly drop: () => void };
export const stager = (dir: string, label: string, log: (l: string) => void, o: StageOpts = {}): Stager => {
  const made = new Map<string, Promise<Assets | { readonly why: string } | undefined>>();
  const fds: number[] = [];
  let dropped = false;
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
        if (dropped) {
          closeSync(r.assets.fd);
          return { why: "the job ended while its --sync paths were archived" };
        }
        fds.push(r.assets.fd);
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
      dropped = true;
      for (const fd of fds.splice(0)) closeSync(fd);
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
  // tar's lines joined into one: ASSET_BAD and HEAVY_EXEC_UNPACK are single lines of the helper's protocol and its log
  const why = code !== 0 ? `tar -x exited ${code}: ${(await said).trim().split(/\s*\n\s*/).join(" | ").slice(0, 200)}` : undefined;
  if (!want) {
    if (why) say(`HEAVY_EXEC_UNPACK ${why}`);
    return !why;
  }
  const got = h.digest("hex");
  const bad = why ?? (seen < want.bytes || got !== want.sha ? `sent as ${want.sha} (${want.bytes} bytes), ${got} arrived (${Math.min(seen, want.bytes)} bytes)` : undefined);
  say(bad ? `ASSET_BAD ${bad}; the job does not run` : `ASSET_OK ${want.sha} ${want.bytes}`);
  return !bad;
};
