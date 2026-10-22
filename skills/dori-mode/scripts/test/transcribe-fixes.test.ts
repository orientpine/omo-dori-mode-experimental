import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "../../setups/discord-aoe/transcribe_fixes.py");
let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dori-fixes-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const fix = async (ledger: string, transcript: string) => {
  writeFileSync(join(dir, "ledger.csv"), ledger);
  const p = Bun.spawn(["python3", "-I", SCRIPT, join(dir, "ledger.csv")], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  p.stdin.write(transcript);
  p.stdin.end();
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err: err.trim() };
};

test("a ledger pair of three syllables or more is replaced in the spoken words and the particle follows the new word", async () => {
  const r = await fix(
    "틀린표기,올바른표기\n에이아이디,에이아이랩\n로보틱스,로봇팀\n드론컨트,드론컨트롤\n",
    "[00:00:05] 화자1: 에이아이디가 로보틱스로 가요\n[00:01:00] 화자2: 드론컨트으로 보내고 에이아이디는\n",
  );
  expect(r).toEqual({
    code: 0,
    out: "[00:00:05] 화자1: 에이아이랩이 로봇팀으로 가요\n[00:01:00] 화자2: 드론컨트롤로 보내고 에이아이랩은\n",
    err: "LEDGER_APPLIED pairs=3 short_skipped=0 edits=4",
  });
});

test("a short pair, a comment and a one-column row change nothing, and the speaker head is never touched", async () => {
  const r = await fix("# owner pairs\n면도,연도\n화자1,사람1\n바른표기만\n", "[00:00:05] 화자1: 면도 얘기 화자1 이름\n");
  expect(r).toEqual({
    code: 0,
    out: "[00:00:05] 화자1: 면도 얘기 사람1 이름\n",
    err: "LEDGER_APPLIED pairs=1 short_skipped=1 edits=1",
  });
});

test("an empty ledger leaves the transcript byte for byte, tab-separated rows count as pairs", async () => {
  const text = "[00:00:00] 화자1: 그대로 둔다\n";
  expect(await fix("", text)).toEqual({ code: 0, out: text, err: "LEDGER_APPLIED pairs=0 short_skipped=0 edits=0" });
  expect((await fix("그대로\t이대로\n", text)).out).toBe("[00:00:00] 화자1: 이대로 둔다\n");
});
