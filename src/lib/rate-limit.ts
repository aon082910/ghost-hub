type Bucket = { count: number; resetAt: number };

/**
 * Tiny in-memory fixed-window limiter. Ghost-Hub is a single-process, single-user app, so
 * per-process state is enough to slow down password guessing on the login form.
 */
export function createLimiter(max: number, windowMs: number) {
  const buckets = new Map<string, Bucket>();
  return {
    /** Returns true if the attempt is allowed (and counts it). */
    hit(key: string, now = Date.now()): boolean {
      const b = buckets.get(key);
      if (!b || b.resetAt <= now) {
        buckets.set(key, { count: 1, resetAt: now + windowMs });
        return true;
      }
      b.count += 1;
      return b.count <= max;
    },
    reset(key: string) {
      buckets.delete(key);
    },
  };
}

const FIFTEEN_MIN = 15 * 60 * 1000;

/** Per-client limit. The client key comes from X-Forwarded-For, which can be spoofed if the app is exposed directly. */
export const loginLimiter = createLimiter(5, FIFTEEN_MIN);

/** Backstop across all clients so rotating spoofed IPs can't bypass the per-client limit. */
export const globalLoginLimiter = createLimiter(30, FIFTEEN_MIN);
