import { basename } from "node:path";

// A bash -c script whose pipeline ends in tail, grep or head exits with that last command's code, so a failing test run
// piped into tail looked like a pass (2026-11-02: 171 of 744 failed on the helper, HEAVY_DONE exit 0). The script that pipes
// and does not set pipefail itself runs with set -o pipefail, so any failing stage fails the job; anything else is unchanged.
export const withPipefail = (cmd: readonly string[]): readonly string[] => {
  if (basename(cmd[0] ?? "") !== "bash" || cmd.some((a) => a.includes("pipefail"))) return cmd;
  let sawC = false;
  for (let i = 1; i < cmd.length; i++) {
    const a = cmd[i]!;
    if (/^[-+][oO]$/.test(a)) {
      i++;
      continue;
    }
    if (/^-[A-Za-z]+$/.test(a)) {
      sawC ||= a.includes("c");
      continue;
    }
    if (a === "--" || a.startsWith("--")) continue;
    if (!sawC || !/(?:^|[^|])\|(?!\|)/.test(a)) return cmd;
    return [...cmd.slice(0, i), `set -o pipefail; ${a}`, ...cmd.slice(i + 1)];
  }
  return cmd;
};
