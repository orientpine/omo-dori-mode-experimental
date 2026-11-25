import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { run } from "../src/run.ts";
import { viaEnvFile, withState } from "./fakes.ts";

// upstream sisyphuslabs/dori-superagent#243 (https://github.com/sisyphuslabs/dori-superagent/pull/243): a launch whose
// brief file or --cwd directory is not there is refused before it writes, asks a model or opens anything. PATH holds no
// program at all, so a launch that went on could not open a session either.
const cli = join(import.meta.dir, "../src/cli.ts");

const launch = async (dir: string, brief: string, cwd: string) => {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const state = join(dir, "state");
  const r = await run(viaEnvFile([
    "env", "-u", "HERDR_PANE_ID", "-u", "HERDR_SOCKET_PATH", "-u", "HC_TERMINAL_ID", "-u", "DORI_RUNTIME",
    `PATH=${bin}`, `DORI_CONFIG=${join(dir, "missing.json")}`, `DORI_STATE_DIR=${state}`, `DORI_ENV_FILE=${join(dir, "missing.env")}`,
    process.execPath, cli, "launch", "qa-paths", "--title", "t", "--brief", brief, "--done", "file /x", "--no-thread", "QA", "--model", "m", "--cwd", cwd,
  ]), { timeoutMs: 20_000 });
  return { code: r.code, err: r.err.trim(), out: r.out, logged: existsSync(join(state, "lanes.log")) };
};

test("a --cwd that is not a directory is refused before anything is written or asked", async () => {
  const state = withState();
  try {
    const brief = join(state.dir, "brief.md");
    writeFileSync(brief, "# brief\n");
    for (const cwd of [join(state.dir, "gone"), brief]) {
      const r = await launch(state.dir, brief, cwd);
      expect(r).toEqual({ code: 1, err: `LAUNCH_NO_CWD qa-paths: no directory ${cwd}; nothing was written or opened`, out: "", logged: false });
      expect(readFileSync(brief, "utf8")).toBe("# brief\n");
    }
  } finally {
    state.done();
  }
});

test("a brief file that is not there is refused first, before any warning or write", async () => {
  const state = withState();
  try {
    const brief = join(state.dir, "missing.md");
    const r = await launch(state.dir, brief, state.dir);
    expect(r).toEqual({ code: 1, err: `brief not found: ${brief}`, out: "", logged: false });
  } finally {
    state.done();
  }
});
