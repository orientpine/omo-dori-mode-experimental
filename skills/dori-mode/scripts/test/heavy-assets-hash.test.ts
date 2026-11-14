import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { assetHash, assetsWord, checkAssets } from "../src/heavy-assets.ts";
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

test("a newline cannot move between a link's target and the next name without changing the hash (review 5 of #477)", async () => {
  const [a, b] = [join(state.dir, "one", "t"), join(state.dir, "two", "t")];
  for (const d of [a, b]) mkdirSync(d, { recursive: true });
  symlinkSync("b\nc", join(a, "a"));
  writeFileSync(join(a, "x"), "same");
  symlinkSync("b", join(b, "a"));
  writeFileSync(join(b, "c\nx"), "same");
  expect(await assetHash(a)).not.toBe(await assetHash(b));
});

// a file whose metadata reads but whose bytes never come (a hung mount): hashing gives up after stallMs without progress
// and cancels its read, on the caller (the path goes without a hash) and on the helper (ASSET_BAD, the job runs on it)
const stalled = (): { read: () => ReadableStream<Uint8Array>; cancelled: () => boolean } => {
  let cancelled = false;
  const cancel = (): void => {
    cancelled = true;
  };
  return { read: () => new ReadableStream<Uint8Array>({ cancel }), cancelled: () => cancelled };
};

test("a caller whose --sync file stalls while it is hashed sends that path without a hash and says so (review 5 of #477)", async () => {
  const d = join(state.dir, "w");
  mkdirSync(d);
  writeFileSync(join(d, "data.bin"), "x");
  const s = stalled();
  const said: string[] = [];
  expect(await assetsWord([d], (l) => said.push(l), { stallMs: 50, read: s.read })).toBe("assets=-");
  expect(said).toEqual([`${d} could not be hashed (no progress for 0 s, unreadable, or a name not in UTF-8), so it goes without one`]);
  expect(s.cancelled()).toBe(true);
});

test("a helper whose arrived file stalls while it is checked says ASSET_BAD and goes on (review 5 of #477)", async () => {
  const root = join(state.dir, "in");
  mkdirSync(join(root, "w"), { recursive: true });
  writeFileSync(join(root, "w", "data.bin"), "x");
  const s = stalled();
  const said: string[] = [];
  await checkAssets(root, ["/w"], [`assets=${"0".repeat(32)}`], (l) => said.push(l), { stallMs: 50, read: s.read });
  expect(said).toEqual(["ASSET_BAD /w: could not be hashed here (no progress for 0 s, unreadable, or a name not in UTF-8); the job runs on what arrived"]);
  expect(s.cancelled()).toBe(true);
});

test("hashing many chunks holds only the chunk in hand, not every chunk read so far (review 6 of #477)", async () => {
  const d = join(state.dir, "m");
  mkdirSync(d);
  writeFileSync(join(d, "big.bin"), "x");
  const n = 400;
  let i = 0;
  let early = 0;
  let late = 0;
  const rss = (): number => {
    Bun.gc(true);
    return process.memoryUsage().rss;
  };
  // a fresh 1 MiB chunk each time: memory taken at chunk 20 and at the last one
  const read = (): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      pull: (c) => {
        i++;
        if (i === 20) early = rss();
        if (i === n) late = rss();
        if (i > n) c.close();
        else c.enqueue(new Uint8Array(1 << 20).fill(i & 255));
      },
    });
  expect(await assetHash(d, { read })).toMatch(/^[0-9a-f]{32}$/);
  expect(late - early).toBeLessThan(128 << 20);
});

test("a tree whose link target is not UTF-8 is not hashed, so two such trees never pass for one (review 6 of #477)", async () => {
  const [a, b] = [join(state.dir, "ua", "t"), join(state.dir, "ub", "t")];
  for (const [d, byte] of [[a, 0xfe], [b, 0xff]] as const) {
    mkdirSync(d, { recursive: true });
    symlinkSync(Buffer.from([0x61, byte]), Buffer.from(join(d, "l")));
  }
  expect(await assetHash(a)).toBeUndefined();
  expect(await assetHash(b)).toBeUndefined();
});
