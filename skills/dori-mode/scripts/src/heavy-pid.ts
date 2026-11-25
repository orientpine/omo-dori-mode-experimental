// https://github.com/sisyphuslabs/omo-dori-mode-experimental/pull/264
// In dynamic mode, a failed probe is not proof of death. Legacy mode retains its existing fallback.
const probePid = (pid: number, since: number | undefined, conservative: boolean): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (e) {
    return conservative && !(e instanceof Error && "code" in e && e.code === "ESRCH");
  }
  try {
    const ps = Bun.spawnSync(["ps", "-o", "stat=,etimes=", "-p", String(pid)]);
    if (conservative && ps.exitCode !== 0) return true;
    const [stat = "", etimes = ""] = ps.stdout.toString().trim().split(/\s+/);
    if (!stat) return conservative;
    if (stat.startsWith("Z")) return false;
    // A reused PID started after the claim; ps etimes is in whole seconds, so allow 2 s of slack.
    return since === undefined || !/^\d+$/.test(etimes) || Date.now() - Number(etimes) * 1000 <= since + 2_000;
  } catch (e) {
    if (conservative && e instanceof Error) return true;
    throw e;
  }
};

export const pidAlive = (pid: number, since?: number): boolean => probePid(pid, since, false);
export const ownerAlive = (pid: number, since?: number): boolean => probePid(pid, since, true);
