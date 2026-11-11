import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ackHandover, launchOf, manifestPath, type MonitorSpec, missingMonitors, verify } from "../src/handover.ts";
import { ranToEnd } from "../src/handover-ran.ts";
import { verifyLane } from "../src/lane-handover.ts";
import { sessionDirFor } from "../src/session-id.ts";
import { depsFor, newWorld, RUNNING, sent } from "./fakes.ts";

// SooDori's lead handover 20261111-142213 (w9:p15 -> hc:t6) rolled back with "monitors not running in hc:t6: UPDATE 15분
// 조용함(#414·#456)": the old lead's one-shot gate starts work (LAUNCHES_WORK), the new session re-armed it as a watch-only
// one with the same description and filter, and that watch printed UPDATE_QUIET_456 and exited 0 at 14:35:39Z, before the
// check at 14:37:49Z. omo drops an ended watch from its manifest; what is left is its wake in the session log.
const HOME = "/home/soodori";
const CWD = "/home/soodori/Documents/soodori";
const DESC = "UPDATE 15분 조용함(#414·#456)";
const OLD = "f=~/.soodori/state/update.json; until [ \"$(( $(date +%s) - $(stat -c %Y $f) ))\" -ge 900 ]; do sleep 30; done; printf 'UPDATE_QUIET_456\\n'";
const REARMED = 'until test -n "$(find /home/soodori/.soodori/state/update.json -mmin +15 2>/dev/null)"; do sleep 30; done; echo UPDATE_QUIET_456';
const FILTER = "^UPDATE_QUIET_456";
const DONE = "watcher completed (exit code 0)";
const launched = (command: string, filter = FILTER): MonitorSpec => {
  const launch = launchOf(command, HOME);
  if (!launch) throw new Error(`not work: ${command}`);
  return { description: DESC, command, filter, persistent: true, launch };
};
const gate = launched(OLD);

type Args = { description: string; command?: string; filter?: string; persistent?: boolean };
// the new session's monitor call as its eval cell records it, and a wake omo delivered for one or more monitors
const arm = (args: Args) => ({ type: "message", message: { role: "toolResult", toolName: "eval", details: { toolCalls: [{ name: "monitor", ok: true, args, resultPreview: "Monitor started with ID: mon_SVVDTHZT1XBHDWPW" }] } } });
const wake = (groups: { description: string; bodies: string[]; kinds: string[] }[]) => ({
  type: "custom_message",
  customType: "senpi-monitor:notification",
  content: `<system-reminder>${groups.map((g) => `Monitor event(${g.description}): ${g.bodies.join("\n")}`).join("\n")}</system-reminder>`,
  display: false,
  details: { monitors: groups.map((g, i) => ({ id: `bash_${i + 2}`, description: g.description, eventCount: g.bodies.length, kinds: g.kinds })) },
});
const fired = (bodies = ["UPDATE_QUIET_456", DONE], description = DESC) => wake([{ description, bodies, kinds: ["line", "summary"] }]);
const watchOnly: Args = { description: DESC, command: REARMED, filter: FILTER, persistent: true };
const { filter: _a, ...unfiltered } = watchOnly;
const { filter: _b, ...unfilteredGate } = gate;
const SCREEN = "❯ \n────\n Claude·x ▕██▏ 60%\n~/work • CH85.0% • $0.5 • 90K/1M (9.0%) (auto)    (anthropic-subscription@x) claude-opus-5-5 • effort high (shift+tab)\n(OmO) mem:x";

let dir: string;
let sessionsDir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "handover-ran-"));
  sessionsDir = join(dir, "sessions");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const sessionLog = (rows: object[]) => {
  const sessionDir = sessionDirFor(sessionsDir, CWD);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, "2026-11-11T14-22-15-149Z_new-sid.jsonl"), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
};
const manifest = (monitors: object[]) => {
  const file = manifestPath(sessionsDir, CWD, "new-sid");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, monitors }));
};
const missing = (wanted: MonitorSpec[], rows: object[]) => {
  sessionLog(rows);
  return missingMonitors(wanted, [], () => true, HOME, 0, ranToEnd(sessionDirFor(sessionsDir, CWD), "new-sid", HOME));
};

test("the re-armed watch-only form of a one-shot gate is a watch, not work", () => {
  expect(launchOf(REARMED, HOME)).toBeUndefined();
  // find only as a read: an action that runs, deletes or writes, or a word that expands, is work
  for (const action of ["-exec rm {} ;", "-execdir rm {} +", "-ok rm {} ;", "-delete", "-fprint /tmp/x", "-fls /tmp/x", "-newer $f"]) expect([action, launchOf(`until test -n "$(find /tmp/u.json -mmin +15 ${action})"; do sleep 30; done; echo X`, HOME) !== undefined]).toEqual([action, true]);
});

test("the lead's handover goes on when the new session's watch-only gate fired and exited 0 before the check, and before the commit", async () => {
  for (const when of ["before the first check", "between the first check and the commit"] as const) {
    // Given: the old lead's unfinished one-shot gate (LAUNCHES_WORK), re-armed watch-only by the new lead
    const w = newWorld();
    const pane = "new-lead";
    const inbox = join(dir, `inbox-${when.length}.jsonl`);
    w.tmux = [pane];
    w.screens[pane] = SCREEN;
    if (when === "before the first check") {
      sessionLog([arm(watchOnly), fired()]);
      manifest([]);
    } else {
      sessionLog([arm(watchOnly)]);
      manifest([{ ...watchOnly, persistent: true, runtime: { pid: 4242 } }]);
    }
    // the gate ends once the new lead acked a probe (between the two checks), or had ended already
    const sleep = async () => {
      const ids = [...[...sent(w), existsSync(inbox) ? readFileSync(inbox, "utf8") : ""].join("\n").matchAll(/HANDOVER_PROBE (n\d+)/g)].map((m) => m[1] ?? "");
      for (const id of ids) ackHandover(dir, id, pane, "2026-11-11T14:37:00Z");
      if (ids.length && when !== "before the first check") {
        sessionLog([arm(watchOnly), fired()]);
        manifest([]);
      }
    };
    let n = 0;
    const deps = { ...depsFor(w, { now: () => 0, sleep }, dir, { backend: "aoe", sessionsDir }), sessionOf: async () => "new-sid", alive: () => true, home: HOME, inbox, routedPane: async () => pane, nonce: () => `n${++n}` } as never;
    const lines: string[] = [];
    // When
    const r = await verify(deps, { cwd: CWD, monitors: [gate], watchers: [], todos: [] } as never, { pane, aoeId: "", session: "" }, 1, "", (l) => lines.push(l));
    // Then: the move commits
    expect([when, r.reasons]).toEqual([when, []]);
    expect(lines).toContain(`HANDOVER_MONITORS_OK 1 in ${pane} (session new-sid)`);
  }
});

test("a lane's handover goes on when the new session's re-armed gate fired and exited 0 before the check", async () => {
  // Given
  sessionLog([arm(watchOnly), fired()]);
  const screen = `${SCREEN}\n${RUNNING}`;
  const deps = { sessionOf: async () => "new-sid", config: { sessionsDir, stateDir: dir }, alive: () => true, home: HOME, clock: { now: () => 0, sleep: async () => {} }, run: async (argv: string[]) => ({ code: argv[1] === "capture-pane" ? 0 : 1, out: argv[1] === "capture-pane" ? screen : "", err: "" }) } as never;
  const lines: string[] = [];
  // When
  const r = await verifyLane(deps, { cwd: CWD, model: "anthropic-subscription/claude-opus-5-5:high", thinking: "high", monitors: [gate], todos: [] } as never, "new-lane", 1, "", (l) => lines.push(l));
  // Then: the monitors pass; the check stops at the probe, since the first turn still runs
  expect(lines).toContain("HANDOVER_MONITORS_OK 1 in new-lane (session new-sid)");
  expect(r.reasons).toEqual(["the first turn of new-lane was still running after the verify time; the probe was not sent"]);
});

test("a plain command gate the new session armed again and ran to its end is not missing", () => {
  const ready: MonitorSpec = { description: "x ready", command: "until [ -f /tmp/x ]; do sleep 5; done; echo READY", filter: "^READY$", persistent: true };
  expect(missing([ready], [arm({ ...ready }), fired(["READY", DONE], "x ready")])).toEqual([]);
});

test("a watch that did not end normally, or whose end cannot be told from its own lines, is still missing", () => {
  const cases: [string, object[], MonitorSpec?][] = [
    ["never armed in the new session", [fired()]],
    ["armed, no wake yet", [arm(watchOnly)]],
    ["the wake came before the call", [fired(), arm(watchOnly)]],
    ["exit 1", [arm(watchOnly), fired(["UPDATE_QUIET_456", "watcher completed (exit code 1)"])]],
    ["a line that reads like the summary, then exit 1", [arm(watchOnly), fired(["UPDATE_QUIET_456", DONE, "watcher completed (exit code 1)"])]],
    ["an omo notice after the summary", [arm(watchOnly), fired(["UPDATE_QUIET_456", DONE, "[3 more lines in /tmp/overflow.log]"])]],
    ["killed at its deadline", [arm(watchOnly), fired(["UPDATE_QUIET_456", "watcher killed at deadline (timed_out)"])]],
    ["no signal line before it ended", [arm(watchOnly), wake([{ description: DESC, bodies: [DONE], kinds: ["summary"] }])]],
    ["no summary in the wake, only a line that reads like one", [arm(watchOnly), wake([{ description: DESC, bodies: ["UPDATE_QUIET_456", DONE], kinds: ["line"] }])]],
    ["armed with no filter: any line of its own passes", [arm(unfiltered), fired()], unfilteredGate],
    ["a filter that also passes the summary's words", [arm({ ...watchOnly, filter: "QUIET|watcher" }), fired()], { ...gate, filter: "QUIET|watcher" }],
    ["another monitor's lines in the same wake", [arm(watchOnly), wake([{ description: "other", bodies: [`Monitor event(${DESC}): ${DONE}`], kinds: ["line"] }, { description: DESC, bodies: ["UPDATE_QUIET_456", "watcher completed (exit code 1)"], kinds: ["line", "summary"] }])]],
    ["not persistent", [arm({ ...watchOnly, persistent: false }), fired()]],
    ["re-armed with the command that starts work", [arm({ ...watchOnly, command: OLD }), fired()]],
    ["a second watch with the same description and another command", [arm(watchOnly), arm({ ...watchOnly, command: "sleep 1; echo UPDATE_QUIET_456" }), fired()]],
  ];
  for (const [name, rows, wanted = gate] of cases) expect([name, missing([wanted], rows)]).toEqual([name, [`${DESC} (starts work: arm a watch-only one with the same description)`]]);
});
