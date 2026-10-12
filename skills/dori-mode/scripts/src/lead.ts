import { sessionFor, type AoeSession } from "./aoe.ts";
import type { DoriConfig } from "./config.ts";
import type { Runner } from "./run.ts";

export class LeadError extends Error {}

export const findLead = async (run: Runner, config: Pick<DoriConfig, "leadPane">, env: Readonly<Record<string, string | undefined>> = process.env): Promise<string> => {
  const tmux = env.DORI_LEAD_TMUX?.trim() || config.leadPane;
  if (!tmux) throw new LeadError("no DORI_LEAD_TMUX or leadPane configured");
  if ((await run(["tmux", "has-session", "-t", `=${tmux}`])).code !== 0) throw new LeadError(`no live lead tmux session: ${tmux}`);
  const short = tmux.slice(-8);
  const configured = env.DORI_LEAD_AOE_ID?.trim();
  if (configured && tmux.endsWith(`_${short}`) && configured.slice(0, 8) === short) return `${configured} ${tmux}`;
  const listed = await run(["aoe", "list", "--json"]);
  if (listed.code !== 0) throw new LeadError(`aoe list failed: ${listed.err || listed.out}`);
  const session = sessionFor(JSON.parse(listed.out) as AoeSession[], tmux);
  if (!session) throw new LeadError(`no aoe session matches ${tmux}`);
  return `${session.id} ${tmux}`;
};
