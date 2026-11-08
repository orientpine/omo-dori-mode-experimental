import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";

// A directory every Dori account on this host writes in (backlog.hostDir's lane files, heavyHoldDir's holds): mode 1777,
// sticky, so only a file's owner removes or replaces it. Why it is unsafe to write in (a link, not a directory, no sticky
// bit), or undefined; made when missing.
export const sharedDirProblem = (dir: string): string | undefined => {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o1777);
  }
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) return "is not a plain directory";
  if (!(st.mode & 0o1000)) return "has no sticky bit (another account could remove or replace this Dori's files)";
  return undefined;
};
