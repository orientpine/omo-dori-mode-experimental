import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { assetHash } from "../src/heavy-assets.ts";
import { withState } from "./fakes.ts";

// What a --sync tree's hash covers (review 1 and 2 of #477, and the challenge of the review-3 plan): the root's name,
// every path's type and mode, a file's bytes; and hashing yields to the event loop.
let state: ReturnType<typeof withState>;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

test("trees of one name, size and mtime but other bytes, or single files of other names, hash apart", async () => {
  // both trees are named t, so only their bytes can tell them apart (review 2 of #477)
  const [a, b] = [join(state.dir, "one", "t"), join(state.dir, "two", "t")];
  for (const [d, text] of [[a, "one"], [b, "two"]] as const) {
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "f.py"), text);
    utimesSync(join(d, "f.py"), 1e9, 1e9);
  }
  expect(await assetHash(a)).not.toBe(await assetHash(b));
  writeFileSync(join(state.dir, "x.txt"), "same");
  writeFileSync(join(state.dir, "y.txt"), "same");
  expect(await assetHash(join(state.dir, "x.txt"))).not.toBe(await assetHash(join(state.dir, "y.txt")));
});

test("a tree's hash covers its files' and folders' modes and its bytes under one name", async () => {
  const d = join(state.dir, "t");
  mkdirSync(join(d, "sub"), { recursive: true });
  writeFileSync(join(d, "sub", "in.csv"), "1,2\n");
  utimesSync(join(d, "sub", "in.csv"), 1e9, 1e9);
  const base = await assetHash(d);
  chmodSync(join(d, "sub", "in.csv"), 0o444);
  const readOnly = await assetHash(d);
  expect(readOnly).not.toBe(base);
  chmodSync(join(d, "sub", "in.csv"), 0o644);
  chmodSync(join(d, "sub"), 0o555);
  expect(await assetHash(d)).not.toBe(base);
  chmodSync(join(d, "sub"), 0o755);
  // the same name, size and mtime with other bytes
  writeFileSync(join(d, "sub", "in.csv"), "1,3\n");
  utimesSync(join(d, "sub", "in.csv"), 1e9, 1e9);
  expect(await assetHash(d)).not.toBe(base);
});

test("hashing a tree lets the event loop run before it ends (a helper's heartbeat, the batch's other transfers)", async () => {
  const d = join(state.dir, "big");
  mkdirSync(d);
  writeFileSync(join(d, "a.bin"), Buffer.alloc(8 << 20, 7));
  // a macrotask queued before the hash starts runs before the hash is done only when hashing waits on the event loop
  const order: string[] = [];
  setImmediate(() => order.push("loop"));
  expect(await assetHash(d)).toMatch(/^[0-9a-f]{32}$/);
  order.push("hashed");
  expect(order).toEqual(["loop", "hashed"]);
});
