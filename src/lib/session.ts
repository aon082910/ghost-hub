import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { deriveKey } from "./crypto";
import { getEnv } from "./env";

export const SESSION_COOKIE = "ghosthub_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

function sign(payload: string): string {
  return createHmac("sha256", deriveKey("session")).update(payload).digest("base64url");
}

/** Token format: `<expiryUnixSeconds>.<hmac>`. Stateless; expires on its own. */
export function createSessionToken(nowMs = Date.now()): string {
  const exp = Math.floor(nowMs / 1000) + SESSION_TTL_SECONDS;
  return `${exp}.${sign(String(exp))}`;
}

export function verifySessionToken(token: string | undefined, nowMs = Date.now()): boolean {
  if (!token) return false;
  const [exp, sig, ...rest] = token.split(".");
  if (!exp || !sig || rest.length > 0 || !/^\d+$/.test(exp)) return false;
  const expected = Buffer.from(sign(exp));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
  return Number(exp) * 1000 > nowMs;
}

/** Constant-time password check (hashing first equalizes lengths). */
export function checkAdminPassword(candidate: string): boolean {
  const a = createHash("sha256").update(candidate).digest();
  const b = createHash("sha256").update(getEnv().ADMIN_PASSWORD).digest();
  return timingSafeEqual(a, b);
}
