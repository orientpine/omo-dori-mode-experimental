import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type DoriConfig, defaultConfig } from "../src/config.ts";
import type { FlowDeps } from "../src/done-flow.ts";
import { Registry } from "../src/registry.ts";
import type { Clock, Ran, Runner } from "../src/run.ts";

export type World = {
  prState: string;
  issueState: string;
  aheadCount: string;
  dirty: string;
  stuckReads: number;
  screen: string;
  screens: Record<string, string>;
  aoePs: { session: string; state: string }[];
  panes: { pane_id: string; workspace_id: string; agent?: string; title?: string; cwd?: string }[];
  aoe: { id: string; title: string; path: string; tool?: string; profile?: string }[];
  tmux: string[];
  calls: string[][];
};

export const NEW_AOE_ID = "5e5e5e5e00aa11bb";

export const WT = "/repo/.wt/demo-lane";

export const newWorld = (): World => ({ prState: "MERGED", issueState: "CLOSED", aheadCount: "0", dirty: "", stuckReads: 0, screen: "❯ ", screens: {}, aoePs: [], panes: [], aoe: [], tmux: [], calls: [] });

export const fakeRunner = (w: World): Runner => async (argv) => {
  w.calls.push([...argv]);
  const ok = (out = ""): Ran => ({ code: 0, out, err: "" });
  const [cmd, a1, a2] = argv;
  if ((cmd === "herdr" && a1 === "pane" && a2 === "read") || (cmd === "tmux" && a1 === "capture-pane")) {
    if (w.stuckReads > 0) {
      w.stuckReads--;
      return ok("❯ [LEAD] stuck text still here");
    }
    const pane = cmd === "tmux" ? (argv[argv.indexOf("-t") + 1] ?? "").replace(/^=|:$/g, "") : (a2 === "read" ? argv[3] : "") ?? "";
    return ok(w.screens[pane] ?? w.screen);
  }
  if (cmd === "herdr" && a1 === "pane" && a2 === "list") return ok(JSON.stringify({ result: { panes: w.panes } }));
  if (cmd === "herdr") return ok();
  if (cmd === "aoe" && a1 === "list") return ok(JSON.stringify(w.aoe));
  if (cmd === "aoe" && a1 === "ps") return ok(JSON.stringify(w.aoePs));
  if (cmd === "aoe" && a1 === "add") {
    const title = argv[argv.indexOf("-t") + 1] ?? "";
    w.aoe.push({ id: NEW_AOE_ID, title, path: a2 ?? "", tool: "omo", profile: "main" });
    w.tmux.push(`aoe_${title}_${NEW_AOE_ID.slice(0, 8)}`);
    return ok();
  }
  if (cmd === "aoe") return ok();
  if (cmd === "tmux" && a1 === "ls") return ok(w.tmux.join("\n"));
  if (cmd === "tmux" && a1 === "display-message") return ok("10");
  if (cmd === "tmux") return ok();
  if (cmd === "git" && argv.includes("worktree") && argv.includes("list")) return ok(`worktree /repo\nbranch refs/heads/main\n\nworktree ${WT}\nbranch refs/heads/demo-lane`);
  if (cmd === "git" && argv.includes("status")) return ok(w.dirty);
  if (cmd === "git" && argv.includes("rev-list")) return ok(w.aheadCount);
  if (cmd === "git") return ok();
  if (cmd === "gh" && a1 === "pr") return ok(JSON.stringify({ state: w.prState, mergeCommit: w.prState === "MERGED" ? { oid: "abc1234567890" } : null }));
  if (cmd === "gh" && a1 === "issue") return ok(JSON.stringify({ state: w.issueState }));
  if (cmd === "notify") return ok();
  return { code: 1, out: "", err: `unexpected ${argv.join(" ")}` };
};

export const fakeClock = (start: number): Clock & { at: number } => {
  const c = { at: start, now: () => c.at, sleep: async () => {} };
  return c;
};

export const withState = (): { dir: string; done: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), "dori-test-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
};

export const depsFor = (w: World, clock: Clock, stateDir: string, patch: Partial<DoriConfig> = {}): FlowDeps => {
  const config: DoriConfig = { ...defaultConfig("/home/test"), stateDir, watchLog: join(stateDir, "lanes.log"), defaultCwd: "/repo", leadPane: "lead:p1", ...patch };
  return { run: fakeRunner(w), clock, registry: new Registry(stateDir), config, exists: () => true };
};

export const sent = (w: World): string[] => w.calls.flatMap((c) => (c[0] === "herdr" && c[2] === "send-text" ? [c[4] ?? ""] : c[0] === "tmux" && c[1] === "send-keys" && c.includes("-l") ? [c.at(-1) ?? ""] : []));
