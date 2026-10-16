import { appliesWhy, briefGaps, type DirectiveBlock, type Gap, type Ledger, leadGaps, scopeContext, unledgered } from "./directives.ts";
import type { FlowDeps } from "./done-flow.ts";
import { eightSteps, laneRepo, launchLedger, uiSteps } from "./launch.ts";
import { sendVerified } from "./panes.ts";
import type { Lane } from "./registry.ts";
import { watchLog } from "./watch-log.ts";

// dori directive-audit and owner-check: a launched lane's brief and the lead's actions against the directive ledger.

export const blockTexts = async (): Promise<Record<DirectiveBlock, string>> => ({ "eight-steps": await eightSteps(), "ui-steps": await uiSteps() });

const readBrief = async (path: string): Promise<string> => {
  const f = Bun.file(path);
  return (await f.exists()) ? await f.text() : "";
};

export const laneDirectiveGaps = async (deps: Pick<FlowDeps, "run" | "config">, lane: Lane, ledger: Ledger, blocks: Readonly<Record<DirectiveBlock, string>>): Promise<Gap[]> => {
  if (!ledger.entries.length) return [];
  const brief = await readBrief(lane.brief);
  if (!brief) return [{ lane: lane.key, id: "-", line: `DIRECTIVE_GAP ${lane.key} -: its brief ${lane.brief} is not there to check` }];
  const repo = await laneRepo(deps, lane.cwd ?? deps.config.defaultCwd);
  return [...briefGaps(lane, brief, ledger, repo, blocks), ...leadGaps(lane, ledger)];
};

// The directives in scope for a lane, as the owner's words: owner-check reads them next to the brief.
export const laneDirectiveWords = async (deps: Pick<FlowDeps, "run" | "config">, lane: Lane, ledger: Ledger): Promise<string[]> => {
  const brief = await readBrief(lane.brief);
  const ctx = scopeContext(brief, ledger, { ui: lane.ui, repo: await laneRepo(deps, lane.cwd ?? deps.config.defaultCwd) });
  const waived = new Set((lane.directives?.waived ?? []).map((w) => w.id));
  return ledger.entries.filter((e) => e.words && !waived.has(e.id) && appliesWhy(e, ctx)).map((e) => `[${e.id}, ${e.date}] "${e.words}"`);
};

// "Nh", "Nd" or an ISO time, back from now
export const sinceIso = (spec: string, now: number): string => {
  const m = /^(\d+)([hd])$/.exec(spec.trim());
  if (m) return new Date(now - Number(m[1]) * (m[2] === "h" ? 3_600_000 : 86_400_000)).toISOString();
  const t = Date.parse(spec);
  if (Number.isNaN(t)) throw new Error(`--since ${spec}: give Nh, Nd or an ISO time`);
  return new Date(t).toISOString();
};

export type AuditResult = { readonly gaps: readonly Gap[]; readonly lines: readonly string[]; readonly lanes: number };

// The lanes opened since `since` and the owner's messages since then against the ledger. No gap: one DIRECTIVE_AUDIT_OK
// line on stdout and nothing else (quiet). Gaps: each line in the watch log and one [DIRECTIVE_AUDIT] summary typed to the
// lead. dryRun: the lines only.
export const runDirectiveAudit = async (deps: FlowDeps, opts: { readonly since: string; readonly inbox: string; readonly owner: string; readonly dryRun?: boolean }): Promise<AuditResult> => {
  const ledger = launchLedger(deps);
  const lanes = (await deps.registry.list()).filter((l) => l.openedAt >= opts.since).sort((a, b) => a.openedAt.localeCompare(b.openedAt));
  const blocks = await blockTexts();
  const gaps: Gap[] = [];
  for (const l of lanes) gaps.push(...(await laneDirectiveGaps(deps, l, ledger, blocks)));
  gaps.push(...unledgered(await readBrief(opts.inbox), ledger, opts.owner, opts.since, process.env.DORI_DISCORD_GUILD?.trim() ?? ""));
  if (!gaps.length) return { gaps, lanes: lanes.length, lines: [`DIRECTIVE_AUDIT_OK since ${opts.since}: ${lanes.length} lanes and the owner's messages read against ${ledger.entries.length} directives, no gap`] };
  const lines = gaps.map((g) => g.line);
  if (opts.dryRun) return { gaps, lanes: lanes.length, lines };
  for (const line of lines) watchLog(deps.config.watchLog, deps.clock, { source: "directive-audit", line });
  const short = gaps.slice(0, 4).map((g) => (g.lane === "-" ? `unledgered ${g.id}` : `${g.lane} ${g.id}`)).join(", ");
  const summary = `[DIRECTIVE_AUDIT] ${gaps.length} directive gaps since ${opts.since}: ${short}${gaps.length > 4 ? ", ..." : ""}. Full list: dori directive-audit --since ${opts.since} --dry-run`;
  const pane = deps.config.leadPane;
  const sent = pane ? await sendVerified(deps.run, deps.clock, deps.config, pane, summary) : false;
  const tail = sent ? `DIRECTIVE_AUDIT_SENT ${pane}` : `DIRECTIVE_AUDIT_NOT_SENT ${pane || "(no leadPane)"}: the summary did not reach the lead; the gaps are in the watch log`;
  watchLog(deps.config.watchLog, deps.clock, { source: "directive-audit", line: tail });
  return { gaps, lanes: lanes.length, lines: [...lines, tail] };
};
