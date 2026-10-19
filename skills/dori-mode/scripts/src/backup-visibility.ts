import type { Runner } from "./run.ts";

type VisibilityDeps = {
  readonly run: Runner;
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
};

export const backupRemoteUrl = (repo: string): string => `https://github.com/${repo}.git`;

const reason = (text: string): string => text.replace(/\s+/g, " ").slice(0, 120);

// Only an unavailable gh login permits the anonymous API + deploy-key check. A gh 404 is still missing.
export const backupVisibility = async (repo: string, deps: VisibilityDeps): Promise<string> => {
  const gh = await deps.run(["gh", "api", `repos/${repo}`, "--jq", ".visibility"]);
  if (gh.code === 0) return gh.out.trim() || "unknown: empty answer";
  const error = `${gh.err} ${gh.out}`;
  if (/404|Not Found/.test(error)) return "missing";
  const unavailable = (gh.code === 127 && /ENOENT|not found|no such file|executable/i.test(error))
    || /gh auth login|not logged (?:in|into)|authentication required|requires authentication|GH_TOKEN|HTTP 401|Bad credentials/i.test(error);
  if (!unavailable) return `unknown: ${reason(gh.err || gh.out)}`;
  try {
    const response = await deps.fetch(`https://api.github.com/repos/${repo}`, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    if (response.status === 200) {
      const body: unknown = await response.json();
      if (body && typeof body === "object" && "visibility" in body && typeof body.visibility === "string"
        && ["private", "public", "internal"].includes(body.visibility)) return body.visibility;
      return "unknown: invalid API visibility";
    }
    if (response.status !== 404) return `unknown: GitHub API HTTP ${response.status}`;
    const git = await deps.run(["git", "ls-remote", backupRemoteUrl(repo)], {
      env: { GIT_TERMINAL_PROMPT: "0" },
      timeoutMs: 20_000,
    });
    return git.code === 0 ? "private" : "missing";
  } catch (e) {
    return `unknown: ${reason(e instanceof Error ? e.message : String(e))}`;
  }
};
