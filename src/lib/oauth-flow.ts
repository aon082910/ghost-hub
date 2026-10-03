import { timingSafeEqual } from "node:crypto";
import { decrypt } from "./crypto";
import { getEnv } from "./env";

export const OAUTH_COOKIE = "ghosthub_oauth";
export const OAUTH_COOKIE_PATH = "/api/auth";
export const OAUTH_COOKIE_MAX_AGE = 10 * 60;

/** Absolute URL on the configured public origin (request.url can be an internal Docker host). */
export function appUrl(path: string): URL {
  return new URL(path, getEnv().APP_URL);
}

export type OAuthFlow = { provider: string; state: string; verifier: string };

/** Read what the start route stored. Returns null if missing, tampered or malformed. */
export function readOAuthCookie(value: string | undefined): OAuthFlow | null {
  if (!value) return null;
  try {
    const p = JSON.parse(decrypt(value)) as Partial<Record<keyof OAuthFlow, unknown>>;
    if (typeof p.provider !== "string" || typeof p.state !== "string" || typeof p.verifier !== "string") return null;
    return { provider: p.provider, state: p.state, verifier: p.verifier };
  } catch {
    return null;
  }
}

export function statesMatch(expected: string, given: string | null): boolean {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}
