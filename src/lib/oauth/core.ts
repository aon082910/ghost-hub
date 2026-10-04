import { createHash, randomBytes } from "node:crypto";
import { getEnv } from "../env";

export type FetchLike = typeof fetch;

export class OAuthError extends Error {
  constructor(
    /** OAuth error code from the provider, e.g. `invalid_grant`, or `http_<status>`. */
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

export class ProviderNotConfiguredError extends Error {
  constructor(label: string) {
    super(`${label} OAuth credentials are not set`);
    this.name = "ProviderNotConfiguredError";
  }
}

export type OAuthTokens = {
  accessToken: string;
  /** Present on first exchange; also on refresh for providers that rotate refresh tokens. */
  refreshToken?: string;
  expiresIn: number;
  scope: string;
};

export type OAuthProvider = {
  id: string;
  label: string;
  isConfigured(): boolean;
  redirectUri(): string;
  buildAuthUrl(opts: { state: string; challenge: string }): string;
  exchangeCode(code: string, verifier: string, fetchImpl?: FetchLike): Promise<OAuthTokens>;
  refreshAccessToken(refreshToken: string, fetchImpl?: FetchLike): Promise<OAuthTokens>;
  fetchProfile(accessToken: string, fetchImpl?: FetchLike): Promise<{ email: string }>;
  /** Best-effort revocation. Undefined when the provider has no revocation endpoint. */
  revoke?: (token: string, fetchImpl?: FetchLike) => Promise<boolean>;
  hasRequiredScope(granted: string): boolean;
  /** Where the user can remove Ghost-Hub's access themselves. */
  manageAccessUrl: string;
};

export type OAuthProviderConfig = {
  id: string;
  label: string;
  credentials(): { clientId: string; clientSecret: string } | null;
  /** Called lazily (never at import time) because it may read the validated environment. */
  endpoints(): { auth: string; token: string; revoke?: string };
  /** Whether endpoints().revoke exists. Static so building the provider never touches the environment. */
  supportsRevoke?: boolean;
  scopes: string[];
  /** The scope without which Ghost-Hub can't read mail (compared case-insensitively). */
  requiredScope: string;
  authParams?: Record<string, string>;
  /** Extra form fields on refresh requests (Microsoft wants `scope`). */
  refreshParams?: Record<string, string>;
  fetchProfile(accessToken: string, fetchImpl: FetchLike): Promise<{ email: string }>;
  manageAccessUrl: string;
};

const b64url = (buf: Buffer) => buf.toString("base64url");

export function createPkce() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function createState(): string {
  return b64url(randomBytes(16));
}

export { devOverride } from "../dev-override";

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

export function createOAuthProvider(config: OAuthProviderConfig): OAuthProvider {
  const credentials = () => {
    const c = config.credentials();
    if (!c) throw new ProviderNotConfiguredError(config.label);
    return c;
  };

  const redirectUri = () => `${getEnv().APP_URL.replace(/\/+$/, "")}/api/auth/${config.id}/callback`;

  async function tokenRequest(params: Record<string, string>, fetchImpl: FetchLike): Promise<OAuthTokens> {
    const { clientId, clientSecret } = credentials();
    const res = await fetchImpl(config.endpoints().token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as TokenResponse;
    if (!res.ok || body.error || !body.access_token) {
      throw new OAuthError(
        body.error ?? `http_${res.status}`,
        body.error_description ?? `${config.label} token endpoint returned ${res.status}`,
      );
    }
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresIn: body.expires_in ?? 3600,
      scope: body.scope ?? "",
    };
  }

  return {
    id: config.id,
    label: config.label,
    manageAccessUrl: config.manageAccessUrl,
    isConfigured: () => config.credentials() !== null,
    redirectUri,

    buildAuthUrl({ state, challenge }) {
      const { clientId } = credentials();
      const url = new URL(config.endpoints().auth);
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri(),
        response_type: "code",
        scope: config.scopes.join(" "),
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        ...config.authParams,
      }).toString();
      return url.toString();
    },

    exchangeCode: (code, verifier, fetchImpl = fetch) =>
      tokenRequest(
        { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri() },
        fetchImpl,
      ),

    refreshAccessToken: (refreshToken, fetchImpl = fetch) =>
      tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken, ...config.refreshParams }, fetchImpl),

    fetchProfile: (accessToken, fetchImpl = fetch) => config.fetchProfile(accessToken, fetchImpl),

    revoke: config.supportsRevoke
      ? async (token, fetchImpl = fetch) => {
          try {
            const res = await fetchImpl(config.endpoints().revoke!, {
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
      : undefined,

    hasRequiredScope: (granted) =>
      granted
        .toLowerCase()
        .split(/\s+/)
        .includes(config.requiredScope.toLowerCase()),
  };
}
