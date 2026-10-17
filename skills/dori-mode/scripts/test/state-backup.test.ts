import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { approve, BACKUP_DEFAULTS, type BackupDeps, backupStep, backupTick, branchFor, loadSecrets, pushAll, pushCheck, type Secrets } from "../src/state-backup.ts";
import { commitDir } from "../src/state-git.ts";

let root: string;
let dir: string;
let bare: string;
let now: number;
let visibility: string;
let busy: string[];
let secrets: Secrets;
const REPO = "o/dori-local-test";
const REAL = "kimm-vpn-Pw-7731"; // a real secret value with no token shape, as in an env file

const deps = (): BackupDeps => ({
  settings: { dirs: [], everyMin: 10, maxFileKb: 512, timeoutSec: 30, timeZone: "", backup: { ...BACKUP_DEFAULTS, repo: REPO } },
  backup: { ...BACKUP_DEFAULTS, repo: REPO },
  timeZone: "Asia/Seoul",
  now: () => now,
  print: () => undefined,
  stateDir: join(root, "state"),
  home: root,
  visibility: async () => visibility,
  remoteUrl: () => bare,
  secrets: async () => secrets,
  busy: async () => busy,
});
const put = (rel: string, text: string): void => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
};
const git = (at: string, ...args: string[]): string => Bun.spawnSync(["git", "-C", at, ...args]).stdout.toString().trim();
const remoteFiles = (branch: string): string[] => git(bare, "ls-tree", "-r", "--name-only", branch).split("\n").filter(Boolean).sort();
const remoteHas = (text: string): boolean => Bun.spawnSync(["git", "-C", bare, "grep", "-q", "-F", text, ...git(bare, "rev-list", "--all").split("\n").filter(Boolean)]).exitCode === 0;
const kst = (hhmm: string): number => Date.parse(`2026-10-18T${hhmm}:00+09:00`);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "state-backup-"));
  dir = join(root, ".dori");
  bare = join(root, "remote.git");
  mkdirSync(dir);
  Bun.spawnSync(["git", "init", "-q", "--bare", bare]);
  now = kst("06:00");
  visibility = "private";
  busy = [];
  writeFileSync(join(root, "dori.env"), `KIMM_VPN_PASSWORD=${REAL}\nDORI_DISCORD_GUILD=1528936606264856737\n`);
  writeFileSync(join(root, "inbox.jsonl"), `${JSON.stringify({ author_kind: "owner", content: "로컬 도리들은 비공개 레포로 올려두기 그리고 푸시는 대기 상태일때 새벽6시에 수행" })}\n`);
  secrets = loadSecrets([join(root, "dori.env")], [join(root, "inbox.jsonl")], [], 30, []);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const OWNER = "로컬 도리들은 비공개 레포로 올려두기 그리고 푸시는 대기 상태일때 새벽6시에 수행";

test("a remote that is not private gets nothing; a private one gets the snapshot on the directory's branch", async () => {
  // Given: a Dori's state, committed, and the lead's approval
  put("config.json", "{}\n");
  put("state/lanes/a.json", '{"key":"a"}\n');
  await commitDir(deps(), dir);
  approve(deps(), "lead: test", []);
  // When: the repo is public
  visibility = "public";
  const refused = await pushAll(deps(), [dir]);
  // Then
  expect(refused).toEqual([`STATE_GIT_PUSH_REFUSED ${dir} ${REPO} is public, not private: nothing pushed`]);
  expect(git(bare, "for-each-ref")).toBe("");
  // When: it is private
  visibility = "private";
  const pushed = await pushAll(deps(), [dir]);
  // Then
  expect(pushed.some((l) => l.startsWith(`STATE_GIT_PUSHED ${dir} ${REPO}:dot-dori `))).toBe(true);
  expect(remoteFiles("dot-dori")).toEqual([".gitignore", "config.json", "state/lanes/a.json"]);
  expect((await pushAll(deps(), [dir])).at(-1)).toBe(`STATE_GIT_PUSH_NOCHANGE ${dir}`);
});

test("a file with a real secret value or the owner's words is left out of the push; the ledger keeps his words", async () => {
  // Given: a lane note holding the VPN password, a handover note quoting the owner, the directive ledger quoting him
  put("state/lanes/vpn.json", `{"note":"pw is ${REAL}"}\n`);
  put("state/handover/x.md", `the owner said: ${OWNER}\n`);
  put("directives.json", `{"entries":[{"original":"${OWNER}"}]}\n`);
  put("state/lanes/b.json", "{}\n");
  await commitDir(deps(), dir);
  approve(deps(), "lead: test", []);
  // When
  const lines = await pushAll(deps(), [dir]);
  // Then
  expect(lines).toContain(`STATE_GIT_PUSH_LEFT_OUT ${dir} state/lanes/vpn.json real-secret (a value from dori.env)`);
  expect(lines).toContain(`STATE_GIT_PUSH_LEFT_OUT ${dir} state/handover/x.md owner-message x1`);
  expect(remoteFiles("dot-dori")).toEqual([".gitignore", "directives.json", "state/lanes/b.json"]);
  expect(remoteHas(REAL)).toBe(false);
  // and the local repo still has every file
  expect(git(dir, "ls-files")).toContain("state/lanes/vpn.json");
});

test("a secret in the local history holds the repo until the lead accepts it, and the history never leaves", async () => {
  // Given: a commit once held the password (by hand, past the hook), a later one removed it
  put("notes.md", `vpn ${REAL}\n`);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "notes.md");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--no-verify", "-m", "notes");
  put("notes.md", "vpn: see the password manager\n");
  await commitDir(deps(), dir);
  approve(deps(), "lead: test", []);
  // When
  const held = await pushAll(deps(), [dir]);
  // Then
  expect(held[0]).toStartWith(`STATE_GIT_PUSH_HELD ${dir} its local history holds 1 secret(s) (notes.md@`);
  expect(git(bare, "for-each-ref")).toBe("");
  // When: the lead accepts that hit after reading the preview
  approve(deps(), "lead: old commit, never pushed", [`${dir}:notes.md`]);
  const pushed = await pushAll(deps(), [dir]);
  // Then: only the clean snapshot went up, as one commit
  expect(pushed.some((l) => l.startsWith(`STATE_GIT_PUSHED ${dir}`))).toBe(true);
  expect(git(bare, "rev-list", "--count", "dot-dori")).toBe("1");
  expect(remoteHas(REAL)).toBe(false);
});

test("no push before the lead approved the first one", async () => {
  put("config.json", "{}\n");
  await commitDir(deps(), dir);
  expect((await pushAll(deps(), [dir]))[0]).toStartWith(`STATE_GIT_PUSH_WAIT_APPROVAL ${REPO}`);
  expect(git(bare, "for-each-ref")).toBe("");
});

test("busy at 06:00 defers to 06:30, a quiet 06:30 pushes once; busy until after 07:30 skips the day", async () => {
  // Given
  put("config.json", "{}\n");
  await commitDir(deps(), dir);
  approve(deps(), "lead: test", []);
  // When: before 06:00 nothing happens; at 06:00 the lead is mid-turn
  now = kst("05:59");
  expect(await backupTick(deps(), [dir])).toEqual([]);
  now = kst("06:00");
  busy = ["turn:lead"];
  expect(await backupTick(deps(), [dir])).toEqual(["STATE_GIT_PUSH_DEFER 2026-10-18 06:00 busy: turn:lead; next try 06:30"]);
  now = kst("06:10");
  expect(await backupTick(deps(), [dir])).toEqual([]);
  expect(git(bare, "for-each-ref")).toBe("");
  // When: quiet at 06:30
  busy = [];
  now = kst("06:30");
  expect((await backupTick(deps(), [dir])).some((l) => l.startsWith(`STATE_GIT_PUSHED ${dir}`))).toBe(true);
  now = kst("07:00");
  expect(await backupTick(deps(), [dir])).toEqual([]);
  // When: the next day stays busy
  const day = 24 * 3_600_000;
  busy = ["heavy:train"];
  for (const t of ["06:00", "06:30", "07:00", "07:30"]) {
    now = kst(t) + day;
    expect((await backupTick(deps(), [dir]))[0]).toStartWith("STATE_GIT_PUSH_DEFER 2026-10-19");
  }
  now = kst("07:31") + day;
  expect(await backupTick(deps(), [dir])).toEqual(["STATE_GIT_PUSH_SKIP 2026-10-19 no quiet moment from 06:00 to 07:30 Asia/Seoul: no backup today"]);
  now = kst("08:00") + day;
  expect(await backupTick(deps(), [dir])).toEqual([]);
});

test("schedule: the slot of each try in the owner's time zone", () => {
  const s = { ...BACKUP_DEFAULTS, repo: REPO };
  expect(backupStep(kst("06:29"), "Asia/Seoul", s, { day: "2026-10-18", slot: 0 })).toEqual({ kind: "none" });
  expect(backupStep(kst("06:30"), "Asia/Seoul", s, { day: "2026-10-18", slot: 0 })).toEqual({ kind: "try", day: "2026-10-18", slot: 1 });
  expect(backupStep(kst("06:00"), "Asia/Seoul", s, { day: "2026-10-17", slot: 3, done: true })).toEqual({ kind: "try", day: "2026-10-18", slot: 0 });
});

test("a push by hand: refused to another remote, to a public repo, before the lead's approval, or with a secret in any pushed commit", async () => {
  // Given: a clean commit and one with the password
  put("a.json", "{}\n");
  await commitDir(deps(), dir);
  const clean = git(dir, "rev-parse", "HEAD");
  put("b.md", `pw ${REAL}\n`);
  git(dir, "add", "b.md");
  git(dir, "commit", "-q", "--no-verify", "-m", "b");
  const dirty = git(dir, "rev-parse", "HEAD");
  const zero = "0".repeat(40);
  const refs = (sha: string): string => `refs/heads/main ${sha} refs/heads/main ${zero}\n`;
  // Then
  expect(await pushCheck(deps(), dir, "origin", bare, refs(clean))).toEqual([`only the remote "backup" at ${bare} takes a push (got origin ${bare})`]);
  visibility = "public";
  expect(await pushCheck(deps(), dir, "backup", bare, refs(clean))).toEqual([`${REPO} is public, not private`]);
  visibility = "private";
  expect((await pushCheck(deps(), dir, "backup", bare, refs(clean)))[0]).toStartWith("the lead has not approved the first push");
  approve(deps(), "lead: test", []);
  expect(await pushCheck(deps(), dir, "backup", bare, refs(clean))).toEqual([]);
  expect(await pushCheck(deps(), dir, "backup", bare, refs(dirty))).toEqual([`${dirty.slice(0, 7)} b.md real-secret (a value from dori.env)`]);
});

test("branch names and secret values: ids and paths are no secrets", () => {
  expect(branchFor("/h/.dori", "/h")).toBe("dot-dori");
  expect(branchFor("/h/Documents/zzangdori", "/h")).toBe("documents-zzangdori");
  expect(secrets.values.map((v) => v.value)).toEqual([REAL]);
  expect(secrets.ownerTexts).toEqual([OWNER]);
});
