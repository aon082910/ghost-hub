import { microsoftCredentials, microsoftTenant } from "../config";
import { OAuthError, createOAuthProvider, devOverride, type FetchLike } from "./core";

/** Read-only mail access. `User.Read` lets us look up the mailbox address. */
export const MICROSOFT_SCOPES = ["offline_access", "Mail.Read", "User.Read"];

export const graphApiBase = () => devOverride("MICROSOFT_GRAPH_URL", "https://graph.microsoft.com/v1.0");

const authority = () => `https://login.microsoftonline.com/${encodeURIComponent(microsoftTenant())}/oauth2/v2.0`;

export const microsoft = createOAuthProvider({
  id: "microsoft",
  label: "Microsoft",
  // Personal accounts manage app access here; work/school accounts use https://myapps.microsoft.com.
  manageAccessUrl: "https://account.live.com/consent/Manage",
  scopes: MICROSOFT_SCOPES,
  requiredScope: "Mail.Read",
  authParams: { response_mode: "query", prompt: "select_account" },
  // Microsoft wants the scopes repeated on refresh, otherwise it may issue a token for the defaults only.
  refreshParams: { scope: MICROSOFT_SCOPES.join(" ") },
  credentials: microsoftCredentials,
  // No `revoke`: the Microsoft identity platform has no token revocation endpoint for users.
  endpoints: () => ({
    auth: devOverride("MICROSOFT_AUTH_URL", `${authority()}/authorize`),
    token: devOverride("MICROSOFT_TOKEN_URL", `${authority()}/token`),
  }),
  async fetchProfile(accessToken: string, fetchImpl: FetchLike) {
    const res = await fetchImpl(`${graphApiBase()}/me?$select=mail,userPrincipalName`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new OAuthError(`http_${res.status}`, `Microsoft Graph profile request failed (${res.status})`);
    const body = (await res.json()) as { mail?: string | null; userPrincipalName?: string | null };
    const email = body.mail || body.userPrincipalName;
    if (!email) throw new OAuthError("no_email", "Microsoft profile had no email address");
    return { email: email.toLowerCase() };
  },
});
