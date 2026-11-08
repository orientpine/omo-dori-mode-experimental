import type { ArgvTemplate } from "./config-types.ts";

// dori heavy --job: a named job one host may run for another. argv fills {in} (the input folder), {in0}, {in1}... (the
// input files in the order given), {out} (a folder for result files); env is all the job gets besides PATH, HOME, LANG and
// TMPDIR (inside the job's folder). rl: reinforcement learning, run only on hosts whose heavyQueue.rl is true (queue host or helper).
export type HeavyJob = { readonly argv: ArgvTemplate; readonly env?: Readonly<Record<string, string>>; readonly rl?: boolean };
// a second GPU host the queue host hands jobs to: ssh argv to its forced-command `dori heavy-worker`
export type HeavyHelper = { readonly name: string; readonly ssh: ArgvTemplate };
export type HeavyQueue = {
  readonly jobs: Readonly<Record<string, HeavyJob>>;
  // on the queue host: helpers tried in order when a job at the front of the line cannot start here
  readonly helpers: readonly HeavyHelper[];
  // on any other host: argv that runs `dori` on the queue host (e.g. ["ssh", "main", "~/.bun/bin/dori"]); empty: this
  // host is the queue
  readonly queue: ArgvTemplate;
  // whether this host runs rl jobs at all (false: as a helper it refuses them, cut off from the queue it waits instead)
  readonly rl: boolean;
  // a job's files live here while it runs, on every host, and are deleted after (memory-backed, gone at reboot)
  readonly jobDir: string;
  // as a helper: run other hosts' own commands (dori heavy --kind ... --sync ...) in a bwrap box (heavy-spread.ts)
  readonly exec: boolean;
  // as a helper: such a run is stopped after this many minutes
  readonly execMaxMin: number;
};

const isArgv = (v: unknown): boolean => Array.isArray(v) && v.length > 0 && v.every((p) => typeof p === "string");
const isStringMap = (v: unknown): boolean => v === undefined || (typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string"));

// what is wrong with a heavyQueue section, or undefined
export const heavyQueueProblem = (q: HeavyQueue): string | undefined => {
  for (const [name, job] of Object.entries(q.jobs)) {
    if (!/^[\w.-]{1,64}$/.test(name)) return `heavyQueue.jobs: job name "${name}" must be letters, digits, . _ -`;
    if (!isArgv(job.argv)) return `heavyQueue.jobs.${name}.argv must be a non-empty list of strings`;
    if (!isStringMap(job.env)) return `heavyQueue.jobs.${name}.env must map variable names to strings`;
  }
  for (const h of q.helpers) if (typeof h.name !== "string" || !/^[\w.-]{1,64}$/.test(h.name) || !isArgv(h.ssh)) return `heavyQueue.helpers: each needs a name (letters, digits, . _ -) and an ssh argv`;
  if (!Array.isArray(q.queue) || !q.queue.every((p) => typeof p === "string")) return "heavyQueue.queue must be a list of strings";
  if (q.queue.length && q.helpers.length) return "heavyQueue: a host is either the queue (helpers) or reaches it (queue), not both";
  if (typeof q.exec !== "boolean") return "heavyQueue.exec must be true or false";
  if (!Number.isInteger(q.execMaxMin) || q.execMaxMin < 1) return "heavyQueue.execMaxMin must be a whole number of minutes, 1 or more";
  return undefined;
};
