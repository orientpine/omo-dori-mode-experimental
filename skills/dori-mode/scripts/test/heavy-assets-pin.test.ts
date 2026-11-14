import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { assetHash, assetsHave, settleAssets } from "../src/heavy-assets.ts";
import { withState } from "./fakes.ts";

// Review 2 of #477: a held tree is copied into the job's own folder when the helper offers it (WORKER_ADMIT have=), so
// nothing the store does later (pruning, another job) can take it from that job, and an entry that cannot be copied is
// dropped and not offered, so the caller sends it again; a tree's hash also covers its modes, and hashing yields to the
// event loop.
let state: ReturnType<typeof withState>;
let lines: string[];
const say = (l: string): void => {
  lines.push(l);
};
const heavy = (): string => join(state.dir, "heavy");
const store = (): string => join(heavy(), "assets", "tester");
// a job's folder: the upload unpacks under in/, offered trees wait in pin/
const job = (n: number): { root: string; pin: string } => ({ root: join(state.dir, `job${n}`, "in"), pin: join(state.dir, `job${n}`, "pin") });

beforeEach(() => {
  state = withState();
  lines = [];
});
afterEach(() => state.done());

// one job that sent /w and kept it, and the hash it is kept as
const keep = async (): Promise<string> => {
  const { root } = job(0);
  mkdirSync(join(root, "w"), { recursive: true });
  writeFileSync(join(root, "w", "run.py"), "print(1)\n");
  const h = (await assetHash(join(root, "w")))!;
  expect(await settleAssets(root, ["/w"], [`assets=${h}`], heavy(), "tester", [], say)).toBe(true);
  return h;
};

test("a tree offered to a job is that job's even when the store loses it before the job settles", async () => {
  const h = await keep();
  const { root, pin } = job(1);
  expect(await assetsHave(heavy(), "tester", [`assets=${h}`], pin)).toEqual([h]);
  // pruning or another worker takes the entry while this job's upload is still coming
  rmSync(join(store(), h), { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  expect(await settleAssets(root, ["/w"], [`assets=${h}`], heavy(), "tester", [h], say)).toBe(true);
  expect(lines.at(-1)).toBe(`ASSET_OK ${h} /w cached`);
  expect(readFileSync(join(root, "w", "run.py"), "utf8")).toBe("print(1)\n");
});

test("an entry whose copy cannot be made is dropped and not offered, so the next job sends the tree and keeps it again", async () => {
  const h = await keep();
  rmSync(join(store(), h, "tree"), { recursive: true });
  expect(await assetsHave(heavy(), "tester", [`assets=${h}`], job(1).pin)).toEqual([]);
  expect(existsSync(join(store(), h))).toBe(false);
  expect(await keep()).toBe(h);
  expect(await assetsHave(heavy(), "tester", [`assets=${h}`], job(2).pin)).toEqual([h]);
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
  chmodSync(join(d, "sub"), 0o700);
  expect(await assetHash(d)).not.toBe(base);
  chmodSync(join(d, "sub"), 0o755);
  // the same name, size and mtime with other bytes
  writeFileSync(join(d, "sub", "in.csv"), "1,3\n");
  utimesSync(join(d, "sub", "in.csv"), 1e9, 1e9);
  expect(await assetHash(d)).not.toBe(base);
});

test("hashing a large tree lets the event loop run (a helper's heartbeat, the batch's other transfers)", async () => {
  const d = join(state.dir, "big");
  mkdirSync(d);
  writeFileSync(join(d, "a.bin"), Buffer.alloc(48 << 20, 7));
  let ticks = 0;
  const t = setInterval(() => ticks++, 1);
  try {
    expect(await assetHash(d)).toMatch(/^[0-9a-f]{32}$/);
  } finally {
    clearInterval(t);
  }
  expect(ticks).toBeGreaterThan(0);
});
