import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TarError } from "./heavy-job.ts";
import type { SpreadJob } from "./heavy-spread.ts";
import { killAlive } from "./heavy-settle.ts";

// The caller's upload to a helper (heavy-spread.ts startExec).

type Sink = { write(chunk: Uint8Array): number | Promise<number>; flush(): number | Promise<number>; end(): number | Promise<number> };

// the job (job.json) and the --sync paths that exist, as one tar into the helper's stdin, its tar killed on cut (stale)
// while it runs and put in kids; the bytes sent
export const sendTar = async (sink: Sink, job: SpreadJob, sync: readonly string[], took: (bytes: number) => void, cut: Promise<unknown>, kids: Bun.Subprocess[]): Promise<number> => {
  const tmp = mkdtempSync(join(tmpdir(), "dori-spread-"));
  try {
    writeFileSync(join(tmp, "job.json"), JSON.stringify({ argv: job.cmd, cwd: job.cwd, sync, env: job.env, ...(job.back?.length ? { back: job.back } : {}) }));
    const have = sync.filter((s) => existsSync(s)).map((s) => s.slice(1));
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
    if (code !== 0) throw new TarError(`tar -c exited ${code}: ${(await new Response(tar.stderr).text()).trim().slice(0, 200)}`);
    return bytes;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
};
