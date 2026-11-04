import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, expect, test } from "bun:test";

import { type FlowDeps, watchTick } from "../src/done-flow.ts";
import { writeFrozen } from "../src/frozen.ts";
import type { JobStat } from "../src/job-control.ts";
import { laneSuspendTick, type SuspendIO } from "../src/lane-death.ts";
import type { Lane } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, sent, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-10-30T02:33:00Z");
const S = 1_000;
const OOM = "aoe-session-8f671fcc7b52492e-1793325137515.scope: Failed with result 'oom-kill'.";

let state: ReturnType<typeof withState>;
beforeEach(() => (state = withState()));
afterEach(() => state.done());

const laneOf = (key: string, pane: string, patch: Partial<Lane> = {}): Lane => ({ key, title: key, thread: "discord:1", brief: "/b.md", done: "file /d", openedAt: new Date(T0 - 60 * 60 * S).toISOString(), pane, ...patch });

// panes: "live" | "dead <status>" | "gone"; journal: what journalctl --user prints for the grep
const world = (panes: Record<string, string>, journal: string[] = []) => {
  const w: World = newWorld();
  w.screens["lead:p1"] = "❯ ";
  const deps = (ms: number): FlowDeps => {
    const base = depsFor(w, fakeClock(ms), state.dir, { backend: "aoe", leadPane: "lead:p1" });
    return {
      ...base,
      run: async (argv, opts) => {
        const pane = (argv[argv.indexOf("-t") + 1] ?? "").replace(/^=|:$/g, "");
        if (argv[0] === "tmux" && argv[1] === "has-session" && pane in panes) return { code: panes[pane] === "gone" ? 1 : 0, out: "", err: "" };
        if (argv[0] === "tmux" && argv[1] === "display-message" && argv.at(-1) === "#{pane_dead} #{pane_dead_status}" && pane in panes) return { code: 0, out: panes[pane]?.startsWith("dead") ? `1 ${panes[pane]?.split(" ")[1]}` : "0 ", err: "" };
        if (argv[0] === "journalctl") {
          w.calls.push([...argv]);
          const g = argv[argv.indexOf("-g") + 1] ?? "";
          return { code: 0, out: journal.filter((l) => l.includes(g)).join("\n"), err: "" };
        }
        return base.run(argv, opts);
      },
    };
  };
  return { w, deps };
};

const died = (lines: string[]) => lines.filter((l) => l.startsWith("LANE_DIED"));

test("a lane whose pane dies in an OOM is told to the lead once within two checks, with 메모리 부족 from its scope's journal line", async () => {
  // Given: the asr lane's pane is dead (status 143) and this user's journal has its scope's oom-kill
  const panes: Record<string, string> = { "aoe_asr-nemotron-compare_8f671fcc": "dead 143", "aoe_other_11112222": "live" };
  const { w, deps } = world(panes, [OOM, "aoe-session-11112222aaaa.scope: Consumed 1s CPU time."]);
  await deps(T0).registry.write(laneOf("asr-nemotron-compare", "aoe_asr-nemotron-compare_8f671fcc"));
  await deps(T0).registry.write(laneOf("other", "aoe_other_11112222"));
  // When / Then: the first check only notes it, the second (30 s later) tells the lead
  expect(died(await watchTick(deps(T0)))).toEqual([]);
  expect(died(await watchTick(deps(T0 + 30 * S)))).toEqual([`LANE_DIED asr-nemotron-compare aoe_asr-nemotron-compare_8f671fcc: oom-kill (journal: ${OOM})`, "LANE_DIED_TOLD asr-nemotron-compare lead:p1"]);
  expect(sent(w)).toEqual(["[DORI] 레인 asr-nemotron-compare 꺼짐(메모리 부족) — 이어서 살릴지 정해"]);
  expect(w.calls.find((c) => c[0] === "journalctl")).toEqual(["journalctl", "--user", "--since", `@${Math.floor((T0 - 30 * 60 * S) / 1000)}`, "--no-pager", "-o", "cat", "-g", "aoe-session-8f671fcc"]);
  // and never again while it stays dead
  expect(died(await watchTick(deps(T0 + 60 * S)))).toEqual([]);
  expect(sent(w).length).toBe(1);
  // revived, then dead again without an OOM: told again, with the exit status
  panes["aoe_asr-nemotron-compare_8f671fcc"] = "live";
  expect(died(await watchTick(deps(T0 + 90 * S)))).toEqual([]);
  expect((await deps(T0).registry.read("asr-nemotron-compare"))?.died).toBeUndefined();
  panes["aoe_asr-nemotron-compare_8f671fcc"] = "dead 1";
  const { deps: noOom } = { deps: (ms: number) => ({ ...deps(ms), run: async (argv: readonly string[], opts?: Parameters<FlowDeps["run"]>[1]) => (argv[0] === "journalctl" ? { code: 0, out: "", err: "" } : deps(ms).run([...argv], opts)) }) };
  expect(died(await watchTick(noOom(T0 + 120 * S)))).toEqual([]);
  expect(died(await watchTick(noOom(T0 + 150 * S)))).toEqual(["LANE_DIED asr-nemotron-compare aoe_asr-nemotron-compare_8f671fcc: pane dead, status 1", "LANE_DIED_TOLD asr-nemotron-compare lead:p1"]);
  expect(sent(w).at(-1)).toBe("[DORI] 레인 asr-nemotron-compare 꺼짐(종료 코드 1) — 이어서 살릴지 정해");
});

test("a gone session is told as tmux 세션 없음; a paused lane and a pane back between the two checks are never told", async () => {
  const panes: Record<string, string> = { aoe_gone_aaaa1111: "gone", aoe_parked_bbbb2222: "gone", aoe_swap_cccc3333: "gone" };
  const { w, deps } = world(panes);
  await deps(T0).registry.write(laneOf("gone", "aoe_gone_aaaa1111"));
  await deps(T0).registry.write(laneOf("parked", "aoe_parked_bbbb2222", { status: "paused" }));
  await deps(T0).registry.write(laneOf("swap", "aoe_swap_cccc3333"));
  expect(died(await watchTick(deps(T0)))).toEqual([]);
  // a check soon after the first (a second watch) does not count as the confirming one
  expect(died(await watchTick(deps(T0 + 10 * S)))).toEqual([]);
  // a handover gave the swap lane a live pane before the second check
  panes.aoe_swap_cccc3333 = "live";
  expect(died(await watchTick(deps(T0 + 30 * S)))).toEqual(["LANE_DIED gone aoe_gone_aaaa1111: tmux session gone", "LANE_DIED_TOLD gone lead:p1"]);
  expect(sent(w)).toEqual(["[DORI] 레인 gone 꺼짐(tmux 세션 없음) — 이어서 살릴지 정해"]);
});

// handover-simplify on 2026-11-03: a rolled-back handover left its omo stopped behind its last busy screen for 18 hours
const held = (states: Record<number, "S" | "T" | "bg">): ((pid: number) => JobStat | undefined) => (pid) => {
  const s = states[pid];
  if (!s) return undefined;
  return { pid, state: s === "T" ? "T" : "S", ppid: 100, pgrp: pid, session: 100, tpgid: s === "bg" ? 100 : pid };
};
const shellOf = (pid: number): JobStat | undefined => (pid === 100 ? { pid: 100, state: "S", ppid: 1, pgrp: 100, session: 100, tpgid: 100 } : undefined);

test("a lane whose omo stays stopped is told to the lead once and brought back; the lead's own stopped omo is too", async () => {
  // Given: the lane's agent 200 is stopped (T) and the lead's agent 300 is a background job of its shell
  const { w, deps } = world({ "aoe_hs_aaaa1111": "live" });
  await deps(T0).registry.write(laneOf("handover-simplify", "aoe_hs_aaaa1111"));
  const states: Record<number, "S" | "T" | "bg"> = { 200: "T", 300: "bg" };
  const resumed: string[] = [];
  let fails = false;
  const io: SuspendIO = {
    agentOf: async (pane) => (pane === "aoe_hs_aaaa1111" ? 200 : pane === "lead:p1" ? 300 : undefined),
    stat: (pid) => held(states)(pid) ?? shellOf(pid),
    resume: async (pane, pid) => {
      if (fails) return `AGENT_RESUME_FAIL ${pane} agent ${pid}: the shell 100 holds 2 jobs, so fg could pick another`;
      resumed.push(`${pane} ${pid}`);
      states[pid] = "S";
      return `AGENT_RESUMED ${pane} agent ${pid}: fg typed into the shell`;
    },
  };
  const tick = (ms: number) => laneSuspendTick(deps(ms), io, () => false);
  // When / Then: the first check only notes it, the second tells the lead and resumes both
  expect(await tick(T0)).toEqual([]);
  expect(await tick(T0 + 30 * S)).toEqual([
    "LANE_SUSPENDED handover-simplify aoe_hs_aaaa1111: agent 200 stopped (state T, tty foreground group 200, its group 200); its screen is stale, resuming it",
    "AGENT_RESUMED aoe_hs_aaaa1111 agent 200: fg typed into the shell",
    "LANE_SUSPENDED_TOLD handover-simplify lead:p1",
    "LANE_SUSPENDED lead lead:p1: agent 300 background (state S, tty foreground group 100, its group 300); its screen is stale, resuming it",
    "AGENT_RESUMED lead:p1 agent 300: fg typed into the shell",
    "LANE_SUSPENDED_TOLD lead lead:p1",
  ]);
  expect(sent(w)).toEqual(["[DORI] 레인 handover-simplify 멈춤(프로세스 정지) — 스스로 되살렸어, 하던 일을 잇는지 봐", "[DORI] 리드 omo 멈춤(셸 뒤 작업으로 밀림) — 스스로 되살렸어, 하던 일을 잇는지 봐"]);
  // running again: the marks go, and a second stop of the lane is told again
  expect(await tick(T0 + 60 * S)).toEqual(["LANE_RUNNING_AGAIN handover-simplify aoe_hs_aaaa1111", "LANE_RUNNING_AGAIN lead lead:p1"]);
  states[200] = "T";
  fails = true;
  expect(await tick(T0 + 90 * S)).toEqual([]);
  expect((await tick(T0 + 120 * S)).at(-1)).toBe("LANE_SUSPENDED_TOLD handover-simplify lead:p1");
  expect(sent(w).at(-1)).toBe("[DORI] 레인 handover-simplify 멈춤(프로세스 정지) — 되살리지 못했어(agent 200: the shell 100 holds 2 jobs, so fg could pick another) — dori revive aoe_hs_aaaa1111로 다시 해 봐");
  // still stopped: not told twice
  expect(await tick(T0 + 150 * S)).toEqual([]);
  expect(await tick(T0 + 180 * S)).toEqual([]);
  expect(sent(w).length).toBe(3);
});

test("an agent a handover froze on purpose is never taken for a suspended lane", async () => {
  const { w, deps } = world({ "aoe_mv_bbbb2222": "live", "aoe_old_cccc3333": "live" });
  await deps(T0).registry.write(laneOf("moving", "aoe_mv_bbbb2222"));
  await deps(T0).registry.write(laneOf("frozenold", "aoe_old_cccc3333"));
  writeFrozen(state.dir, { pane: "aoe_old_cccc3333", aoeId: "x", at: new Date(T0).toISOString(), agentPid: 201, pids: [201] });
  mkdirSync(join(state.dir, "handover", "lanes"), { recursive: true });
  writeFileSync(join(state.dir, "handover", "lanes", "moving.lock"), JSON.stringify({ pid: 4242, at: new Date(T0).toISOString() }));
  const io: SuspendIO = { agentOf: async (pane) => (pane === "aoe_mv_bbbb2222" ? 200 : pane === "aoe_old_cccc3333" ? 201 : undefined), stat: (pid) => held({ 200: "T", 201: "T" })(pid) ?? shellOf(pid), resume: async () => "AGENT_RESUMED x" };
  const tick = (ms: number) => laneSuspendTick(deps(ms), io, (pid) => pid === 4242);
  expect(await tick(T0)).toEqual([]);
  expect(await tick(T0 + 30 * S)).toEqual([]);
  expect(sent(w)).toEqual([]);
});
