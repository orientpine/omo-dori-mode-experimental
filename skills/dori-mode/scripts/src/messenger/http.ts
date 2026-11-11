import type { Clock } from "../run.ts";

export type HttpRequest = {
  readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | FormData | Uint8Array<ArrayBuffer>;
  readonly signal?: AbortSignal;
};
export type HttpResponse = { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: string };
export type Http = (req: HttpRequest) => Promise<HttpResponse>;

export const fetchHttp: Http = async (req) => {
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: req.signal ?? null });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  return { status: res.status, headers, body: await res.text() };
};

export class MessengerError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    // seconds a 429 asked to wait, when the platform said
    readonly retryAfterS?: number,
  ) {
    super(message);
  }
}

export class UnsafeMessageError extends Error {}

export const guardText = (text: string): string => {
  if (text.includes("$(")) throw new UnsafeMessageError("message text contains $( ; build messages as data, never through a shell string");
  return text;
};

export type RetryPolicy = { readonly attempts: number; readonly baseMs: number; readonly maxMs: number };
export const DEFAULT_RETRY: RetryPolicy = { attempts: 5, baseMs: 1_000, maxMs: 60_000 };

export const withBackoff = async (http: Http, clock: Clock, req: HttpRequest, policy: RetryPolicy = DEFAULT_RETRY, retryAfterFromBody?: (body: string) => number | undefined): Promise<HttpResponse> => {
  const sleep = (ms: number): Promise<void> => {
    if (!req.signal) return clock.sleep(ms);
    const signal = req.signal;
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  };
  let last: HttpResponse | undefined;
  for (let attempt = 0; attempt < policy.attempts; attempt++) {
    last = await http(req);
    if (last.status !== 429 && last.status < 500) return last;
    const header = Number(last.headers["retry-after"]);
    const fromBody = retryAfterFromBody?.(last.body);
    const waitS = Number.isFinite(header) && header > 0 ? header : fromBody;
    const waitMs = waitS !== undefined ? waitS * 1000 : Math.min(policy.maxMs, policy.baseMs * 2 ** attempt);
    if (attempt < policy.attempts - 1) await sleep(Math.min(policy.maxMs, waitMs));
  }
  return last as HttpResponse;
};
