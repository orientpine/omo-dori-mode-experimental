import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, expect, test } from "bun:test";

import type { FlowDeps } from "../src/done-flow.ts";
import { writeFrozen } from "../src/frozen.ts";
import type { JobStat } from "../src/job-control.ts";
import { laneSuspendTick, type SuspendIO } from "../src/lane-death.ts";
import { depsFor, fakeClock, newWorld, sent, withState, type World } from "./fakes.ts";
import { FakeHc, terminal } from "./fake-hc.ts";
import { AT_PROMPT, screenWith } from "./lead-resume-screen.ts";

const T0 = Date.parse("2026-11-09T02:18:00Z");
const S = 1_000;
const AGENT = 200;
const SHELL = 100;
let state: ReturnType<typeof withState>;
beforeEach(() => (state = withState()));
afterEach(() => state.done());
// the lead's agent and its shell; "fg" typed in the pane gives the agent the tty and continues it, as bash does
const lead = (pane: string, how: "foreground-stopped" | "background-stopped" | "background-running", screen = AT_PROMPT, opts: { fgTakes?: boolean; extraJob?: boolean; hc?: boolean; psJobs?: string; freezeOnFg?: boolean; goneOnFg?: boolean } = {}) => {
  const w: World = newWorld();
  w.screens[pane] = screen;
  const hcFake = opts.hc ? new FakeHc({ t1: terminal({ screen }) }) : undefined;
  const agent: { state: string; tpgid: number } = { state: how === "background-running" ? "S" : "T", tpgid: how === "foreground-stopped" ? AGENT : SHELL };
  let gone = false;
  const signals: [number, string][] = [];
  const posts: [string, string][] = [];
  let postsFail = false;
  const stat = (pid: number): JobStat | undefined => {
    if (pid === AGENT && !gone) return { pid, state: agent.state, ppid: SHELL, pgrp: AGENT, session: SHELL, tpgid: agent.tpgid };
    return pid === SHELL ? { pid, state: "S", ppid: 1, pgrp: SHELL, session: SHELL, tpgid: agent.tpgid } : undefined;
  };
  const io: SuspendIO = {
    agentOf: async (p) => (p === pane ? AGENT : undefined),
    stat,
    ...(opts.psJobs === undefined ? { jobGroups: async () => (opts.extraJob ? [AGENT, 300] : [AGENT]) } : {}),
    signal: (pid, sig) => {
      signals.push([pid, sig]);
      if (pid === -AGENT && sig === "SIGCONT") agent.state = "S";
      return true;
    },
  };
  const onFg = (): void => {
    if (opts.goneOnFg) {
      gone = true;
      return;
    }
    if (opts.freezeOnFg) {
      mkdirSync(join(state.dir, "handover"), { recursive: true });
      writeFileSync(join(state.dir, "handover", "lock"), JSON.stringify({ pid: 4242, at: new Date(T0).toISOString() }));
      Object.assign(agent, { state: "T", tpgid: AGENT });
      return;
    }
    if (opts.fgTakes !== false) Object.assign(agent, { state: "S", tpgid: AGENT });
  };
  const deps = (ms: number): FlowDeps => {
    const base = depsFor(w, fakeClock(ms), state.dir, { backend: "herdr", leadPane: pane });
    return {
      ...base,
      run: async (argv, opts2) => {
        if (opts.psJobs !== undefined && argv[0] === "ps") return { code: 0, out: opts.psJobs, err: "" };
        if (hcFake && argv[0] === "hc") {
          const result = await hcFake.exec("hc", argv.slice(1));
          if (argv.includes("send") && argv.at(-1) === "fg") onFg();
          return { code: result.code, out: result.stdout.trim(), err: result.stderr.trim() };
        }
        const result = await base.run(argv, opts2);
        if (argv[0] === "herdr" && argv[2] === "send-text" && argv[4] === "fg\r") onFg();
        return result;
      },
      ownerInbox: { path: join(state.dir, "no-inbox.jsonl"), ownerId: "owner", ownerChannel: "C-OWNER" },
      postOwner: async (channel, text) => {
        if (postsFail) throw new Error("discord unavailable");
        posts.push([channel, text]);
        return `m${posts.length}`;
      },
    };
  };
  const tick = (ms: number, alive: (pid: number) => boolean = () => false) => laneSuspendTick(deps(ms), io, alive);
  // the two checks that confirm a hold
  const confirmed = async (alive?: (pid: number) => boolean) => (await tick(T0, alive), tick(T0 + 30 * S, alive));
  return { w, agent, signals, posts, tick, confirmed, hcFake, failPosts: (fail: boolean) => {
    postsFail = fail;
  } };
};

test("a lead stopped as its tty's foreground group is continued with no key typed, and the owner hears it once", async () => {
  const { w, signals, posts, confirmed } = lead("w9:p1", "foreground-stopped");
  const lines = await confirmed();
  expect(lines[0]?.startsWith("LANE_SUSPENDED lead w9")).toBe(true);
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
  const { w, tick, confirmed } = lead("w9:p5", "background-stopped", AT_PROMPT, { fgTakes: false });
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

test("another stopped job makes bare fg ambiguous, so no key reaches the shell", async () => {
  const { w, tick, confirmed, agent } = lead("w9:p9", "background-stopped", AT_PROMPT, { extraJob: true });
  const first = await confirmed();
  expect(first.some((l) => l.startsWith("LEAD_RESUME_FAIL w9:p9 ") && l.includes("another job"))).toBe(true);
  expect(sent(w)).toEqual([]);
  expect(agent.tpgid).toBe(SHELL);
  expect(await tick(T0 + 60 * S)).toEqual([]);
  expect(sent(w)).toEqual([]);
});

test("an hc lead reads and foregrounds through hc, never through herdr", async () => {
  const { w, hcFake, confirmed, agent } = lead("hc:t1", "background-stopped", AT_PROMPT, { hc: true });
  expect(await confirmed()).toContain(`LEAD_RESUMED hc:t1 ${AGENT}`);
  expect(hcFake?.sent).toEqual([{ id: "t1", text: "fg" }]);
  expect(agent.tpgid).toBe(AGENT);
  expect(w.calls.filter((c) => c[0] === "herdr" && c.some((a) => a.includes("hc:t1")))).toEqual([]);
});

test("a failed owner post is retried while the failure reason stays the same", async () => {
  const { posts, tick, confirmed, failPosts } = lead("w9:p10", "background-stopped", screenWith("soodori@ori0a83:/tmp$ git push"));
  failPosts(true);
  expect((await confirmed()).some((l) => l.includes("NOT_POSTED"))).toBe(true);
  expect(posts).toHaveLength(0);
  failPosts(false);
  const next = await tick(T0 + 60 * S);
  expect(next).toContain("LEAD_RESUME_NOTICE w9:p10 POSTED C-OWNER m1");
  expect(posts).toHaveLength(1);
  expect(await tick(T0 + 90 * S)).toEqual([]);
  expect(posts).toHaveLength(1);
});

test("a failed recovery notice is retried after the lead already runs again", async () => {
  const { posts, tick, confirmed, failPosts } = lead("w9:p11", "foreground-stopped");
  failPosts(true);
  expect(await confirmed()).toContain(`LEAD_RESUMED w9:p11 ${AGENT}`);
  expect(posts).toHaveLength(0);
  failPosts(false);
  const next = await tick(T0 + 60 * S);
  expect(next).toContain("LANE_RUNNING_AGAIN lead w9:p11");
  expect(next).toContain("LEAD_RESUME_NOTICE w9:p11 POSTED C-OWNER m1");
  expect(posts).toHaveLength(1);
});

test("the production job enumeration sees a stopped pipeline member whose group leader exited", async () => {
  const psJobs = "  100     1   100 S bash\n  200   100   200 T omo\n  301   100   300 T cat\n";
  const { w, confirmed, agent } = lead("w9:p12", "background-stopped", AT_PROMPT, { psJobs });
  const lines = await confirmed();
  expect(lines.some((l) => l.startsWith("LEAD_RESUME_FAIL w9:p12 ") && l.includes("another job"))).toBe(true);
  expect(sent(w)).toEqual([]);
  expect(agent.tpgid).toBe(SHELL);
});

test("a handover that freezes the lead during fg waits is not continued by the second recovery call", async () => {
  const { w, signals, confirmed } = lead("w9:p13", "background-stopped", AT_PROMPT, { freezeOnFg: true });
  const lines = await confirmed((pid) => pid === 4242);
  expect(lines.some((l) => l.startsWith("LEAD_RESUMED"))).toBe(false);
  expect(signals).toEqual([]);
  expect(sent(w)).toEqual(["fg\r"]);
});

test("an agent that disappears while being foregrounded is a failure, never a resumed notice", async () => {
  const { posts, confirmed } = lead("w9:p14", "background-stopped", AT_PROMPT, { goneOnFg: true });
  const lines = await confirmed();
  expect(lines.some((l) => l.startsWith("LEAD_RESUME_FAIL w9:p14 ") && l.includes("gone"))).toBe(true);
  expect(lines.some((l) => l.startsWith("LEAD_RESUMED"))).toBe(false);
  expect(posts[0]?.[1]).toContain("could not start it again");
});
