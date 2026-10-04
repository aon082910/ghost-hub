export class ScanHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ScanHttpError";
  }
}

export type HttpDeps = {
  fetchImpl?: typeof fetch;
  /** Injected so tests don't actually wait. */
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Seconds from a Retry-After header, capped so a hostile or broken server can't stall a scan for long. */
export function retryAfterMs(header: string | null, fallbackMs: number): number {
  const seconds = header ? Number(header) : NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 30) * 1000 : fallbackMs;
}

/**
 * GET/POST JSON with retries on throttling (429) and server errors (5xx), honouring Retry-After.
 * Returns null on 404 when `allow404` is set (e.g. a message deleted mid-scan).
 */
export async function requestJson<T>(
  url: string,
  init: RequestInit,
  { fetchImpl = fetch, sleep = defaultSleep, retries = 4, allow404 = false, signal }: HttpDeps & {
    retries?: number;
    allow404?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<T | null> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    const res = await fetchImpl(url, { ...init, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
    if (res.ok) return (await res.json()) as T;
    if (res.status === 404 && allow404) return null;
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= retries) {
      throw new ScanHttpError(res.status, `Request failed with HTTP ${res.status}`);
    }
    await sleep(retryAfterMs(res.headers.get("retry-after"), 500 * 2 ** attempt));
  }
}

/** Map with a concurrency limit, preserving order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
