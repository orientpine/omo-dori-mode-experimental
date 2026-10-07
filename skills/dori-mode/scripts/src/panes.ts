import { captureTmux, listAoePanes, sendTmuxVerified } from "./aoe.ts";
import type { Backend } from "./config.ts";
import type { Clock, Runner } from "./run.ts";

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

const promptHolds = (screen: string, probe: string): boolean =>
  screen.split("\n").some((l) => l.trimStart().startsWith("❯") && l.includes(probe));

export const sendVerified = async (run: Runner, clock: Clock, backend: Backend, pane: string, text: string): Promise<boolean> => {
  if (/`|\$\(/.test(text)) throw new UnsafeTextError("refusing to send text containing a backtick or $(");
  if (backend === "aoe") return sendTmuxVerified(run, clock, pane, text);
  if ((await run(["herdr", "pane", "send-text", pane, text])).code !== 0) return false;
  await run(["herdr", "pane", "send-keys", pane, "enter"]);
  const probe = text.slice(0, 24);
  for (let attempt = 0; attempt < 4; attempt++) {
    await clock.sleep(700);
    if (!promptHolds(await readScreen(run, backend, pane), probe)) return true;
    if (attempt < 3) await run(["herdr", "pane", "send-keys", pane, "enter"]);
  }
  return false;
};
