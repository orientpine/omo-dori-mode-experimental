// From upstream dori-superagent src/runtime/group.ts (https://github.com/sisyphuslabs/dori-superagent/blob/7ac0ed761dfb6aa0b3a81e8740a29cde5cbd0444/src/runtime/group.ts; #147 #148 #150 #155, licences in NOTICE).
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

const realOrResolved = (path: string): string => {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
};

/** The session group of one store root: 8 hex chars of sha256 over the resolved path, so two homes never share one. */
export function groupId(storeRoot: string): string {
  return createHash("sha256").update(realOrResolved(storeRoot)).digest("hex").slice(0, 8);
}
