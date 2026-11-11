import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { watchTick, type FlowDeps } from "../src/done-flow.ts";
import { sessionDirFor } from "../src/session-id.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

test.each(["clear", "custom-log", "unrelated"])("aoe send then %s with a new child survives the first watcher reconciliation", async (kind) => {
  const state = withState(), at = Date.parse("2026-01-01T12:00:00Z"), min = 60_000;
  const old = "11111111-1111-1111-1111-111111111111", current = "22222222-2222-2222-2222-222222222222";
  const pane = "aoe_Dori_0a1b2c3d", cwd = "/home/test/dori", owner = "100000000000000001", sessionsDir = join(state.dir, "sessions");
  const dir = kind === "custom-log" ? join(state.dir, "custom logs") : sessionDirFor(sessionsDir, cwd), cleared = kind !== "unrelated";
  mkdirSync(dir, { recursive: true });
  const oldPath = join(dir, `2026-01-01T11-59-00-000Z_${old}.jsonl`), currentPath = join(dir, `2026-01-01T12-03-00-000Z_${current}.jsonl`);
  const first = "1569339203593044020", second = "1569339203593044021";
  writeFileSync(oldPath, [
    { type: "session", id: old, cwd, timestamp: new Date(at - min).toISOString() },
    { type: "session_info", name: "Dori" },
    { type: "message", timestamp: new Date(at + 2 * min).toISOString(), message: { role: "assistant", content: [{ type: "toolCall", name: "bash", id: "send", arguments: { command: `dori send discord --to C --reply ${first} --text answer` } }] } },
    { type: "message", timestamp: new Date(at + 2 * min + 1).toISOString(), message: { role: "toolResult", toolCallId: "send", content: [{ type: "text", text: "SENT 153000000000000001" }] } },
  ].map((entry) => JSON.stringify(entry)).join("\n"));
  writeFileSync(currentPath, `${JSON.stringify({ type: "session", id: current, cwd, timestamp: new Date(at + 3 * min).toISOString() })}\n${JSON.stringify({ type: "session_info", name: "Dori" })}\n`);
  utimesSync(oldPath, new Date(at + 2 * min), new Date(at + 2 * min));
  utimesSync(currentPath, new Date(at + 3 * min), new Date(at + 3 * min));
  const inbox = join(state.dir, "inbox.jsonl");
  writeFileSync(inbox, [first, second].map((id, i) => JSON.stringify({ id, ts: new Date(at + i * min).toISOString(), author_id: owner, channel_id: "C", scope: "channel", content: i ? "still waiting" : "answered" })).join("\n"));
  const world = newWorld();
  world.aoe = [{ id: "0a1b2c3d4e5f6a7b", title: "Dori", path: cwd, tool: "omo", profile: "main" }];
  world.tmux = [pane];
  world.screen = "❯ \n Claude │ pool\n(OmO) mem:repo just now ◉ watching inbox";
  world.agentStart = new Date(at - min).toUTCString();
  const argv = ["/x/senpi/dist/bundle/cli.js", ...(kind === "custom-log" ? ["--session-dir", dir] : []), "--session-id", cleared ? old : current];
  world.cmdlines = { 11: argv };
  world.ps = `10 1 /bin/bash\n11 10 ${argv.join(" ")}\n12 11 /bin/sleep 100\n`;
  const base = depsFor(world, fakeClock(at + 20 * min), state.dir, { backend: "aoe", leadPane: pane, sessionsDir, leadInboxMin: 0 });
  const run: FlowDeps["run"] = async (argv, opts) => argv[0] === "ps" && argv[1] === "eww" && argv.at(-1) === "12"
    ? { code: 0, out: `/bin/sleep 100 PI_SESSION_ID=${current} PI_SESSION_FILE=${currentPath}`, err: "" } : base.run(argv, opts);
  try {
    expect(existsSync(join(state.dir, "lead-answered.json"))).toBe(false);
    expect(existsSync(join(state.dir, "herdr-sessions.json"))).toBe(false);
    const lines = await watchTick({ ...base, run, readGoal: async () => ({ status: "active" }), ownerInbox: { path: inbox, ownerId: owner, ownerChannel: "C" } });
    expect(lines).toEqual([`LEAD_OWNER_WAITING ${pane} ${cleared ? 1 : 2} owner message(s), oldest ${new Date(at + (cleared ? min : 0)).toISOString()} (${cleared ? 19 : 20} min); woke the lead (SUBMITTED)`]);
    expect(existsSync(join(state.dir, "lead-answered.json")) ? JSON.parse(readFileSync(join(state.dir, "lead-answered.json"), "utf8")) : []).toEqual(cleared ? [first] : []);
  } finally { state.done(); }
});
