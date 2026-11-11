import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sessionFile } from "../src/background.ts";
import type { FlowDeps } from "../src/done-flow.ts";
import { readHerdrSessions } from "../src/herdr-sessions.ts";
import { keepSessions } from "../src/lane-handover.ts";
import { QuestionStore } from "../src/messenger/discord-cards.ts";
import { readAnswerHistory, reconcileRows } from "../src/missed-answers.ts";
import { procTable, sessionDirFor } from "../src/session-id.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

test.each(["ack", "delivery", "history", "custom-log", "new-agent", "wrong-B-header", "rolled-back", "no-child", "stale-child", "custom-stale-child", "wrong-title", "rollback-stale-child"])("lane A to B then %s clear trusts only C's verified successor evidence and cache", async (kind) => {
  const state = withState(), at = Date.parse("2026-01-01T12:00:00Z"), iso = (t: number) => new Date(t).toISOString(), cwd = "/repo/asking";
  const a = "11111111-1111-1111-1111-111111111111", b = "22222222-2222-2222-2222-222222222222", c = "33333333-3333-3333-3333-333333333333", d = "44444444-4444-4444-4444-444444444444";
  const titleSelected = ["no-child", "stale-child", "custom-stale-child", "wrong-title", "rollback-stale-child"].includes(kind), custom = kind === "custom-log" || kind === "custom-stale-child";
  const oldPane = "aoe_Old_11111111", pane = "aoe_Asking_22222222", sessionsDir = join(state.dir, "sessions"), folder = sessionDirFor(sessionsDir, cwd), dir = custom ? join(state.dir, "live logs") : folder;
  const moves = join(state.dir, "handover", "lanes");
  mkdirSync(folder, { recursive: true }); mkdirSync(dir, { recursive: true }); mkdirSync(moves, { recursive: true });
  const aPath = join(folder, `2026-01-01T11-59-00-000Z_${a}.jsonl`), bPath = join(dir, `2026-01-01T12-00-02-000Z_${b}.jsonl`), cPath = join(dir, `2026-01-01T12-00-04-000Z_${c}.jsonl`), dPath = join(dir, `2026-01-01T12-00-06-000Z_${d}.jsonl`);
  const store = new QuestionStore(join(state.dir, "cards"));
  const q = store.create("first?", ["yes"], "CARD", { tmux: oldPane, session: a, thread: "CARD" }, iso(at - 1000)), q2 = store.create("second?", ["yes"], "CARD", { tmux: oldPane, session: a, thread: "CARD" }, iso(at - 900));
  store.answer(q.id, "yes", "button", iso(at)); store.answer(q2.id, "yes", "button", iso(at + 1000));
  const answered = { id: "answer-delivered", qid: q.id, thread: "CARD", tmux: oldPane, at: at + 300 }, pending = { ...answered, id: "answer-pending", qid: q2.id, at: at + 1300 };
  const evidence = kind === "delivery" ? [{ type: "custom_message", customType: "senpi-monitor:notification", content: JSON.stringify({ kind: "answer", qid: q.id, id: answered.id, ts: iso(at + 5000) }) }] : [
    { type: "message", timestamp: iso(at + 5000), message: { role: "assistant", content: [{ type: "toolCall", id: "reply", name: "bash", arguments: { command: `dori send discord --to CARD --text '${q.id} applied'` } }] } },
    { type: "message", message: { role: "toolResult", toolCallId: "reply", content: [{ type: "text", text: "SENT 153000000000000001" }] } },
  ];
  writeFileSync(aPath, JSON.stringify({ type: "session", id: a, cwd, timestamp: iso(at - 2000) }));
  writeFileSync(bPath, [{ type: "session", id: kind === "wrong-B-header" ? a : b, cwd, timestamp: iso(at + 2000) }, ...(titleSelected ? [{ type: "session_info", name: "Asking" }] : [])].map((entry) => JSON.stringify(entry)).join("\n"));
  writeFileSync(cPath, [{ type: "session", id: c, cwd, timestamp: iso(at + 4000) }, ...(titleSelected ? [{ type: "session_info", name: kind === "wrong-title" ? "Other" : "Asking" }] : []), ...evidence].map((entry) => JSON.stringify(entry)).join("\n"));
  writeFileSync(dPath, JSON.stringify({ type: "session", id: d, cwd, timestamp: iso(at + 6000) }));
  for (const [path, ms] of [[bPath, at + 2000], [cPath, at + 5000], [dPath, at + 6000]] as const) utimesSync(path, new Date(ms), new Date(ms));
  const world = newWorld(); world.aoe = [{ id: "22222222aaaaaaaa", title: "Asking", path: cwd, tool: "omo", profile: "main" }]; world.tmux = [pane];
  let agent = 11, childSession = titleSelected ? b : c;
  const configure = (flag: string, pid: number, started: number) => {
    agent = pid; const argv = ["/x/senpi/dist/bundle/cli.js", ...(custom ? ["--session-dir", dir] : []), "--session-id", flag];
    world.cmdlines = { [pid]: argv }; world.ps = `10 1 /bin/bash\n${pid} 10 ${argv.join(" ")}\n${kind === "no-child" ? "" : `${pid + 1} ${pid} /bin/sleep 100\n`}`; world.agentStart = new Date(started).toUTCString();
  };
  configure(b, 11, at + 2000);
  const base = depsFor(world, fakeClock(at + 8000), state.dir, { sessionsDir });
  const run: FlowDeps["run"] = async (argv, opts) => argv[0] === "ps" && argv[1] === "eww" && argv.at(-1) === String(agent + 1)
    ? { code: 0, out: `/bin/sleep 100 PI_SESSION_ID=${childSession} PI_SESSION_FILE=${childSession === d ? dPath : childSession === b ? bPath : cPath}`, err: "" } : base.run(argv, opts);
  const deps = { ...base, run, answerHistory: () => readAnswerHistory(store.answersFile) }, leadPath = join(state.dir, "lead.jsonl");
  writeFileSync(leadPath, JSON.stringify({ type: "session", id: "99999999-9999-9999-9999-999999999999", cwd: "/repo/lead" }));
  try {
    const lane = { key: "work", title: "Work", pane: oldPane, session: a, cwd, thread: "none", brief: "/brief", done: "merged acme/app#1", openedAt: iso(at - 60_000) };
    await deps.registry.write(lane); await deps.registry.patch(lane.key, { pane }); await keepSessions(deps, lane.key, a, b);
    const note = join(moves, "move.md"), from = { pane: oldPane, session: a, cwd };
    writeFileSync(note.replace(/\.md$/, ".json"), JSON.stringify({ lane, from, cwd, oldLog: aPath }));
    writeFileSync(note.replace(/\.md$/, ".result.json"), JSON.stringify({ at: iso(at + 2000), key: lane.key, to: pane, note, result: kind === "rolled-back" || kind === "rollback-stale-child" ? "rolled-back" : "done" }));
    store.retarget({ tmux: oldPane }, { tmux: pane, session: b });
    if (kind === "history" || kind === "new-agent") {
      if (kind === "new-agent") childSession = b;
      expect((await sessionFile(run, sessionsDir, pane, cwd, await procTable(run), state.dir))?.path).toBe(kind === "history" ? cPath : bPath);
      if (kind === "history") childSession = d;
      else { childSession = c; configure(c, 31, at + 4000); }
    }
    const good = ["ack", "delivery", "history", "custom-log", "no-child", "stale-child", "custom-stale-child"].includes(kind), cache = join(state.dir, "lead-answered.json");
    expect(existsSync(cache)).toBe(false);
    if (titleSelected) expect(readHerdrSessions(state.dir)[pane]).toBeUndefined();
    expect(await reconcileRows({ rows: [answered, pending], cards: store.all(), lead: { pane: "lead", path: leadPath, title: "", text: readFileSync(leadPath, "utf8") }, sessions: world.aoe, table: await procTable(run), deps })).toEqual({ waiting: good ? [pending] : [answered, pending], answeredIds: good ? [answered.id] : [] });
    expect(existsSync(cache) ? JSON.parse(readFileSync(cache, "utf8")) : []).toEqual(good ? [answered.id] : []);
    expect((await deps.registry.read(lane.key))?.session).toBe(b);
    if (good && !titleSelected) expect(readHerdrSessions(state.dir)[pane]?.previous?.some((s) => s.session === b)).toBe(true);
    if (titleSelected) {
      expect(readHerdrSessions(state.dir)[pane]?.session).toBe(b);
      expect(readHerdrSessions(state.dir)[pane]?.previous?.some((s) => s.session === c) ?? false).toBe(false);
    }
  } finally { state.done(); }
});
