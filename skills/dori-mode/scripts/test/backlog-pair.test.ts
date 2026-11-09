import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { backlogTick, dropItem, type InboxRow, laneKeyOf, pairIntake, readItem, type TickDeps } from "../src/backlog.ts";
import { pairHandled } from "../src/backlog-pair.ts";
import type { BacklogSettings } from "../src/config.ts";
import type { Lane } from "../src/registry.ts";
import { repliedTo, sendKey, sendOnce } from "../src/send-dedupe.ts";

// a #dori-pair repair request the lead already took up (his reply to it, a lane of his naming it) must not start a bl-pair
// lane 1-2 minutes later (2026-11-09: pair-1569061847150231603, -1569093323359002725, -1569098506688266301,
// -1569135350507638795 each got a second lane)
const SETTINGS: BacklogSettings = { enabled: true, everyMin: 60, maxLanes: 3, maxStarts: 3, hostMaxLanes: 3, hostDir: "", pairRepairPattern: "^수돌, 수리 요청", intakeDone: "file {stateDir}/backlog/reports/{id}.md", writeNeedsOwnerLink: false, feedCommand: [], orderKinds: [], dayReportAt: "", timeZone: "UTC" };
const NOW = Date.parse("2026-11-08T23:44:40Z");
const REQUEST = "1569135350507638795";

let root: string;
let state: string;
let lanes: Lane[];
let launched: string[];
const sent = () => join(state, "sent");

const lane = (key: string, brief: string, noThread?: string): Lane => ({ key, title: key, thread: "none", brief, done: "file /d", openedAt: "2026-11-08T23:44:16Z", ...(noThread ? { noThread } : {}) });

const deps = (): TickDeps => ({
  stateDir: state,
  settings: { ...SETTINGS, hostDir: join(root, "host") },
  now: () => NOW,
  lanes: async () => lanes,
  busy: async () => [],
  limited: () => undefined,
  host: { dir: join(root, "host"), user: "me", instance: "i1", max: 3 },
  launch: async (item, _brief, key) => {
    launched.push(item.id);
    lanes.push(lane(key, join(state, "backlog", "launched", `${item.id}.md`)));
    return { pane: `p_${item.id}`, startup: "STARTUP_OK" };
  },
  inbox: () => {},
  // as cli-deps-backlog.ts wires it
  handled: (item, all) => pairHandled(item, all, (id) => repliedTo(sent(), id)),
});

const posts = (...ids: string[]): InboxRow[] => [{ id: "1569000000000000000", scope: "pair-bot", author_id: "B1", content: "옛 글" }, ...ids.map((id) => ({ id, scope: "pair-bot", author_id: "B1", channel_id: "P", content: `수돌, 수리 요청: ${id}` }))];
const intake = (list: InboxRow[]) => pairIntake({ stateDir: state, settings: SETTINGS, rows: () => list, pairBots: ["B1"], guild: "G", now: () => NOW });
// the lead's `dori send discord --to P --reply <id>`, through the same record as the CLI
const reply = (to: string, id: string) => sendOnce(sent(), "discord:P", sendKey(["discord", "P", to, undefined, `고쳤어 ${to}`]), async () => ({ id }), { replyTo: to });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "backlog-pair-test-"));
  state = join(root, "state");
  lanes = [];
  launched = [];
  intake(posts());
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("a repair request this Dori already replied to is not started: BACKLOG_ALREADY_HANDLED with the reply, kept dropped", async () => {
  // Given: the lead replied to the request before the pass took it in
  await reply(REQUEST, "1569135589213610026");
  intake(posts(REQUEST));
  // When
  const lines = await backlogTick(deps(), { force: true });
  const again = await backlogTick(deps(), { force: true });
  // Then
  expect(launched).toEqual([]);
  expect(lines.filter((l) => l.startsWith("BACKLOG_ALREADY_HANDLED"))).toEqual([`BACKLOG_ALREADY_HANDLED pair-${REQUEST} reply 1569135589213610026 (this Dori's post answering ${REQUEST})`]);
  expect(readItem(state, `pair-${REQUEST}`)?.status).toBe("dropped");
  expect(again.join("\n")).not.toContain(REQUEST);
});

test("a repair request a lane of the lead names as its own (#dori-pair <id> in the [목표] line, or the --no-thread reason) is not started; a quote elsewhere does not count", async () => {
  // Given: the lead's lanes name 2001 as the brief's [목표] (as the lead writes it) and 2002 in the --no-thread reason;
  // another lane quotes 2003 in its body and 2004 in its [목표] without the #dori-pair mark; a bl- lane names 2005
  const brief = (name: string, text: string): string => {
    writeFileSync(join(root, name), text);
    return join(root, name);
  };
  lanes.push(
    lane("moodori-vpn-edge", brief("lead.md", "[목표] 무돌 수리 요청(#dori-pair 1569000000000002001): keep.ts\n")),
    lane("rv-occlude-self", join(root, "missing.md"), "공돌 #dori-pair 수리 요청 1569000000000002002"),
    lane("other-fix", brief("other.md", "ulw\n[목표] 백로그 고장(pair-1569000000000002004)\n[자료] #dori-pair 1569000000000002003 과 같은 고장\n")),
    lane("bl-pair-1569000000000001999", brief("bl.md", "[목표] 수리 요청(#dori-pair 1569000000000002005)\n")),
  );
  intake(posts("1569000000000002001", "1569000000000002002", "1569000000000002003", "1569000000000002004", "1569000000000002005", "15690000000000020011"));
  // When: room for every start
  const lines = await backlogTick({ ...deps(), settings: { ...SETTINGS, hostDir: join(root, "host"), maxLanes: 9, maxStarts: 9 }, host: { ...deps().host, max: 9 } }, { force: true });
  // Then: the quoted, unmarked, backlog-lane and longer ids start as before
  expect(lines.filter((l) => l.startsWith("BACKLOG_ALREADY_HANDLED"))).toEqual([
    "BACKLOG_ALREADY_HANDLED pair-1569000000000002001 lane moodori-vpn-edge (its [목표] line names #dori-pair 1569000000000002001)",
    "BACKLOG_ALREADY_HANDLED pair-1569000000000002002 lane rv-occlude-self (its --no-thread reason names 1569000000000002002)",
  ]);
  expect(launched.sort()).toEqual(["pair-15690000000000020011", "pair-1569000000000002003", "pair-1569000000000002004", "pair-1569000000000002005"].sort());
});

test("an answered repair request is dropped while no lane may start (slots full, host busy), not left to start after its reply record is gone", async () => {
  // Given: no room and a busy host; the lead replied to the request
  await reply(REQUEST, "1569135589213610026");
  intake(posts(REQUEST));
  // When
  const lines = await backlogTick({ ...deps(), busy: async () => ["load 30"], settings: { ...SETTINGS, hostDir: join(root, "host"), maxLanes: 0 } }, { force: true });
  // Then
  expect(lines).toContain(`BACKLOG_ALREADY_HANDLED pair-${REQUEST} reply 1569135589213610026 (this Dori's post answering ${REQUEST})`);
  expect(readItem(state, `pair-${REQUEST}`)?.status).toBe("dropped");
  expect(launched).toEqual([]);
});

test("a repair request nobody answered starts as before, and a reply to another post or a post without a reply target does not hold it", async () => {
  // Given
  await reply("1569000000000003999", "1569000000000004000");
  await sendOnce(sent(), "discord:P", sendKey(["discord", "P", undefined, undefined, "그냥 글"]), async () => ({ id: "1569000000000004001" }));
  intake(posts("1569000000000003001"));
  // When
  const lines = await backlogTick(deps(), { force: true });
  // Then
  expect(launched).toEqual(["pair-1569000000000003001"]);
  expect(lines.join("\n")).not.toContain("BACKLOG_ALREADY_HANDLED");
  expect(readItem(state, "pair-1569000000000003001")).toMatchObject({ status: "running", lane: laneKeyOf("pair-1569000000000003001") });
});

test("dori backlog drop of a repair request not taken in yet keeps it out: the intake skips it when it comes; another unknown id still fails", () => {
  // Given / When: dropped ahead, then the post reaches the inbox
  const ahead = dropItem(state, `pair-${REQUEST}`, "리드가 직접 고침", new Date(NOW).toISOString());
  const lines = intake(posts(REQUEST));
  // Then
  expect(ahead).toMatchObject({ id: `pair-${REQUEST}`, status: "dropped", row: REQUEST });
  expect(ahead.log.map((l) => l.what)).toEqual(["dropped before intake: 리드가 직접 고침"]);
  expect(lines).toEqual([]);
  expect(readItem(state, `pair-${REQUEST}`)?.status).toBe("dropped");
  expect(() => dropItem(state, "typo-1", "x", "t")).toThrow(/no backlog item typo-1/);
});
