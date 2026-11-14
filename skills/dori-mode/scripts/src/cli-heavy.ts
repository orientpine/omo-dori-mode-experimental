import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { stager } from "./heavy-assets.ts";
import { defaultOut, heavyBatch, readItems } from "./heavy-batch.ts";
import { heavyOuter, runHere } from "./heavy-here.ts";
import { holdCommand } from "./heavy-hold.ts";
import { gpuRoom, neverFits, parseMem, readMeminfo } from "./heavy-mem.ts";
import { heavyJobCommand, heavyServe } from "./heavy-queue.ts";
import { heavyWorker } from "./heavy-worker.ts";
import { logShip, shipMissing } from "./heavy-ship.ts";
import { heavySpread, isKind, spreadPlan, toolsHere, withPipefail, type Plan, type SpreadJob } from "./heavy-spread.ts";
import { sampleHost } from "./host-guard.ts";
import { run } from "./run.ts";
import type { Command } from "./cli-context.ts";
import { die } from "./cli-context.ts";
import { makeHeavyDeps } from "./cli-deps-heavy.ts";

const heavyCommand: Command = async (context) => {
  const { rest, config, opt, flags, many } = context;
  const { heavyDeps } = makeHeavyDeps(context);
  const sep = rest.indexOf("--");
  const label = rest[0];
  const cmd = sep >= 0 ? rest.slice(sep + 1) : [];
  const load = async () => (await sampleHost(run, config)).load1;
  // dori heavy hold-local [on --until ... --reason ... [--except ACCOUNT ...] | off]: no job of any account but those
  // excepted takes this host's slots meanwhile
  if (label === "hold-local" && sep < 0) {
    const r = holdCommand(config.heavyHoldDir, userInfo().username, rest[1], opt("until"), many("reason").join(" "), Date.now(), many("except"));
    for (const l of r.lines) heavyDeps(load).log?.(l);
    process.exitCode = r.code;
    return;
  }
  const jobName = opt("job");
  // --helpers-only: the caller wants it on a helper and never in this host's slot (zzangdori 2026-11-08); a --job goes to
  // the GPU line of all hosts, this one too, so the two do not go together
  const helpersOnly = Boolean(flags.values["helpers-only"]);
  if (helpersOnly && jobName !== undefined) die("dori heavy --helpers-only goes with --kind cpu|browser|gpu --sync PATH ..., not --job: a --job runs in the GPU line of every host, this one too");
  if (jobName !== undefined) {
    const jobLabel = label && !label.startsWith("-") ? label : die("usage: dori heavy <label> --job <name> [--in FILE ...] [--out DIR] [--rl] [-- arg ...]");
    const out = opt("out");
    process.exitCode = await heavyJobCommand({ q: config.heavyQueue, deps: heavyDeps(load) }, { req: { label: jobLabel, kind: jobName, rl: Boolean(flags.values.rl), args: cmd }, files: many("in").map((f) => resolve(f)), ...(out ? { out: resolve(out) } : {}) });
    return;
  }
  const name = label && label !== "--" && !label.startsWith("-") && cmd.length ? label : die("usage: dori heavy <label> [--mem SIZE] [--kind cpu|browser|gpu --sync PATH ... [--env NAME ...]] -- <command ...>");
  const memOpt = opt("mem");
  const needBytes = memOpt === undefined ? undefined : (parseMem(memOpt) ?? die(`dori heavy --mem takes a size like 70G or 200M, not "${memOpt}"`));
  // --items: a batch over every host (heavy-batch.ts); there --mem caps each host's items at once, --mem-per-worker is one item's
  const itemsOpt = opt("items");
  const perOpt = opt("mem-per-worker");
  const perBytes = perOpt === undefined ? undefined : (parseMem(perOpt) ?? die(`dori heavy --mem-per-worker takes a size like 15G, not "${perOpt}"`));
  if ((itemsOpt !== undefined || perBytes !== undefined) && (itemsOpt === undefined || opt("kind") === undefined || helpersOnly || heavyOuter())) die("usage: dori heavy <label> --kind cpu|browser|gpu --sync PATH ... --items FILE [--mem-per-worker SIZE [--mem SIZE]] [--out DIR] -- <command with {item}>, not with --helpers-only or inside another heavy job");
  if (itemsOpt !== undefined && needBytes && !perBytes) die("dori heavy --items --mem SIZE caps the items each host runs at once, so it needs --mem-per-worker SIZE");
  if (itemsOpt !== undefined && name.length > 56) die(`dori heavy --items: the label takes 56 characters at most (each item runs as <label>.<n>)`);
  const deps = heavyDeps(load);
  // a bash -c pipe into tail must not turn a failure into exit 0, here or on a helper (heavy-pipefail.ts withPipefail)
  const jobCmd = withPipefail(cmd);
  if (jobCmd !== cmd) deps.log?.(`HEAVY_PIPEFAIL ${name}: the bash -c script pipes, so it runs with set -o pipefail and a failing stage fails the job`);
  // a --helpers-only job never runs here: the helper that takes it checks its own memory (heavy-spread.ts heavyExec)
  const host = helpersOnly ? undefined : readMeminfo();
  const oneJob = itemsOpt !== undefined ? perBytes : needBytes;
  const never = oneJob && host ? neverFits(oneJob, host, config.heavyHeadroomPct) : undefined;
  if (never) {
    deps.log?.(`HEAVY_REFUSED ${name}: ${never}`);
    process.exitCode = 2;
    return;
  }
  // --kind: the command may run on the less busy host (heavy-spread.ts); what it cannot take along keeps it here
  const kindOpt = opt("kind");
  const kind = kindOpt === undefined ? undefined : isKind(kindOpt) ? kindOpt : die(`dori heavy --kind takes cpu, browser or gpu, not "${kindOpt}"`);
  if (helpersOnly && kind === undefined) die("dori heavy --helpers-only goes with --kind cpu|browser|gpu --sync PATH ...: only those can run on a helper");
  const local = Boolean(flags.values["local"]);
  if (local && helpersOnly) die("dori heavy --local runs the job on this host, --helpers-only never does: give one of them");
  const refuseLocal = (why: string): void => {
    deps.log?.(`HEAVY_LOCAL_REFUSED ${name}: ${why}; it did not run: give that path with --sync, or run it on this host with --local`);
    process.exitCode = 2;
  };
  const refuseHere = (why: string): void => {
    deps.log?.(`HEAVY_HELPERS_ONLY ${name}: ${why}; it does not run here`);
    process.exitCode = 2;
  };
  let spreadSlot: string | undefined;
  let abandoned = false;
  if (kind !== undefined && !heavyOuter()) {
    const badEnv = many("env").find((e) => !/^[A-Za-z_]\w{0,63}$/.test(e));
    if (badEnv !== undefined) die(`dori heavy --env takes a variable name, not "${badEnv}"`);
    const env = Object.fromEntries(["LANG", "TZ", ...many("env")].flatMap((k) => (process.env[k] === undefined ? [] : [[k, process.env[k]!]])));
    if (itemsOpt !== undefined) {
      const items = readItems(resolve(itemsOpt));
      if (!items.length) die(`dori heavy --items ${itemsOpt}: no item in it (one per line; blank and # lines are skipped)`);
      const back = flags.values.back as string[] | undefined;
      const here = toolsHere(name, many("tools"), deps.log).env;
      const r = await heavyBatch({ q: config.heavyQueue, deps }, { label: name, kind, cmd, cwd: process.cwd(), sync: many("sync").map((s) => resolve(s)), env, items, out: resolve(opt("out") ?? defaultOut(name, Date.now())), ...(perBytes ? { memPerWorker: perBytes } : {}), ...(needBytes ? { memCap: needBytes } : {}), ...(many("tools").length ? { tools: many("tools") } : {}), ...(back?.length ? { back } : {}), ...(here ? { hereEnv: here } : {}), ...(!local && config.heavyQueue.helpers.length ? { ship: { noShip: config.heavyNoShip, maxBytes: config.heavyShipMaxMb * 1024 ** 2, heavyLog: `${config.stateDir}/heavy/heavy.log` } } : {}) });
      // a stale helper run left a child or pipe not ended: exit now instead of waiting on it
      if (r.abandoned) process.exit(r.code);
      process.exitCode = r.code;
      return;
    }
    const job: SpreadJob = { ...(helpersOnly ? { helpersOnly } : {}), label: name, kind, cmd: jobCmd, cwd: process.cwd(), sync: many("sync").map((s) => resolve(s)), env, ...(needBytes ? { needBytes } : {}), ...(many("tools").length ? { tools: many("tools") } : {}), ...(flags.values.back ? { back: flags.values.back as string[] } : {}), ...(flags.values["stale-again"] ? { staleAgain: true } : {}) };
    // a folder or file outside --sync goes along, or the job stops here before it runs; --local runs it here on purpose (heavy-ship.ts)
    const who = { uid: process.getuid?.() ?? -1, home: homedir() };
    const ship = !local && config.heavyQueue.helpers.length ? shipMissing(job, who, config.heavyNoShip, config.heavyShipMaxMb * 1024 ** 2) : undefined;
    if (ship && "refuse" in ship && ship.refuse) return helpersOnly ? refuseHere(ship.why) : refuseLocal(ship.why);
    const sent = ship && "plan" in ship ? ship : undefined;
    if (sent) logShip(`${config.stateDir}/heavy/heavy.log`, name, sent, (l) => deps.log?.(l));
    const plan: Plan = sent?.plan ?? (ship && "why" in ship ? { ok: false, why: ship.why } : spreadPlan(job, who));
    if (!plan.ok && helpersOnly) return refuseHere(plan.why);
    if (!config.heavyQueue.helpers.length && helpersOnly) return refuseHere("no heavyQueue.helpers on this host");
    if (!plan.ok) deps.log?.(`HEAVY_LOCAL ${name}: ${plan.why}`);
    else if (!config.heavyQueue.helpers.length) deps.log?.(`HEAVY_LOCAL ${name}: no heavyQueue.helpers on this host`);
    else {
      // its --sync paths archived once for every helper it is offered to, and removed when it ended (heavy-assets.ts)
      const assets = stager(join(deps.dir, "assets"), name, (l) => deps.log?.(l));
      const r = await heavySpread({ q: config.heavyQueue, deps }, { ...(sent?.job ?? job), assets }, plan).finally(assets.drop);
      // a stale run left a child or a pipe not ended (HEAVY_STALE_LEFT): it would keep this process alive, so exit
      abandoned = r.abandoned === true;
      if ("code" in r) {
        if (abandoned) process.exit(r.code);
        process.exitCode = r.code;
        return;
      }
      spreadSlot = r.slot;
    }
  }
  // plain dori heavy is the GPU slot line, and --kind gpu a GPU job: both get free memory made first (heavy-mem.ts gpuRoom)
  const gpu = kind === undefined || kind === "gpu";
  process.exitCode = await runHere(deps, { label: name, cmd: jobCmd, free: config.heavyHeadroomPct, ...(needBytes ? { needBytes } : {}), ...(deps.log ? { log: deps.log } : {}), ...(gpu ? { gpuFreeKb: config.heavyGpuFreeGb * 1024 ** 2 } : {}) }, { slot: spreadSlot, ...toolsHere(name, many("tools"), deps.log) });
  if (abandoned) process.exit();
  return;
};

const gpuRoomCommand: Command = async (context) => {
  const { opt, config, key } = context;
  const { heavyDeps } = makeHeavyDeps(context);
  // what dori heavy does before a GPU job, on its own: a script whose CUDA start failed calls it before its one retry
  const wantOpt = opt("want");
  const want = wantOpt === undefined ? config.heavyGpuFreeGb * 1024 ** 3 : (parseMem(wantOpt) ?? die(`dori gpu-room --want takes a size like 20G, not "${wantOpt}"`));
  await gpuRoom(key && !key.startsWith("-") ? key : "gpu-room", want / 1024, config.heavyHeadroomPct, heavyDeps(async () => 0).log);
  return;
};

const heavyServeCommand: Command = async (context) => {
  const { rest, config, flags } = context;
  const { heavyDeps } = makeHeavyDeps(context);
  const sep = rest.indexOf("--");
  const load = async () => (await sampleHost(run, config)).load1;
  const [label = "", kind = ""] = flags.positionals;
  process.exitCode = await heavyServe({ q: config.heavyQueue, deps: heavyDeps(load) }, { label, kind, rl: Boolean(flags.values.rl), args: sep >= 0 ? rest.slice(sep + 1) : [] });
  return;
};

const heavyWorkerCommand: Command = async (context) => {
  const { config, rest, opt } = context;
  const { heavyDeps } = makeHeavyDeps(context);
  const load = async () => (await sampleHost(run, config)).load1;
  const at = rest.indexOf("--caller");
  const words = at >= 0 ? [...rest.slice(0, at), ...rest.slice(at + 2)] : rest;
  process.exitCode = await heavyWorker({ q: config.heavyQueue, deps: heavyDeps(load) }, process.env["SSH_ORIGINAL_COMMAND"] ?? words.join(" "), opt("caller"));
  return;
};

export const heavyCommands: Readonly<Record<string, Command>> = {
  "heavy": heavyCommand,
  "gpu-room": gpuRoomCommand,
  "heavy-serve": heavyServeCommand,
  "heavy-worker": heavyWorkerCommand,
};
