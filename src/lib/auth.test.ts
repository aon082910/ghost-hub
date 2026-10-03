import { beforeEach, describe, expect, it } from "vitest";
import { decrypt, encrypt } from "./crypto";
import { getEnv, resetEnvCache } from "./env";
import { createLimiter } from "./rate-limit";
import {
  SESSION_TTL_SECONDS,
  checkAdminPassword,
  createSessionToken,
  verifySessionToken,
} from "./session";

const KEY = Buffer.alloc(32, 7).toString("base64");

beforeEach(() => {
  process.env.ADMIN_PASSWORD = "correct-horse";
  process.env.ENCRYPTION_KEY = KEY;
  process.env.DATABASE_URL = "postgres://x:y@localhost:5432/z";
  resetEnvCache();
});

describe("env", () => {
  it("rejects a short admin password and a bad encryption key, listing both", () => {
    process.env.ADMIN_PASSWORD = "short";
    process.env.ENCRYPTION_KEY = "nope";
    resetEnvCache();
    expect(() => getEnv()).toThrow(/ADMIN_PASSWORD[\s\S]*ENCRYPTION_KEY/);
  });

  it("treats empty strings as unset", () => {
    process.env.GOOGLE_CLIENT_ID = "";
    resetEnvCache();
    expect(getEnv().GOOGLE_CLIENT_ID).toBeUndefined();
  });
});

describe("session", () => {
  it("accepts a fresh token", () => {
    expect(verifySessionToken(createSessionToken())).toBe(true);
  });

  it("rejects expired tokens", () => {
    const now = Date.now();
    const token = createSessionToken(now);
    expect(verifySessionToken(token, now + (SESSION_TTL_SECONDS + 1) * 1000)).toBe(false);
  });

  it("rejects tampered, malformed and missing tokens", () => {
    const [exp, sig] = createSessionToken().split(".");
    expect(verifySessionToken(`${Number(exp) + 999999}.${sig}`)).toBe(false);
    expect(verifySessionToken(`${exp}.${sig}x`)).toBe(false);
    expect(verifySessionToken(`${exp}.${sig}.extra`)).toBe(false);
    expect(verifySessionToken("garbage")).toBe(false);
    expect(verifySessionToken(undefined)).toBe(false);
  });

  it("rejects tokens signed under a different key", () => {
    const token = createSessionToken();
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    resetEnvCache();
    expect(verifySessionToken(token)).toBe(false);
  });

  it("checks the admin password", () => {
    expect(checkAdminPassword("correct-horse")).toBe(true);
    expect(checkAdminPassword("wrong")).toBe(false);
    expect(checkAdminPassword("")).toBe(false);
  });
});

describe("crypto", () => {
  it("round-trips and uses a fresh IV each time", () => {
    const a = encrypt("refresh-token");
    expect(decrypt(a)).toBe("refresh-token");
    expect(encrypt("refresh-token")).not.toBe(a);
  });

  it("fails on tampering or the wrong key", () => {
    const blob = Buffer.from(encrypt("secret"), "base64");
    blob[blob.length - 1] ^= 1;
    expect(() => decrypt(blob.toString("base64"))).toThrow();

    const good = encrypt("secret");
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    resetEnvCache();
    expect(() => decrypt(good)).toThrow();
  });
});

describe("rate limiter", () => {
  it("blocks after max hits and recovers after the window", () => {
    const l = createLimiter(3, 1000);
    expect([1, 2, 3, 4].map(() => l.hit("ip", 0))).toEqual([true, true, true, false]);
    expect(l.hit("other", 0)).toBe(true);
    expect(l.hit("ip", 1001)).toBe(true);
  });

  it("reset clears the counter", () => {
    const l = createLimiter(1, 1000);
    l.hit("ip", 0);
    l.reset("ip");
    expect(l.hit("ip", 1)).toBe(true);
  });
});
