import { captureTmux, listAoePanes, target, waitForPrompt } from "./aoe.ts";
import type { Backend, DoriConfig } from "./config.ts";
import type { Clock, Runner } from "./run.ts";
import { type PaneKeys, submitText, type Submitted } from "./submit.ts";
import { watchLog } from "./watch-log.ts";

export type Pane = {
  readonly pane_id: string;
  readonly workspace_id: string;
  readonly tab_id?: string;
  readonly agent?: string;
  readonly agent_status?: string;
  readonly title?: string;
  readonly cwd?: string;
};

export class UnsafeTextError extends Error {}

export const listPanes = async (run: Runner, backend: Backend): Promise<Pane[]> => {
  if (backend === "aoe") return listAoePanes(run);
  const r = await run(["herdr", "pane", "list"]);
  if (r.code !== 0) throw new Error(`herdr pane list failed: ${r.err || r.out}`);
  return (JSON.parse(r.out) as { result: { panes: Pane[] } }).result.panes;
};

export const readScreen = async (run: Runner, backend: Backend, pane: string, lines?: number): Promise<string> =>
  backend === "aoe"
    ? captureTmux(run, pane, lines)
    : (await run(["herdr", "pane", "read", pane, "--source", lines ? "recent" : "visible", ...(lines ? ["--lines", String(lines)] : [])])).out;

const paneKeys = (run: Runner, clock: Clock, backend: Backend, pane: string): PaneKeys =>
  backend === "aoe"
    ? {
        type: async (text) => {
          if (!(await waitForPrompt(run, clock, pane, 10, 1_000))) return "no ❯ prompt in the pane";
          return (await run(["tmux", "send-keys", "-t", target(pane), "-l", "--", text])).code === 0 ? undefined : "tmux send-keys failed";
        },
        enter: async () => { await run(["tmux", "send-keys", "-t", target(pane), "Enter"]); },
        read: () => captureTmux(run, pane),
      }
    : {
        type: async (text) => ((await run(["herdr", "pane", "send-text", pane, text])).code === 0 ? undefined : "herdr send-text failed"),
        enter: async () => { await run(["herdr", "pane", "send-keys", pane, "enter"]); },
        read: () => readScreen(run, backend, pane),
      };

// Every text the scripts type into a pane goes through here; NOT_SUBMITTED lands in the watch log for the lead.
export const submitToPane = async (run: Runner, clock: Clock, config: DoriConfig, pane: string, text: string): Promise<Submitted> => {
  if (/`|\$\(/.test(text)) throw new UnsafeTextError("refusing to send text containing a backtick or $(");
  const result = await submitText(paneKeys(run, clock, config.backend, pane), clock, text);
  if (result.status === "NOT_SUBMITTED") watchLog(config.watchLog, clock, { source: "submit", line: `NOT_SUBMITTED ${pane} ${result.reason}` });
  return result;
};

export const sendVerified = async (run: Runner, clock: Clock, config: DoriConfig, pane: string, text: string): Promise<boolean> =>
  (await submitToPane(run, clock, config, pane, text)).status === "SUBMITTED";
