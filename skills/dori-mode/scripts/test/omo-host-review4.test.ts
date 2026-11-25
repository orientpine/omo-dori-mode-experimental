import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { keepTick } from "../src/compaction-keep.ts";
import { watchTick } from "../src/done-flow.ts";
import { footer } from "../src/launch-footer.ts";
import type { Question } from "../src/messenger/discord-cards.ts";
import { missedAnswersTick } from "../src/missed-answers.ts";
import type { Lane } from "../src/registry.ts";
import type { Runner } from "../src/run.ts";
import { FakeOmoHost } from "./fake-omo-host.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const at = Date.parse("2026-11-25T12:00:00Z");
const lane: Lane = { key: "example", title: "Example", thread: "none", brief: "/brief.md", done: "file /proof", openedAt: new Date(at - 600_000).toISOString() };

test.each(["pending", "consumed", "lost"] as const)("hosted missed-answer recovery reconciles a %s parked steer", async (mode) => {
  const state = withState();
  try {
    const id = "00000000-0000-4000-8000-000000000054";
    const pane = `omo-host:${id}`;
    const host = new FakeOmoHost(join(state.dir, "sessions"));
    const session = host.add({ id, state: { isStreaming: true } });
    const transcript = String(session.state["sessionFile"]);
    mkdirSync(dirname(transcript), { recursive: true });
    writeFileSync(transcript, `${JSON.stringify({ type: "session", timestamp: lane.openedAt })}\n`);
    const base = depsFor(newWorld(), fakeClock(at), state.dir, { backend: "herdr", runtime: "hc" });
    const run: Runner = async (argv, opts) => {
      if (argv[0] !== "omo") return base.run(argv, opts);
      // The turn settles after the state read, but the host still acknowledges and retains the steer.
      if (argv[3] === "steer") {
        session.state["isStreaming"] = false;
        session.state["steering"] = [argv[5]];
        session.state["pendingMessageCount"] = 1;
      }
      const result = await host.exec("omo", argv.slice(1));
      return { code: result.code, out: result.stdout, err: result.stderr };
    };
    const card = { id: "Q54", status: "answered", tmux: pane, answeredAt: new Date(at - 240_000).toISOString(), text: "which?", answer: "blue" } as const;
    const deps = { ...base, run, answeredCards: () => [card as Question] };
    await deps.registry.write({ ...lane, pane });
    const first = await missedAnswersTick(deps);
    const answer = host.calls.find(([verb]) => verb === "steer")?.[2];
    if (mode !== "pending") {
      session.state["steering"] = [];
      session.state["pendingMessageCount"] = 0;
    }
    if (mode === "consumed") writeFileSync(transcript, `${JSON.stringify({ type: "session", timestamp: lane.openedAt })}\n${JSON.stringify({ type: "message", message: { role: "user", content: answer } })}\n`);
    const next = await missedAnswersTick(deps);
    const sends = host.calls.filter(([verb]) => verb === "steer" || verb === "prompt");
    expect(sends.map(([verb]) => verb)).toEqual(mode === "lost" ? ["steer", "prompt"] : ["steer"]);
    expect(sends[0]?.[2]).toContain("[DORI] ANSWER Q54");
    expect(first).toEqual([expect.stringContaining("CARD_ANSWER_QUEUED Q54")]);
    expect(next).toEqual([expect.stringContaining(mode === "pending" ? "CARD_ANSWER_PENDING Q54" : mode === "consumed" ? "CARD_ANSWER_CONSUMED Q54" : "CARD_ANSWER_REDELIVERED Q54")]);
    if (mode !== "pending") expect(await missedAnswersTick(deps)).toEqual([]);
  } finally { state.done(); }
});

test("watch twice delivers one answer to a stored hosted lane under a non-OmO config", async () => {
  const state = withState();
  try {
    const host = new FakeOmoHost(join(state.dir, "sessions"));
    const id = "00000000-0000-4000-8000-000000000055";
    const session = host.add({ id });
    const pane = `omo-host:${id}`;
    const path = String(session.state["sessionFile"]);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ type: "session", timestamp: lane.openedAt })}\n`);
    const base = depsFor(newWorld(), fakeClock(at), state.dir, { backend: "herdr", agentCommand: ["other-agent"] });
    const run: Runner = async (argv, opts) => {
      if (argv[0] !== "omo") return base.run(argv, opts);
      const result = await host.exec("omo", argv.slice(1));
      return { code: result.code, out: result.stdout, err: result.stderr };
    };
    const card = { id: "Q55", status: "answered", tmux: pane, answeredAt: new Date(at - 240_000).toISOString(), text: "which?", answer: "blue" } as const;
    const deps = { ...base, run, answeredCards: () => [card as Question] };
    await deps.registry.write({ ...lane, pane });
    await watchTick(deps);
    await watchTick(deps);
    expect(host.calls.filter(([verb]) => verb === "prompt" || verb === "steer").map((call) => call[2])).toEqual([expect.stringContaining("[DORI] ANSWER Q55")]);
  } finally { state.done(); }
});

test("compaction never reads or controls a stored hosted lane quoting terminal borders", async () => {
  const state = withState();
  try {
    const host = new FakeOmoHost(join(state.dir, "sessions"));
    const id = "00000000-0000-4000-8000-000000000056";
    const pane = `omo-host:${id}`;
    const entry = { type: "message", message: { role: "assistant", content: "──────\n❯\n──────", usage: { input: 500_000 } } };
    const session = host.add({ id, entries: [entry], state: { isStreaming: true } });
    const path = String(session.state["sessionFile"]);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(entry)}\n`);
    const base = depsFor(newWorld(), fakeClock(at), state.dir, { sessionsDir: join(state.dir, "sessions") });
    const run: Runner = async (argv, opts) => {
      if (argv[0] !== "omo") return base.run(argv, opts);
      const result = await host.exec("omo", argv.slice(1));
      return { code: result.code, out: result.stdout, err: result.stderr };
    };
    const config = { ...base.config, compactionTrial: { ...base.config.compactionTrial, until: new Date(at + 60_000).toISOString(), atK: 1 } };
    const stored = { ...lane, pane, session: id, trialArm: "early" as const, compactionsSeen: 0 };
    await base.registry.write(stored);
    expect(await keepTick({ ...base, config, run }, stored)).toEqual([]);
    expect(host.calls).toEqual([]);
  } finally { state.done(); }
});

test("a Windows terminal lane's explicit lead report uses PowerShell instance binding", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  if (!platform) throw new Error("process.platform has no descriptor");
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  try {
    const config = "C:\\Dori Instance\\config.json";
    const stateDir = "C:\\Dori Instance\\state";
    const envFile = "C:\\Dori Instance\\dori.env";
    const text = footer(lane, "fallback:p1", "herdr", [], { config, stateDir, envFile, sendTo: "w1:p2" });
    const report = text.split("\n").find((line) => line.startsWith("- Report to the lead at each milestone:"));
    expect(report).toContain("Set-Item");
    const data = [...(report ?? "").matchAll(/FromBase64String\('([^']*)'\)/g)].map((m) => Buffer.from(m[1] ?? "", "base64").toString());
    expect(data.slice(0, 7)).toEqual(["DORI_CONFIG", config, "DORI_STATE_DIR", stateDir, "DORI_ENV_FILE", envFile, "bun"]);
    expect(data.slice(-4)).toEqual(["type", "w1:p2", "--text", "<report line>"]);
    expect(report).not.toContain('run ["env",');
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});
