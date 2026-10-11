import { fill } from "./config.ts";
import type { Runner } from "./run.ts";

// Which reviewer ids this host can call, checked before any review is asked for. Offered: the ids `omo --list-models`
// prints per provider. Logged in: `omo auth check --provider P --json` says status "ready" or lists an account that is not
// blocked (omo reports a provider served by an extension, such as anthropic-subscription, as provider_not_found while
// its accounts are logged in and calls work).

export type HostModels = { readonly offered: ReadonlyMap<string, ReadonlySet<string>>; readonly loggedIn: ReadonlySet<string> };

export type ReviewerCheck = { readonly listed: string; readonly call?: string; readonly note: string };

const THINKING = /:(off|minimal|low|medium|high|xhigh|max)$/;

export const splitModel = (model: string): { readonly provider?: string; readonly id: string; readonly level: string } => {
  const level = THINKING.exec(model)?.[0] ?? "";
  const bare = level ? model.slice(0, -level.length) : model;
  const slash = bare.indexOf("/");
  return slash > 0 ? { provider: bare.slice(0, slash), id: bare.slice(slash + 1), level } : { id: bare, level };
};

// `omo --list-models`: a header line, then "<provider> <model> <context> ..." per model
export const parseModelList = (out: string): Map<string, Set<string>> => {
  const offered = new Map<string, Set<string>>();
  for (const line of out.split("\n")) {
    const [provider, id] = line.trim().split(/\s+/);
    if (!provider || !id || provider === "provider") continue;
    offered.set(provider, (offered.get(provider) ?? new Set<string>()).add(id));
  }
  return offered;
};

export const loggedInFrom = (json: string): boolean => {
  let r: { status?: string; accounts?: { blocked?: boolean }[] };
  try {
    r = JSON.parse(json) as typeof r;
  } catch {
    return false;
  }
  return r.status === "ready" || (r.accounts ?? []).some((a) => a.blocked !== true);
};

export class ModelCheckError extends Error {}

export const hostModels = async (run: Runner, cmds: { readonly modelsCommand: readonly string[]; readonly authCommand: readonly string[] }, wanted: readonly string[]): Promise<HostModels> => {
  const listed = await run(cmds.modelsCommand, { timeoutMs: 60_000 });
  const offered = parseModelList(listed.out);
  if (listed.code !== 0 || !offered.size) throw new ModelCheckError(`cannot list this host's models (${cmds.modelsCommand.join(" ")}: exit ${listed.code} ${listed.err.split("\n")[0] ?? ""})`);
  const ids = new Set(wanted.map((m) => splitModel(m).id));
  const providers = [...offered].filter(([, models]) => [...ids].some((id) => models.has(id))).map(([p]) => p);
  const checked = await Promise.all(providers.map(async (p) => [p, loggedInFrom((await run(fill(cmds.authCommand, { provider: p }), { timeoutMs: 60_000 })).out)] as const));
  return { offered, loggedIn: new Set(checked.filter(([, ok]) => ok).map(([p]) => p)) };
};

// The listed id when its provider offers it and is logged in; otherwise the same model under another logged-in provider
// that offers it (github-copilot/gpt-6.1-sol -> chatgpt-subscription/gpt-6.1-sol); otherwise no call, and why.
export const resolveReviewer = (listed: string, host: HostModels): ReviewerCheck => {
  const { provider, id, level } = splitModel(listed);
  const offers = (p: string): boolean => host.offered.get(p)?.has(id) ?? false;
  if (provider && offers(provider) && host.loggedIn.has(provider)) return { listed, call: listed, note: "offered and logged in" };
  const why = !provider ? `${id} has no provider` : !host.offered.has(provider) ? `omo knows no provider ${provider}` : !offers(provider) ? `${provider} does not offer ${id}` : `${provider} is not logged in`;
  const other = [...host.offered.keys()].find((p) => p !== provider && offers(p) && host.loggedIn.has(p));
  return other ? { listed, call: `${other}/${id}${level}`, note: `${why}; ${other} serves it` } : { listed, note: `${why}, and no logged-in provider offers ${id}` };
};
