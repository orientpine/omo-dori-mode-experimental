import { expect, test } from "bun:test";

import { backupRemoteUrl, backupVisibility } from "../src/backup-visibility.ts";
import type { Ran, Runner } from "../src/run.ts";

const REPO = "o/dori-local-test";
const loggedOut: Ran = { code: 4, out: "", err: "To get started with GitHub CLI, please run: gh auth login" };
const unexpectedFetch = async (): Promise<Response> => { throw new Error("unexpected fetch"); };

test.each(["private", "public"])("logged-in gh keeps its %s visibility without fallback", async (visibility) => {
  // Given
  const run: Runner = async () => ({ code: 0, out: visibility, err: "" });
  // When
  const result = await backupVisibility(REPO, { run, fetch: unexpectedFetch });
  // Then
  expect(result).toBe(visibility);
});

test("logged-out gh still refuses a public repo visible to the anonymous API", async () => {
  // Given
  let commands = 0;
  const run: Runner = async () => { commands++; return loggedOut; };
  // When
  const result = await backupVisibility(REPO, {
    run,
    fetch: async (url, init) => {
      expect(url).toBe(`https://api.github.com/repos/${REPO}`);
      expect(init.headers).toEqual({ Accept: "application/vnd.github+json" });
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.redirect).toBe("error");
      return Response.json({ visibility: "public" });
    },
  });
  // Then
  expect(result).toBe("public");
  expect(commands).toBe(1);
});

test.each([0, 128])("anonymous 404 checks deploy-key access with git exit %i", async (code) => {
  // Given
  let commands = 0;
  const run: Runner = async (argv, opts) => {
    if (commands++ === 0) return loggedOut;
    expect(argv).toEqual(["git", "ls-remote", backupRemoteUrl(REPO)]);
    expect(opts).toEqual({ env: { GIT_TERMINAL_PROMPT: "0" }, timeoutMs: 20_000 });
    return { code, out: "", err: code ? "repository not found" : "" };
  };
  // When
  const result = await backupVisibility(REPO, { run, fetch: async () => new Response(null, { status: 404 }) });
  // Then: even an empty private repo has exit 0 with no refs
  expect(result).toBe(code === 0 ? "private" : "missing");
  expect(commands).toBe(2);
});

test("a missing gh binary can use the deploy-key fallback", async () => {
  // Given
  let commands = 0;
  const run: Runner = async () => commands++ === 0
    ? { code: 127, out: "", err: 'Executable not found in $PATH: "gh"' }
    : { code: 0, out: "", err: "" };
  // When
  const result = await backupVisibility(REPO, { run, fetch: async () => new Response(null, { status: 404 }) });
  // Then
  expect(result).toBe("private");
  expect(commands).toBe(2);
});

test("an anonymous API network error stays unknown without probing git", async () => {
  // Given
  let commands = 0;
  const run: Runner = async () => { commands++; return loggedOut; };
  // When
  const result = await backupVisibility(REPO, { run, fetch: async () => { throw new TypeError("network unavailable"); } });
  // Then
  expect(result).toBe("unknown: network unavailable");
  expect(commands).toBe(1);
});

test.each([
  { code: 1, out: "", err: "gh: Not Found (HTTP 404)", expected: "missing" },
  { code: 1, out: "", err: "network unavailable", expected: "unknown: network unavailable" },
  { code: 0, out: "", err: "", expected: "unknown: empty answer" },
])("gh result $expected never enables fallback", async ({ expected, ...gh }) => {
  // Given
  const run: Runner = async () => gh;
  // When
  const result = await backupVisibility(REPO, { run, fetch: unexpectedFetch });
  // Then
  expect(result).toBe(expected);
});

test.each([403, 429, 500])("anonymous API HTTP %i stays unknown", async (status) => {
  // Given
  let commands = 0;
  const run: Runner = async () => { commands++; return loggedOut; };
  // When
  const result = await backupVisibility(REPO, { run, fetch: async () => new Response(null, { status }) });
  // Then
  expect(result).toBe(`unknown: GitHub API HTTP ${status}`);
  expect(commands).toBe(1);
});

test.each([{}, { visibility: "unexpected" }, { visibility: 1 }])("malformed API visibility %j stays unknown", async (body) => {
  // Given
  const run: Runner = async () => loggedOut;
  // When
  const result = await backupVisibility(REPO, { run, fetch: async () => Response.json(body) });
  // Then
  expect(result).toBe("unknown: invalid API visibility");
});
