import { closeSync, openSync, writeSync } from "node:fs";

// Where one item's lines go in dori heavy --items (heavy-batch.ts): its own files, and the helper's own lines watched apart
// from the command's, so only the runner can say the item was killed for memory.
export type Sink = { write(s: string | Uint8Array): unknown; close(): void };

export const fileSink = (path: string): Sink => {
  const fd = openSync(path, "w");
  let open = true;
  return {
    write: (s) => {
      if (!open) return 0;
      return typeof s === "string" ? writeSync(fd, s) : writeSync(fd, s);
    },
    close: () => {
      if (open) closeSync(fd);
      open = false;
    },
  };
};

export const pump = async (s: ReadableStream<Uint8Array> | undefined, sink: Sink): Promise<void> => {
  if (s) for await (const c of s) sink.write(c);
};

// the lines of sink, each also shown to seen (a helper's own lines, heavy-spread.ts startExec's runner)
export const watched = (sink: Sink, seen: (line: string) => void): { write(s: string): unknown } => ({
  write: (s) => {
    seen(s);
    return sink.write(s);
  },
});
