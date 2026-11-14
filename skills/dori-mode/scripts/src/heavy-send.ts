import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TarError } from "./heavy-job.ts";
import type { SpreadJob } from "./heavy-spread.ts";
import { killAlive, readerLines, settle } from "./heavy-settle.ts";

// The caller's upload to a helper (heavy-spread.ts startExec).

type Sink = { write(chunk: Uint8Array): number | Promise<number>; flush(): number | Promise<number>; end(): number | Promise<number> };

// the job (job.json) and the --sync paths that exist, as one tar into the helper's stdin, its tar killed on cut (stale)
// while it runs and put in kids; the bytes sent
export const sendTar = async (sink: Sink, job: SpreadJob, sync: readonly string[], took: (bytes: number) => void, cut: Promise<unknown>, kids: Bun.Subprocess[], changed?: (why: string) => void, skip: readonly string[] = []): Promise<number> => {
  const tmp = mkdtempSync(join(tmpdir(), "dori-spread-"));
  try {
    writeFileSync(join(tmp, "job.json"), JSON.stringify({ argv: job.cmd, cwd: job.cwd, sync, env: job.env, ...(job.back?.length ? { back: job.back } : {}) }));
    // skip: --sync paths the helper holds by hash (heavy-assets.ts); job.json still names them all
    const have = sync.filter((s) => existsSync(s) && !skip.includes(s)).map((s) => s.slice(1));
    const tar = Bun.spawn(["tar", "-cf", "-", "-C", tmp, "job.json", ...(have.length ? ["-C", "/", ...have] : [])], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    kids.push(tar);
    void cut.then(() => killAlive(tar));
    let bytes = 0;
    for await (const chunk of tar.stdout) {
      bytes += chunk.byteLength;
      took(chunk.byteLength);
      sink.write(chunk);
      await sink.flush();
    }
    await sink.end();
    const code = await tar.exited;
    // GNU tar exits 1 when a file changed, shrank or went away while it read it (another job of a batch writing under the
    // --sync paths): what it read is sent, and the job runs on that; any other failure breaks the upload
    if (code === 1) changed?.((await new Response(tar.stderr).text()).trim().split("\n")[0]?.slice(0, 200) ?? "");
    else if (code !== 0) throw new TarError(`tar -c exited ${code}: ${(await new Response(tar.stderr).text()).trim().slice(0, 200)}`);
    return bytes;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
};

// the bytes of the --sync paths, for HEAVY_SYNC: du -sbc, 30 s at most (a stalled file system answers nothing), else 0
// (unknown); ended with the run (cut), never waited on before the run's stale watch exists
export const syncBytes = async (paths: readonly string[], cut: Promise<unknown>, waitMs = 30_000): Promise<number> => {
  const have = paths.filter((s) => existsSync(s));
  if (!have.length) return 0;
  const p = Bun.spawn(["du", "-sbc", ...have], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const reader = p.stdout.getReader();
  let last = "";
  const read = (async () => {
    for await (const l of readerLines(reader)) last = l;
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = Promise.race([cut, new Promise<void>((r) => (timer = setTimeout(r, waitMs).unref()))]);
  const ok = await settle([p], [reader], Promise.all([read, p.exited]), late);
  clearTimeout(timer);
  return ok ? Number(last.split(/\s/)[0]) || 0 : 0;
};
