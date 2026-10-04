/**
 * Endpoint overrides for local testing against a fake server. Honoured only outside production,
 * so a deployed instance can never be pointed at another host.
 */
export function devOverride(name: string, fallback: string): string {
  return (process.env.NODE_ENV !== "production" && process.env[name]) || fallback;
}
