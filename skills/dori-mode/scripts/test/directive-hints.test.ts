import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { messageLines } from "../src/directive-hints.ts";
import { COMMON_LEDGER, directiveLine, ledgerProblems, loadLedger, textDirectives } from "../src/directives.ts";
import { withState } from "./fakes.ts";

let state: ReturnType<typeof withState>;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

const write = async (name: string, text: string) => {
  const path = join(state.dir, name);
  await Bun.write(path, text);
  return path;
};

// 2026-11-02 QA on ZzangDori's real ledger: its 30 every-lane local entries came before request-thread, the one entry the
// thread's words called, and a broken local file left the host's own directives out of a message's row without a word
test("what the text calls comes before every-lane entries of either layer, and a message's row says when local lines were left out", async () => {
  const everyLane = { id: "host-every-lane", name: "host every lane", by: "lead", rule: "Every lane here.", basis: "fixture basis line", date: "2026-11-02", source: "x", scope: { all: true }, mode: "inject" };
  const ledger = loadLedger({ directives: { common: COMMON_LEDGER, local: await write("every.json", JSON.stringify({ entries: [everyLane] })) } });
  const ids = textDirectives("Claude 10/29 카드 처리", ledger, { all: true }).map(({ e }) => e.id);
  expect(ids[0]).toBe("request-thread");
  expect(ids.indexOf("host-every-lane")).toBeGreaterThan(0);
  expect(messageLines("카드 처리", ledger)).toEqual([directiveLine(ledger.entries.find((e) => e.id === "request-thread")!)]);
  const broken = loadLedger({ directives: { common: COMMON_LEDGER, local: await write("broken.json", "{ not json") } }, { tolerant: true });
  const lines = messageLines("카드 처리", broken);
  expect(lines.length).toBe(2);
  expect(lines[1]).toStartWith("[장부 경고] 이 도리 로컬 장부에서 1줄을 못 읽어 뺐다: DIRECTIVES_LOCAL_SKIP");
});

// 2026-11-11: YooDori's sixth 회신 entry pushed mail-check-sent out of the row of "회신 초안 써줘" (HINT_LIMIT 5)
test("every entry a keyword calls is in a message's row; kind matches only fill it up to HINT_LIMIT", async () => {
  const mail = Array.from({ length: 6 }, (_, i) => ({ id: `mail-${i}`, name: `mail ${i}`, by: "owner", basis: "fixture basis line", words: `회신 규칙 ${i}`, prompt: `회신 규칙 ${i}.`, date: "2026-11-11", source: `https://discord.com/channels/1/2/${i + 10}`, scope: { keywords: ["회신"] }, mode: "inject" }));
  const ledger = loadLedger({ directives: { common: COMMON_LEDGER, local: await write("mail.json", JSON.stringify({ entries: mail })) } });
  expect(ledgerProblems(ledger)).toEqual([]);
  const ids = mail.map((e) => e.id);
  expect(messageLines("회신 초안 써줘", ledger)).toEqual(mail.map((e) => directiveLine(ledger.entries.find((x) => x.id === e.id)!)));
  // the kind matches of "이 PC에서 강화학습 돌려" (four, above) get no room next to six keyword matches, and two next to three
  expect(messageLines("회신 초안 쓰고 이 PC에서 강화학습 돌려", ledger).length).toBe(6);
  const three = loadLedger({ directives: { common: COMMON_LEDGER, local: await write("mail3.json", JSON.stringify({ entries: mail.slice(0, 3) })) } });
  const lines = messageLines("회신 초안 쓰고 이 PC에서 강화학습 돌려", three);
  expect(lines.length).toBe(5);
  expect(lines.slice(0, 3)).toEqual(ids.slice(0, 3).map((id) => directiveLine(three.entries.find((x) => x.id === id)!)));
});

// review of #440: an entry with kinds and keywords gets its kind's reason as why; its keyword still keeps it in the row
test("an entry whose kind gave its why still comes in by its keyword", async () => {
  const entry = (id: string, scope: object) => ({ id, name: id, by: "owner", basis: "fixture basis line", words: `${id} 규칙`, prompt: `${id} 규칙.`, date: "2026-11-11", source: "https://discord.com/channels/1/2/9", scope, mode: "inject" });
  const mail = [...Array.from({ length: 5 }, (_, i) => entry(`mail-${i}`, { keywords: ["회신"] })), entry("mixed", { kinds: ["learning"], keywords: ["회신"] })];
  const ledger = loadLedger({ directives: { common: COMMON_LEDGER, local: await write("mixed.json", JSON.stringify({ entries: mail })) } });
  expect(ledgerProblems(ledger)).toEqual([]);
  expect(textDirectives("회신 강화학습", ledger).find(({ e }) => e.id === "mixed")?.why).toStartWith("learning work");
  expect(messageLines("회신 강화학습", ledger)).toContain(directiveLine(ledger.entries.find((e) => e.id === "mixed")!));
});
