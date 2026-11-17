import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";

import { runDirectiveAudit } from "../src/directive-audit.ts";
import { enforcerGone } from "../src/directive-enforced.ts";
import { COMMON_LEDGER, ledgerProblems, ledgerTable, loadLedger, textDirectives } from "../src/directives.ts";
import { renderBrief } from "../src/launch.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

let state: ReturnType<typeof withState>;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

const fields = "ulw\n\n[목표] 로그인 고침\n[끝난 상태] x\n[사용자와 장면] y\n[넘으면 안 되는 선] 없음\n\n위치: ~/app\n";
const write = async (name: string, text: string) => {
  const path = join(state.dir, name);
  await Bun.write(path, text);
  return path;
};
const entry = (id: string, enforced: { by: string; token: string } | undefined, mode = "code") => ({
  id,
  name: `${id} 이름`,
  by: "lead",
  basis: "fixture basis line",
  rule: `${id} 규칙 문장이다.`,
  date: "2026-11-17",
  source: "https://discord.com/channels/1/2/3",
  scope: { all: true },
  mode,
  ...(enforced ? { enforced } : {}),
});
// a local layer with one code entry whose check is in a file, and one whose token is not there (the check was removed)
const ledgerWith = async (checkText: string) => {
  const check = await write("check.ts", checkText);
  const local = { entries: [entry("kept-check", { by: `${check}:refuse`, token: "KEPT_REFUSED" }), entry("lost-check", { by: `${check}:refuse`, token: "LOST_REFUSED" })] };
  return { common: COMMON_LEDGER, local: await write("local.json", JSON.stringify(local)) };
};
const input = (brief: string) => ({ key: "lane-a", title: "t", brief, done: 'command ["bun","test"]', cwd: "/work/app", goal: "g", noThread: "test lane" });

test("a code entry needs its check named (enforced by and token); a host ledger may point a fork entry at a check outside the fork", async () => {
  const ledger = loadLedger({ directives: await ledgerWith('throw new Error("KEPT_REFUSED x");') });
  const base = ledger.entries.find((e) => e.id === "kept-check")!;
  const { enforced: _e, ...unchecked } = base;
  const { rule: _r, ...noText } = base;
  expect(ledgerProblems(ledger)).toEqual([]);
  expect(ledgerProblems({ ...ledger, entries: [unchecked] })).toEqual(["directive kept-check: a code directive needs enforced { by, token } (the check that enforces it)"]);
  expect(ledgerProblems({ ...ledger, entries: [{ ...base, enforced: { by: base.enforced!.by, token: "has space" } }] })[0]).toContain("enforced.token must be");
  expect(ledgerProblems({ ...ledger, entries: [{ ...noText, by: "owner" }] })).toEqual(["directive kept-check: a code directive needs words or a rule (it goes into briefs again when its check is gone)"]);
  expect(ledgerProblems({ ...ledger, entries: [{ ...base, layer: "common" }] })).toEqual([]);
  expect(ledgerProblems({ ...ledger, entries: [{ ...base, mode: "nope" as "code" }] })[0]).toBe("directive kept-check: mode must be inject|require|lead|code");
});

test("launch leaves a code entry out of the brief while its check is in the code; a check that is gone puts it in as inject again", async () => {
  const directives = await ledgerWith('throw new Error("KEPT_REFUSED x");');
  const deps = depsFor(newWorld(), fakeClock(Date.parse("2026-11-17T00:00:00Z")), state.dir, { directives, watchLog: join(state.dir, "watch.log") });
  const r = await renderBrief(deps, input(await write("brief.md", fields)));
  expect(r.text).not.toContain("[리드 규칙 kept-check]");
  expect(r.text).toContain("[리드 규칙 lost-check]\nlost-check 규칙 문장이다.");
  const loaded = loadLedger({ directives });
  expect(loaded.entries.find((e) => e.id === "kept-check")?.mode).toBe("code");
  expect(loaded.entries.find((e) => e.id === "lost-check")).toMatchObject({ mode: "inject", gone: { why: `token LOST_REFUSED is no longer in ${join(state.dir, "check.ts")}`, from: "code" } });
  // the lead's hints (an owner message, a thread he opens) leave it out too while the check stands
  expect(textDirectives("아무 글", loaded, { all: true }).map((x) => x.e.id)).toEqual(expect.not.arrayContaining(["kept-check"]));
  expect(textDirectives("아무 글", loaded, { all: true }).map((x) => x.e.id)).toContain("lost-check");
});

test("the ledger table says which check enforces an entry, and that a check is gone", async () => {
  const table = ledgerTable(loadLedger({ directives: await ledgerWith('"KEPT_REFUSED"') }));
  expect(table).toMatch(/\| kept-check \|.*\| 코드가 강제함\(KEPT_REFUSED\) \| 로컬 \|$/m);
  expect(table).toMatch(/\| lost-check \|.*\| 주입 · 검사 사라짐\(token LOST_REFUSED is no longer in .*check\.ts\) \| 로컬 \|$/m);
  expect(table).toMatch(/\| eight-steps \|.*\| 주입\(eight-steps\) · 코드가 강제함\(LAUNCH_STEPS_ADDED\) \| 포크 \|$/m);
});

test("dori directive-audit names an entry whose check is gone (DIRECTIVE_ENFORCER_GONE), a code one and one that keeps its mode", async () => {
  const directives = await ledgerWith("nothing left here");
  const deps = depsFor(newWorld(), fakeClock(Date.parse("2026-11-17T00:00:00Z")), state.dir, { directives, watchLog: join(state.dir, "watch.log") });
  const r = await runDirectiveAudit(deps, { since: "2026-11-16T00:00:00.000Z", inbox: join(state.dir, "inbox.jsonl"), owner: "7", dryRun: true });
  const gone = r.lines.filter((l) => l.startsWith("DIRECTIVE_ENFORCER_GONE"));
  expect(gone).toEqual([
    `DIRECTIVE_ENFORCER_GONE kept-check: token KEPT_REFUSED is no longer in ${join(state.dir, "check.ts")} (enforced by ${join(state.dir, "check.ts")}:refuse); it goes into briefs as inject again until the check is back or the ledger names the new one`,
    `DIRECTIVE_ENFORCER_GONE lost-check: token LOST_REFUSED is no longer in ${join(state.dir, "check.ts")} (enforced by ${join(state.dir, "check.ts")}:refuse); it goes into briefs as inject again until the check is back or the ledger names the new one`,
  ]);
});

test("an entry of another mode whose check is gone keeps its mode, and the table and the audit both say the check is gone (review 1 of #493)", async () => {
  const check = await write("check.ts", "nothing here");
  const local = { entries: [entry("lead-check", { by: `${check}:refuse`, token: "LEAD_REFUSED" }, "lead")].map((e) => ({ ...e, check: "none" })) };
  const directives = { common: COMMON_LEDGER, local: await write("local.json", JSON.stringify(local)) };
  const loaded = loadLedger({ directives });
  expect(loaded.entries.find((e) => e.id === "lead-check")).toMatchObject({ mode: "lead", gone: { from: "lead" } });
  expect(ledgerTable(loaded)).toMatch(/\| lead-check \|.*\| 리드 행동\(기계 확인 없음, intent-check가 읽음\) · 검사 사라짐\(token LEAD_REFUSED is no longer in .*check\.ts\) \| 로컬 \|$/m);
  const deps = depsFor(newWorld(), fakeClock(Date.parse("2026-11-17T00:00:00Z")), state.dir, { directives, watchLog: join(state.dir, "watch.log") });
  const r = await runDirectiveAudit(deps, { since: "2026-11-16T00:00:00.000Z", inbox: join(state.dir, "inbox.jsonl"), owner: "7", dryRun: true });
  expect(r.lines.filter((l) => l.startsWith("DIRECTIVE_ENFORCER_GONE lead-check:"))[0]).toEndWith("; it keeps mode lead until the check is back or the ledger names the new one");
});

test("a host line whose enforced is not { by, token } is left out by the tolerant load and the fork entry stands; the audit still runs (review 1 of #493)", async () => {
  const directives = { common: COMMON_LEDGER, local: await write("local.json", JSON.stringify({ entries: [{ id: "eight-steps", enforced: null }, { id: "four-fields", enforced: { by: 3, token: "X" } }] })) };
  const loaded = loadLedger({ directives }, { tolerant: true });
  expect(loaded.skipped?.filter((l) => l.includes("enforced"))).toEqual([
    "DIRECTIVES_LOCAL_SKIP eight-steps: its local line is left out and the fork entry stands (enforced must be { by, token })",
    "DIRECTIVES_LOCAL_SKIP four-fields: its local line is left out and the fork entry stands (enforced.by must name the file (and symbol) of the check; enforced.token must be the check's refusal or warning token (letters, digits, _ . -))",
  ]);
  expect(loaded.entries.find((e) => e.id === "eight-steps")?.enforced?.token).toBe("LAUNCH_STEPS_ADDED");
  const deps = depsFor(newWorld(), fakeClock(Date.parse("2026-11-17T00:00:00Z")), state.dir, { directives, watchLog: join(state.dir, "watch.log") });
  const r = await runDirectiveAudit(deps, { since: "2026-11-16T00:00:00.000Z", inbox: join(state.dir, "inbox.jsonl"), owner: "7", dryRun: true });
  expect(r.lines.some((l) => l.startsWith("DIRECTIVES_LOCAL_SKIP eight-steps:"))).toBe(true);
});

test("every check the fork ledger names is in this checkout (renaming a token means updating the ledger in the same change)", () => {
  const fork = loadLedger({ directives: { common: COMMON_LEDGER, local: "" } });
  const named = fork.entries.filter((e) => e.enforced);
  expect(named.length).toBeGreaterThan(0);
  expect(named.flatMap((e) => (enforcerGone(e.enforced!) ? [`${e.id}: ${enforcerGone(e.enforced!)}`] : []))).toEqual([]);
});
