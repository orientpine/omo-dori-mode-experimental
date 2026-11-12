import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAoeSession, paneLife } from "../src/aoe.ts";
import { readFrozen, replacementOf } from "../src/frozen.ts";
import { ackHandover, handover, type HandoverDeps } from "../src/handover.ts";
import { recordHerdrSession, reviveHerdr } from "../src/herdr-sessions.ts";
import { submitToPane } from "../src/panes.ts";
import { readRollovers } from "../src/rollover.ts";
import { procTable } from "../src/session-id.ts";
import { depsFor, fakeClock, newWorld } from "./fakes.ts";
import { CORE, flowRig, restartCore, saveCore, SESSION } from "./hc-flow-rig.ts";

let dir: string;
const ENV = ["PATH", "DORI_RUNTIME", "DORI_ENV_FILE", "HC_SESSION", "HC_FLOW_ROOT"] as const;
let saved: (string | undefined)[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hc-flow-"));
  saved = ENV.map((k) => process.env[k]);
  process.env["PATH"] = `${dir}:${process.env["PATH"]}`;
  process.env["DORI_RUNTIME"] = "hc";
  process.env["DORI_ENV_FILE"] = join(dir, "dori.env");
  process.env["HC_SESSION"] = "wrong-caller-core";
  process.env["HC_FLOW_ROOT"] = dir;
  writeFileSync(join(dir, "dori.env"), `HC_SESSION=${CORE}\nDORI_LEAD_TMUX=hc:t1\n`);
});
afterEach(() => {
  ENV.forEach((k, i) => {
    if (saved[i] === undefined) delete process.env[k];
    else process.env[k] = saved[i];
  });
  rmSync(dir, { recursive: true, force: true });
});

const setup = () => {
  const rig = flowRig(dir);
  const clock = fakeClock(Date.parse("2026-11-09T00:00:00Z"));
  const base = depsFor(newWorld(), clock, dir, { runtime: "hc", backend: "herdr", leadPane: "hc:t1", sessionsDir: join(dir, "sessions") });
  const configPath = join(dir, "config.json");
  const inbox = join(dir, "inbox.jsonl");
  writeFileSync(configPath, JSON.stringify({ runtime: "hc", backend: "herdr", leadPane: "hc:t1" }));
  writeFileSync(inbox, `${JSON.stringify({ id: "3", channel_id: "2", author_id: "owner", content: "move the lead" })}\n`);
  const lines: string[] = [];
  const signals: string[] = [];
  let nonce = 0;
  const deps: HandoverDeps = {
    ...base, run: rig.run,
    clock: { ...clock, sleep: async () => {
      for (const { id, text } of rig.read().sent) {
        const probe = /HANDOVER_PROBE (\w+):/.exec(text)?.[1];
        if (probe) ackHandover(dir, probe, `hc:${id}`, new Date(clock.now()).toISOString());
      }
      for (const match of readFileSync(inbox, "utf8").matchAll(/HANDOVER_PROBE (\w+):/g)) {
        ackHandover(dir, match[1] ?? "", "hc:t2", new Date(clock.now()).toISOString());
      }
    } },
    configPath, envPath: join(dir, "dori.env"), cardDir: join(dir, "cards"), inbox, ownerIds: ["owner"], home: dir,
    sessionOf: async (pane) => pane === "hc:t1" ? SESSION : "new-session",
    routedPane: async () => {
      const config: { leadPane: string } = JSON.parse(readFileSync(configPath, "utf8"));
      return config.leadPane;
    },
    envLeadPane: "", alive: () => false, procs: () => procTable(rig.run),
    signal: (pid, sig) => {
      signals.push(`${sig} ${pid}`);
      return true;
    },
    realpath: (path) => path, timers: async () => [], restart: async () => undefined,
    nonce: () => `n${++nonce}`, print: (line) => void lines.push(line),
  };
  return { rig, deps, lines, signals };
};

const OPTIONS = { approvedBy: "https://discord.com/channels/1/2/3", title: "replacement", noMonitors: true, verifyMin: 1 } as const;
// A handover runs real hc calls and takes seconds under load (#426), so its tests get a long deadline. Not { timeout: 0 }: in a
// file with beforeEach/afterEach, bun 1.4.2 still fires the hook's 5 s default from that test's start and SIGTERMs whatever
// process runs then, the next test's hc call included ("killed 1 dangling process", the zzangdori-lead-2 flake in 4eae ci).
const HANDOVER_TIMEOUT = { timeout: 120_000 } as const;

test("hc lead handover commits replacement routing in the same group and named core before freezing the old lead", async () => {
  // Given: an hc lead in a named core; the caller's core points elsewhere.
  const { rig, deps: baseDeps, lines, signals } = setup();
  let routed = false;
  let frozen = false;
  const deps: HandoverDeps = {
    ...baseDeps,
    routedPane: async () => {
      const pane = await baseDeps.routedPane();
      if (pane === "hc:t2") routed = true;
      return pane;
    },
    signal: (pid, sig) => {
      const sent = baseDeps.signal(pid, sig);
      if (pid === 4242 && sig === "SIGSTOP") frozen = true;
      return sent;
    },
  };
  // When: the replacement acknowledges the real handover's report and inbox probes. The exact commit/freeze events are
  // recorded and asserted as soon as it returns: a close without a freeze cannot leave a pending wait behind.
  const result = await handover(deps, OPTIONS);
  // Then: the move succeeded, and its exact routing/freeze events happened before it returned.
  expect(result).toMatchObject({ code: 0, to: "hc:t2" });
  expect(routed).toBe(true);
  expect(frozen).toBe(true);
  // Then: routing and forwarding target the replacement, while the old terminal stays frozen.
  expect(await deps.routedPane()).toBe("hc:t2");
  expect(readFileSync(deps.envPath, "utf8")).toContain(`HC_SESSION=${CORE}\n`);
  expect(readFileSync(deps.envPath, "utf8")).toContain("DORI_LEAD_TMUX=hc:t2");
  expect(rig.read().terminals["t2"]?.labels["dori.group"]).toBe("lead-group");
  expect(Object.keys(rig.read().terminals)).toEqual(["t1", "t2"]);
  expect(signals).toEqual(["SIGSTOP 4242"]);
  expect(readFrozen(dir)).toMatchObject([{ pane: "hc:t1", to: "hc:t2", session: SESSION, pids: [4242] }]);
  expect(replacementOf(dir, "hc:t1", deps.clock.now())).toBe("hc:t2");
  const submitted = await submitToPane(rig.run, deps.clock, deps.config, "hc:t1", "[REPORT] after commit");
  expect(submitted).toMatchObject({ status: "SUBMITTED" });
  expect(rig.read().sent.at(-1)).toEqual({ id: "t2", text: "[REPORT] after commit" });
  expect(lines).toContain("HANDOVER_COMMITTED lead hc:t2");
  expect(readRollovers(dir).at(-1)).toMatchObject({ result: "done-frozen" });
}, HANDOVER_TIMEOUT);

// The owner reads the lead rows in doriterm by name (2026-11-12: "dori-mode-11111163은 뭐야? 다른 리드들은 이름이 바로 보이는데?"):
// a new hc lead is named after this Dori, and while the frozen old lead holds that name the next free -2 is used.
test.each([["dori-mode-11111633", "zzangdori-lead"], ["zzangdori-lead", "zzangdori-lead-2"]])("hc lead handover from a lead named %s names the new terminal %s", async (old, expected) => {
  // Given: an hc lead with that name, and a Dori the owner calls 짱돌 / ZzangDori; the handover gets no title
  const { rig, deps: baseDeps } = setup();
  const state = rig.read();
  saveCore(dir, { ...state, terminals: { t1: { ...state.terminals["t1"]!, name: old } } });
  const deps: HandoverDeps = { ...baseDeps, config: { ...baseDeps.config, discord: { ...baseDeps.config.discord, callNames: ["짱돌", "짱도리", "ZzangDori"] } } };
  // When
  const result = await handover(deps, { approvedBy: OPTIONS.approvedBy, noMonitors: true, verifyMin: 1 });
  // Then: the replacement terminal carries this Dori's lead name, its labels too
  expect(result).toMatchObject({ code: 0, to: "hc:t2" });
  expect(rig.read().terminals["t2"]?.name).toBe(expected);
  expect(rig.read().terminals["t2"]?.labels["dori.name"]).toBe(expected);
}, HANDOVER_TIMEOUT);

test("hc lead handover leaves the old lead routed and closes the replacement when its agent cannot start", async () => {
  // Given: hc creates the replacement's shell but rejects its initial agent command.
  const { rig, deps, lines, signals } = setup();
  saveCore(dir, { ...rig.read(), failStart: true });
  // When
  const result = await handover(deps, OPTIONS);
  // Then: the failed transaction owns no orphan terminal and never freezes the lead.
  expect(result.code).toBe(3);
  expect(lines.some((line) => line.includes("hc send failed"))).toBe(true);
  expect(await deps.routedPane()).toBe("hc:t1");
  expect(readFileSync(deps.envPath, "utf8")).toContain("DORI_LEAD_TMUX=hc:t1");
  expect(readRollovers(dir).at(-1)).toMatchObject({ result: "rolled-back" });
  expect(signals).toEqual([]);
  expect(readFrozen(dir)).toEqual([]);
  expect(Object.keys(rig.read().terminals)).toEqual(["t1"]);
});

test("hc core restart restores a kept shell and revive resumes its recorded conversation with SUBMITTED text", async () => {
  // Given: a lead opened through the hc runtime, with its conversation recorded before the core restarts.
  const { rig, deps } = setup();
  const pane = await openAoeSession(rig.run, deps.clock, { backend: "herdr", title: "kept-lead", cwd: "/w", tool: "omo", agentCommand: ["omo"], model: "p/m", workspace: "lead-group" });
  recordHerdrSession(dir, pane, { session: SESSION, cwd: "/w", model: "p/recorded", at: new Date(0).toISOString() });
  restartCore(dir);
  expect(await paneLife(rig.run, pane)).toEqual({ live: false, how: "dead", status: -1 });
  const submitted: string[] = [];
  // When: recovery starts the recorded session in that same shell and uses the real submission path.
  const line = await reviveHerdr(rig.run, deps.clock, deps.config, pane, "[DORI] resume work", async (p, text) => {
    const result = await submitToPane(rig.run, deps.clock, deps.config, p, text);
    submitted.push(result.status);
    return result.status === "SUBMITTED";
  });
  // Then: the session, model, terminal identity and submitted message survive recovery.
  expect(line).toBe(`REVIVE_OK ${pane} session ${SESSION} (prompt submitted)`);
  expect(submitted).toEqual(["SUBMITTED"]);
  expect(rig.read().terminals["t2"]?.foreground?.argv).toEqual(["omo", "--session-id", SESSION, "--model", "p/recorded"]);
  expect(rig.read().sent.at(-1)).toEqual({ id: "t2", text: "[DORI] resume work" });
  expect(await paneLife(rig.run, pane)).toEqual({ live: true });
  expect(rig.read().terminals["t2"]?.labels["dori.group"]).toBe("lead-group");
});

test("revive names a gone hc terminal and types nothing even when its conversation is recorded", async () => {
  // Given: a recorded conversation whose terminal was removed.
  const { rig, deps } = setup();
  recordHerdrSession(dir, "hc:t9", { session: SESSION, cwd: "/w", at: new Date(0).toISOString() });
  // When
  const line = await reviveHerdr(rig.run, deps.clock, deps.config, "hc:t9", "[DORI] resume work", async (p, text) => (await submitToPane(rig.run, deps.clock, deps.config, p, text)).status === "SUBMITTED");
  // Then
  expect(line).toStartWith("REVIVE_FAIL hc:t9: herdr has no such pane");
  expect(rig.read().sent).toEqual([]);
  expect(existsSync(join(dir, "wrong-caller-core.json"))).toBe(false);
});
