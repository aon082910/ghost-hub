/** What an API said was wrong, reduced to fields that are safe to show: a short code, a trimmed message and an https console link. */
export type ApiErrorInfo = { reason: string | null; message: string | null; activationUrl: string | null };

const NO_INFO: ApiErrorInfo = { reason: null, message: null, activationUrl: null };
const SAFE_REASON = /^[A-Za-z0-9_.-]{1,64}$/;
// Google tells you where to switch an API on; only a link to its own consoles is passed on.
const CONSOLE_LINK = /^https:\/\/console\.(?:developers|cloud)\.google\.com\/[^\s]*$/;

export class ScanHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly info: ApiErrorInfo = NO_INFO,
  ) {
    super(message);
    this.name = "ScanHttpError";
  }
}

/** Pull the useful part out of a Google or Microsoft error body. Never throws; the body is untrusted. */
export async function readApiError(res: Response): Promise<ApiErrorInfo> {
  try {
    const body = JSON.parse((await res.text()).slice(0, 16_000)) as Record<string, unknown>;
    const err = (typeof body.error === "object" && body.error !== null ? body.error : {}) as Record<string, unknown>;
    const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null) : []);
    const details = list(err.details);
    const candidates = [...details.map((d) => d.reason), ...list(err.errors).map((e) => e.reason), err.status, err.code, body.error];
    const reason = candidates.find((c): c is string => typeof c === "string" && SAFE_REASON.test(c)) ?? null;
    const message = typeof err.message === "string" ? err.message.replace(/\s+/g, " ").trim().slice(0, 200) || null : null;
    const links = details.map((d) => (typeof d.metadata === "object" && d.metadata !== null ? (d.metadata as Record<string, unknown>).activationUrl : undefined));
    const activationUrl = links.find((l): l is string => typeof l === "string" && CONSOLE_LINK.test(l)) ?? null;
    return { reason, message, activationUrl };
  } catch {
    return NO_INFO;
  }
}

// Gmail reports being throttled as a 403, not a 429.
const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "RATE_LIMIT_EXCEEDED", "quotaExceeded"]);

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
    const info = await readApiError(res);
    const retryable = res.status === 429 || res.status >= 500 || (res.status === 403 && info.reason !== null && RATE_LIMIT_REASONS.has(info.reason));
    if (!retryable || attempt >= retries) {
      throw new ScanHttpError(res.status, `Request failed with HTTP ${res.status}`, info);
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
