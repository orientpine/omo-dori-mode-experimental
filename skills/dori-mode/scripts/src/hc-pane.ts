import { liveSessions, QUESTION_MARK, sessionFor } from "./aoe.ts";
import { hcCall, isKind } from "./runtime/hc/exec.ts";
import { shellInFrontName } from "./herdr.ts";
import { type Clock, execOf, type Runner, runtimesOf } from "./run.ts";
import { formatRef, type SessionRef, type SessionRuntime } from "./runtime/types.ts";
import { AGENT, procTable, topAgent } from "./session-id.ts";

// An hc (herdr-core) terminal in the fork's records: its pane is formatRef's "hc:t<n>", the one shape no herdr pane id
// (w1:p2) or tmux name takes, so every primitive in herdr.ts and aoe.ts that gets it answers through hc. hc starts a core
// on any call when none runs, so nothing here is called for a pane that is not hc, and hc is listed only where it is the
// chosen runtime (hcChosen).
export const isHcPane = (pane: string): boolean => pane.startsWith("hc:");
export const hcRef = (pane: string): SessionRef => ({ runtime: "hc", id: pane.slice("hc:".length) });
const hc = (run: Runner): SessionRuntime => runtimesOf(run).for({ runtime: "hc", id: "" });

export const hcChosen = (run: Runner): boolean => runtimesOf(run).choice?.kind === "hc";

// The group a pane's session lives in: an hc terminal's dori.group label (hc ls prints no labels, hc 0.1.18), a herdr pane's
// workspace. An hc terminal that is gone, or whose labels cannot be read, throws: a handover then opens nothing rather than
// a replacement in the default group (review 3 of #404)
export const paneGroup = async (run: Runner, pane: string): Promise<string | undefined> => {
  if (!isHcPane(pane)) return sessionFor(await liveSessions(run), pane)?.profile;
  try {
    const labels = (await hcCall(execOf(run), ["get", hcRef(pane).id]))["labels"] as Record<string, unknown> | undefined;
    const group = labels?.["dori.group"];
    return typeof group === "string" && group !== "" ? group : undefined;
  } catch (e) {
    if (isKind(e, "not_found")) throw new Error(`there is no hc terminal ${pane} any more`);
    throw new Error(`the hc group of ${pane} could not be read (${e instanceof Error ? e.message : String(e)})`);
  }
};

// hc's read with no --lines prints the whole history; 120 rows covers the screen the omo marks are read from
const SCREEN_ROWS = 120;
export const hcRead = (run: Runner, pane: string, lines?: number): Promise<string> => hc(run).read(hcRef(pane), lines ?? SCREEN_ROWS).catch(() => "");

const probeOf = (run: Runner, pane: string) => hc(run).probe(hcRef(pane)).catch(() => undefined);

// gone: hc has no such terminal (or it finished); dead: the terminal is there but its shell is in front, the agent gone
// (hc keeps no exit status of a program the shell ran, so status is -1). A probe that fails is read as gone, as herdr's is.
export const hcLife = async (run: Runner, pane: string): Promise<{ readonly live: true } | { readonly live: false; readonly how: "gone" } | { readonly live: false; readonly how: "dead"; readonly status: number }> => {
  const p = await probeOf(run, pane);
  if (!p || p.status === "gone") return { live: false, how: "gone" };
  return p.shellInFront || p.status === "shell" ? { live: false, how: "dead", status: -1 } : { live: true };
};

export const hcShellPid = async (run: Runner, pane: string): Promise<number> => (await probeOf(run, pane))?.rootPid ?? 0;

// the foreground agent hc names, else the topmost agent under the terminal's root process
export const hcAgentPid = async (run: Runner, pane: string): Promise<number | undefined> => {
  const p = await probeOf(run, pane);
  if (!p) return undefined;
  const fg = p.foreground?.find((f) => f.pid && AGENT.test(f.argv.join(" ")));
  if (fg?.pid) return fg.pid;
  return p.rootPid ? topAgent(await procTable(run), p.rootPid)?.pid : undefined;
};

export const hcClose = async (run: Runner, pane: string): Promise<string> => {
  if ((await probeOf(run, pane))?.status === "gone") return `hc terminal ${pane} not found`;
  const failed = await hc(run).close(hcRef(pane)).then(() => undefined, (e: unknown) => (e instanceof Error ? e.message : String(e)));
  return failed === undefined ? `hc terminal (${pane}) stopped and closed` : `hc ${pane} not closed: ${failed.slice(0, 160)}`;
};

// The live terminals of this core as aoe.ts session rows (id and pane "hc:t<n>", title its name, path its cwd, profile
// its dori.group); none when hc is not the chosen runtime.
export const hcSessions = async (run: Runner): Promise<{ id: string; title: string; path: string; tool?: string; profile?: string; pane: string }[]> => {
  if (!hcChosen(run)) return [];
  const rows = await hc(run).list().catch(() => []);
  return rows.map(({ ref, name, cwd, agent }) => ({ id: formatRef(ref), title: name ?? ref.id, path: cwd ?? "", ...(agent ? { tool: agent } : {}), ...(ref.group ? { profile: ref.group } : {}), pane: formatRef(ref) }));
};

// A new labelled terminal in cwd running the user's shell (group: the dori.group label, "dori" unless laneWorkspace
// names one), with line typed into it once its shell has drawn; the pane "hc:t<n>".
export const hcOpen = async (rt: SessionRuntime, run: Runner, clock: Clock, opts: { readonly title: string; readonly cwd: string; readonly workspace?: string }, line: string): Promise<{ readonly pane: string }> => {
  const ref = await rt.create({ name: opts.title, cwd: opts.cwd, env: {}, role: "lane", container: "tab", ...(opts.workspace ? { group: opts.workspace } : {}) }).catch((e: unknown) => Promise.reject(new Error(`hc run failed: ${e instanceof Error ? e.message : String(e)}`)));
  const pane = formatRef(ref);
  for (let i = 0; i < 20 && !(await hcRead(run, pane)).trim(); i++) await clock.sleep(250);
  await rt.start(ref, line).catch((e: unknown) => Promise.reject(new Error(`hc send failed in ${pane}: ${e instanceof Error ? e.message : String(e)}`)));
  return { pane };
};

// What dori type gets into an hc pane: hc send pastes the text and presses Enter in one call, so Enter is nothing here;
// typed under "any" like a herdr pane (a running turn takes it as steering), never into a shell, an unreported program,
// a blocked agent or an open omo question. A string is why nothing was sent.
export const hcType = async (run: Runner, pane: string, text: string): Promise<string | undefined> => {
  const life = await hcLife(run, pane);
  if (life.live) {
    // the fork's shell rule (herdr.ts shellInFrontName, reviews 1-3 of #347): any shell in front holds the text, a sh -c
    // reading stdin included, where the runtime's own check lets a command-running shell through
    const fg = (await probeOf(run, pane))?.foreground ?? [];
    const shell = shellInFrontName({ foreground_processes: fg.map((f) => ({ name: f.name, argv: f.argv })) });
    if (shell !== undefined) return `the agent in ${pane} is not in front: ${shell ? `a shell (${shell}) is` : "hc shows nothing readable in front"}, and it could run the text; nothing was typed`;
  }
  if (!life.live) return life.how === "gone" ? `PANE_GONE: there is no hc terminal ${pane} (it ended, or the name is wrong); nothing was typed` : `PANE_DEAD: no agent runs in ${pane} (only its shell, which would run the text); nothing was typed`;
  if (QUESTION_MARK.test(await hcRead(run, pane))) return `PANE_BLOCKED: a question is open in ${pane} (Ask user); the text would answer it, so nothing was typed`;
  const out = await hc(run).deliver(hcRef(pane), text, { when: "any" });
  if (out.kind === "delivered") return undefined;
  if (out.kind === "no-agent") return `PANE_DEAD: hc says no agent reads ${pane}; nothing was typed`;
  if (out.kind === "not-ready") return out.status === "blocked" ? `PANE_BLOCKED: the agent in ${pane} waits on a confirmation the text would answer; nothing was typed` : `the agent in ${pane} is in state ${out.status}, not one that reads input, so nothing was typed`;
  return `hc send to ${pane} did not complete (${out.kind === "ambiguous" ? out.detail : out.kind}); the text may have arrived`;
};
