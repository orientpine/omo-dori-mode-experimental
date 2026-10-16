import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";

import { runDirectiveAudit } from "../src/directive-audit.ts";
import { COMMON_LEDGER, DirectiveError, directiveText, ledgerProblems, loadLedger, scopeContext } from "../src/directives.ts";
import { DirectiveMissingError, eightSteps, launchLane, renderBrief, uiSteps } from "../src/launch.ts";
import { depsFor, fakeClock, newWorld, sent, withState, type World } from "./fakes.ts";

let state: ReturnType<typeof withState>;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

const T0 = Date.parse("2026-10-16T06:00:00Z");
const fields = "ulw\n\n[목표] 로그인 고침\n[끝난 상태] x\n[사용자와 장면] y\n[넘으면 안 되는 선] 없음\n\n위치: ~/app\n";
const write = async (name: string, text: string) => {
  const path = join(state.dir, name);
  await Bun.write(path, text);
  return path;
};
// a host layer like the owner's: a repo directive, a learning one, and the names the lead uses for them
const local = {
  entries: [
    { id: "options-ledger", name: "옵션 장부·순서 기록", by: "owner", basis: "fixture basis line", words: "내가 이것저것 시도하는 옵션들이 실제로 얼마나 학습에 유용했는지 내가 요청할 때마다 다 표로 정리되어 있었으면 좋겠어", rule: "같은 커밋에서 옵션 장부 줄을 갱신한다.", date: "2026-10-16", source: "https://discord.com/channels/1/2/3", scope: { repos: ["hr35-isaac"] }, mode: "inject" },
    { id: "no-rl-here", name: "이 PC 학습 금지", by: "owner", basis: "fixture basis line", words: "이 PC에서는 강화학습 자체는 하지 말고 테스트 같은 거는 가끔 가끔 돌려도 돼", date: "2026-10-15", source: "https://discord.com/channels/1/2/4", scope: { kinds: ["learning", "gpu"] }, mode: "inject" },
    { id: "gpu-rule", name: "GPU 규칙", by: "owner", basis: "fixture basis line", words: "Gpu제한 같은거 모두 없애", date: "2026-10-15", source: "x", scope: { kinds: ["gpu"] }, mode: "inject" },
    { id: "docs-same-pr", source: "https://discord.com/channels/1/2/5" },
  ],
  reviewed: ["900"],
};
const ledgerDeps = async (patch = {}) => depsFor(world, fakeClock(T0), state.dir, { directives: { common: COMMON_LEDGER, local: await write("local.json", JSON.stringify(local)) }, watchLog: join(state.dir, "watch.log"), ...patch });
const input = (brief: string, extra = {}) => ({ key: "lane-a", title: "t", brief, done: 'command ["bun","test"]', cwd: "/work/hr35-isaac", goal: "g", ...extra });
const count = (text: string, s: string) => text.split(s).length - 1;

test("the fork ledger validates, carries the template's directives and holds no links, paths or ids; a local entry overrides by id", async () => {
  const fork = loadLedger({ directives: { common: COMMON_LEDGER, local: "" } });
  expect(ledgerProblems(fork)).toEqual([]);
  expect(fork.entries.map((e) => e.id)).toEqual(expect.arrayContaining(["eight-steps", "four-fields", "ui-steps", "docs-same-pr", "lane-thread", "ledger-same-day"]));
  expect(await Bun.file(COMMON_LEDGER).text()).not.toMatch(/discord(?:app)?\.com|\/home\/|~\/|\d{15,}/);
  const both = loadLedger((await ledgerDeps()).config);
  expect(ledgerProblems(both)).toEqual([]);
  const docs = both.entries.find((e) => e.id === "docs-same-pr");
  expect(docs?.source).toBe("https://discord.com/channels/1/2/5");
  expect(docs?.words).toBe("세션에서 작업 시 문서를 업데이트 하게 해당 프로젝트 지침에 추가해");
  expect(docs?.layer).toBe("common");
  // a rule the lead set never carries the owner's words: what he said that led to it is its trigger
  expect(both.entries.filter((e) => e.by === "lead").every((e) => !e.words && e.rule)).toBe(true);
  const lead = both.entries.find((e) => e.by === "lead")!;
  expect(ledgerProblems({ ...both, entries: [{ ...lead, words: "형 말처럼 붙인 문장" }] })).toEqual([`directive ${lead.id}: a lead rule has no owner words (put what he said in trigger)`]);
  expect(directiveText(lead)).toBe(`[리드 규칙 ${lead.id}]\n${lead.rule}`);
  expect(ledgerProblems({ ...both, entries: [...both.entries, { ...both.entries[0], id: "Bad Id", mode: "inject", scope: { kinds: ["nope"] } } as never] })).toEqual(["directive Bad Id: id must be lowercase words with -", "directive Bad Id: unknown kind nope"]);
});

test("launch puts an inject directive in scope into the brief as the ledger writes it, once; LAUNCH_DIRECTIVE_ADDED says which and why", async () => {
  const deps = await ledgerDeps();
  const options = loadLedger(deps.config).entries.find((e) => e.id === "options-ledger");
  const r = await renderBrief(deps, input(await write("brief.md", fields)));
  expect(r.missing).toEqual([]);
  expect(count(r.text, directiveText(options!))).toBe(1);
  // the owner's words byte for byte under a one-line tag; his directive is never summarised in the brief
  expect(r.text).toContain(`\n[형 지침 options-ledger, 2026-10-16]\n${options?.words}\n`);
  expect(r.text).not.toContain(options?.rule ?? "-");
  for (const e of loadLedger(deps.config).entries) {
    if (e.basis) expect(r.text).not.toContain(e.basis);
    if (e.trigger) expect(r.text).not.toContain(e.trigger);
  }
  expect(r.text.indexOf("## 형 지침 (지침 장부에서 dori launch가 넣음)")).toBeGreaterThan(r.text.indexOf("8. 보고:"));
  expect(r.text.indexOf("## 형 지침")).toBeLessThan(r.text.indexOf("## Lane footer"));
  expect(r.lines.find((l) => l.startsWith("LAUNCH_DIRECTIVE_ADDED lane-a:"))).toContain("options-ledger (repo hr35-isaac)");
  // another repo: not in scope
  expect((await renderBrief(deps, input(await write("b2.md", fields), { cwd: "/work/app" }))).text).not.toContain("[지침 options-ledger]");
  // a relaunch of the written brief adds nothing again
  const again = await renderBrief(deps, input(await write("b3.md", r.text)));
  expect(count(again.text, "[형 지침 options-ledger,")).toBe(1);
  expect(again.lines.some((l) => l.startsWith("LAUNCH_DIRECTIVE_ADDED"))).toBe(false);
});

test("a brief without the four fields stops the launch (LAUNCH_DIRECTIVE_MISSING, nothing opened); --waive with a reason lets it through and records it", async () => {
  const deps = await ledgerDeps({ backend: "aoe", leadPane: "aoe_Dori_0a1b2c3d" });
  const bare = "ulw\n\nfix the login loop\n";
  const brief = await write("bare.md", bare);
  const warned: string[] = [];
  const stopped = await launchLane(deps, input(brief), (l) => warned.push(l)).catch((e: unknown) => e);
  expect(stopped).toBeInstanceOf(DirectiveMissingError);
  expect(warned.find((l) => l.startsWith("LAUNCH_DIRECTIVE_MISSING lane-a four-fields:"))).toContain('--waive four-fields "<reason>"');
  expect(await deps.registry.read("lane-a")).toBeNull();
  expect(world.calls.some((c) => c[0] === "aoe" && c[1] === "add")).toBe(false);
  expect(await Bun.file(brief).text()).toBe(bare);
  expect(await Bun.file(deps.config.watchLog).text()).toMatch(/^\S+ launch LAUNCH_DIRECTIVE_MISSING lane-a four-fields:/m);
  await expect(launchLane(deps, input(brief, { waive: { "four-feilds": "typo" } }))).rejects.toBeInstanceOf(DirectiveError);
  const r = await launchLane(deps, input(brief, { waive: { "four-fields": "a one-line ops fix" } }));
  expect(r.lane.directives?.waived).toEqual([{ id: "four-fields", reason: "a one-line ops fix", at: new Date(T0).toISOString() }]);
  expect((await deps.registry.read("lane-a"))?.directives?.applied).toContain("docs-same-pr");
  expect(await Bun.file(deps.config.watchLog).text()).toMatch(/^\S+ launch LAUNCH_DIRECTIVE_WAIVED lane-a four-fields: 네 칸 left out on the lead's word: a one-line ops fix/m);
});

test("scope comes from the work, not from names or quotes: a brief about directives is not UI, learning, GPU or autophagy work", async () => {
  const ledger = loadLedger((await ledgerDeps()).config);
  // the brief that opened this feature's lane: it names the UI steps, the PC rule and the scopes, and does none of that work
  const meta = [
    "[목표] 형 10/16 13:56 KST 원문: \"앞으로 내가 설정한 지침이 절대로 빠지지 않도록 강제하는 프로세스 만들고 도리에도 푸쉬해줘\". 형이 정한 지침이 lane 브리프에서 빠지지 않게 기계로 강제하는 프로세스를 dori 포크에 만들고 푸시.",
    "[끝난 상태] (1) 지침 장부: 적용 범위(모든 lane / UI / 학습 / 릴리스·외부효과 / 노드·GPU / 오토파지 / 특정 저장소 등). 지금 지침에서 채움: 8단계 틀, UI 7단계, 이 PC 학습 금지, GPU 규칙, 관문 통과 시 미룬 결정 찾기, 승인 표 \"코드에 있음\" 열, 결과 본 뒤 바꾼 정의 표시, 문서 갱신 규칙, 옵션 장부·순서 기록 등 — 출처는 각 저장소 AGENTS.md(hr35·cytoplasm). (2) 강제: dori launch가 --ui·--cwd 저장소로 판정. (5) 시험, 문서, PR 머지·푸시, 재시작.",
  ].join("\n");
  const ctx = scopeContext(meta, ledger, { repo: "src" });
  expect(ctx.ui).toBe(false);
  expect(ctx.kinds).toEqual({});
  // the same words as work
  expect(scopeContext("[목표] 대시보드 화면을 고친다. 프론트엔드 디자인", ledger, { repo: "app" }).ui).toBe(true);
  const rl = scopeContext("E7 강화학습 학습을 노드에서 돌리고 보상 항을 고친다. 체크포인트는 iter 400.", ledger, { repo: "x" });
  expect(Object.keys(rl.kinds).sort()).toEqual(["learning"]);
  const r = await renderBrief(await ledgerDeps(), input(await write("meta.md", `ulw\n\n${meta}\n[사용자와 장면] x\n[넘으면 안 되는 선] 없음\n`), { cwd: "/work/src" }));
  expect(r.lines.some((l) => l.startsWith("LAUNCH_UI_HINT"))).toBe(false);
  expect(r.text).not.toContain("[UI 지침]");
  expect(r.text).not.toContain("no-rl-here");
  expect(r.text).not.toContain("gate-deferred");
});

test("directive-audit: gaps of the day go to the watch log and one summary to the lead; a day without gaps stays quiet", async () => {
  const deps = await ledgerDeps();
  const full = (await renderBrief(deps, input(await write("full.md", fields)))).text;
  const clean = { key: "clean", title: "c", thread: "discord:42", brief: await write("clean.md", full), done: "x", cwd: "/work/hr35-isaac", openedAt: "2026-10-16T05:00:00.000Z" };
  await deps.registry.write(clean);
  // an older lane is outside the window
  await deps.registry.write({ ...clean, key: "old", thread: "none", brief: "/nope.md", openedAt: "2026-10-14T00:00:00.000Z" });
  const inbox = await write("inbox.jsonl", "");
  const quiet = await runDirectiveAudit(deps, { since: "2026-10-15T06:00:00.000Z", inbox, owner: "7" });
  expect(quiet.lines).toEqual(["DIRECTIVE_AUDIT_OK since 2026-10-15T06:00:00.000Z: 1 lanes and the owner's messages read against 17 directives, no gap"]);
  expect(await Bun.file(deps.config.watchLog).exists()).toBe(false);
  expect(sent(world)).toEqual([]);
  // a lane whose brief lacks a directive and has no thread, and a standing directive of the owner nobody put in the ledger
  await deps.registry.write({ ...clean, key: "gappy", thread: "none", brief: await write("gappy.md", fields), cwd: "/work/hr35-isaac" });
  await Bun.write(inbox, [
    JSON.stringify({ ts: "2026-10-16T04:00:00.123456+00:00", id: "777", guild_id: "1", channel_id: "2", author_id: "7", content: "앞으로 lane 보고는 항상 표로 해" }),
    JSON.stringify({ ts: "2026-10-16T04:01:00+00:00", id: "900", author_id: "7", content: "앞으로 이건 지침 아님" }),
    JSON.stringify({ ts: "2026-10-16T04:02:00+00:00", id: "901", author_id: "8", content: "앞으로 항상 이렇게" }),
    JSON.stringify({ ts: "2026-10-16T04:03:00+00:00", id: "902", author_id: "7", content: "밥 먹었어?" }),
  ].join("\n"));
  const r = await runDirectiveAudit(deps, { since: "2026-10-15T06:00:00.000Z", inbox, owner: "7" });
  const kinds = r.gaps.map((g) => `${g.lane} ${g.id}`);
  expect(kinds).toEqual(expect.arrayContaining(["gappy docs-same-pr", "gappy options-ledger", "gappy lane-thread", "- 777"]));
  expect(kinds.some((k) => k.startsWith("clean ") || k === "- 900" || k === "- 901" || k === "- 902")).toBe(false);
  expect(r.lines.find((l) => l.startsWith("DIRECTIVE_UNLEDGERED"))).toContain("https://discord.com/channels/1/2/777");
  const log = await Bun.file(deps.config.watchLog).text();
  expect(log).toMatch(/^\S+ directive-audit DIRECTIVE_GAP gappy docs-same-pr:/m);
  expect(sent(world).filter((t) => t.startsWith("[DIRECTIVE_AUDIT] "))).toHaveLength(1);
  // a waiver on record is not a gap
  await deps.registry.write({ ...clean, key: "gappy", thread: "none", brief: await write("gappy.md", fields), directives: { applied: [], waived: [{ id: "lane-thread", reason: "ops", at: "t" }] } });
  expect((await runDirectiveAudit(deps, { since: "2026-10-15T06:00:00.000Z", inbox, owner: "7", dryRun: true })).gaps.some((g) => g.id === "lane-thread")).toBe(false);
});

test("the blocks the ledger names are the ones launch inserts", async () => {
  const deps = await ledgerDeps();
  const r = await renderBrief(deps, input(await write("ui.md", fields), { ui: true }));
  expect(r.text).toContain(await uiSteps());
  expect(r.text).toContain(await eightSteps());
  expect((await deps.registry.list()).length).toBe(0);
});
