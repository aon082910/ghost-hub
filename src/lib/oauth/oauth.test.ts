import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encrypt } from "../crypto";
import { resetEnvCache } from "../env";
import { readOAuthCookie, statesMatch } from "../oauth-flow";
import { OAuthError, ProviderNotConfiguredError, createPkce, getOAuthProvider, isOAuthProviderId } from "./index";
import { GMAIL_SCOPE, google } from "./google";
import { microsoft } from "./microsoft";

beforeEach(() => {
  process.env.ADMIN_PASSWORD = "correct-horse";
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.DATABASE_URL = "postgres://x:y@localhost:5432/z";
  process.env.APP_URL = "https://hub.example.com/";
  process.env.GOOGLE_CLIENT_ID = "g-id";
  process.env.GOOGLE_CLIENT_SECRET = "g-secret";
  process.env.MICROSOFT_CLIENT_ID = "m-id";
  process.env.MICROSOFT_CLIENT_SECRET = "m-secret";
  delete process.env.MICROSOFT_TENANT;
  for (const k of Object.keys(process.env)) if (/^(GOOGLE|MICROSOFT)_(AUTH|TOKEN|REVOKE|GMAIL|GRAPH)_URL$/.test(k)) delete process.env[k];
  resetEnvCache();
});

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

describe("registry", () => {
  it("knows google and microsoft only", () => {
    expect(isOAuthProviderId("google")).toBe(true);
    expect(isOAuthProviderId("microsoft")).toBe(true);
    expect(isOAuthProviderId("yahoo")).toBe(false);
    expect(isOAuthProviderId("toString")).toBe(false); // not fooled by Object.prototype keys
    expect(getOAuthProvider("__proto__")).toBeNull();
  });
});

describe("auth URLs", () => {
  it("google: offline access, consent, PKCE S256, only the Gmail read scope", () => {
    const url = new URL(google.buildAuthUrl({ state: "st", challenge: "ch" }));
    const p = url.searchParams;
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(p.get("client_id")).toBe("g-id");
    expect(p.get("redirect_uri")).toBe("https://hub.example.com/api/auth/google/callback");
    expect(p.get("scope")).toBe(GMAIL_SCOPE);
    expect(p.get("access_type")).toBe("offline");
    expect(p.get("prompt")).toBe("consent");
    expect(p.get("state")).toBe("st");
    expect(p.get("code_challenge")).toBe("ch");
    expect(p.get("code_challenge_method")).toBe("S256");
  });

  it("microsoft: common tenant by default, read-only mail scopes, account picker", () => {
    const url = new URL(microsoft.buildAuthUrl({ state: "st", challenge: "ch" }));
    const p = url.searchParams;
    expect(url.origin + url.pathname).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(p.get("redirect_uri")).toBe("https://hub.example.com/api/auth/microsoft/callback");
    expect(p.get("scope")!.split(" ").sort()).toEqual(["Mail.Read", "User.Read", "offline_access"]);
    expect(p.get("prompt")).toBe("select_account");
    expect(p.get("code_challenge_method")).toBe("S256");
    // No write scopes, ever.
    expect(p.get("scope")).not.toMatch(/Send|Write|ReadWrite/);
  });

  it("microsoft honours MICROSOFT_TENANT and encodes it", () => {
    process.env.MICROSOFT_TENANT = "consumers";
    resetEnvCache();
    expect(microsoft.buildAuthUrl({ state: "s", challenge: "c" })).toContain("/consumers/oauth2/v2.0/authorize");
    process.env.MICROSOFT_TENANT = "a/b";
    resetEnvCache();
    expect(microsoft.buildAuthUrl({ state: "s", challenge: "c" })).toContain("/a%2Fb/oauth2/v2.0/authorize");
  });

  it("reports unconfigured providers and refuses to build a URL", () => {
    delete process.env.MICROSOFT_CLIENT_ID;
    resetEnvCache();
    expect(microsoft.isConfigured()).toBe(false);
    expect(google.isConfigured()).toBe(true);
    expect(() => microsoft.buildAuthUrl({ state: "a", challenge: "b" })).toThrow(ProviderNotConfiguredError);
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

describe("token endpoints", () => {
  it("exchanges a code with the verifier, redirect URI and client secret", async () => {
    const fetchImpl = vi.fn((_u: string | URL | Request, init?: RequestInit) => {
      const b = init!.body as URLSearchParams;
      expect(b.get("grant_type")).toBe("authorization_code");
      expect(b.get("code")).toBe("the-code");
      expect(b.get("code_verifier")).toBe("the-verifier");
      expect(b.get("client_secret")).toBe("m-secret");
      expect(b.get("redirect_uri")).toBe("https://hub.example.com/api/auth/microsoft/callback");
      return json({ access_token: "at", refresh_token: "rt", expires_in: 3599, scope: "Mail.Read User.Read" });
    });
    expect(await microsoft.exchangeCode("the-code", "the-verifier", fetchImpl as unknown as typeof fetch)).toEqual({
      accessToken: "at",
      refreshToken: "rt",
      expiresIn: 3599,
      scope: "Mail.Read User.Read",
    });
  });

  it("microsoft repeats its scopes on refresh and surfaces a rotated refresh token", async () => {
    const fetchImpl = vi.fn((_u: string | URL | Request, init?: RequestInit) => {
      const b = init!.body as URLSearchParams;
      expect(b.get("grant_type")).toBe("refresh_token");
      expect(b.get("scope")).toContain("Mail.Read");
      return json({ access_token: "fresh", refresh_token: "rotated", expires_in: 100 });
    });
    const out = await microsoft.refreshAccessToken("old", fetchImpl as unknown as typeof fetch);
    expect(out).toMatchObject({ accessToken: "fresh", refreshToken: "rotated", expiresIn: 100 });
  });

  it("google does not send a scope on refresh", async () => {
    const fetchImpl = vi.fn((_u: string | URL | Request, init?: RequestInit) => {
      expect((init!.body as URLSearchParams).has("scope")).toBe(false);
      return json({ access_token: "fresh", expires_in: 100 });
    });
    await google.refreshAccessToken("rt", fetchImpl as unknown as typeof fetch);
  });

  it("surfaces the provider's error code and message", async () => {
    const fetchImpl = (() => json({ error: "invalid_grant", error_description: "Bad code" }, 400)) as typeof fetch;
    await expect(google.exchangeCode("x", "y", fetchImpl)).rejects.toMatchObject({
      name: "OAuthError",
      code: "invalid_grant",
      message: "Bad code",
    });
  });

  it("falls back to http_<status> when the body isn't JSON", async () => {
    const fetchImpl = (() => Promise.resolve(new Response("nope", { status: 502 }))) as typeof fetch;
    await expect(google.refreshAccessToken("rt", fetchImpl)).rejects.toMatchObject({ code: "http_502" });
  });
});

describe("profiles", () => {
  it("gmail: lowercases the address and sends the bearer token", async () => {
    const fetchImpl = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://gmail.googleapis.com/gmail/v1/users/me/profile");
      expect((init!.headers as Record<string, string>).authorization).toBe("Bearer at");
      return json({ emailAddress: "Me@Gmail.com" });
    });
    expect(await google.fetchProfile("at", fetchImpl as unknown as typeof fetch)).toEqual({ email: "me@gmail.com" });
  });

  it("microsoft: prefers mail, falls back to userPrincipalName, lowercases", async () => {
    const fetchImpl = vi.fn((url: string | URL | Request) => {
      expect(String(url)).toBe("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName");
      return json({ mail: null, userPrincipalName: "Me@Outlook.com" });
    });
    expect(await microsoft.fetchProfile("at", fetchImpl as unknown as typeof fetch)).toEqual({ email: "me@outlook.com" });
    expect(await microsoft.fetchProfile("at", (() => json({ mail: "Work@Corp.com", userPrincipalName: "u@corp" })) as typeof fetch)).toEqual({
      email: "work@corp.com",
    });
  });

  it("rejects profiles with no address and failed requests", async () => {
    await expect(google.fetchProfile("at", (() => json({})) as typeof fetch)).rejects.toMatchObject({ code: "no_email" });
    await expect(microsoft.fetchProfile("at", (() => json({})) as typeof fetch)).rejects.toMatchObject({ code: "no_email" });
    await expect(microsoft.fetchProfile("at", (() => json({}, 401)) as typeof fetch)).rejects.toBeInstanceOf(OAuthError);
  });
});

describe("revocation", () => {
  it("google revokes and reports success, failure, and swallows network errors", async () => {
    expect(await google.revoke!("rt", (() => json({})) as typeof fetch)).toBe(true);
    expect(await google.revoke!("rt", (() => json({}, 400)) as typeof fetch)).toBe(false);
    expect(await google.revoke!("rt", (() => Promise.reject(new Error("offline"))) as typeof fetch)).toBe(false);
  });

  it("microsoft has no revoke endpoint", () => {
    expect(microsoft.revoke).toBeUndefined();
    expect(microsoft.manageAccessUrl).toMatch(/^https:\/\//);
  });
});

describe("granted scopes", () => {
  it("google requires the Gmail scope", () => {
    expect(google.hasRequiredScope(GMAIL_SCOPE)).toBe(true);
    expect(google.hasRequiredScope(`openid ${GMAIL_SCOPE}`)).toBe(true);
    expect(google.hasRequiredScope("openid email")).toBe(false);
    expect(google.hasRequiredScope("")).toBe(false);
  });

  it("microsoft requires Mail.Read, case-insensitively (Microsoft varies the casing)", () => {
    expect(microsoft.hasRequiredScope("Mail.Read User.Read profile openid email")).toBe(true);
    expect(microsoft.hasRequiredScope("mail.read user.read")).toBe(true);
    expect(microsoft.hasRequiredScope("User.Read profile")).toBe(false);
    expect(microsoft.hasRequiredScope("Mail.ReadWrite")).toBe(false); // a different scope must not satisfy it
  });
});

describe("oauth flow cookie", () => {
  it("round-trips provider, state and verifier", () => {
    const cookie = encrypt(JSON.stringify({ provider: "microsoft", state: "s", verifier: "v" }));
    expect(readOAuthCookie(cookie)).toEqual({ provider: "microsoft", state: "s", verifier: "v" });
  });

  it("rejects missing, garbage, tampered, wrong-shape and provider-less cookies", () => {
    expect(readOAuthCookie(undefined)).toBeNull();
    expect(readOAuthCookie("garbage")).toBeNull();
    expect(readOAuthCookie(encrypt(JSON.stringify({ state: "s", verifier: "v" })))).toBeNull(); // no provider
    expect(readOAuthCookie(encrypt(JSON.stringify({ provider: "g", state: 1, verifier: "v" })))).toBeNull();
    expect(readOAuthCookie(encrypt("not json"))).toBeNull();
    const blob = Buffer.from(encrypt(JSON.stringify({ provider: "g", state: "s", verifier: "v" })), "base64");
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
