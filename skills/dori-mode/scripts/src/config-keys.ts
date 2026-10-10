import { defaultConfig } from "./config.ts";

// Arrays describe entries with the same dotted field names, without numeric indexes.
export const configKeys = (value: unknown, prefix = ""): string[] => {
  if (Array.isArray(value)) return [...new Set(value.flatMap((item: unknown) => configKeys(item, prefix)))].sort();
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]: [string, unknown]) => {
    const name = prefix ? `${prefix}.${key}` : key;
    return [name, ...configKeys(child, name)];
  }).sort();
};

export const knownConfigKeys = (): string[] => configKeys({
  ...defaultConfig(),
  hooks: { threadReply: [], threadDone: [], transcribe: [] },
  update: { ...defaultConfig().update, services: [{ unit: "", paths: [], log: "", ready: "" }] },
});
