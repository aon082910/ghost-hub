import { createHash, randomBytes } from "node:crypto";
import { getEnv } from "./env";

/** The only scope Ghost-Hub requests. It also lets us read the mailbox address via users/me/profile. */
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

type FetchLike = typeof fetch;

/**
 * Google endpoints. Overridable via env for local testing against a fake server, but only
 * outside production so a deployed instance can never be pointed at another host.
 */
function endpoints() {
  const dev = process.env.NODE_ENV !== "production";
  const pick = (name: string, fallback: string) => (dev && process.env[name]) || fallback;
  return {
    auth: pick("GOOGLE_AUTH_URL", "https://accounts.google.com/o/oauth2/v2/auth"),
    token: pick("GOOGLE_TOKEN_URL", "https://oauth2.googleapis.com/token"),
    revoke: pick("GOOGLE_REVOKE_URL", "https://oauth2.googleapis.com/revoke"),
    gmail: pick("GOOGLE_GMAIL_URL", "https://gmail.googleapis.com/gmail/v1"),
  };
}

export class GoogleAuthError extends Error {
  constructor(
    /** OAuth error code from Google, e.g. `invalid_grant`, or `http_<status>`. */
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GoogleAuthError";
  }
}

export class GoogleNotConfiguredError extends Error {
  constructor() {
    super("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set");
    this.name = "GoogleNotConfiguredError";
  }
}

export function isGoogleConfigured(): boolean {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = getEnv();
  return Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
}

function credentials() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = getEnv();
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) throw new GoogleNotConfiguredError();
  return { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET };
}

export function redirectUri(): string {
  return `${getEnv().APP_URL.replace(/\/+$/, "")}/api/auth/google/callback`;
}

const b64url = (buf: Buffer) => buf.toString("base64url");

export function createPkce() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function createState(): string {
  return b64url(randomBytes(16));
}

export function buildAuthUrl(opts: { state: string; challenge: string }): string {
  const { clientId } = credentials();
  const url = new URL(endpoints().auth);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: GMAIL_SCOPE,
    access_type: "offline", // ask for a refresh token
    prompt: "consent", // Google only returns a refresh token on consent
    include_granted_scopes: "false",
    state: opts.state,
    code_challenge: opts.challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

async function tokenRequest(params: Record<string, string>, fetchImpl: FetchLike): Promise<TokenResponse> {
  const { clientId, clientSecret } = credentials();
  const res = await fetchImpl(endpoints().token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || body.error || !body.access_token) {
    throw new GoogleAuthError(
      body.error ?? `http_${res.status}`,
      body.error_description ?? `Google token endpoint returned ${res.status}`,
    );
  }
  return body;
}

export async function exchangeCode(code: string, verifier: string, fetchImpl: FetchLike = fetch) {
  const body = await tokenRequest(
    { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri() },
    fetchImpl,
  );
  return {
    accessToken: body.access_token!,
    refreshToken: body.refresh_token,
    expiresIn: body.expires_in ?? 3600,
    scope: body.scope ?? "",
  };
}

export async function refreshAccessToken(refreshToken: string, fetchImpl: FetchLike = fetch) {
  const body = await tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken }, fetchImpl);
  return { accessToken: body.access_token!, expiresIn: body.expires_in ?? 3600 };
}

export async function fetchGmailProfile(accessToken: string, fetchImpl: FetchLike = fetch) {
  const res = await fetchImpl(`${endpoints().gmail}/users/me/profile`, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new GoogleAuthError(`http_${res.status}`, `Gmail profile request failed (${res.status})`);
  const body = (await res.json()) as { emailAddress?: string; messagesTotal?: number };
  if (!body.emailAddress) throw new GoogleAuthError("no_email", "Gmail profile had no email address");
  return { email: body.emailAddress.toLowerCase(), messagesTotal: body.messagesTotal ?? null };
}

/** Best-effort revocation; returns whether Google accepted it. */
export async function revokeToken(token: string, fetchImpl: FetchLike = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(endpoints().revoke, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Whether a space-separated granted-scope string includes the scope we need. */
export function hasRequiredScope(scope: string): boolean {
  return scope.split(/\s+/).includes(GMAIL_SCOPE);
}
