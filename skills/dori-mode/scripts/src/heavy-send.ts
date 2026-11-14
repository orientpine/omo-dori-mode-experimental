import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Assets } from "./heavy-assets.ts";
import { TarError } from "./heavy-job.ts";
import type { SpreadJob } from "./heavy-spread.ts";
import { killAlive, readerLines, settle } from "./heavy-settle.ts";

// The caller's upload to a helper (heavy-spread.ts startExec).

type Sink = { write(chunk: Uint8Array): number | Promise<number>; flush(): number | Promise<number>; end(): number | Promise<number> };

// the --sync paths' archive made once and checked by the one archive builder (heavy-assets.ts), its bytes as they are,
// then a tar of job.json alone (the helper unpacks both with tar -i), into the helper's stdin; its tar killed on cut
// (stale) while it runs and put in kids; the bytes sent. No file of the --sync paths is ever tarred here (review 6 of #479:
// one place lists what leaves); a helper too old to take assets= is left out (heavy-spread.ts startExec)
export const sendTar = async (sink: Sink, job: SpreadJob, sync: readonly string[], took: (bytes: number) => void, cut: Promise<unknown>, kids: Bun.Subprocess[], changed?: (why: string) => void, assets?: Assets): Promise<number> => {
  const tmp = mkdtempSync(join(tmpdir(), "dori-spread-"));
  try {
    writeFileSync(join(tmp, "job.json"), JSON.stringify({ argv: job.cmd, cwd: job.cwd, sync, env: job.env, ...(job.back?.length ? { back: job.back } : {}) }));
    const tar = Bun.spawn(["tar", "-cf", "-", "-C", tmp, "job.json"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    kids.push(tar);
    let gone = false;
    void cut.then(() => {
      gone = true;
      killAlive(tar);
    });
    let bytes = 0;
    for (const part of [...(assets ? [Bun.file(assets.path).stream()] : []), tar.stdout]) for await (const chunk of part) {
      if (gone) break;
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
