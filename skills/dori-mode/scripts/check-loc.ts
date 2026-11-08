/**
 * From upstream https://github.com/sisyphuslabs/omo-dori-mode-experimental/pull/149 (scripts/check-loc.ts), rooted at skills/dori-mode/scripts.
 *
 * The 250-line rule: no TypeScript source or test file may exceed MAX_LINES.
 *
 * Files that were already over the cap when the rule landed are listed in loc-baseline.json with their exact line
 * count. The baseline is a ratchet: every entry must equal the measured count, so a listed file can never grow (a
 * larger count is LOC_GREW) and a shrink must lower its entry in the same change (a smaller count is LOC_LOOSE), and an
 * entry whose file is back under the cap (or gone) is refused (LOC_STALE), so the list can only get shorter until it
 * is empty.
 *
 * Upstream #159 (https://github.com/sisyphuslabs/dori-superagent/pull/159) split its last oversize files and has no baseline
 * any more. In the fork every file that came from upstream is under the cap as well; the baseline lists only the fork's own
 * files, whose split is a follow-up (docs/follow-ups.md).
 *
 * Prints `LOC_OK <n> files` and exits 0, or one `LOC_OVER` / `LOC_GREW` / `LOC_LOOSE` / `LOC_STALE` line per problem
 * and exits 1.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { Glob } from "bun";

const MAX_LINES = 250;
const ROOTS = ["src", "test"] as const;
const BASELINE_FILE = "loc-baseline.json";

type Baseline = Readonly<Record<string, number>>;

const countLines = (text: string): number => {
  const pieces = text.split("\n");
  return pieces.at(-1) === "" ? pieces.length - 1 : pieces.length;
};

const readBaseline = (root: string): Baseline => {
  const path = join(root, BASELINE_FILE);
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(`${BASELINE_FILE} must be an object of "path": lineCount`);
  const baseline: Record<string, number> = {};
  for (const [file, n] of Object.entries(parsed)) {
    if (typeof n !== "number" || !Number.isInteger(n))
      throw new Error(`${BASELINE_FILE}: ${file} must map to an integer line count`);
    baseline[file] = n;
  }
  return baseline;
};

const sourceFiles = (root: string): string[] => {
  const files: string[] = [];
  for (const dir of ROOTS) {
    if (!existsSync(join(root, dir))) continue;
    for (const file of new Glob("**/*.ts").scanSync({ cwd: join(root, dir), onlyFiles: true })) {
      const rel = relative(root, join(root, dir, file))
        .split(sep)
        .join("/");
      if (!rel.split("/").includes("node_modules")) files.push(rel);
    }
  }
  return files.sort();
};

const checkLoc = (root: string): { readonly files: number; readonly problems: readonly string[] } => {
  const baseline = readBaseline(root);
  const files = sourceFiles(root);
  const problems: string[] = [];
  const counts = new Map<string, number>();
  for (const file of files) {
    const n = countLines(readFileSync(join(root, file), "utf8"));
    counts.set(file, n);
    const allowed = baseline[file];
    if (n <= MAX_LINES) continue;
    if (allowed === undefined) problems.push(`LOC_OVER ${file} ${n}`);
    else if (n > allowed) problems.push(`LOC_GREW ${file} ${n} (baseline ${allowed})`);
    else if (n < allowed)
      problems.push(`LOC_LOOSE ${file} is ${n} lines but the baseline allows ${allowed}: set the entry to ${n}`);
  }
  for (const [file, allowed] of Object.entries(baseline)) {
    const n = counts.get(file);
    if (n === undefined)
      problems.push(`LOC_STALE ${file} is in ${BASELINE_FILE} but no longer exists: remove the entry`);
    else if (n <= MAX_LINES)
      problems.push(`LOC_STALE ${file} is ${n} lines (baseline ${allowed}), under ${MAX_LINES}: remove the entry`);
  }
  return { files: files.length, problems };
};

if (import.meta.main) {
  const { files, problems } = checkLoc(process.cwd());
  for (const p of problems) console.log(p);
  if (problems.length) process.exit(1);
  console.log(`LOC_OK ${files} files`);
}
