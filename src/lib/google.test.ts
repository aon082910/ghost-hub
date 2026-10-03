import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encrypt } from "./crypto";
import { resetEnvCache } from "./env";
import {
  GMAIL_SCOPE,
  GoogleAuthError,
  GoogleNotConfiguredError,
  buildAuthUrl,
  createPkce,
  exchangeCode,
  fetchGmailProfile,
  hasRequiredScope,
  isGoogleConfigured,
  redirectUri,
  refreshAccessToken,
  revokeToken,
} from "./google";
import { readOAuthCookie, statesMatch } from "./oauth-flow";

beforeEach(() => {
  process.env.ADMIN_PASSWORD = "correct-horse";
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.DATABASE_URL = "postgres://x:y@localhost:5432/z";
  process.env.APP_URL = "https://hub.example.com/";
  process.env.GOOGLE_CLIENT_ID = "client-id";
  process.env.GOOGLE_CLIENT_SECRET = "client-secret";
  delete process.env.GOOGLE_TOKEN_URL;
  resetEnvCache();
});

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

describe("auth URL", () => {
  it("requests offline access, consent, PKCE S256 and only the Gmail read scope", () => {
    const url = new URL(buildAuthUrl({ state: "st", challenge: "ch" }));
    const p = url.searchParams;
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(p.get("client_id")).toBe("client-id");
    expect(p.get("redirect_uri")).toBe("https://hub.example.com/api/auth/google/callback");
    expect(p.get("response_type")).toBe("code");
    expect(p.get("scope")).toBe(GMAIL_SCOPE);
    expect(p.get("access_type")).toBe("offline");
    expect(p.get("prompt")).toBe("consent");
    expect(p.get("state")).toBe("st");
    expect(p.get("code_challenge")).toBe("ch");
    expect(p.get("code_challenge_method")).toBe("S256");
  });

  it("strips trailing slashes from APP_URL in the redirect URI", () => {
    expect(redirectUri()).toBe("https://hub.example.com/api/auth/google/callback");
  });

  it("throws when the client isn't configured", () => {
    delete process.env.GOOGLE_CLIENT_ID;
    resetEnvCache();
    expect(isGoogleConfigured()).toBe(false);
    expect(() => buildAuthUrl({ state: "a", challenge: "b" })).toThrow(GoogleNotConfiguredError);
  });
});

describe("PKCE", () => {
  it("derives the challenge as base64url(sha256(verifier))", () => {
    const { verifier, challenge } = createPkce();
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(createPkce().verifier).not.toBe(verifier);
  });
});

describe("token exchange", () => {
  it("posts the code, verifier and redirect URI, and parses the response", async () => {
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const body = init!.body as URLSearchParams;
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("the-code");
      expect(body.get("code_verifier")).toBe("the-verifier");
      expect(body.get("client_secret")).toBe("client-secret");
      return json({ access_token: "at", refresh_token: "rt", expires_in: 3599, scope: GMAIL_SCOPE });
    });
    const out = await exchangeCode("the-code", "the-verifier", fetchImpl as unknown as typeof fetch);
    expect(out).toEqual({ accessToken: "at", refreshToken: "rt", expiresIn: 3599, scope: GMAIL_SCOPE });
  });

  it("surfaces Google's error code", async () => {
    const fetchImpl = (() => json({ error: "invalid_grant", error_description: "Bad code" }, 400)) as typeof fetch;
    await expect(exchangeCode("x", "y", fetchImpl)).rejects.toMatchObject({
      name: "GoogleAuthError",
      code: "invalid_grant",
      message: "Bad code",
    });
  });

  it("falls back to an http_<status> code when the body isn't JSON", async () => {
    const fetchImpl = (() => Promise.resolve(new Response("nope", { status: 502 }))) as typeof fetch;
    await expect(refreshAccessToken("rt", fetchImpl)).rejects.toMatchObject({ code: "http_502" });
  });

  it("refreshes an access token", async () => {
    const fetchImpl = vi.fn((_u: string | URL | Request, init?: RequestInit) => {
      expect((init!.body as URLSearchParams).get("grant_type")).toBe("refresh_token");
      return json({ access_token: "fresh", expires_in: 100 });
    });
    expect(await refreshAccessToken("rt", fetchImpl as unknown as typeof fetch)).toEqual({
      accessToken: "fresh",
      expiresIn: 100,
    });
  });
});

describe("gmail profile and revoke", () => {
  it("lowercases the mailbox address and sends the bearer token", async () => {
    const fetchImpl = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://gmail.googleapis.com/gmail/v1/users/me/profile");
      expect((init!.headers as Record<string, string>).authorization).toBe("Bearer at");
      return json({ emailAddress: "Me@Gmail.com", messagesTotal: 42 });
    });
    expect(await fetchGmailProfile("at", fetchImpl as unknown as typeof fetch)).toEqual({
      email: "me@gmail.com",
      messagesTotal: 42,
    });
  });

  it("rejects a profile without an address, and a failed request", async () => {
    await expect(fetchGmailProfile("at", (() => json({})) as typeof fetch)).rejects.toMatchObject({ code: "no_email" });
    await expect(fetchGmailProfile("at", (() => json({}, 401)) as typeof fetch)).rejects.toBeInstanceOf(GoogleAuthError);
  });

  it("revoke reports success and swallows network errors", async () => {
    expect(await revokeToken("rt", (() => json({})) as typeof fetch)).toBe(true);
    expect(await revokeToken("rt", (() => json({}, 400)) as typeof fetch)).toBe(false);
    expect(await revokeToken("rt", (() => Promise.reject(new Error("offline"))) as typeof fetch)).toBe(false);
  });
});

describe("granted scopes", () => {
  it("requires the Gmail scope among those granted", () => {
    expect(hasRequiredScope(GMAIL_SCOPE)).toBe(true);
    expect(hasRequiredScope(`openid ${GMAIL_SCOPE}`)).toBe(true);
    expect(hasRequiredScope("openid email")).toBe(false);
    expect(hasRequiredScope("")).toBe(false);
  });
});

describe("oauth flow cookie", () => {
  it("round-trips state and verifier", () => {
    const cookie = encrypt(JSON.stringify({ state: "s", verifier: "v" }));
    expect(readOAuthCookie(cookie)).toEqual({ state: "s", verifier: "v" });
  });

  it("rejects missing, garbage, tampered and wrong-shape cookies", () => {
    expect(readOAuthCookie(undefined)).toBeNull();
    expect(readOAuthCookie("garbage")).toBeNull();
    expect(readOAuthCookie(encrypt(JSON.stringify({ state: 1 })))).toBeNull();
    expect(readOAuthCookie(encrypt("not json"))).toBeNull();
    const blob = Buffer.from(encrypt(JSON.stringify({ state: "s", verifier: "v" })), "base64");
    blob[blob.length - 1] ^= 1;
    expect(readOAuthCookie(blob.toString("base64"))).toBeNull();
  });

  it("compares state in constant time and rejects mismatches", () => {
    expect(statesMatch("abc", "abc")).toBe(true);
    expect(statesMatch("abc", "abd")).toBe(false);
    expect(statesMatch("abc", "abcd")).toBe(false);
    expect(statesMatch("abc", null)).toBe(false);
  });
});
