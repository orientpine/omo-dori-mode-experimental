import { herdrLife, herdrRead, herdrShellPid, isHerdrPane } from "./herdr.ts";
import { runtimesOf, type Runner } from "./run.ts";
import { parseRef } from "./runtime/types.ts";

// a herdr pane is read through herdr (herdr.ts), the same visible screen or last lines
export const captureTmux = async (run: Runner, pane: string, lines?: number): Promise<string> => {
  // https://github.com/sisyphuslabs/omo-dori-mode-experimental/pull/282: hosted refs are never tmux or herdr panes.
  const hosted = parseRef(pane);
  if (hosted?.runtime === "omo-host") return runtimesOf(run).for(hosted).read(hosted, lines ?? 80);
  if (isHerdrPane(pane)) return herdrRead(run, pane, lines);
  const out = (await run(["tmux", "capture-pane", "-p", "-J", "-t", `=${pane}:`, ...(lines ? ["-S", `-${lines}`] : [])])).out;
  return lines ? out.split("\n").slice(-lines).join("\n") : out;
};

export type PaneLife = { readonly live: true } | { readonly live: false; readonly how: "gone" } | { readonly live: false; readonly how: "dead"; readonly status: number };

// gone: no tmux session of that name; dead: the session is there, its pane's program exited (remain-on-exit)
export const paneLife = async (run: Runner, pane: string): Promise<PaneLife> => {
  const hosted = parseRef(pane);
  if (hosted?.runtime === "omo-host") return (await runtimesOf(run).for(hosted).list()).some(({ ref }) => ref.id === hosted.id) ? { live: true } : { live: false, how: "gone" };
  if (isHerdrPane(pane)) return herdrLife(run, pane);
  if ((await run(["tmux", "has-session", "-t", `=${pane}`])).code !== 0) return { live: false, how: "gone" };
  const r = await run(["tmux", "display-message", "-p", "-t", `=${pane}:`, "#{pane_dead} #{pane_dead_status}"]);
  const [dead = "", status = ""] = r.out.trim().split(" ");
  return r.code === 0 && dead === "1" ? { live: false, how: "dead", status: Number(status) } : { live: true };
};

// the pane's shell: a herdr pane's from herdr pane process-info
export const tmuxPanePid = async (run: Runner, pane: string): Promise<number> => {
  if (parseRef(pane)?.runtime === "omo-host") return 0;
  if (isHerdrPane(pane)) return herdrShellPid(run, pane);
  const r = await run(["tmux", "display-message", "-p", "-t", `=${pane}:`, "#{pane_pid}"]);
  return r.code === 0 ? Number(r.out.trim()) || 0 : 0;
};
