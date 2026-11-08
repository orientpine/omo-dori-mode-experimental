import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { BACKUP_REMOTE } from "./config.ts";
import type { FlowDeps } from "./done-flow-state.ts";
import type { Lane } from "./registry.ts";
import type { Runner } from "./run.ts";

export const discoverWorktrees = async (lane: Lane, run: Runner, extraRoots: readonly string[] = []): Promise<string[]> => {
  const found = new Set<string>(lane.worktrees ?? []);
  const ours = (name: string) => name === lane.key || name.startsWith(`${lane.key}-`);
  for (const root of new Set([lane.cwd ?? "", ...extraRoots].filter(Boolean))) {
    const r = await run(["git", "-C", root, "worktree", "list", "--porcelain"]);
    if (r.code !== 0) continue;
    let path = "";
    for (const line of r.out.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice(9);
      else if (line.startsWith("branch ") && path !== root && (ours(line.split("/").pop() ?? "") || ours(path.split("/").pop() ?? ""))) found.add(path);
    }
  }
  return [...found];
};

// `git rev-parse --local-env-vars` (git 2.43) and GIT_CEILING_DIRECTORIES, each unset for a child git
const GIT_REPO_ENV_CLEARED: Readonly<Record<string, undefined>> = Object.fromEntries(
  ["GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_OBJECT_DIRECTORY", "GIT_DIR", "GIT_WORK_TREE", "GIT_IMPLICIT_WORK_TREE", "GIT_GRAFT_FILE", "GIT_INDEX_FILE", "GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE", "GIT_PREFIX", "GIT_SHALLOW_FILE", "GIT_COMMON_DIR", "GIT_CEILING_DIRECTORIES"].map((k) => [k, undefined]),
);

// owner/name of a GitHub URL in its https, ssh or scp-like form (git@github.com:owner/name.git), lower case
const githubRepo = (url: string): string | undefined => /^(?:https:\/\/|ssh:\/\/)?(?:[^@/]+@)?github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(url.trim())?.[1]?.toLowerCase();

// the backup remote counts only when this Dori names a backup repo and the remote's configured URL is that repo
const isBackupRemote = async (git: Runner, wt: string, repo: string): Promise<boolean> => {
  if (!repo) return false;
  const url = await git(["git", "-C", wt, "config", "--get", `remote.${BACKUP_REMOTE}.url`]);
  return url.code === 0 && githubRepo(url.out) === repo.toLowerCase();
};

export const unpushedWork = async (deps: FlowDeps, lane: Lane): Promise<string[]> => {
  const exists = deps.exists ?? existsSync;
  const reasons: string[] = [];
  // dori-superagent issue #40 reproduced here (MIT): https://github.com/sisyphuslabs/dori-superagent/issues/40
  // A lane with no worktree of its own works in its cwd, so that checkout is what is checked; one with its own worktree
  // is checked there only, and the human's checkout in its cwd does not hold it. Git is asked first, and a checkout it
  // finds is checked. When it fails, a .git entry in the cwd or above it (on the physical path, as git walks it, so a
  // cwd that is a symlink into a repository counts) means a broken checkout: unreadable git state, which holds the lane.
  // Without one the cwd is no checkout and has no work to push. Git's message cannot tell the two apart: it prints
  // "not a git repository" for a missing repository and for a bad HEAD or a .git file pointing nowhere alike (git's
  // setup.c skips a .git it cannot use and walks on up). A .git entry counts when lstat sees it, so a dangling .git
  // symlink holds too; only ENOENT or ENOTDIR mean none. Every git call here, the worktree discovery too, runs without
  // the repository overrides git lists in `git rev-parse --local-env-vars` and without GIT_CEILING_DIRECTORIES: from the
  // watcher's environment they would point git at another repository, index or object store, or stop its walk.
  // (discoverWorktrees stays as it is: closeLane removes what it finds, never the cwd.)
  const git: Runner = (argv, opts) => deps.run(argv, { ...opts, env: { ...opts?.env, ...GIT_REPO_ENV_CLEARED } });
  const own = await discoverWorktrees(lane, git, [deps.config.defaultCwd]);
  const cwd = lane.cwd ?? deps.config.defaultCwd;
  const present = (p: string): boolean => {
    if (exists(p)) return true;
    try {
      lstatSync(p);
      return true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return code !== "ENOENT" && code !== "ENOTDIR";
    }
  };
  const underGit = (dir: string): boolean => {
    let d = resolve(dir);
    try {
      d = realpathSync(d);
    } catch {
      // a path the file system cannot resolve is walked as written
    }
    for (; ; d = dirname(d)) {
      if (present(join(d, ".git"))) return true;
      if (dirname(d) === d) return false;
    }
  };
  let checked = own;
  // a cwd checkout that holds this Dori's stateDir (a lane in ~/.soodori/qa works in the state-git repo ~/.soodori):
  // dori rewrites its state files there all the time, so they are no lane work; every other path still counts
  let statePaths: string[] = [];
  if (!own.length && exists(cwd)) {
    const probe = await git(["git", "-C", cwd, "rev-parse", "--is-inside-work-tree"]);
    if (probe.code === 0) checked = probe.out.trim() === "true" ? [cwd] : [];
    else if (underGit(cwd)) reasons.push(`unpushed work in ${cwd} (git state unreadable)`);
    const top = checked.length ? await git(["git", "-C", cwd, "rev-parse", "--show-toplevel"]) : undefined;
    if (top?.code === 0 && top.out.trim()) {
      const real = (p: string): string => {
        try {
          return realpathSync(p);
        } catch {
          return resolve(p);
        }
      };
      const rel = relative(real(top.out.trim()), real(deps.config.stateDir));
      if (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel)) statePaths = ["--", ":(top)", rel ? `:(top,literal,exclude)${rel}` : ":(top,exclude)*"];
    }
  }
  for (const wt of checked) {
    if (!exists(wt)) continue;
    const dirty = await git(["git", "-C", wt, "status", "--porcelain", "--untracked-files=no", ...(wt === cwd ? statePaths : [])]);
    // a cwd checkout with no remote at all (a Dori's own Documents repository) has nowhere to push its commits, so they
    // are not unpushed work; its uncommitted changes still are. Its history is still walked, so one git cannot read
    // stays unreadable. A lane's own worktree is checked as before.
    // This Dori's stateGit backup remote (named backup, its URL this Dori's stateGit.backup.repo) takes only snapshots of
    // HEAD on their own history, so it is no place to push either: a checkout with only that remote is one with no
    // remote, and with a real remote besides, the commits are counted against the real one, never the snapshot refs.
    const remotes = own.length ? undefined : await git(["git", "-C", wt, "remote"]);
    if (remotes && remotes.code !== 0) {
      reasons.push(`unpushed work in ${wt} (git state unreadable)`);
      continue;
    }
    const names = remotes ? remotes.out.split("\n").map((n) => n.trim()).filter(Boolean) : [];
    const snapshotOnly = names.includes(BACKUP_REMOTE) && (await isBackupRemote(git, wt, deps.config.stateGit.backup.repo));
    const noRemote = remotes !== undefined && !names.some((n) => !(snapshotOnly && n === BACKUP_REMOTE));
    const notPushed = noRemote ? [] : ["--not", ...(snapshotOnly ? [`--exclude=${BACKUP_REMOTE}/*`] : []), "--remotes"];
    let ahead = await git(["git", "-C", wt, "rev-list", "--count", "HEAD", ...notPushed]);
    if (noRemote && ahead.code === 0) ahead = { code: 0, out: "0", err: "" };
    // a fresh repository's branch has no commit yet (an unborn HEAD): rev-list fails, but there is nothing to push;
    // it is unborn only when HEAD names a branch that resolves to no commit. A HEAD that resolves but cannot be read
    // (a missing object) stays unreadable. Its staged files still show in status.
    if (ahead.code !== 0 && (await git(["git", "-C", wt, "rev-parse", "-q", "--verify", "HEAD"])).code === 1 && (await git(["git", "-C", wt, "symbolic-ref", "-q", "HEAD"])).code === 0) ahead = { code: 0, out: "0", err: "" };
    if (dirty.code !== 0 || ahead.code !== 0) reasons.push(`unpushed work in ${wt} (git state unreadable)`);
    else if (dirty.out.trim() || Number(ahead.out.trim()) > 0) reasons.push(`unpushed work in ${wt}`);
  }
  return reasons;
};
