import { closeSync, existsSync, openSync, readSync } from "node:fs";

import type { ArgvTemplate } from "./config.ts";

// a host the queue host hands jobs to: ssh argv to its `dori heavy-worker`; prefer: the --kind kinds it takes first
export type HeavyHelper = { readonly name: string; readonly ssh: ArgvTemplate; readonly prefer?: readonly string[] };

// Which helper a dori heavy --kind job may go to, beyond "the less busy PC" (heavy-spread.ts).
// Owner 2026-11-08: "우리 학습용 spark 있는데 자율 굴착 시험왜 여기서 돌리고 있어?" and "doriterm에 연결된 모든 기기들 확인해서,
// 리소스 분배해서 사용하도록 해줘": training, simulation and GPU tests go to the training sparks first, and every machine
// that can take a job is a helper, x86_64 ones included.

// the helpers a job of this kind is offered first, before this host however idle it is (heavyQueue.helpers prefer)
export const preferredFor = (helpers: readonly HeavyHelper[], kind: string): readonly HeavyHelper[] => helpers.filter((h) => h.prefer?.includes(kind));

// uname -m of this host, as a helper compares it with a job's arch=
const NODE_MACHINES: Readonly<Record<string, string>> = { arm64: "aarch64", x64: "x86_64" };
export const hostMachine = (): string => NODE_MACHINES[process.arch] ?? process.arch;
const ELF_MACHINES: Readonly<Record<number, string>> = { 62: "x86_64", 183: "aarch64" };

// a job whose --sync paths hold programs of more than one machine: no helper takes it, it stays on the host that sent it
const MIXED = "mixed";

// the machine of a file's ELF header, or undefined for a file that is not ELF or cannot be read (gone, no permission)
const elfMachine = (f: string, head: Buffer): string | undefined => {
  let n = 0;
  try {
    const fd = openSync(f, "r");
    try {
      n = readSync(fd, head, 0, 20, 0);
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
  if (n < 20 || head.readUInt32BE(0) !== 0x7f454c46) return undefined;
  const m = head[5] === 2 ? head.readUInt16BE(18) : head.readUInt16LE(18);
  return ELF_MACHINES[m] ?? `elf-${m}`;
};

// The machine of the ELF programs and libraries in the --sync paths, "mixed" when they are of more than one, or undefined
// when they hold none. A venv's compiled modules and node_modules' native addons run only on a helper of that machine:
// cha-system-product-name (x86_64) became a helper beside the aarch64 sparks on 2026-11-08, and a venv from 0a83 would
// fail there at its first import.
export const syncedMachine = (sync: readonly string[]): string | undefined => {
  const head = Buffer.alloc(20);
  const machines = new Set<string>();
  for (const s of sync) {
    if (!existsSync(s)) continue;
    const found = Bun.spawnSync(["find", s, "-type", "f", "(", "-perm", "-u+x", "-o", "-name", "*.so", "-o", "-name", "*.so.*", "-o", "-name", "*.node", ")", "-print0"], { stdout: "pipe", stderr: "ignore" });
    for (const f of found.stdout.toString().split("\0")) {
      const m = f ? elfMachine(f, head) : undefined;
      if (m) machines.add(m);
      if (machines.size > 1) return MIXED;
    }
  }
  return [...machines][0];
};

// the plan's arch: the machine a helper must be for the --sync paths' programs, when they hold any
export const archOf = (sync: readonly string[]): { readonly arch?: string } => {
  const arch = syncedMachine(sync);
  return arch ? { arch } : {};
};

const KINDS = ["cpu", "browser", "gpu"];
const isArgv = (v: unknown): boolean => Array.isArray(v) && v.length > 0 && v.every((p) => typeof p === "string");
// what is wrong with one heavyQueue.helpers entry, or undefined
export const helperProblem = (h: HeavyHelper): string | undefined => {
  if (typeof h.name !== "string" || !/^[\w.-]{1,64}$/.test(h.name) || !isArgv(h.ssh)) return "heavyQueue.helpers: each needs a name (letters, digits, . _ -) and an ssh argv";
  if (h.prefer !== undefined && (!Array.isArray(h.prefer) || !h.prefer.every((k) => KINDS.includes(k)))) return `heavyQueue.helpers.${h.name}.prefer must list kinds of ${KINDS.join(", ")}`;
  return undefined;
};

// the helper's refusal of a job whose arch= is not this host's machine, or undefined
export const archRefusal = (opts: readonly string[]): string | undefined => {
  const arch = opts.find((o) => o.startsWith("arch="))?.slice(5);
  if (arch === MIXED) return "the job's --sync paths hold programs or libraries of more than one machine, so it stays on the host that sent it";
  return arch && arch !== hostMachine() ? `this host is ${hostMachine()} and the job's --sync paths hold ${arch} programs or libraries, which do not run here` : undefined;
};
