import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verify } from "../src/handover.ts";
import { missingTodos, recentOwnerWords } from "../src/handover-todos.ts";
import { verifyLane } from "../src/lane-handover.ts";
import { sessionDirFor } from "../src/session-id.ts";
import { RUNNING } from "./fakes.ts";

// ZzangDori's lead handover 20261106-213407 (audit 2026-11-07): the owner wrote 64 messages in the 24 h before it and the
// note kept the newest 8, and two of his orders that OkDori and YooDori relayed in the pair room with "형 원문 <link>" were
// not in it at all (the relay's author is a Dori, the original is in another Dori's channel). Its two open todos were in
// the note, but the new lead wrote a todo list of its own and the handover never looked.
const OWNER = "280680578314010625";
const OKDORI = "okdori-bot";
const NOW = Date.parse("2026-11-06T21:34:00Z");
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "handover-todos-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("the note carries every owner message of the last 24 h and the owner's words a Dori relayed in the pair room", () => {
  // Given
  const inbox = join(dir, "inbox.jsonl");
  const own = Array.from({ length: 10 }, (_, i) => ({ ts: `2026-11-06T2${Math.floor(i / 6)}:${String((i % 6) * 9).padStart(2, "0")}:00Z`, id: `o${i}`, scope: "channel", channel_id: "c1", author_id: OWNER, content: `owner order ${i}` }));
  const rows = [
    { ts: "2026-11-05T20:00:00Z", id: "old", scope: "channel", channel_id: "c1", author_id: OWNER, content: "from before the window" },
    { ts: "2026-11-06T08:24:34Z", id: "relay-1", scope: "pair-bot", channel_id: "pair", author_id: OKDORI, content: '짱돌, 형 요청이야(형 원문 https://discord.com/channels/1/2/3 , 음성): "윈도우에서도 돌게 새로 만들라고 해".\n배경: 오픈방 사람이 막혔어.' },
    { ts: "2026-11-06T09:00:00Z", id: "p2", scope: "pair-bot", channel_id: "pair", author_id: OKDORI, content: "짱돌, 4eae 부하 내려갔어. 이제 ci 돌려도 돼." },
    ...own,
  ];
  writeFileSync(inbox, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  // When
  const words = recentOwnerWords(inbox, [OWNER], NOW);
  // Then: all ten of his own, the relayed order with the Dori that relayed it and his original's link, no plain pair talk
  expect(words.map((w) => w.text)).toEqual(["윈도우에서도 돌게 새로 만들라고 해", ...own.map((o) => o.content)]);
  expect(words[0]?.where).toBe(`relayed in the pair room by ${OKDORI} (message relay-1), the owner's original https://discord.com/channels/1/2/3`);
});

test("a todo of the old session counts as carried only when the new session's todo list holds its words, done or not", () => {
  // Given
  const sessionDir = join(dir, "sessions");
  const old = ["전환: 짱돌 리드를 Opus high로 전환하기 (in_progress)", "확인: 여섯 도리 모델과 실제 응답 확인하기 (pending)", "Report: Report per brief footer format (pending)"];
  const log = (tasks: { content: string; status: string }[]) =>
    writeFileSync(join(dir, "2026-11-06T21-34-09-103Z_new-sid.jsonl"), `${JSON.stringify({ type: "custom", customType: "senpi.todo-state", data: { phases: [{ name: "인수인계", tasks }] } })}\n`);
  // When: the new lead wrote its own list, as db696e0a did ("여섯 리드 6/6 직접 재측정")
  log([{ content: "핸드오버 노트 전체 읽기", status: "completed" }, { content: "여섯 리드 6/6 직접 재측정", status: "pending" }]);
  // Then
  expect(missingTodos(old, dir, "new-sid")).toEqual(["짱돌 리드를 Opus high로 전환하기", "여섯 도리 모델과 실제 응답 확인하기", "Report per brief footer format"]);
  // When: it put the note's todos into its list (one already finished)
  log([{ content: "짱돌 리드를 Opus high로 전환하기", status: "completed" }, { content: "여섯 도리 모델과 실제 응답 확인하기", status: "in_progress" }, { content: "Report per brief footer format", status: "pending" }]);
  // Then
  expect(missingTodos(old, dir, "new-sid")).toEqual([]);
  // and a session without a log holds none of them
  expect(missingTodos(old, sessionDir, "gone-sid")).toHaveLength(3);
});

// the new session as the checks see it: its omo session id, and its todo list in its log under the session directory
const CWD = "/work/lead";
const newSession = (todos: string[]): string => {
  const sessionsDir = join(dir, "sessions");
  const sessionDir = sessionDirFor(sessionsDir, CWD);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, "2026-11-06T21-38-47-680Z_new-sid.jsonl"), `${JSON.stringify({ type: "custom", customType: "senpi.todo-state", data: { phases: [{ name: "Work", tasks: todos.map((content) => ({ content, status: "pending" })) }] } })}\n`);
  return sessionsDir;
};
const SCREEN = "❯ \n────\n Claude·x ▕██▏ 60%\n~/work • CH85.0% • $0.5 • 90K/1M (9.0%) (auto)    (anthropic-subscription@x) claude-opus-5-5 • effort high (shift+tab)\n(OmO) mem:x";
const deps = (sessionsDir: string, screen = SCREEN) =>
  ({ sessionOf: async () => "new-sid", config: { sessionsDir, stateDir: dir }, alive: () => true, home: "/home/test", clock: { now: () => 0, sleep: async () => {} }, routedPane: async () => "another-pane", run: async (argv: string[]) => ({ code: argv[1] === "capture-pane" ? 0 : 1, out: argv[1] === "capture-pane" ? screen : "", err: "" }) }) as never;

test("the lead's handover check holds the move while an open todo of the old lead is not in the new lead's todo list", async () => {
  // Given: the old lead's open todo, and a new lead that wrote a list of its own
  const facts = { cwd: CWD, monitors: [], watchers: [], todos: ["전환: 짱돌 리드를 Opus high로 전환하기 (in_progress)"] } as never;
  const lines: string[] = [];
  // When
  const lost = await verify(deps(newSession(["여섯 리드 6/6 직접 재측정"])), facts, { pane: "new-lead", aoeId: "", session: "" }, 1, "", (l) => lines.push(l));
  // Then
  expect(lost.reasons).toEqual(["todos not in the todo list of new-lead: 짱돌 리드를 Opus high로 전환하기"]);
  // When: the new lead put the note's todo into its list, the check goes on to the next step (here: where lanes report)
  const carried = await verify(deps(newSession(["짱돌 리드를 Opus high로 전환하기"])), facts, { pane: "new-lead", aoeId: "", session: "" }, 1, "", (l) => lines.push(l));
  // Then
  expect(lines).toContain("HANDOVER_TODOS_OK 1 in the todo list of new-lead");
  expect(carried.reasons).toEqual(["lanes would still report to another-pane, not new-lead"]);
});

test("a lane's handover check holds the move while an open todo of the old session is not in the new session's todo list", async () => {
  // Given: ZzangDori's directive-model-defaults lane, whose new session wrote a plan of its own
  const facts = { cwd: CWD, model: "anthropic-subscription/claude-opus-5-5:high", thinking: "high", monitors: [], todos: ["Execution: Cleanup worktree RUN_TMP and QA resources (pending)", "Report: Report per brief footer format (pending)"] } as never;
  const lines: string[] = [];
  // When
  const lost = await verifyLane(deps(newSession(["Post-merge dry-run, local link, REPORT update", "Report per brief footer format"])), facts, "new-lane", 1, "", (l) => lines.push(l));
  // Then
  expect(lost.reasons).toEqual(["todos not in the todo list of new-lane: Cleanup worktree RUN_TMP and QA resources"]);
  expect(lines).not.toContain("HANDOVER_TODOS_OK 2 in the todo list of new-lane");
  // When: both are in its list (and its first turn still runs, so the check stops before the probe)
  const carried = await verifyLane(deps(newSession(["Cleanup worktree RUN_TMP and QA resources", "Report per brief footer format"]), `${SCREEN}\n${RUNNING}`), facts, "new-lane", 1, "", (l) => lines.push(l));
  // Then
  expect(lines).toContain("HANDOVER_TODOS_OK 2 in the todo list of new-lane");
  expect(carried.reasons).toEqual(["the first turn of new-lane was still running after the verify time; the probe was not sent"]);
});
