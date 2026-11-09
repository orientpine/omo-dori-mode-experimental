import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, expect, test } from "bun:test";

import type { FlowDeps } from "../src/done-flow.ts";
import { writeFrozen } from "../src/frozen.ts";
import type { JobStat } from "../src/job-control.ts";
import { laneSuspendTick, type SuspendIO } from "../src/lane-death.ts";
import { atEmptyPrompt } from "../src/lead-resume.ts";
import { depsFor, fakeClock, newWorld, sent, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-11-09T02:18:00Z");
const S = 1_000;
const AGENT = 200;
const SHELL = 100;

// what herdr showed for a real omo SIGSTOPped in a real pane (0.9.5, 2026-11-09): bash printed its job line and prompt
// over omo's screen, and omo's last status line stays below the prompt
const screenWith = (promptLine: string): string => ["────────", "❯", "[1]+  Stopped                 omo────────", promptLine, "(😺 OmO Native by Q Kim) done", ""].join("\n");
const RESIDUE = "\u001b[0m\u001b[1m\u001b[38;5;2msoodori@ori0a83\u001b[0m:\u001b[0m\u001b[1m\u001b[38;5;4m/tmp\u001b[0m$ \u001b[0m\u001b[38;2;103;113;118mto)\u001b[0m        \u001b[0m\u001b[38;2;103;113;118m(anthropic-subscription) \u001b[0m\r";
const AT_PROMPT = screenWith("soodori@ori0a83:/tmp$");

let state: ReturnType<typeof withState>;
beforeEach(() => (state = withState()));
afterEach(() => state.done());

// the lead's agent and its shell; "fg" typed in the pane gives the agent the tty and continues it, as bash does
const lead = (pane: string, how: "foreground-stopped" | "background-stopped" | "background-running", screen = AT_PROMPT, fgTakes = true) => {
  const w: World = newWorld();
  w.screens[pane] = screen;
  const agent: { state: string; tpgid: number } = { state: how === "background-running" ? "S" : "T", tpgid: how === "foreground-stopped" ? AGENT : SHELL };
  const signals: [number, string][] = [];
  const posts: [string, string][] = [];
  const stat = (pid: number): JobStat | undefined => {
    if (pid === AGENT) return { pid, state: agent.state, ppid: SHELL, pgrp: AGENT, session: SHELL, tpgid: agent.tpgid };
    return pid === SHELL ? { pid, state: "S", ppid: 1, pgrp: SHELL, session: SHELL, tpgid: agent.tpgid } : undefined;
  };
  const io: SuspendIO = {
    agentOf: async (p) => (p === pane ? AGENT : undefined),
    stat,
    signal: (pid, sig) => {
      signals.push([pid, sig]);
      if (pid === -AGENT && sig === "SIGCONT") agent.state = "S";
      return true;
    },
  };
  const deps = (ms: number): FlowDeps => {
    const base = depsFor(w, fakeClock(ms), state.dir, { backend: "herdr", leadPane: pane });
    return {
      ...base,
      run: async (argv, opts) => {
        const result = await base.run(argv, opts);
        if (argv[0] === "herdr" && argv[2] === "send-text" && argv[4] === "fg\r" && fgTakes) Object.assign(agent, { state: "S", tpgid: AGENT });
        return result;
      },
      ownerInbox: { path: join(state.dir, "no-inbox.jsonl"), ownerId: "owner", ownerChannel: "C-OWNER" },
      postOwner: async (channel, text) => (posts.push([channel, text]), `m${posts.length}`),
    };
  };
  const tick = (ms: number, alive: (pid: number) => boolean = () => false) => laneSuspendTick(deps(ms), io, alive);
  // the two checks that confirm a hold
  const confirmed = async (alive?: (pid: number) => boolean) => (await tick(T0, alive), tick(T0 + 30 * S, alive));
  return { w, agent, signals, posts, tick, confirmed };
};

const heads = (lines: string[]): string[] => lines.map((l) => l.split(":")[0] ?? "");

test("a lead stopped as its tty's foreground group is continued with no key typed, and the owner hears it once", async () => {
  const { w, signals, posts, confirmed } = lead("w9:p1", "foreground-stopped");
  const lines = await confirmed();
  expect(heads(lines)[0]).toBe("LANE_SUSPENDED lead w9");
  expect(lines.slice(1)).toEqual([`LEAD_RESUMED w9:p1 ${AGENT}`, "LEAD_RESUME_NOTICE w9:p1 POSTED C-OWNER m1"]);
  expect(signals).toEqual([[-AGENT, "SIGCONT"]]);
  expect(sent(w)).toEqual([]);
  expect(posts).toHaveLength(1);
});

test("a stopped lead whose shell holds the tty gets fg typed at an empty prompt", async () => {
  const { w, agent, confirmed } = lead("w9:p2", "background-stopped");
  const lines = await confirmed();
  expect(lines).toContain(`LEAD_RESUMED w9:p2 ${AGENT}`);
  expect(sent(w)).toEqual(["fg\r"]);
  expect(agent).toEqual({ state: "S", tpgid: AGENT });
});

test("a running background lead gets fg at an empty prompt and no signal", async () => {
  const { w, signals, confirmed } = lead("w9:p3", "background-running");
  expect(await confirmed()).toContain(`LEAD_RESUMED w9:p3 ${AGENT}`);
  expect(sent(w)).toEqual(["fg\r"]);
  expect(signals).toEqual([]);
});

test("text on the prompt line types nothing, says why once, and fg follows when the line is empty again", async () => {
  const { w, posts, tick, confirmed } = lead("w9:p4", "background-stopped", screenWith("soodori@ori0a83:/tmp$ git push"));
  const first = await confirmed();
  expect(first.some((l) => l.startsWith("LEAD_RESUME_FAIL w9:p4 "))).toBe(true);
  expect(first).toContain("LEAD_RESUME_NOTICE w9:p4 POSTED C-OWNER m1");
  expect(sent(w)).toEqual([]);
  // still dirty: retried without another line or post
  expect(await tick(T0 + 60 * S)).toEqual([]);
  expect(posts).toHaveLength(1);
  // cleaned: the retry brings it back
  w.screens["w9:p4"] = AT_PROMPT;
  expect(await tick(T0 + 90 * S)).toContain(`LEAD_RESUMED w9:p4 ${AGENT}`);
  expect(sent(w)).toEqual(["fg\r"]);
});

test("a typed fg that does not take is typed at most three times for one stop", async () => {
  const { w, tick, confirmed } = lead("w9:p5", "background-stopped", AT_PROMPT, false);
  await confirmed();
  for (let i = 2; i <= 6; i++) await tick(T0 + i * 30 * S);
  expect(sent(w)).toEqual(["fg\r", "fg\r", "fg\r"]);
});

test("a second stop of the same lead is repaired and logged but not told again; a failure after a success is", async () => {
  const { w, agent, posts, tick, confirmed } = lead("w9:p6", "foreground-stopped");
  await confirmed();
  expect(posts).toHaveLength(1);
  expect(await tick(T0 + 60 * S)).toEqual(["LANE_RUNNING_AGAIN lead w9:p6"]);
  // stopped again
  Object.assign(agent, { state: "T", tpgid: AGENT });
  await tick(T0 + 90 * S);
  expect(await tick(T0 + 120 * S)).toContain(`LEAD_RESUMED w9:p6 ${AGENT}`);
  expect(posts).toHaveLength(1);
  expect(await tick(T0 + 150 * S)).toEqual(["LANE_RUNNING_AGAIN lead w9:p6"]);
  // stopped behind its shell, at a line that cannot take a key
  Object.assign(agent, { state: "T", tpgid: SHELL });
  w.screens["w9:p6"] = screenWith("soodori@ori0a83:/tmp$ git push");
  await tick(T0 + 180 * S);
  await tick(T0 + 210 * S);
  expect(posts).toHaveLength(2);
  await tick(T0 + 240 * S);
  expect(posts).toHaveLength(2);
});

test("a lead a handover froze on purpose or is moving gets no signal, no key and no notice", async () => {
  for (const why of ["frozen", "handover"] as const) {
    const pane = `w9:p7${why[0]}`;
    const { w, signals, posts, confirmed } = lead(pane, "foreground-stopped");
    if (why === "frozen") writeFrozen(state.dir, { pane, aoeId: "x", at: new Date(T0).toISOString(), agentPid: AGENT, pids: [AGENT] });
    else {
      mkdirSync(join(state.dir, "handover"), { recursive: true });
      writeFileSync(join(state.dir, "handover", "lock"), JSON.stringify({ pid: 4242, at: new Date(T0).toISOString() }));
    }
    expect(await confirmed((pid) => pid === 4242)).toEqual([]);
    expect(signals).toEqual([]);
    expect(sent(w)).toEqual([]);
    expect(posts).toEqual([]);
    state.done();
    state = withState();
  }
});

test("a lead that runs in the foreground is left alone", async () => {
  const { w, agent, signals, confirmed } = lead("w9:p8", "foreground-stopped");
  agent.state = "S";
  expect(await confirmed()).toEqual([]);
  expect(signals).toEqual([]);
  expect(sent(w)).toEqual([]);
});

test("the prompt is empty only on the line right under the newest job line, in the whole-prompt shape", () => {
  expect(atEmptyPrompt(AT_PROMPT)).toBe(true);
  expect(atEmptyPrompt(screenWith("(venv) soodori@ori0a83:~/a$"))).toBe(true);
  expect(atEmptyPrompt(screenWith("root@ori0a83:/tmp#"))).toBe(true);
  // as herdr gives it with colours: bash left omo's status text after the prompt, in omo's colours
  expect(atEmptyPrompt(screenWith(RESIDUE))).toBe(true);
  // the same row with something typed over its start, in no colour
  expect(atEmptyPrompt(screenWith(RESIDUE.replace("$ \u001b[0m\u001b[38;2;103;113;118mto)", "$ git\u001b[0m\u001b[38;2;103;113;118m)")))).toBe(false);
  // typed input, a fragment of omo's status line bash has not cleared yet, mouse report bytes
  expect(atEmptyPrompt(screenWith("soodori@ori0a83:/tmp$ git push"))).toBe(false);
  expect(atEmptyPrompt(screenWith("soodori@ori0a83:/tmp$ to)     (anthropic-subscription)"))).toBe(false);
  expect(atEmptyPrompt(screenWith("soodori@ori0a83:/tmp$ 65;57;24M"))).toBe(false);
  // no job line: an ordinary screen, omo's own input box
  expect(atEmptyPrompt("soodori@ori0a83:/tmp$\n")).toBe(false);
  expect(atEmptyPrompt("────\n❯ \n────\n")).toBe(false);
  // a later prompt holds the cursor, and may hold input this check cannot see
  expect(atEmptyPrompt(`${AT_PROMPT}soodori@ori0a83:/tmp$ rm -rf x\n`)).toBe(false);
  expect(atEmptyPrompt(`${AT_PROMPT}soodori@ori0a83:/tmp$\n`)).toBe(false);
  // something ran after the stop
  expect(atEmptyPrompt(["[1]+  Stopped   omo", "hello", "soodori@ori0a83:/tmp$", ""].join("\n"))).toBe(false);
  // a command typed by someone that ends in the prompt's last character, on a prompt with no user@host
  expect(atEmptyPrompt(screenWith("$ echo cost$"))).toBe(false);
});
