import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Lane, Recorded } from "./registry.ts";

type Loader = (raw: Recorded) => Lane;

const files = (dir: string): string[] => {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => join(dir, f));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
};

export const listLanes = async (dir: string, load: Loader): Promise<Lane[]> => {
  mkdirSync(dir, { recursive: true });
  const lanes: Lane[] = [];
  for (const f of files(dir)) lanes.push(load((await Bun.file(f).json()) as Recorded));
  return lanes;
};

export const scanLanes = async (dir: string, load: Loader): Promise<{ lanes: Lane[]; unreadable: string[] }> => {
  const lanes: Lane[] = [];
  const unreadable: string[] = [];
  for (const f of files(dir)) {
    try {
      const lane: unknown = await Bun.file(f).json();
      if (typeof lane !== "object" || lane === null || !("key" in lane) || typeof lane.key !== "string") throw new Error("not a lane record");
      lanes.push(load(lane as Recorded));
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      unreadable.push(f);
    }
  }
  return { lanes, unreadable };
};
