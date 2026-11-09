// One owner for the children a helper run starts on the caller's side and the pipes it reads (heavy-spread.ts,
// heavy-stale.ts): os/exec's WaitDelay for Bun (golang/go#50436, #23019). A child's exit does not end the reads of its
// pipes while a descendant holds them (an ssh ProxyCommand, a wrapper's background job: Playwright #41210, bpo-31935),
// and a timeout on the direct child ends with it, so no read of a child's pipe is waited on past its owner's deadline.
// #410 reviews 3 to 6 each found one more such wait, patched one at a time; every one goes through settle now.

// SIGKILL to a child of this process only while it has not ended (an upload tar done hours before may have a reused
// pid by then); until Bun reaps a child its pid stays a zombie no one else gets, so one not seen ended is still ours
export const killAlive = (p: { readonly exitCode: number | null; readonly signalCode: string | null; readonly kill: (signal?: NodeJS.Signals) => void }): void => {
  if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
};

// the lines of a child's pipe, read through a reader its owner can cancel: a pending read ends with the cancel
type Reader = { read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array | undefined }>; cancel(): Promise<void> };
export async function* readerLines(reader: Reader): AsyncGenerator<string> {
  const dec = new TextDecoder();
  let buf = "";
  for (let n = await reader.read(); !n.done; n = await reader.read()) {
    if (n.value) buf += dec.decode(n.value, { stream: true });
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      yield buf.slice(0, i);
      buf = buf.slice(i + 1);
    }
  }
  if (buf) yield buf;
}

// done (the children's exits and the reads of their pipes) or the deadline (ms, or a promise), whichever comes first.
// Then every reader is cancelled (what is not read by then is not wanted, and a descendant may still hold the pipe), and
// when the deadline came first the children not ended are killed and let go (unref), so nothing of them keeps this
// process alive. true when done came first. A deadline in ms is a timer cleared once settled, that never keeps this
// process alive itself
export const settle = async (kids: readonly Bun.Subprocess[], readers: readonly Reader[], done: Promise<unknown>, deadline: number | Promise<unknown>): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = typeof deadline === "number" ? new Promise<void>((r) => (timer = setTimeout(r, deadline))) : deadline;
  timer?.unref();
  const ended = await Promise.race([done.then(() => true, () => true), late.then(() => false)]);
  clearTimeout(timer);
  for (const r of readers) void r.cancel().catch(() => undefined);
  if (!ended) {
    for (const x of kids) {
      killAlive(x);
      x.unref();
    }
  }
  return ended;
};

// A helper's first answer on its ssh's stderr (the line answer matches), echoing the lines before it: within deadline
// ms, or not answered (then its ssh is killed and let go). The lines after an answer stay for the caller to read.
export const firstAnswer = async (p: Bun.Subprocess<"pipe", "pipe", "pipe">, lines: AsyncGenerator<string>, answer: RegExp, deadline: number): Promise<{ readonly said?: RegExpExecArray; readonly last: string; readonly answered: boolean }> => {
  let said: RegExpExecArray | undefined;
  let last = "";
  const answered = await settle([p], [], (async () => {
    for (let n = await lines.next(); !n.done; n = await lines.next()) {
      said = answer.exec(n.value) ?? undefined;
      if (said) return;
      last = n.value;
      process.stderr.write(`${n.value}\n`);
    }
  })(), deadline);
  return { ...(said ? { said } : {}), last, answered };
};

// the end of a child turned away: its stdin closed, its exit waited on grace ms at most, then it and its reader let go
export const letGo = async (p: Bun.Subprocess<"pipe", "pipe", "pipe">, reader: Reader, grace: number): Promise<void> => {
  await p.stdin.end();
  await settle([p], [reader], p.exited, grace);
};

// after settle gave up on a stale run's children: HEAVY_STALE_LEFT names those not ended (stuck where
// SIGKILL does not reach, as a read in uninterruptible disk I/O) or the pipes still held; true when something was left
export const staleLeft = (kids: readonly Bun.Subprocess[], ended: boolean, log: (line: string) => void, who: string, graceMs: number): boolean => {
  const left = kids.filter((x) => x.exitCode === null && x.signalCode === null);
  if (!ended) log(`HEAVY_STALE_LEFT ${who}: ${graceMs / 1000} s after the stale verdict ${left.length ? `pid ${left.map((x) => x.pid).join(",")} not ended` : "its pipes are still held"}; dori heavy ends without waiting on them`);
  return !ended;
};
