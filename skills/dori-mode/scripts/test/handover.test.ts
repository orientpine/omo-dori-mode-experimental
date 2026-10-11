import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ackHandover, handover, type HandoverDeps, manifestPath } from "../src/handover.ts";
import { QuestionStore } from "../src/messenger/discord-cards.ts";
import type { Lane } from "../src/registry.ts";
import { sessionDirFor } from "../src/session-id.ts";
import { depsFor, fakeClock, NEW_AOE_ID, newWorld, sent, withState, type World } from "./fakes.ts";

const OLD = "aoe_lead_0a0a0a0a";
const OLD_ID = "0a0a0a0a11112222";
const NEW = `aoe_lead2_${NEW_AOE_ID.slice(0, 8)}`;
const CWD = "/work/lead";
const INBOX_CMD = "tail -n 0 -F /home/test/.dori/inbox.jsonl";
const LANES_CMD = "tail -n 0 -F ~/.dori/lanes.log | grep --line-buffered LANE_";

type Sim = { arm: { command: string; description: string; pid: number }[]; ackPane: string; ackReport: boolean; ackInbox: boolean };

let state: { dir: string; done: () => void };
let w: World;
let sim: Sim;
let printed: string[];
let restarted: string[];
let live: Set<number>;

const monitor = (description: string, command: string, extra: Record<string, unknown> = {}) => ({ description, command, filter: "^\\{", persistent: true, suspended: false, expiresAt: Date.parse("2026-10-20T00:00:00Z"), runtime: { pid: 101 }, ...extra });

const writeManifest = (session: string, monitors: unknown[]) => {
  const file = manifestPath(join(state.dir, "sessions"), CWD, session);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, sessionId: session, monitors }));
};

const lane = (): Lane => ({ key: "demo", title: "Demo", thread: "discord:12345678", pane: "aoe_demo_12345678", brief: join(state.dir, "demo.md"), done: "merged o/r#1", openedAt: "2026-10-11T00:00:00Z", status: "working", lastReport: "[REPORT] demo | milestone | half way" });

const setup = async (): Promise<HandoverDeps> => {
  const clock = fakeClock(Date.parse("2026-10-11T16:35:00Z"));
  const base = depsFor(w, { ...clock, sleep: async () => simulate() }, state.dir, { backend: "aoe", leadPane: OLD, sessionsDir: join(state.dir, "sessions"), update: { repo: "/repo", services: [{ unit: "dori-lanes", paths: [], log: "", ready: "" }], readyTimeoutSec: 5, alertPane: OLD, announce: "" } });
  w.aoe = [{ id: OLD_ID, title: "lead", path: CWD, tool: "omo", profile: "main" }];
  w.tmux = [OLD];
  writeManifest("old-sid", [
    monitor("inbox", INBOX_CMD),
    monitor("lanes", LANES_CMD, { runtime: { pid: 102 } }),
    monitor("paused watch", "tail -F /tmp/suspended", { suspended: true }),
    monitor("expired watch", "tail -F /tmp/expired", { expiresAt: Date.parse("2026-10-01T00:00:00Z") }),
    monitor("digest due", "until false; do sleep 60; done", { persistent: false }),
  ]);
  const sessionDir = sessionDirFor(join(state.dir, "sessions"), CWD);
  writeFileSync(join(sessionDir, "2026-10-08T08-13-21-349Z_old-sid.jsonl"), [
    JSON.stringify({ type: "custom", customType: "senpi.todo-state", data: { phases: [{ name: "Old", tasks: [{ content: "stale task", status: "pending" }] }] } }),
    JSON.stringify({ type: "custom", customType: "senpi.todo-state", data: { phases: [{ name: "Work", tasks: [{ content: "finished task", status: "completed" }, { content: "watch the E7 run", status: "in_progress" }] }] } }),
  ].join("\n"));
  writeFileSync(join(state.dir, "config.json"), JSON.stringify({ backend: "aoe", leadPane: OLD, update: { alertPane: OLD } }));
  writeFileSync(join(state.dir, "dori.env"), `DORI_DISCORD_CHANNEL=1\nDORI_LEAD_AOE_ID=${OLD_ID}\nDORI_LEAD_TMUX=${OLD}\n`);
  writeFileSync(lane().brief, `Do the work.\n- Report ... sent to pane ${OLD} as an argv array.\n- run ["tmux","send-keys","-t","=${OLD}:","-l","--","<report line>"]\n`);
  await base.registry.write(lane());
  new QuestionStore(join(state.dir, "discord")).create("Ship it?", ["yes", "no"], "1", { thread: "12345678", tmux: OLD, session: "old-sid" }, "2026-10-11T00:00:00Z");
  let n = 0;
  return {
    ...base,
    configPath: join(state.dir, "config.json"),
    envPath: join(state.dir, "dori.env"),
    cardDir: join(state.dir, "discord"),
    inbox: join(state.dir, "inbox.jsonl"),
    home: "/home/test",
    sessionOf: async (pane) => (pane === OLD ? "old-sid" : pane === NEW ? "new-sid" : ""),
    routedPane: async () => (JSON.parse(readFileSync(join(state.dir, "config.json"), "utf8")) as { leadPane: string }).leadPane,
    envLeadPane: "",
    alive: (pid) => live.has(pid),
    timers: async () => ["Sat 2026-10-17 08:30:00 UTC 5 days - - dori-remind-droneshow.timer dori-remind-droneshow.service"],
    restart: async (unit) => {
      restarted.push(unit);
      return undefined;
    },
    nonce: () => `n${++n}`,
    print: (line) => printed.push(line),
  };
};

// The new session as the fake world sees it: once prompted it arms its monitors, and it acks the probes it receives.
const simulate = () => {
  if (!w.calls.some((c) => c[1] === "send-keys" && c.includes(`=${NEW}:`) && (c.at(-1) ?? "").includes("handover note"))) return;
  writeManifest("new-sid", sim.arm.map((m) => monitor(m.description, m.command, { runtime: { pid: m.pid } })));
  const at = "2026-10-11T16:40:00Z";
  if (sim.ackReport && w.calls.some((c) => c[1] === "send-keys" && c.includes(`=${NEW}:`) && (c.at(-1) ?? "").includes("HANDOVER_PROBE n1"))) ackHandover(state.dir, "n1", sim.ackPane, at);
  const inbox = join(state.dir, "inbox.jsonl");
  if (sim.ackInbox && existsSync(inbox) && readFileSync(inbox, "utf8").includes("HANDOVER_PROBE n2")) ackHandover(state.dir, "n2", sim.ackPane, at);
};

const stopped = () => w.calls.some((c) => c[0] === "aoe" && c[1] === "session" && c[2] === "stop");
const leadPaneInConfig = () => (JSON.parse(readFileSync(join(state.dir, "config.json"), "utf8")) as { leadPane: string }).leadPane;

beforeEach(() => {
  state = withState();
  w = newWorld();
  sim = { arm: [{ description: "inbox", command: INBOX_CMD, pid: 201 }, { description: "lanes", command: LANES_CMD.replace("~/", "/home/test/"), pid: 202 }], ackPane: NEW, ackReport: true, ackInbox: true };
  printed = [];
  restarted = [];
  live = new Set([101, 102, 201, 202]);
});
afterEach(() => state.done());

test("the note lists open lanes, the running monitors, open cards, unfinished todos and timers; --dry-run moves nothing", async () => {
  // Given
  const deps = await setup();
  // When
  const r = await handover(deps, { dryRun: true });
  // Then
  expect(r.code).toBe(0);
  const note = readFileSync(r.note ?? "", "utf8");
  expect(note).toContain("| demo | working | aoe_demo_12345678 | discord:12345678 | [REPORT] demo / milestone / half way |");
  expect(note).toContain(`- inbox: command ${JSON.stringify(INBOX_CMD)} filter "^\\\\{"`);
  expect(note).toContain(`- lanes: command ${JSON.stringify(LANES_CMD)}`);
  expect(note).not.toContain("/tmp/suspended");
  expect(note).not.toContain("/tmp/expired");
  expect(note).toMatch(/One-shot watches[^\n]*\n- digest due/);
  expect(note).toContain("- Q1: Ship it?");
  expect(note).toContain("- Work: watch the E7 run (in_progress)");
  expect(note).not.toContain("finished task");
  expect(note).not.toContain("stale task");
  expect(note).toContain("dori-remind-droneshow.timer");
  expect(printed.some((l) => l.startsWith("HANDOVER_DRY_RUN would open aoe session \"lead-10111635\""))).toBe(true);
  expect(w.calls.some((c) => c[0] === "aoe" && c[1] === "add")).toBe(false);
  expect(leadPaneInConfig()).toBe(OLD);
});

test("refuses before changing anything when the old lead runs no persistent monitor", async () => {
  // Given
  const deps = await setup();
  writeManifest("old-sid", [monitor("paused watch", "tail -F /tmp/suspended", { suspended: true })]);
  // When
  const r = await handover(deps, { title: "lead2" });
  // Then
  expect(r.code).toBe(2);
  expect(printed[0]).toStartWith("HANDOVER_REFUSED no running persistent monitor found for aoe_lead_0a0a0a0a");
  expect(w.calls.some((c) => c[0] === "aoe" && c[1] === "add")).toBe(false);
  expect(leadPaneInConfig()).toBe(OLD);
});

test("refuses while DORI_LEAD_PANE overrides the config, since lanes would keep reporting to the old pane", async () => {
  // Given
  const deps = { ...(await setup()), envLeadPane: OLD };
  // When
  const r = await handover(deps, { title: "lead2" });
  // Then
  expect(r.code).toBe(2);
  expect(printed[0]).toStartWith(`HANDOVER_REFUSED DORI_LEAD_PANE=${OLD} is set`);
  expect(w.calls.some((c) => c[0] === "aoe" && c[1] === "add")).toBe(false);
});

test("refuses while another handover holds the lock, and takes over a lock whose process is gone", async () => {
  // Given
  const deps = await setup();
  mkdirSync(join(state.dir, "handover"), { recursive: true });
  writeFileSync(join(state.dir, "handover", "lock"), JSON.stringify({ pid: 101, at: "2026-10-11T16:30:00Z" }));
  // When
  const busy = await handover(deps, { title: "lead2" });
  live.delete(101);
  const after = await handover(deps, { title: "lead2", noMonitors: true, verifyMin: 1 });
  // Then
  expect(busy.code).toBe(2);
  expect(printed.find((l) => l.startsWith("HANDOVER_REFUSED another handover is running (pid 101"))).toBeDefined();
  expect(after.to).toBe(NEW);
  expect(existsSync(join(state.dir, "handover", "lock"))).toBe(false);
});

test("moves config, env, lanes and cards to the new session, checks monitors and both probes, and only then closes the old one", async () => {
  // Given
  const deps = await setup();
  // When
  const r = await handover(deps, { title: "lead2", note: lane().brief });
  // Then
  expect(r).toMatchObject({ code: 0, to: NEW });
  expect(leadPaneInConfig()).toBe(NEW);
  expect((JSON.parse(readFileSync(join(state.dir, "config.json"), "utf8")) as { update: { alertPane: string } }).update.alertPane).toBe(NEW);
  expect(readFileSync(join(state.dir, "dori.env"), "utf8")).toBe(`DORI_DISCORD_CHANNEL=1\nDORI_LEAD_AOE_ID=${NEW_AOE_ID}\nDORI_LEAD_TMUX=${NEW}\n`);
  const brief = readFileSync(lane().brief, "utf8");
  expect(brief).toContain(`"=${NEW}:"`);
  expect(brief).not.toContain(OLD);
  expect(sent(w).some((t) => t.startsWith(`[LEAD] The lead moved to tmux session ${NEW}.`))).toBe(true);
  const card = new QuestionStore(join(state.dir, "discord")).get("Q1");
  expect(card).toMatchObject({ tmux: NEW, session: "new-sid" });
  expect(restarted).toEqual(["dori-lanes"]);
  const probeAt = w.calls.findIndex((c) => c[1] === "send-keys" && c.includes(`=${NEW}:`) && (c.at(-1) ?? "") === `[REPORT] handover-probe | milestone | HANDOVER_PROBE n1: run dori handover ack n1 --state ${state.dir}`);
  const stopAt = w.calls.findIndex((c) => c[0] === "aoe" && c[1] === "session" && c[2] === "stop" && c[3] === OLD_ID);
  expect(probeAt).toBeGreaterThan(-1);
  expect(stopAt).toBeGreaterThan(probeAt);
  expect(w.calls.some((c) => c[0] === "aoe" && c[1] === "rm" && c[2] === OLD_ID)).toBe(true);
  expect(printed).toContain("HANDOVER_MONITORS_OK 2 in aoe_lead2_5e5e5e5e (session new-sid)");
  expect(printed.some((l) => l.startsWith(`HANDOVER_DONE ${OLD} -> ${NEW}`))).toBe(true);
  expect(readFileSync(r.note ?? "", "utf8")).toContain("## The old lead's notes\nDo the work.");
});

test("an inbox probe acked by the old lead does not count: nothing is closed and everything moves back", async () => {
  // Given
  const deps = await setup();
  sim.ackInbox = false;
  const original = deps.nonce;
  let acked = false;
  const withOldAck: HandoverDeps = {
    ...deps,
    nonce: () => {
      const id = original();
      if (id === "n2" && !acked) {
        acked = true;
        ackHandover(state.dir, "n2", OLD, "2026-10-11T16:40:00Z");
      }
      return id;
    },
  };
  // When
  const r = await handover(withOldAck, { title: "lead2", verifyMin: 1 });
  // Then
  expect(r.code).toBe(3);
  expect(printed.find((l) => l.startsWith("HANDOVER_VERIFY_FAIL"))).toContain(`the inbox probe was acked from ${OLD}, not ${NEW}`);
  expect(stopped()).toBe(false);
  expect(leadPaneInConfig()).toBe(OLD);
  expect(readFileSync(join(state.dir, "dori.env"), "utf8")).toContain(`DORI_LEAD_TMUX=${OLD}\n`);
  expect(readFileSync(lane().brief, "utf8")).not.toContain(NEW);
  expect(new QuestionStore(join(state.dir, "discord")).get("Q1")?.tmux).toBe(OLD);
  expect(sent(w).some((t) => t.startsWith(`[LEAD] Handover to ${NEW} failed`))).toBe(true);
  expect(printed.some((l) => l.startsWith(`HANDOVER_ROLLED_BACK ${OLD} stays the lead`))).toBe(true);
});

test("a monitor whose process died in the new session counts as missing, so the old lead stays", async () => {
  // Given
  const deps = await setup();
  live.delete(202);
  // When
  const r = await handover(deps, { title: "lead2", verifyMin: 1 });
  // Then
  expect(r.code).toBe(3);
  expect(printed.find((l) => l.startsWith("HANDOVER_VERIFY_FAIL"))).toContain("monitors not running in aoe_lead2_5e5e5e5e: lanes");
  expect(stopped()).toBe(false);
  expect(leadPaneInConfig()).toBe(OLD);
  expect(w.calls.some((c) => c[1] === "send-keys" && (c.at(-1) ?? "").startsWith("[REPORT] handover-probe"))).toBe(false);
  expect(existsSync(join(state.dir, "inbox.jsonl"))).toBe(false);
});
