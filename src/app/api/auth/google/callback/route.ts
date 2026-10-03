import { NextResponse, type NextRequest } from "next/server";
import {
  GoogleAuthError,
  exchangeCode,
  fetchGmailProfile,
  hasRequiredScope,
  isGoogleConfigured,
} from "@/lib/google";
import { saveConnection } from "@/lib/mailboxes";
import { OAUTH_COOKIE, appUrl, readOAuthCookie, statesMatch } from "@/lib/oauth-flow";

export const dynamic = "force-dynamic";

function done(path: string) {
  const res = NextResponse.redirect(appUrl(path));
  res.cookies.delete({ name: OAUTH_COOKIE, path: "/api/auth/google" });
  return res;
}

/** Google redirects here after consent. Requires a logged-in session (enforced by src/proxy.ts). */
export async function GET(request: NextRequest) {
  if (!isGoogleConfigured()) return done("/?error=not_configured");

  const params = request.nextUrl.searchParams;
  if (params.get("error")) return done("/?error=access_denied");

  const flow = readOAuthCookie(request.cookies.get(OAUTH_COOKIE)?.value);
  const code = params.get("code");
  if (!flow || !code || !statesMatch(flow.state, params.get("state"))) return done("/?error=state_mismatch");

  try {
    const tokens = await exchangeCode(code, flow.verifier);
    // Granular consent lets users untick scopes; without Gmail read access we can't do anything.
    if (!hasRequiredScope(tokens.scope)) return done("/?error=scope_missing");
    if (!tokens.refreshToken) return done("/?error=no_refresh_token");

    const { email } = await fetchGmailProfile(tokens.accessToken);
    await saveConnection({ mailbox: email, refreshToken: tokens.refreshToken, scopes: tokens.scope });
    return done(`/?connected=${encodeURIComponent(email)}`);
  } catch (err) {
    console.error("[ghost-hub] Google OAuth callback failed:", err instanceof GoogleAuthError ? err.code : err);
    return done("/?error=exchange_failed");
  }
}
