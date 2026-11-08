export const compactionTrialProblem = (raw: unknown): string | undefined => {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return "compactionTrial: an object";
  const t = raw as Record<string, unknown>;
  for (const k of ["from", "until"] as const)
    if (t[k] !== undefined && (typeof t[k] !== "string" || (t[k] !== "" && Number.isNaN(Date.parse(t[k] as string))))) return `compactionTrial.${k}: an ISO time or ""`;
  if (t["atK"] !== undefined && !(typeof t["atK"] === "number" && t["atK"] > 0)) return "compactionTrial.atK: a positive number";
  if (t["exclude"] !== undefined) {
    if (typeof t["exclude"] !== "string") return "compactionTrial.exclude: a regular expression";
    try {
      new RegExp(t["exclude"]);
    } catch {
      return "compactionTrial.exclude: a regular expression";
    }
  }
  return undefined;
};

export class ConfigError extends Error {}

// the start of every text typed into a lane for its external-search step: omo's trigger for the ulw-research skill
export const RESEARCH_PREFIX = "ulw research ";

export const researchTextProblem = (text: string): string | undefined =>
  !text.startsWith(RESEARCH_PREFIX)
    ? `explore.researchText must start with "${RESEARCH_PREFIX}" (omo starts its ulw-research skill only for typed text that begins that way here), got "${text.slice(0, 40)}"`
    : !text.includes("{question}")
      ? "explore.researchText must contain {question}, where the research question built from the lane's records goes"
      : undefined;
