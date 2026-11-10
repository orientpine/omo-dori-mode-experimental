import type { HeavyHelper } from "./heavy-route.ts";
import { readerLines, settle } from "./heavy-settle.ts";
// the helper's side of a run (heavy-stop.ts), for heavy-spread.ts beside the caller's
export { endedWith, heartbeat, markRun, sayCancelled, watchCaller } from "./heavy-stop.ts";

// Is a helper's run still alive (heavy-spread.ts)? On 2026-11-08 zzangdori's rvq-c3-final2 went to cha with a 2.1 GB --sync
// and sat 73 minutes with no line on either side until its lane cut it by hand: the upload went at 0.2-0.6 MB/s over the
// internet, the caller logged HEAVY_SPREAD only once the upload was over, the helper logged nothing between its admission
// and the job's start, and the caller waited on ssh with no check of its own. Now the caller logs HEAVY_SYNC while it
// uploads (lead 2026-11-08: "HEAVY_SYNC <label> <보낸 MB>/<전체 MB>"), a helper sends WORKER_ALIVE heartbeats (announced
// as alive=<sec> on its WORKER_ADMIT line), and a run with no bytes taken during the upload, or no line from a helper that
// beats after it, for heavyQueue.staleMin minutes is stale: HEAVY_HELPER_STALE, the ssh is killed, the helper is asked to
// stop what is left of it, and the job ends with STALE_EXIT, or with --stale-again goes back to the line. A long job that
// keeps beating is never cut; one on a helper that does not beat yet is watched during its upload only.

export const STALE_EXIT = 124;
// how long a stale run's ssh, tar and untar get to end after their process groups were killed
export const STALE_GRACE_MS = 5_000;

// stale: the run ended for no sign of life; abandoned: what it started had not all ended STALE_GRACE_MS after that
export type Stale = { readonly stale: string; readonly abandoned: boolean };

// a run dori heavy-stop ended on its helper ends its caller so too, instead of going back to the line (SIGTERM's code)
const CANCEL_EXIT = 143;

// how a helper run ended: its exit code, null when it broke off (back to the line), stale, or cancelled there
export type RunEnd = number | null | Stale | { readonly cancelled: string };

// The caller's side of a run that ended stale or cancelled: the job's exit code, or again (the stale why) when
// --stale-again sends it back to the line, and left when the stop of a stale run on its helper was let go (stopOnHelper)
export const unfinished = async (h: HeavyHelper, label: string, end: Stale | { readonly cancelled: string }, again: boolean, log: (l: string) => void, run?: string, waitMs?: number): Promise<({ readonly code: number } | { readonly again: string }) & { readonly left: boolean }> => {
  if ("cancelled" in end) {
    log(`HEAVY_HELPER_CANCELLED ${label} ${h.name}: ${end.cancelled}; the job ends with exit ${CANCEL_EXIT}`);
    return { code: CANCEL_EXIT, left: false };
  }
  log(`HEAVY_HELPER_STALE ${label} ${h.name}: ${end.stale}; ${again ? "the job goes back to the line" : `the job ends with exit ${STALE_EXIT} (dori heavy --stale-again sends it again)`}`);
  const { left } = h.ssh.length ? await stopOnHelper(h, label, log, run, waitMs === undefined ? {} : { waitMs }) : { left: false };
  return again ? { again: end.stale, left } : { code: STALE_EXIT, left };
};
const SYNC_LOG_MS = 5 * 60_000;

// alive=<sec> on a WORKER_ADMIT line: the helper's heartbeat, or undefined for a helper that does not beat
export const aliveOf = (admitted: string): number | undefined => {
  const s = Number(/(?:^|\s)alive=(\d+(?:\.\d+)?)(?:\s|$)/.exec(admitted)?.[1]);
  return s > 0 ? s : undefined;
};

// run=<id> on a WORKER_ADMIT line: that run's job folder on the helper, which `stop <label> <id>` ends alone (a label is not
// unique: two lanes of one caller may run the same label at once)
export const runOf = (admitted: string): string | undefined => /(?:^|\s)run=(\d{1,10}-[\w-]{1,32})(?:\s|$)/.exec(admitted)?.[1];

const mb = (b: number): string => (b / 1e6).toFixed(0);
// a total du could not tell in time (heavy-send.ts syncBytes 0) shows as ?

type Watch = { readonly sent: (bytes: number) => void; readonly heard: () => void; readonly synced: () => void; readonly stop: () => void; readonly stale: Promise<string> };

// The caller's watch on one helper run: sent() for bytes the helper took, heard() for a line from it, synced() once the
// upload is over. stale resolves with why the run is stale; stop() ends the watch.
export const staleWatch = (o: { readonly label: string; readonly helper: string; readonly total: (stopped: Promise<unknown>) => Promise<number>; readonly staleMs: number; readonly aliveSec?: number; readonly now: () => number; readonly log: (l: string) => void }): Watch => {
  const start = o.now();
  // the upload's size comes when du answers (heavy-send.ts syncBytes), the first HEAVY_SYNC line with it or the first byte
  let total = 0;
  let stopped: () => void = () => {};
  void o.total(new Promise<void>((r) => (stopped = r))).then((n) => {
    total = n;
    if (!first && !opened && syncing && shown()) open();
  });
  let last = start;
  let logged = start;
  let sent = 0;
  let syncing = true;
  let fire: (why: string) => void = () => {};
  const stale = new Promise<string>((r) => (fire = r));
  const of = (): string => (total ? mb(total) : "?");
  const line = () => {
    const sec = Math.max(1, (o.now() - start) / 1000);
    const rate = sent / sec;
    const left = rate > 0 && total > sent ? `, about ${Math.ceil((total - sent) / rate / 60)} min left` : "";
    o.log(`HEAVY_SYNC ${o.label} ${mb(sent)}/${of()} MB to ${o.helper}, ${(rate / 1e6).toFixed(2)} MB/s${left}`);
  };
  // a job of less than 1 MB goes in a moment: no HEAVY_SYNC lines for it; one of unknown size shows once 1 MB went
  const shown = (): boolean => total >= 1e6 || sent >= 1e6;
  let first = true;
  let opened = false;
  const open = (): void => {
    opened = true;
    line();
  };
  // a heartbeat that comes less often than staleMin would make a live run look stale: three missed beats at the least
  const quietMs = Math.max(o.staleMs, 3 * (o.aliveSec ?? 0) * 1000);
  const tick = setInterval(() => {
    const now = o.now();
    if (syncing && shown() && now - logged >= SYNC_LOG_MS) {
      logged = now;
      line();
    }
    const min = ((now - last) / 60_000).toFixed(1);
    if (syncing && now - last >= o.staleMs) fire(`it took no bytes for ${min} min (${mb(sent)}/${of()} MB sent)`);
    else if (!syncing && o.aliveSec !== undefined && now - last >= quietMs) fire(`no word from it for ${min} min after the upload (it beats every ${o.aliveSec} s)`);
  }, Math.max(50, Math.min(30_000, o.staleMs / 4)));
  return {
    sent: (n) => {
      first = false;
      sent += n;
      if (!opened && shown()) open();
      if (syncing) last = o.now();
    },
    heard: () => {
      if (!syncing) last = o.now();
    },
    synced: () => {
      if (!syncing) return;
      syncing = false;
      last = o.now();
      if (shown()) line();
    },
    stop: () => {
      clearInterval(tick);
      stopped();
    },
    stale,
  };
};

// The run broke off without a word. A frozen worker that dori heavy-stop killed could not say WORKER_CANCELLED, so ask the
// helper whether this run was stopped there before calling it a dropped connection: cancelled, or null to go back to the line.
export const brokeOff = async (h: HeavyHelper, label: string, admitted: string): Promise<{ readonly cancelled: string } | null> =>
  (await cancelledOnHelper(h, label, runOf(admitted))) ? { cancelled: "stopped there by dori heavy-stop" } : null;

// After a stale run, or from dori heavy-stop: ask the helper to stop what is left of it (`dori heavy-worker "stop <label>
// [run]"`): the one stale run, or with byLabel every run of that label (dori heavy-stop). waitMs at most for its answer, its
// stderr read included (a subprocess timeout ends with its direct child): stopped, the runs it stopped (0 when it said
// nothing), and left, true when the stop was let go unended so the caller exits without it
export const stopOnHelper = async (h: HeavyHelper, label: string, log: (l: string) => void, run: string | undefined, o: { readonly byLabel?: boolean; readonly waitMs?: number } = {}): Promise<{ readonly stopped: number; readonly left: boolean }> => {
  const waitMs = o.waitMs ?? 30_000;
  // a helper that named no run id is older than run ids; a stop by label alone could end another run of that label there
  if (!run && !o.byLabel) {
    log(`HEAVY_HELPER_STOP ${label} ${h.name}: not asked, it named no run id (its dori is older), and a stop by label could end another run of ${label} there`);
    return { stopped: 0, left: false };
  }
  const p = Bun.spawn([...h.ssh, "stop", label, ...(run ? [run] : [])], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const reader = p.stderr.getReader();
  let said: string | undefined;
  const answer = (async () => {
    for await (const l of readerLines(reader)) {
      if (!/^WORKER_(STOPPED|REFUSED)\b/.test(l)) continue;
      said = l;
      return;
    }
  })();
  // its answer and its ssh's exit, waitMs at most together: a child of that ssh may hold stderr after the answer
  const ended = await settle([p], [reader], Promise.all([answer, p.exited]), waitMs);
  log(`HEAVY_HELPER_STOP ${label} ${h.name}: ${said ?? (ended ? `no answer (ssh exited ${p.exitCode ?? p.signalCode})` : `no answer within ${waitMs / 1000} s`)}${ended ? "" : "; dori heavy ends without waiting on the stop"}`);
  return { stopped: Number(/^WORKER_STOPPED (\d+)$/.exec(said ?? "")?.[1] ?? 0), left: !ended };
};

// Did the helper stop this run (dori heavy-stop), asked over a fresh ssh after the run's own connection died without a
// word? A frozen worker is SIGKILLed before it can say WORKER_CANCELLED, so the run id's cancellation record is the only
// way to tell a manual stop from a dropped connection. waitMs at most for the answer.
export const cancelledOnHelper = async (h: HeavyHelper, label: string, run: string | undefined, waitMs = 10_000): Promise<boolean> => {
  if (!run) return false;
  const p = Bun.spawn([...h.ssh, "cancelled", label, run], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const reader = p.stderr.getReader();
  let yes = false;
  const answer = (async () => {
    for await (const l of readerLines(reader)) {
      if (!/^WORKER_CANCELLED_RECORD\b/.test(l)) continue;
      yes = l.endsWith(" yes");
      return;
    }
  })();
  await settle([p], [reader], Promise.all([answer, p.exited]), waitMs);
  return yes;
};

