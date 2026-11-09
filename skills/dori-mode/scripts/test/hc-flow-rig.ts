import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shellWords } from "../src/handover.ts";
import { run, type Runner } from "../src/run.ts";
import { FakeHc, type FakeTerminal, terminal } from "./fake-hc.ts";
import { RUNNING } from "./fakes.ts";

type State = {
  terminals: Record<string, FakeTerminal>;
  calls: string[][];
  sent: { id: string; text: string }[];
  kept: string[];
  failStart: boolean;
};

export const CORE = "flow-core";
export const SESSION = "11111111-2222-4333-8444-555555555555";
export const SCREEN = "omo\n────────\n❯ \n────────";

const statePath = (dir: string, core = CORE): string => join(dir, `${core}.json`);
export const readCore = (dir: string): State => JSON.parse(readFileSync(statePath(dir), "utf8"));
export const saveCore = (dir: string, state: State): void => writeFileSync(statePath(dir), JSON.stringify(state));

// A core restart keeps only terminals created with --keep, restoring their shells rather than their agents.
export const restartCore = (dir: string): void => {
  const state = readCore(dir);
  for (const [id, t] of Object.entries(state.terminals)) {
    t.state = state.kept.includes(id) ? "live" : "finished";
    t.status = null;
    t.reported = false;
    t.foreground = { name: "bash", argv: ["bash"], pid: t.pid ?? 900 };
    t.screen = "$ ";
  }
  saveCore(dir, state);
};

export const flowRig = (dir: string) => {
  saveCore(dir, {
    terminals: { t1: terminal({ labels: { "dori.group": "lead-group" }, screen: SCREEN, foreground: { name: "omo", argv: ["omo", "--session-id", SESSION], pid: 4242 } }) },
    calls: [], sent: [], kept: [], failStart: false,
  });
  writeFileSync(join(dir, "hc"), `#!/bin/sh\nexec flock "$HC_FLOW_ROOT/hc.lock" '${process.execPath}' '${import.meta.path}' "$@"\n`);
  chmodSync(join(dir, "hc"), 0o700);
  const runner: Runner = async (argv, opts) => {
    if (argv[0] === "hc") return run(argv, opts);
    if (argv[0] === "ps") {
      const out = Object.values(readCore(dir).terminals).flatMap((t) => [
        `${t.pid} 1 ${t.pid} Ss bash`,
        ...(t.foreground?.name === "omo" ? [`${t.foreground.pid} ${t.pid} ${t.foreground.pid} S+ ${t.foreground.argv.join(" ")}`] : []),
      ]).join("\n");
      return { code: 0, out, err: "" };
    }
    if (argv[0] === "aoe") return { code: 0, out: "[]", err: "" };
    if (argv[0] === "herdr") return { code: 1, out: "", err: "no herdr" };
    throw new Error(`unexpected flow command: ${argv.join(" ")}`);
  };
  return { run: runner, read: () => readCore(dir) };
};

// Executed as the hc binary by the real Runner: HC_SESSION selects the state, including when the caller names another core.
if (import.meta.main) {
  const dir = process.env["HC_FLOW_ROOT"] ?? "";
  const file = statePath(dir, process.env["HC_SESSION"] ?? "default");
  const state: State = JSON.parse(readFileSync(file, "utf8"));
  const fake = new FakeHc(state.terminals);
  const argv = process.argv.slice(2);
  const [verb, id] = argv.slice(1);
  const text = argv.at(-1) ?? "";
  const command = verb === "send" && shellWords(text)?.includes("omo");
  if (command && state.failStart) fake.knobs.sendError = "unavailable";
  const result = await fake.exec("hc", argv);
  if (result.code === 0 && verb === "run") {
    for (const [key, t] of fake.terminals) {
      if (Object.hasOwn(state.terminals, key)) continue;
      t.pid = 900 + fake.terminals.size;
      t.foreground = { name: "bash", argv: ["bash"], pid: t.pid };
      t.screen = "$ ";
      if (argv.includes("--keep")) state.kept.push(key);
    }
  }
  if (result.code === 0 && command && id) {
    const t = fake.terminals.get(id);
    const words = shellWords(text) ?? [];
    if (t) {
      t.foreground = { name: "omo", argv: words.slice(words.indexOf("omo")), pid: (t.pid ?? 900) + 4000 };
      t.status = { state: "idle", app: "omo" };
      t.reported = true;
      t.screen = SCREEN;
    }
  }
  if (result.code === 0 && id && !command) {
    const t = fake.terminals.get(id);
    if (t && verb === "send") t.screen = `${RUNNING}\n${SCREEN}`;
    if (t?.screen?.includes(RUNNING) && verb === "read") t.screen = SCREEN;
  }
  writeFileSync(file, JSON.stringify({ ...state, terminals: Object.fromEntries(fake.terminals), calls: [...state.calls, ...fake.calls], sent: [...state.sent, ...fake.sent] }));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.code);
}
