import { readFileSync } from "node:fs";
import { BUSY_MARK, liveSessions, QUESTION_MARK, sessionFor } from "./aoe.ts";
import { readFrozen } from "./frozen.ts";
import { Registry } from "./registry.ts";
import { hcCall, isKind } from "./runtime/hc/exec.ts";
import { slugName } from "./runtime/hc/sessions.ts";
import { shellInFrontName } from "./herdr.ts";
import { type ChosenRuntimes, type Clock, execOf, openingRuntime, type Runner, runtimesOf } from "./run.ts";
import { formatRef, type RuntimeKind, type SessionInfo, type SessionRef, type SessionRuntime } from "./runtime/types.ts";
import { AGENT, procTable, topAgent } from "./session-id.ts";
import { LaunchFailed } from "./launch-types.ts";

// An hc (herdr-core) terminal in the fork's records: its pane is formatRef's "hc:t<n>", the one shape no herdr pane id
// (w1:p2) or tmux name takes, so every primitive in herdr.ts and aoe.ts that gets it answers through hc. hc starts a core
// on any call when none runs, so nothing here is called for a pane that is not hc, and hc is listed only where it is the
// chosen runtime (hcChosen).
export const isHcPane = (pane: string): boolean => pane.startsWith("hc:");
export const hcRef = (pane: string): SessionRef => ({ runtime: "hc", id: pane.slice("hc:".length) });
const hc = (run: Runner): SessionRuntime => runtimesOf(run).for({ runtime: "hc", id: "" });

export const hcChosen = (run: Runner): boolean => runtimesOf(run).choice?.kind === "hc";

// The Dori's state folder and config file, handed over once by an entrypoint. What its sessions live on is read from them
// at each listing, as upstream reads registry.open() per call (dead-panes.ts, sync.ts): the open lanes, the lead the config
// names now and the frozen records; a tmux name adds no runtime (reviews 2 and 3 of #404, challenges of plan-r3)
type DoriState = { readonly stateDir: string; readonly configPath: string };
let state: DoriState | undefined;
export const useDoriState = (next: DoriState | undefined): void => {
  state = next;
};
const kindOfPane = (pane: string): RuntimeKind | undefined => (isHcPane(pane) ? "hc" : pane.includes(":") ? "herdr" : undefined);
// the lead as loadConfig takes it: DORI_LEAD_PANE over the file's leadPane (review 4 of #404)
export const leadNow = (path: string): string => {
  const env = process.env["DORI_LEAD_PANE"];
  if (env !== undefined) return env;
  try {
    return String((JSON.parse(readFileSync(path, "utf8")) as { leadPane?: unknown }).leadPane ?? "");
  } catch {
    return "";
  }
};
export const storedRuntimes = async (): Promise<ReadonlySet<RuntimeKind>> => {
  if (!state) return new Set();
  const panes = [...(await new Registry(state.stateDir).open()).map((l) => l.pane ?? ""), leadNow(state.configPath), ...readFrozen(state.stateDir).map((r) => r.pane)];
  return new Set(panes.flatMap((p) => kindOfPane(p) ?? []));
};

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

// Every session of the runtimes in use, as sessions.ts listSessions (upstream #154) lists them, with the stored kinds added
export const listKeptSessions = async (rts: ChosenRuntimes): Promise<SessionInfo[]> => {
  // the chosen runtime and every one a stored session lives on must answer; another the process built on the way (a herdr
  // adapter liveSessions made on an hc Dori) is listed when it can be, never failing the count (review 2 of #404)
  const stored = await storedRuntimes();
  for (const kind of stored) rts.for({ runtime: kind, id: "" });
  const required = new Set<RuntimeKind>([...stored, ...(rts.choice ? [rts.choice.kind] : [])]);
  try {
    void rts.default;
  } catch (e) {
    if (rts.kinds().length === 0) throw e;
  }
  const sessions: SessionInfo[] = [];
  for (const kind of rts.kinds()) {
    try {
      sessions.push(...(await rts.for({ runtime: kind, id: "" }).list()));
    } catch (e) {
      if (required.has(kind)) throw e;
    }
  }
  return sessions;
};

// hc's --lines is history above the screen (hc 0.1.18 api.rs): 0 reads the screen alone, which is what the omo marks and the
// open-question check are read from, so an answered question in the history blocks nothing (review 7 of #404); a caller
// that asks for lines gets that much history too
export const hcRead = (run: Runner, pane: string, lines?: number): Promise<string> => hc(run).read(hcRef(pane), lines ?? 0).catch(() => "");

const probeOf = (run: Runner, pane: string) => hc(run).probe(hcRef(pane)).catch(() => undefined);

// gone: hc has no such terminal (or it finished); dead: the terminal is there but its shell is in front, the agent gone
// (hc keeps no exit status of a program the shell ran, so status is -1). An hc get that fails (the core busy or down, not
// not_found) is no verdict: live, so the dead-lane sweep and revive act on nothing they could not see (plan-r8).
export const hcLife = async (run: Runner, pane: string): Promise<{ readonly live: true } | { readonly live: false; readonly how: "gone" } | { readonly live: false; readonly how: "dead"; readonly status: number }> => {
  const p = await probeOf(run, pane);
  if (!p) return { live: true };
  if (p.status === "gone") return { live: false, how: "gone" };
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

// a deliberate close of a session the caller decided to end: an unreadable first get goes on to the close, which reads hc
// back after it (review 6), so doubt never reports a terminal closed
export const hcClose = async (run: Runner, pane: string): Promise<string> => {
  if ((await probeOf(run, pane))?.status === "gone") return `hc terminal ${pane} not found`;
  const failed = await hc(run).close(hcRef(pane)).then(() => undefined, (e: unknown) => (e instanceof Error ? e.message : String(e)));
  if (failed !== undefined) return `hc ${pane} not closed: ${failed.slice(0, 160)}`;
  // hc's close gives up quietly on a program still running after its kill: closed only once hc reads it gone (review 6 of #404)
  const after = await probeOf(run, pane);
  return after?.status === "gone" ? `hc terminal (${pane}) stopped and closed` : `hc ${pane} not closed: ${after ? "it still runs after the kill" : "its state could not be read after the kill"}`;
};

// The live terminals of this core as aoe.ts session rows (id and pane "hc:t<n>", title its name, path its cwd, profile
// its dori.group); none when hc is not the chosen runtime.
export const hcSessions = async (run: Runner): Promise<{ id: string; title: string; path: string; tool?: string; profile?: string; pane: string }[]> => {
  if (!hcChosen(run) && !(await storedRuntimes()).has("hc")) return [];
  // hc not answering is no empty list: a caller then keeps what it would drop as gone (a frozen record)
  const rows = await hc(run).list();
  return rows.map(({ ref, name, cwd, agent }) => ({ id: formatRef(ref), title: name ?? ref.id, path: cwd ?? "", ...(agent ? { tool: agent } : {}), ...(ref.group ? { profile: ref.group } : {}), pane: formatRef(ref) }));
};

// The name of a new lead's hc terminal: <this Dori>-lead from the first discord.callNames entry hc can spell (ZzangDori ->
// zzangdori-lead), so doriterm's lead row says whose lead it is (owner 2026-11-12: "dori-mode-11111163은 뭐야?"). A live
// terminal holding it (the old lead, frozen until it closes) gives -2, -3, ...; an unreadable list only skips that check,
// since create() drops a name hc reports taken. Undefined off hc or without such a name: the handover keeps its own title.
export const hcLeadTitle = async (run: Runner, backend: "aoe" | "herdr", callNames: readonly string[]): Promise<string | undefined> => {
  const dori = callNames.map((n) => slugName(n.trim())).find((s) => s !== undefined && /[a-z]/.test(s));
  if (!dori || openingRuntime(run, backend) !== "hc") return undefined;
  const taken = new Set((await hc(run).list().catch(() => [])).flatMap((t) => t.name ?? []));
  const base = `${dori.slice(0, 24)}-lead`;
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
  return name;
};

export class HcStartupError extends LaunchFailed {
  constructor(message: string, readonly rollback: boolean) {
    super(message);
  }
}

// A new labelled terminal in cwd running the user's shell (group: the dori.group label, "dori" unless laneWorkspace
// names one), with line typed into it once its shell has drawn; the pane "hc:t<n>".
export const hcOpen = async (rt: SessionRuntime, run: Runner, clock: Clock, opts: { readonly title: string; readonly cwd: string; readonly workspace?: string; readonly beforeStart?: (opened: { readonly pane: string }) => Promise<void> }, line: string): Promise<{ readonly pane: string }> => {
  const ref = await rt.create({ name: opts.title, cwd: opts.cwd, env: {}, role: "lane", container: "tab", ...(opts.workspace ? { group: opts.workspace } : {}) }).catch((e: unknown) => Promise.reject(new Error(`hc run failed: ${e instanceof Error ? e.message : String(e)}`)));
  const pane = formatRef(ref);
  for (let i = 0; i < 20 && !(await hcRead(run, pane)).trim(); i++) await clock.sleep(250);
  const cleanup = async (): Promise<boolean> => {
    try {
      await rt.close(ref);
      return (await rt.probe(ref)).status === "gone";
    } catch {
      return false;
    }
  };
  await opts.beforeStart?.({ pane }).catch(async (error: unknown) => {
    const why = `hc before start failed in ${pane}: ${error instanceof Error ? error.message : String(error)}`;
    const cleaned = await cleanup();
    throw new HcStartupError(why, cleaned);
  });
  await rt.start(ref, line).catch(async (e: unknown) => {
    const why = `hc send failed in ${pane}: ${e instanceof Error ? e.message : String(e)}`;
    const cleaned = await cleanup();
    const definite = isKind(e, "invalid_params", "not_found", "finished", "blocked", "status_mismatch");
    throw new HcStartupError(why, definite && cleaned);
  });
  return { pane };
};

// A blocked status no dialog holds any more (2026-11-12, hc:t2r): senpi reports blocked while a dialog's promise is open,
// and took a permission dialog off the screen without settling it, so the status stayed blocked for hours over omo's own
// input box. It is stale only when all of these hold: hc's status has said blocked for STALE_BLOCKED_MS (a dialog that
// just opened draws within that), and the bottom of the screen is omo's empty input box with no running-turn mark and no
// open question. A dialog on screen replaces that box (senpi's selector has no ❯ line), and an idle agent starts no new
// dialog before a turn runs, so the text goes to the editor and answers nothing. The status's time, else undefined.
const STALE_BLOCKED_MS = 2 * 60_000;
const idleInputBox = (screen: string): boolean => {
  const lines = screen.replace(/\n+$/, "").split("\n");
  const box = lines.findLastIndex((l) => l.trimStart().startsWith("❯"));
  if (box < 0 || lines.length - 1 - box > 4) return false;
  const border = (l: string): boolean => l.trimStart().startsWith("─");
  const above = lines.slice(Math.max(0, box - 2), box);
  // an empty editor only: a draft on the ❯ line, or a second line under it, would be sent with the text (review 1 of #464)
  const empty = (lines[box] ?? "").trim() === "❯" && border(lines[box + 1] ?? "");
  return empty && above.some(border) && !above.some((l) => l.toLowerCase().includes(BUSY_MARK));
};
export const hcStaleBlock = async (run: Runner, pane: string, now = Date.now()): Promise<number | undefined> => {
  const t = await hcCall(execOf(run), ["get", hcRef(pane).id]).catch(() => undefined);
  const status = t?.["status"] as { state?: unknown } | undefined;
  const since = t?.["status_ms"];
  if (status?.state !== "blocked" || typeof since !== "number" || now - since < STALE_BLOCKED_MS) return undefined;
  const screen = await hc(run).read(hcRef(pane), 0).catch(() => "");
  return idleInputBox(screen) && !QUESTION_MARK.test(screen) ? since : undefined;
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
  // the open-question guard needs the screen: one that cannot be read cannot rule a question out (plan-r8, challenge)
  const screen = await hc(run).read(hcRef(pane), 0).catch(() => undefined);
  if (screen === undefined) return `the screen of ${pane} could not be read, so an open question cannot be ruled out; nothing was typed`;
  if (QUESTION_MARK.test(screen)) return `PANE_BLOCKED: a question is open in ${pane} (Ask user); the text would answer it, so nothing was typed`;
  const out = await hc(run).deliver(hcRef(pane), text, { when: "any" });
  if (out.kind === "delivered") return undefined;
  if (out.kind === "no-agent") return `PANE_DEAD: hc says no agent reads ${pane}; nothing was typed`;
  if (out.kind === "not-ready" && out.status === "blocked") {
    const since = await hcStaleBlock(run, pane);
    if (since !== undefined) {
      const forced = await hc(run).deliver(hcRef(pane), text, { when: "any", force: true });
      if (forced.kind === "delivered") {
        process.stderr.write(`STALE_BLOCKED ${pane}: hc has said blocked since ${new Date(since).toISOString()} but omo's idle input box is on screen and no dialog, so the text was typed; the agent's own status (Needs you) clears only when it restarts in the same conversation at idle\n`);
        return undefined;
      }
      if (forced.kind === "ambiguous") return `hc send to ${pane} did not complete (${forced.detail}); the text may have arrived`;
    }
  }
  if (out.kind === "not-ready") return out.status === "blocked" ? `PANE_BLOCKED: the agent in ${pane} waits on a confirmation the text would answer; nothing was typed` : `the agent in ${pane} is in state ${out.status}, not one that reads input, so nothing was typed`;
  return `hc send to ${pane} did not complete (${out.kind === "ambiguous" ? out.detail : out.kind}); the text may have arrived`;
};
