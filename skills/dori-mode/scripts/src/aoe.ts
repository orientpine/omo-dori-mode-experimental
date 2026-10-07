import type { Pane } from "./panes.ts";
import type { Clock, Runner } from "./run.ts";

export type AoeSession = { readonly id: string; readonly title: string; readonly path: string; readonly tool?: string; readonly profile?: string };

// "=name:" makes tmux match the session name exactly instead of by prefix
export const target = (name: string): string => `=${name}:`;

export const aoeSessions = async (run: Runner): Promise<AoeSession[]> => {
  const r = await run(["aoe", "list", "--json", "--state", "live"]);
  if (r.code !== 0) throw new Error(`aoe list failed: ${r.err || r.out}`);
  return JSON.parse(r.out) as AoeSession[];
};

const tmuxNames = async (run: Runner): Promise<string[]> => {
  const r = await run(["tmux", "ls", "-F", "#S"]);
  return r.code === 0 ? r.out.split("\n").filter(Boolean) : [];
};

const suffixOf = (s: AoeSession): string => `_${s.id.slice(0, 8)}`;

export const tmuxNameFor = (s: AoeSession, names: readonly string[]): string | undefined =>
  names.find((n) => n === `aoe_${s.title}${suffixOf(s)}`) ?? names.find((n) => n.startsWith("aoe_") && !n.startsWith("aoe_term_") && n.endsWith(suffixOf(s)));

export const listAoePanes = async (run: Runner): Promise<Pane[]> => {
  const sessions = await aoeSessions(run);
  const names = await tmuxNames(run);
  return sessions.flatMap((s) => {
    const name = tmuxNameFor(s, names);
    return name ? [{ pane_id: name, workspace_id: s.profile ?? "aoe", agent: s.tool, title: s.title, cwd: s.path }] : [];
  });
};

const idFor = (sessions: readonly AoeSession[], pane: string): string | undefined =>
  (sessions.find((s) => pane === `aoe_${s.title}${suffixOf(s)}`) ?? sessions.find((s) => pane.endsWith(suffixOf(s))))?.id;

export const aoeIdFor = async (run: Runner, pane: string): Promise<string | undefined> => idFor(await aoeSessions(run), pane);

// aoe's runtime state per session id: idle, running, waiting (a question or approval is open) or error
export const aoeStates = async (run: Runner): Promise<Map<string, string>> => {
  const r = await run(["aoe", "ps", "--json"]);
  if (r.code !== 0) throw new Error(`aoe ps failed: ${r.err || r.out}`);
  return new Map((JSON.parse(r.out) as { session: string; state: string }[]).map((p) => [p.session, p.state]));
};

// omo prints "esc to interrupt" while its main turn runs, and "goal continues in" while a goal wake is scheduled.
// aoe's state lags behind both, and shows an open omo question ("Ask user · ...") as idle.
export const BUSY_MARKS = ["esc to interrupt", "goal continues in"];
export const QUESTION_MARK = /Ask user ·|\(\d+\/\d+ answered\)/;

export type Activity = "busy" | "running" | "waiting" | "error" | "question" | "idle";

// What each live pane's agent is doing, from aoe ps plus its screen. Panes aoe does not list are left out.
export const paneActivity = async (run: Runner, panes: readonly string[]): Promise<Map<string, Activity>> => {
  const out = new Map<string, Activity>();
  if (!panes.length) return out;
  const [sessions, states] = await Promise.all([aoeSessions(run), aoeStates(run)]);
  for (const pane of panes) {
    const id = idFor(sessions, pane);
    const state = id ? states.get(id) : undefined;
    if (!state) continue;
    const screen = await captureTmux(run, pane);
    if (BUSY_MARKS.some((m) => screen.includes(m))) out.set(pane, "busy");
    else if (state === "waiting" || state === "error") out.set(pane, state);
    else if (QUESTION_MARK.test(screen)) out.set(pane, "question");
    else out.set(pane, state === "idle" ? "idle" : "running");
  }
  return out;
};

export const captureTmux = async (run: Runner, pane: string, lines?: number): Promise<string> => {
  const out = (await run(["tmux", "capture-pane", "-p", "-J", "-t", target(pane), ...(lines ? ["-S", `-${lines}`] : [])])).out;
  return lines ? out.split("\n").slice(-lines).join("\n") : out;
};

export const tmuxPanePid = async (run: Runner, pane: string): Promise<number> => {
  const r = await run(["tmux", "display-message", "-p", "-t", target(pane), "#{pane_pid}"]);
  return r.code === 0 ? Number(r.out.trim()) || 0 : 0;
};

// omo's input line is the last line starting with ❯; transcript lines above it are not input
export const inputLine = (screen: string): string | undefined => screen.split("\n").findLast((l) => l.trimStart().startsWith("❯"));

export const waitForPrompt = async (run: Runner, clock: Clock, pane: string, tries: number, everyMs: number): Promise<boolean> => {
  for (let i = 0; i < tries; i++) {
    if (inputLine(await captureTmux(run, pane)) !== undefined) return true;
    await clock.sleep(everyMs);
  }
  return false;
};

export const sendTmuxVerified = async (run: Runner, clock: Clock, pane: string, text: string): Promise<boolean> => {
  if (!(await waitForPrompt(run, clock, pane, 10, 1_000))) return false;
  if ((await run(["tmux", "send-keys", "-t", target(pane), "-l", "--", text])).code !== 0) return false;
  await run(["tmux", "send-keys", "-t", target(pane), "Enter"]);
  const probe = text.slice(0, 24);
  for (let attempt = 0; attempt < 4; attempt++) {
    await clock.sleep(700);
    if (!inputLine(await captureTmux(run, pane))?.includes(probe)) return true;
    if (attempt < 3) await run(["tmux", "send-keys", "-t", target(pane), "Enter"]);
  }
  return false;
};

export class AoeError extends Error {}

// aoe add refuses a title+path pair that already exists, even in the trash (aoe rm --purge clears it)
export const openAoeSession = async (run: Runner, clock: Clock, opts: { readonly title: string; readonly cwd: string; readonly tool: string; readonly model: string }): Promise<string> => {
  const added = await run(["aoe", "add", opts.cwd, "-t", opts.title, "--tool", opts.tool, "-l", "--extra-args", `--model ${opts.model}`]);
  if (added.code !== 0) throw new AoeError(`aoe add failed: ${added.err || added.out}`);
  for (let i = 0; i < 30; i++) {
    const s = (await aoeSessions(run)).find((x) => x.title === opts.title && x.path === opts.cwd);
    const name = s ? tmuxNameFor(s, await tmuxNames(run)) : undefined;
    if (name) return name;
    await clock.sleep(1_000);
  }
  throw new AoeError(`aoe session ${opts.title} has no tmux session after aoe add`);
};

// stop the agent and move the session to the aoe trash (restorable; never --purge here)
export const closeAoeSession = async (run: Runner, pane: string): Promise<string> => {
  const id = await aoeIdFor(run, pane);
  if (!id) return `aoe session for ${pane} not found`;
  const stopped = await run(["aoe", "session", "stop", id]);
  const removed = await run(["aoe", "rm", id]);
  return removed.code === 0 ? `aoe session ${id} (${pane}) stopped and trashed` : `aoe session ${id} not trashed: ${(removed.err || removed.out || stopped.err).slice(0, 160)}`;
};

export const currentTmuxSession = async (run: Runner): Promise<string> => {
  if (!process.env.TMUX) return "";
  const r = await run(["tmux", "display-message", "-p", "#S"]);
  return r.code === 0 ? r.out.trim() : "";
};
