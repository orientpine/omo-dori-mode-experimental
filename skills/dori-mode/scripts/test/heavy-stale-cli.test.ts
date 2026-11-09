import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { killAlive } from "../src/heavy-settle.ts";
import { withState } from "./fakes.ts";

// What a stale helper run leaves behind on the caller's side (heavy-stale.test.ts covers the verdicts): the real dori CLI
// ends with exit 124 whatever its children still hold, and a Ctrl-C ends them with it. Every config names its own
// heavyHoldDir, so a hold on this host (heavy hold-local) does not turn the helper away.
const CLI = join(import.meta.dir, "../src/cli.ts");
// heavyQueue.staleMin: 1.2 s
const STALE_MIN = 0.02;
let state: ReturnType<typeof withState>;
let work: string;

beforeEach(() => {
  state = withState();
  work = join(state.dir, "work");
  mkdirSync(work);
  writeFileSync(join(work, "in.txt"), "hello\n");
});
afterEach(() => state.done());

// a helper that admits the job: script is what it does after WORKER_ADMIT; `stop` is answered
const silentHelper = (name: string, admit: string, script: string): string[] => ["sh", "-c", `if [ "$1" = stop ]; then echo "WORKER_STOPPED 1" >&2; exit 0; fi; echo "${admit}" >&2; ${script}`, name];

// the real dori CLI as caller of one helper (ssh: its argv), this host's only slot held; PATH may put a tar first
const caller = (name: string, ssh: string[], staleMin: number, path?: string, more: { name: string; ssh: string[] }[] = []) => {
  const dir = join(state.dir, "caller");
  mkdirSync(join(dir, "heavy", "slot.1"), { recursive: true });
  writeFileSync(join(dir, "heavy", "slot.1", "owner"), `${process.pid} hold ${new Date().toISOString()}`);
  const config = join(state.dir, "caller.json");
  writeFileSync(config, JSON.stringify({ stateDir: dir, heavySlots: 1, heavyMaxSlots: 1, heavyHoldDir: join(state.dir, "hold"), heavyQueue: { staleMin, helpers: [{ name, ssh }, ...more] } }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "DORI_STATE_DIR"));
  return Bun.spawn([process.execPath, CLI, "heavy", "t", "--kind", "cpu", "--sync", work, "--", "true"], { cwd: work, env: { ...env, ...(path ? { PATH: `${path}:${process.env["PATH"]}` } : {}), DORI_CONFIG: config, DORI_ENV_FILE: join(state.dir, "none.env") }, stdout: "ignore", stderr: "pipe", detached: true });
};

// a tar first on PATH whose upload (tar -cf) runs script instead; tar -x is the real one
const tarWith = (script: string): string => {
  const bin = join(state.dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "tar"), `#!/bin/sh\ncase "$1" in -cf) ${script};; esac\nexec /usr/bin/tar "$@"\n`, { mode: 0o755 });
  return bin;
};

test("a stale upload whose local tar is stuck reading ends too, and the tar with it", async () => {
  // Given: the real dori CLI as caller, whose tar never writes a byte (a source read that blocks; a tar first on its
  // PATH), this host's only slot held, and a helper that waits for the bytes
  const bin = tarWith('exec sleep 589');
  try {
    // When
    const p = caller("wait", silentHelper("wait", "WORKER_ADMIT slot.1 alive=0.1 run=1-abc", "cat > /dev/null; exec sleep 600"), STALE_MIN, bin);
    const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
    // Then
    expect(code).toBe(124);
    expect(err).toContain("HEAVY_HELPER_STALE t wait: it took no bytes");
    expect(Bun.spawnSync(["pgrep", "-f", "^sleep 589"]).exitCode).toBe(1);
  } finally {
    Bun.spawnSync(["pkill", "-f", "^sleep 589"]);
  }
}, 30_000);

test("a stale run whose ssh left a child holding its pipes still ends with exit 124, not waiting on that child", async () => {
  // Given: the real dori CLI as caller, this host's only slot held, and an ssh stand-in that leaves a child holding its
  // stderr (as an ssh ProxyCommand or a descendant would) and then goes silent
  const ssh = ["sh", "-c", 'if [ "$1" = stop ]; then echo "WORKER_STOPPED 1" >&2; exit 0; fi; sleep 587 >&2 & echo "WORKER_ADMIT slot.1 alive=0.1 run=1-abc" >&2; cat > /dev/null; exec sleep 600', "held"];
  try {
    // When
    const p = caller("held", ssh, STALE_MIN);
    const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
    // Then: ended stale; the ssh it started was killed, and the pipes its child holds did not keep the CLI waiting
    expect(code).toBe(124);
    expect(err).toContain("HEAVY_HELPER_STALE t held");
    expect(err).toMatch(/HEAVY_STALE_LEFT t held: [^\n]*its pipes are still held/);
  } finally {
    Bun.spawnSync(["pkill", "-f", "^sleep 587"]);
  }
}, 30_000);

test("a stale upload whose tar left a child holding its output ends with exit 124, though ssh and untar are done", async () => {
  // Given: the real dori CLI as caller, whose upload tar leaves a child holding its stdout and exits without a byte (so
  // its read never ends and no kill reaches it), and a helper that admits the job and is gone at once
  const bin = tarWith('sleep 592 & exit 0');
  try {
    // When
    const p = caller("gone", silentHelper("gone", "WORKER_ADMIT slot.1 alive=0.1 run=1-abc", "exit 0"), STALE_MIN, bin);
    const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
    // Then: the upload that never ends does not keep the CLI waiting
    expect(code).toBe(124);
    expect(err).toContain("HEAVY_HELPER_STALE t gone: it took no bytes");
    expect(err).toMatch(/HEAVY_STALE_LEFT t gone: /);
  } finally {
    Bun.spawnSync(["pkill", "-f", "^sleep 592"]);
  }
}, 30_000);

test("a stop that answers and exits but leaves a child holding its stderr does not keep the CLI alive", async () => {
  // Given: a helper that goes silent after admission, and whose stop says WORKER_STOPPED, exits and leaves a child
  // holding its stderr (an ssh wrapper or ProxyCommand that leaves a descendant)
  const ssh = ["sh", "-c", 'if [ "$1" = stop ]; then sleep 594 >&2 & echo "WORKER_STOPPED 1" >&2; exit 0; fi; echo "WORKER_ADMIT slot.1 alive=0.1 run=1-abc" >&2; cat > /dev/null; exec sleep 600', "loud"];
  try {
    // When
    const p = caller("loud", ssh, STALE_MIN);
    const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
    // Then
    expect(code).toBe(124);
    expect(err).toContain("HEAVY_HELPER_STOP t loud: WORKER_STOPPED 1");
  } finally {
    Bun.spawnSync(["pkill", "-f", "^sleep 594"]);
  }
}, 30_000);

test("a helper that turns the job away and leaves a child holding its stderr does not keep the CLI alive", async () => {
  // Given: a first helper that answers WORKER_BUSY, exits and leaves a child holding its stderr, and a second that takes
  // the job, reads the upload and ends it with exit 0
  const busy = ["sh", "-c", 'sleep 596 >&2 & echo "WORKER_BUSY full" >&2; exit 0', "busy"];
  const ok = silentHelper("ok", "WORKER_ADMIT slot.1 run=1-abc", 'cat > /dev/null; tar -cf - -T /dev/null; echo "WORKER_EXIT 0" >&2');
  try {
    // When
    const p = caller("busy", busy, 5, undefined, [{ name: "ok", ssh: ok }]);
    const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
    // Then
    expect(code).toBe(0);
    expect(err).toContain("HEAVY_DONE t ok: exit 0");
  } finally {
    Bun.spawnSync(["pkill", "-f", "^sleep 596"]);
  }
}, 30_000);

test("a stale verdict signals only a child that has not ended, never one already done (its pid may be another's by then)", async () => {
  // Given: one child that ended (an upload tar long finished) and one still running
  const done = Bun.spawn(["true"]);
  await done.exited;
  const running = Bun.spawn(["sleep", "591"]);
  const sent: string[] = [];
  const spy = (p: typeof done, name: string) => ({ pid: p.pid, get exitCode() { return p.exitCode; }, get signalCode() { return p.signalCode; }, kill: (s?: NodeJS.Signals) => { sent.push(name); p.kill(s); } });
  // When
  for (const x of [spy(done, "done"), spy(running, "running")]) killAlive(x);
  // Then
  expect(sent).toEqual(["running"]);
  expect(await running.exited).not.toBe(0);
});

test("Ctrl-C on the caller ends the ssh and tars it started, as they share its terminal's process group", async () => {
  // Given: the real dori CLI as caller in a process group of its own (a terminal's foreground job), this host's only
  // slot held, and a helper that takes the upload and then runs a long job without a heartbeat (so no stale verdict)
  try {
    const p = caller("long", silentHelper("long", "WORKER_ADMIT slot.1 run=1-abc", "cat > /dev/null; echo LONG_STARTED >&2; exec sleep 588"), 5);
    const reader = p.stderr.getReader();
    let err = "";
    while (!err.includes("LONG_STARTED")) {
      const n = await reader.read();
      if (n.done) throw new Error(`the CLI ended before the job started: ${err}`);
      err += new TextDecoder().decode(n.value);
    }
    // When: Ctrl-C, which the terminal sends to its whole foreground group
    process.kill(-p.pid, "SIGINT");
    await p.exited;
    // Then: the helper's ssh (here the long job itself) went with it
    const left = await Bun.spawn(["pgrep", "-f", "^sleep 588"]).exited;
    expect(left).toBe(1);
  } finally {
    Bun.spawnSync(["pkill", "-f", "^sleep 588"]);
  }
}, 30_000);
