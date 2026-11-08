import { Glob } from "bun";
import { dirname, isAbsolute, relative } from "node:path";

// What a helper run sends back (heavy-spread.ts heavyExec): the regular files it made or changed under the --sync paths,
// only those the job's --back globs pick when it gave any (relative to its working folder, or absolute), and at most
// BACK_MAX_BYTES of them. Over that, the folders holding the most bytes stay on the helper, biggest first, until the rest
// fits, so a result, its log and its checks come back beside a big intermediate folder (2026-11-08: a 1-minute rv make on
// 4eae made 5.1 GB, 1839 frames in build/frames, and nothing came back, not its mp4, srt or CHECKS.md).
export const BACK_MAX_BYTES = 4 * 1024 ** 3;
const BACK_GLOB = /^[^\n\0]{1,256}$/;
const BACK_GLOBS_MAX = 32;

export const backGlobProblem = (globs: readonly string[] | undefined): string | undefined => {
  if (globs && globs.length > BACK_GLOBS_MAX) return `--back is given ${globs.length} times, more than the ${BACK_GLOBS_MAX} a helper reads`;
  const bad = globs?.find((g) => !BACK_GLOB.test(g));
  return bad === undefined ? undefined : `--back ${JSON.stringify(bad)} is not a glob a helper can read (1 to 256 characters, no newline)`;
};

export type BackFile = { readonly path: string; readonly bytes: number };
export type BackLeft = { readonly dir: string; readonly files: number; readonly bytes: number };
export type BackPick = { readonly keep: string[]; readonly left: BackLeft[]; readonly bytes: number };

export const backPick = (files: readonly BackFile[], o: { readonly cwd: string; readonly max: number; readonly globs?: readonly string[] }): BackPick => {
  const globs = (o.globs ?? []).map((g) => ({ abs: isAbsolute(g), glob: new Glob(g) }));
  const picked = globs.length ? files.filter((f) => globs.some((g) => g.glob.match(g.abs ? f.path : relative(o.cwd, f.path)))) : [...files];
  const byDir = new Map<string, BackLeft>();
  for (const f of picked) {
    const d = byDir.get(dirname(f.path)) ?? { dir: dirname(f.path), files: 0, bytes: 0 };
    byDir.set(d.dir, { ...d, files: d.files + 1, bytes: d.bytes + f.bytes });
  }
  let bytes = picked.reduce((a, f) => a + f.bytes, 0);
  const left: BackLeft[] = [];
  for (const d of [...byDir.values()].sort((a, b) => b.bytes - a.bytes)) {
    if (bytes <= o.max) break;
    left.push(d);
    bytes -= d.bytes;
  }
  const gone = new Set(left.map((d) => d.dir));
  return { keep: picked.filter((f) => !gone.has(dirname(f.path))).map((f) => f.path), left, bytes };
};
