import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ThreadMap = Record<string, { readonly session: string | null; readonly title: string }>;

export const threads = (dir: string): ThreadMap => {
  const file = join(dir, "threads.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
};

const save = (dir: string, all: ThreadMap): void => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "threads.json");
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(all, null, 1), { mode: 0o600 });
  renameSync(tmp, file);
};

export const mapThread = (dir: string, id: string, session: string | null, title?: string): void => {
  const all = threads(dir);
  all[id] = { session, title: title ?? all[id]?.title ?? "" };
  save(dir, all);
};

export const dropThread = (dir: string, id: string): void => {
  const all = threads(dir);
  if (!all[id]) return;
  delete all[id];
  save(dir, all);
};
