import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freshnessTick } from "../src/freshness.ts";
import { heavyBypassTick } from "../src/freshness-heavy.ts";
import type { FlowDeps } from "../src/done-flow.ts";
import type { Lane } from "../src/registry.ts";
import type { Runner } from "../src/run.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const fixture = async () => {
  const state = withState();
  const world = newWorld();
  const deps = depsFor(world, fakeClock(Date.now()), state.dir);
  const lane: Lane = { key: "training", title: "training", pane: "w:p7", thread: "none", brief: "/b.md", done: "manual", openedAt: new Date().toISOString(), status: "paused" };
  await deps.registry.write(lane);
  const probe = { gpu: "4200, 100 MiB\n4200, [N/A]", code: 0, ps: "4000 1 0 0\n4100 4000 0 0\n4200 4100 1 1", env: "", cgroup: "", calls: [] as string[][] };
  const run: Runner = async (argv, opts) => {
    probe.calls.push([...argv]);
    if (argv[0] === "nvidia-smi") return { code: probe.code, out: probe.gpu, err: "" };
    if (argv[0] === "ps") return { code: 0, out: probe.ps, err: "" };
    if (argv[0] === "cat" && argv[1]?.startsWith("/proc/")) return { code: 0, out: argv[1].endsWith("/environ") ? probe.env : probe.cgroup, err: "" };
    return deps.run(argv, opts);
  };
  return { state, probe, deps: { ...deps, run } };
};

test("freshness succeeds and warns on stderr and watch log once per lane/pid across ticks", async () => {
  const f = await fixture();
  const stderr = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await freshnessTick(f.deps, f.state.dir)).toEqual([]);
    const line = String(stderr.mock.calls[0]?.[0]);
    expect(line).toContain("HEAVY_BYPASS training: pid 4200");
    expect(line).toContain("(directive spread-load; a warning for now, refusal to be reviewed on 2026-12-01)");
    expect(readFileSync(f.deps.config.watchLog, "utf8")).toContain(`freshness ${line}`);
    expect(await freshnessTick(f.deps, f.state.dir)).toEqual([]);
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(join(f.state.dir, "heavy-bypass-seen.json"), "utf8"))).toEqual(["training:4200"]);
    expect(f.probe.calls.some((c) => c.includes("send-text") || c[0] === "kill")).toBe(false);
  } finally { stderr.mockRestore(); f.state.done(); }
});

for (const kind of ["empty", "unrelated", "gone", "missing", "unsupported", "malformed"] as const) test(`clean ${kind} GPU query emits nothing`, async () => {
  const f = await fixture();
  const stderr = spyOn(console, "error").mockImplementation(() => {});
  try {
    if (kind === "empty") f.probe.gpu = "";
    if (kind === "unrelated") f.probe.gpu = "9999, 100 MiB";
    if (kind === "gone") f.probe.ps = "4000 1 0 0";
    if (kind === "missing") f.probe.code = 127;
    if (kind === "unsupported") f.probe.code = 1;
    if (kind === "malformed") f.probe.gpu = "pid, used_memory\nbogus\n0, 10\n1, 10";
    expect(await freshnessTick(f.deps, f.state.dir)).toEqual([]);
    expect(stderr).not.toHaveBeenCalled();
    expect(existsSync(join(f.state.dir, "heavy-bypass-seen.json"))).toBe(false);
  } finally { stderr.mockRestore(); f.state.done(); }
});

for (const kind of ["scope", "service", "env", "slot", "slot-tree"] as const) test(`heavy ${kind} process trees are exempt`, async () => {
  const f = await fixture();
  const stderr = spyOn(console, "error").mockImplementation(() => {});
  try {
    if (kind === "scope" || kind === "service") f.probe.cgroup = `0::/user.slice/dori-heavy-test-10-1.${kind}\n`;
    if (kind === "env") f.probe.env = "OTHER=1\0DORI_HEAVY_JOB=training\0";
    if (kind === "slot" || kind === "slot-tree") {
      const slot = join(f.state.dir, "heavy", "slot.1");
      mkdirSync(slot, { recursive: true });
      writeFileSync(join(slot, "owner"), `${process.pid} training ${new Date().toISOString()}`);
      if (kind === "slot-tree") writeFileSync(join(slot, "tree"), "4100");
      else f.probe.ps = `4000 1 0 0\n${process.pid} 4000 0 0\n4200 ${process.pid} 0 0`;
    }
    await heavyBypassTick(f.deps);
    expect(stderr).not.toHaveBeenCalled();
  } finally { stderr.mockRestore(); f.state.done(); }
});

test("a stale slot cannot hide a bypass, and a new pid gets its own warning", async () => {
  const f = await fixture();
  const stderr = spyOn(console, "error").mockImplementation(() => {});
  try {
    const slot = join(f.state.dir, "heavy", "slot.1");
    mkdirSync(slot, { recursive: true });
    writeFileSync(join(slot, "owner"), "2147483647 stale 2026-01-01T00:00:00Z");
    writeFileSync(join(slot, "tree"), "4100");
    await heavyBypassTick(f.deps);
    f.probe.ps += "\n4201 4100 1 1";
    f.probe.gpu = "4201, [N/A]";
    await heavyBypassTick(f.deps);
    expect(stderr).toHaveBeenCalledTimes(2);
    expect(String(stderr.mock.calls[1]?.[0])).toContain("pid 4201");
  } finally { stderr.mockRestore(); f.state.done(); }
});

for (const secondPid of [4200, 4201]) test(`overlapping processes serialize receipts for ${secondPid === 4200 ? "the same" : "different"} GPU pids`, async () => {
  const f = await fixture();
  const script = `
    const { depsFor, fakeClock, newWorld } = await import(${JSON.stringify(join(import.meta.dir, "fakes.ts"))});
    const { heavyBypassTick } = await import(${JSON.stringify(join(import.meta.dir, "../src/freshness-heavy.ts"))});
    const deps = depsFor(newWorld(), fakeClock(Date.now()), process.env["QA_STATE"]);
    const base = deps.run;
    const run = async (argv, opts) => {
      if (argv[0] === "nvidia-smi") {
        console.log("QUERY_READY");
        return { code: 0, out: process.env["QA_GPU"] + ", [N/A]", err: "" };
      }
      if (argv[0] === "ps") return { code: 0, out: "4000 1 0 0\\n4200 4000 1 1\\n4201 4000 1 1", err: "" };
      if (argv[0] === "herdr" && argv.includes("process-info")) {
        console.log("ENTERED");
        if (process.env["QA_GATE"] === "yes") await new Response(Bun.stdin.stream()).text();
      }
      if (argv[0] === "cat" && argv[1].startsWith("/proc/")) return { code: 0, out: "", err: "" };
      return base(argv, opts);
    };
    await heavyBypassTick({ ...deps, run });
  `;
  const start = (pid: number, gated: boolean) => {
    const ready = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const p = Bun.spawn([process.execPath, "-e", script], {
      env: { ...process.env, QA_STATE: f.state.dir, QA_GPU: String(pid), QA_GATE: gated ? "yes" : "no" },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    const stdout = (async () => {
      let text = "";
      for await (const chunk of p.stdout) {
        text += new TextDecoder().decode(chunk);
        if (text.includes("QUERY_READY")) ready.resolve();
        if (text.includes("ENTERED")) entered.resolve();
      }
      return text;
    })();
    return { p, ready: ready.promise, entered: entered.promise, stdout, stderr: new Response(p.stderr).text() };
  };
  const first = start(4200, true);
  let second: ReturnType<typeof start> | undefined;
  try {
    await first.entered;
    second = start(secondPid, false);
    await second.ready;
    // First is paused after reading seen, while second has queried the GPU and is trying to enter that same interval.
    expect(await Promise.race([second.entered.then(() => "entered"), Bun.sleep(200).then(() => "locked")])).toBe("locked");
    first.p.stdin.end();
    expect(await first.p.exited).toBe(0);
    expect(await second.p.exited).toBe(0);
    const stderr = (await first.stderr) + (await second.stderr);
    expect((stderr.match(/HEAVY_BYPASS/g) ?? []).length).toBe(secondPid === 4200 ? 1 : 2);
    const log = readFileSync(f.deps.config.watchLog, "utf8");
    expect((log.match(/HEAVY_BYPASS/g) ?? []).length).toBe(secondPid === 4200 ? 1 : 2);
    expect(log).not.toContain("FRESHNESS_WARN");
    expect(JSON.parse(readFileSync(join(f.state.dir, "heavy-bypass-seen.json"), "utf8"))).toEqual(secondPid === 4200 ? ["training:4200"] : ["training:4200", "training:4201"]);
    expect(readdirSync(f.state.dir).filter((name) => name.startsWith("heavy-bypass-seen.json."))).toEqual([]);
    await Promise.all([first.stdout, second.stdout]);
  } finally {
    first.p.kill();
    second?.p.kill();
    await Promise.all([first.p.exited, second?.p.exited]);
    f.state.done();
  }
}, 10_000);

test("a failed check whose watch log cannot be written still never stops the tick: the warning goes to stderr", async () => {
  const state = withState();
  const blocker = join(state.dir, "not-a-dir");
  writeFileSync(blocker, "a file where the log's folder would be");
  const base = depsFor(newWorld(), fakeClock(Date.parse("2026-11-17T00:00:00Z")), state.dir, { watchLog: join(blocker, "watch.log") });
  const deps = { ...base, registry: { ...base.registry, open: async () => { throw new Error("registry unreadable"); } } } as unknown as FlowDeps;
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(heavyBypassTick(deps)).resolves.toBeUndefined();
    expect(err.mock.calls.map((c) => String(c[0]))).toContain("FRESHNESS_WARN heavy bypass check: Error: registry unreadable");
  } finally {
    err.mockRestore();
    state.done();
  }
});
