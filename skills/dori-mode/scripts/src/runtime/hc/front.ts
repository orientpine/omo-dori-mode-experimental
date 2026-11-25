import type { Exec } from "../exec.ts";
import type { ForegroundProcess } from "../types.ts";

const PS_ARGV = ["-A", "-ww", "-o", "pid=,pgid=,tpgid=,tty=,args="] as const;
const ROW = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(\S.*)$/;

type ForegroundGroup = { readonly pgid: number; readonly processes: readonly ForegroundProcess[] };

/** upstream sisyphuslabs/dori-superagent#277: resolve the root's tty and foreground group in one ps snapshot. */
export async function foregroundGroup(exec: Exec, rootPid: number): Promise<ForegroundGroup | undefined> {
  const result = await exec("ps", PS_ARGV).catch(() => undefined);
  if (result === undefined || result.code !== 0) return undefined;
  const rows = result.stdout.split("\n").flatMap((line) => {
    const match = ROW.exec(line);
    if (match === null) return [];
    const [, pid, pgid, tpgid, tty, args = ""] = match;
    return [{ pid: Number(pid), pgid: Number(pgid), tpgid: Number(tpgid), tty, args }];
  });
  const root = rows.find((row) => row.pid === rootPid);
  if (root === undefined || root.tpgid <= 0 || root.tty?.startsWith("?")) return undefined;
  const processes = rows
    .filter((row) => row.pgid === root.tpgid && row.tty === root.tty)
    .map(({ pid, args }) => {
      // ps flattens argv; whitespace inside a command argument also becomes a split.
      const argv = args.split(/\s+/);
      return { name: argv[0] ?? "", argv, pid };
    });
  return processes.length === 0 ? undefined : { pgid: root.tpgid, processes };
}
