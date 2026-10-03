import { timingSafeEqual } from "node:crypto";
import { decrypt } from "./crypto";
import { getEnv } from "./env";

export const OAUTH_COOKIE = "ghosthub_oauth";
export const OAUTH_COOKIE_MAX_AGE = 10 * 60;

/** Absolute URL on the configured public origin (request.url can be an internal Docker host). */
export function appUrl(path: string): URL {
  return new URL(path, getEnv().APP_URL);
}

/** Read the {state, verifier} the start route stored. Returns null if missing, tampered or malformed. */
export function readOAuthCookie(value: string | undefined): { state: string; verifier: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(decrypt(value)) as { state?: unknown; verifier?: unknown };
    if (typeof parsed.state !== "string" || typeof parsed.verifier !== "string") return null;
    return { state: parsed.state, verifier: parsed.verifier };
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
