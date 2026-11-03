import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";

import { CheckpointError, Checkpoints, LOCK_STALE_MS, type CheckpointInput } from "../src/checkpoints.ts";
import { withState } from "./fakes.ts";

// The two fork changes to the upstream journal (src/checkpoints.ts "Fork change"), from the review of orientpine#297.
const input: CheckpointInput = { step: "deploy", result: "ok", evidence: ["log"], remoteEffects: [] };

describe("checkpoints (fork changes)", () => {
  test("a stale takeover never removes the lock another writer took over in the meantime, even when a third writer races it", () => {
    const state = withState();
    const original = { read: fs.readFileSync, rename: fs.renameSync };
    try {
      const journal = new Checkpoints(state.dir);
      const lock = `${journal.path("demo-lane")}.lock`;
      mkdirSync(dirname(lock), { recursive: true });
      const now = Date.now();
      // a writer that died long ago left its lock
      writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 1, host: hostname(), at: new Date(now - 2 * LOCK_STALE_MS).toISOString(), nonce: "dead" }));
      let other: (() => void) | undefined;
      let theirs = "";
      // Right after this writer read the dead lock, a second writer takes it over and holds it.
      const read = spyOn(fs, "readFileSync").mockImplementation(((path: string, options: BufferEncoding) => {
        const raw = original.read(path, options);
        if (String(path) === lock && !other) {
          read.mockRestore();
          other = new Checkpoints(state.dir).lock("demo-lane", now);
          theirs = original.read(lock, "utf8");
        }
        return raw;
      }) as typeof fs.readFileSync);
      // Once the second writer holds it, a third writer locks the path the moment it stands empty.
      const rename = spyOn(fs, "renameSync").mockImplementation(((from: string, to: string) => {
        original.rename(from, to);
        if (other && String(from) === lock && String(to).endsWith(".stale")) writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname(), at: new Date(now).toISOString(), nonce: "third" }));
      }) as typeof fs.renameSync);
      try {
        expect(() => journal.write("demo-lane", input, now)).toThrow(CheckpointError);
      } finally {
        read.mockRestore();
        rename.mockRestore();
      }
      expect(other).toBeDefined();
      expect(readFileSync(lock, "utf8")).toBe(theirs);
      expect(journal.read("demo-lane")).toEqual([]);
      other!();
    } finally { state.done(); }
  });

  test("an identical replay of a record a killed writer appended before its fsync is flushed before it is acknowledged", () => {
    const state = withState();
    try {
      const journal = new Checkpoints(state.dir);
      const path = journal.path("demo-lane");
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify({ key: "demo-lane", at: new Date(1000).toISOString(), ...input })}\n`);
      // the descriptors opened on the journal itself (the lock file is fsynced too, and does not count)
      const journalFds = new Set<number>();
      const openOriginal = fs.openSync;
      const opened = spyOn(fs, "openSync").mockImplementation(((file: string, ...rest: unknown[]) => {
        const fd = (openOriginal as (...a: unknown[]) => number)(file, ...rest);
        if (String(file) === path) journalFds.add(fd);
        return fd;
      }) as typeof fs.openSync);
      const synced = spyOn(fs, "fsyncSync");
      try {
        expect(journal.write("demo-lane", input, 2000).unchanged).toBe(true);
        expect(synced.mock.calls.some(([fd]) => journalFds.has(fd as number))).toBe(true);
      } finally {
        opened.mockRestore();
        synced.mockRestore();
      }
    } finally { state.done(); }
  });
});
