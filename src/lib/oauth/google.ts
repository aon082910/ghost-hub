import { getEnv } from "../env";
import { OAuthError, createOAuthProvider, devOverride, type FetchLike } from "./core";

/** The only scope requested. It also lets us read the mailbox address via users/me/profile. */
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

export const gmailApiBase = () => devOverride("GOOGLE_GMAIL_URL", "https://gmail.googleapis.com/gmail/v1");

export const google = createOAuthProvider({
  id: "google",
  label: "Google",
  manageAccessUrl: "https://myaccount.google.com/permissions",
  scopes: [GMAIL_SCOPE],
  requiredScope: GMAIL_SCOPE,
  supportsRevoke: true,
  authParams: {
    access_type: "offline", // ask for a refresh token
    prompt: "consent", // Google only returns a refresh token on consent
    include_granted_scopes: "false",
  },
  credentials() {
    const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = getEnv();
    return GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET
      ? { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET }
      : null;
  },
  endpoints: () => ({
    auth: devOverride("GOOGLE_AUTH_URL", "https://accounts.google.com/o/oauth2/v2/auth"),
    token: devOverride("GOOGLE_TOKEN_URL", "https://oauth2.googleapis.com/token"),
    revoke: devOverride("GOOGLE_REVOKE_URL", "https://oauth2.googleapis.com/revoke"),
  }),
  async fetchProfile(accessToken: string, fetchImpl: FetchLike) {
    const res = await fetchImpl(`${gmailApiBase()}/users/me/profile`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new OAuthError(`http_${res.status}`, `Gmail profile request failed (${res.status})`);
    const body = (await res.json()) as { emailAddress?: string };
    if (!body.emailAddress) throw new OAuthError("no_email", "Gmail profile had no email address");
    return { email: body.emailAddress.toLowerCase() };
  },
});
