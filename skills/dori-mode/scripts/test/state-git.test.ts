import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { checkRepo, commitDir, restoreDir, type StateGitDeps, stateGitDirs, tokenShape } from "../src/state-git.ts";

let dir: string;
let lines: string[];
const deps = (maxFileKb = 512): StateGitDeps => ({ settings: { dirs: [], everyMin: 10, maxFileKb, timeoutSec: 30, timeZone: "" }, timeZone: "Asia/Seoul", now: () => Date.now(), print: (l) => lines.push(l) });
const put = (rel: string, text: string): void => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
};
const sh = (...args: string[]): string => {
  const p = Bun.spawnSync(["git", "-C", dir, ...args], { env: { ...process.env, TZ: "Asia/Seoul" } });
  return p.stdout.toString().trim();
};
const tracked = (): string[] => sh("ls-files").split("\n").filter(Boolean).sort();
const commits = (): number => Number(sh("rev-list", "--count", "HEAD"));
const GHP = `ghp_${"a1B2".repeat(9)}`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "state-git-"));
  lines = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("secrets, message text, logs, big files and nested checkouts stay out of git; state files go in", async () => {
  // Given: a Dori directory as on the host
  put("config.json", "{}\n");
  put("state/lanes/a.json", '{"key":"a"}\n');
  put("dori.env", "DORI_DISCORD_TOKEN=abc\n");
  put("dori.env.bak-old", "DORI_DISCORD_TOKEN=old\n");
  put("kakao.env", "X=1\n");
  put("inbox.jsonl", '{"text":"pw 1234"}\n');
  put("state/discord/inbox.jsonl", "{}\n");
  put("state/discord/answers.jsonl", "{}\n");
  put("state/session-events.jsonl", "{}\n");
  put("state/briefs/a.md", "owner words\n");
  put("inbound.log", "line\n");
  put("models/ggml.bin", "x");
  put("state/big.json", "x".repeat(3000));
  put("src/README.md", "fork\n");
  Bun.spawnSync(["git", "init", "-q", join(dir, "src")]);
  // When
  const r = await commitDir(deps(2), dir);
  // Then
  expect(r.lines.some((l) => l.startsWith(`STATE_GIT_INIT ${dir}`))).toBe(true);
  expect(r.lines.some((l) => l.startsWith(`STATE_GIT_COMMIT ${dir}`))).toBe(true);
  expect(tracked()).toEqual([".gitignore", "config.json", "state/lanes/a.json"]);
  expect(existsSync(join(dir, ".git/hooks/pre-push"))).toBe(true);
});

test("a run with nothing changed makes no commit", async () => {
  // Given
  put("config.json", "{}\n");
  await commitDir(deps(), dir);
  const before = commits();
  // When
  const r = await commitDir(deps(), dir);
  // Then
  expect(r.lines).toContain(`STATE_GIT_NOCHANGE ${dir}`);
  expect(commits()).toBe(before);
});

test("token-shaped content is not committed, the rest of the change is, and the refusal is reported once", async () => {
  // Given
  put("lanes/a.json", '{"v":1}\n');
  await commitDir(deps(), dir);
  // When: a lane file gets a GitHub token, another file changes too
  put("lanes/a.json", `{"v":2,"note":"${GHP}"}\n`);
  put("lanes/b.json", '{"v":1}\n');
  const r = await commitDir(deps(), dir);
  // Then
  expect(r.lines.some((l) => l.startsWith(`STATE_GIT_REFUSED ${dir} lanes/a.json github-token`))).toBe(true);
  expect(sh("show", "HEAD:lanes/a.json")).toBe('{"v":1}');
  expect(tracked()).toContain("lanes/b.json");
  expect((await commitDir(deps(), dir)).lines.some((l) => l.startsWith("STATE_GIT_REFUSED"))).toBe(false);
});

test("the pre-commit check refuses a forced env file and token-shaped content in a manual commit", async () => {
  // Given
  put("config.json", "{}\n");
  await commitDir(deps(), dir);
  put("dori.env", "A=1\n");
  put("notes.md", `pw: ${GHP}\n`);
  sh("add", "-f", "dori.env", "notes.md");
  // When
  const refused = await checkRepo(deps(), dir);
  // Then
  expect(refused.map((l) => l.split(" ").slice(2, 4).join(" ").replace(/:$/, "")).sort()).toEqual(["dori.env secret-name", "notes.md github-token"]);
});

test("token shapes: Discord, GitHub, Slack, API key, private key, password; plain state text passes", () => {
  expect(tokenShape(`"t":"MTQ${"x".repeat(21)}.Gabc12.${"y".repeat(30)}"`)).toBe("discord-token");
  expect(tokenShape(GHP)).toBe("github-token");
  expect(tokenShape("xoxb-1234567890-abc")).toBe("slack-token");
  expect(tokenShape(`sk-ant-${"k".repeat(30)}`)).toBe("api-key");
  expect(tokenShape("-----BEGIN OPENSSH PRIVATE KEY-----")).toBe("private-key");
  expect(tokenShape("비밀번호: hunter22")).toBe("password");
  expect(tokenShape('{"key":"blocked-fp","thread":"discord:1560620500135182438","tokenEnv":"DORI_DISCORD_TOKEN"}')).toBeUndefined();
});

test("restore puts a broken state back as it was at a commit, and the restore itself can be undone", async () => {
  // Given: a good state, committed
  put("lanes/x.json", '{"status":"open"}\n');
  put("lanes/y.json", '{"status":"open"}\n');
  const good = (await commitDir(deps(), dir)).sha ?? "";
  const goodX = readFileSync(join(dir, "lanes/x.json"));
  // When: it breaks (changed, deleted, a stray file) and is restored
  put("lanes/x.json", "{broken");
  rmSync(join(dir, "lanes/y.json"));
  put("lanes/stray.json", "{}\n");
  const r = await restoreDir(deps(), dir, good, []);
  // Then
  expect(readFileSync(join(dir, "lanes/x.json"))).toEqual(goodX);
  expect(existsSync(join(dir, "lanes/y.json"))).toBe(true);
  expect(existsSync(join(dir, "lanes/stray.json"))).toBe(false);
  const undo = /undo: dori state-git restore (\w+)/.exec(r.at(-1) ?? "")?.[1] ?? "";
  await restoreDir(deps(), dir, undo, []);
  expect(readFileSync(join(dir, "lanes/x.json"), "utf8")).toBe("{broken");
});

test("restore by a time in the owner's time zone takes the last commit before it", async () => {
  // Given: an evening commit (KST) and a broken one after it
  put("lanes/x.json", "evening\n");
  process.env.GIT_COMMITTER_DATE = "2026-10-16T20:00:00+09:00";
  try {
    await commitDir(deps(), dir);
  } finally {
    delete process.env.GIT_COMMITTER_DATE;
  }
  put("lanes/x.json", "broken\n");
  await commitDir(deps(), dir);
  // When
  const r = await restoreDir(deps(), dir, "2026-10-16 21:00", []);
  // Then
  expect(readFileSync(join(dir, "lanes/x.json"), "utf8")).toBe("evening\n");
  expect(r.at(-1)).toContain("2026-10-16 20:00 Asia/Seoul");
});

test("a stale index.lock left by a killed run is removed on the next run", async () => {
  // Given
  put("a.json", "1\n");
  await commitDir(deps(), dir);
  put("a.json", "2\n");
  writeFileSync(join(dir, ".git/index.lock"), "");
  const old = new Date(Date.now() - 600_000);
  utimesSync(join(dir, ".git/index.lock"), old, old);
  // When
  const r = await commitDir(deps(), dir);
  // Then
  expect(r.lines.some((l) => l.startsWith(`STATE_GIT_UNLOCK ${dir}`))).toBe(true);
  expect(sh("show", "HEAD:a.json")).toBe("2");
});

test("a push is refused", async () => {
  // Given: someone added a remote
  put("a.json", "1\n");
  await commitDir(deps(), dir);
  const bare = mkdtempSync(join(tmpdir(), "state-git-remote-"));
  try {
    Bun.spawnSync(["git", "init", "-q", "--bare", bare]);
    sh("remote", "add", "origin", bare);
    // When
    const p = Bun.spawnSync(["git", "-C", dir, "push", "-q", "origin", "main"]);
    // Then
    expect(p.exitCode).not.toBe(0);
    expect(p.stderr.toString()).toContain("push refused");
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

test("the directories of a Dori: config dir, stateDir and inbox dir, nested ones folded, never the home directory", () => {
  const home = "/h";
  expect(stateGitDirs({ configFile: "/h/.dori/config.json", stateDir: "/h/.dori/state", inbox: "/h/.zzangdori/inbox.jsonl", home, dirs: [] })).toEqual(["/h/.dori", "/h/.zzangdori"]);
  expect(stateGitDirs({ configFile: "/h/.okdori/config.json", stateDir: "/h/.okdori/state", inbox: "/h/.okdori/state/discord/inbox.jsonl", home, dirs: [] })).toEqual(["/h/.okdori"]);
  expect(stateGitDirs({ configFile: "/h/.x/config.json", stateDir: "/h/.x/state", inbox: "/h/inbox.jsonl", home, dirs: [] })).toEqual(["/h/.x"]);
  expect(stateGitDirs({ configFile: "/h/.x/config.json", stateDir: "/h/.x/state", inbox: "/h/inbox.jsonl", home, dirs: ["/h/.only"] })).toEqual(["/h/.only"]);
});
