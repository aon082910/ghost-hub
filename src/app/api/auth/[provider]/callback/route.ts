import { NextResponse, type NextRequest } from "next/server";
import { OAuthError, getOAuthProvider, isOAuthProviderId } from "@/lib/oauth";
import { saveConnection } from "@/lib/mailboxes";
import { OAUTH_COOKIE, OAUTH_COOKIE_PATH, appUrl, readOAuthCookie, statesMatch } from "@/lib/oauth-flow";

export const dynamic = "force-dynamic";

function done(path: string) {
  const res = NextResponse.redirect(appUrl(path));
  res.cookies.delete({ name: OAUTH_COOKIE, path: OAUTH_COOKIE_PATH });
  return res;
}

/** The provider redirects here after consent. Requires a logged-in session (enforced by src/proxy.ts). */
export async function GET(request: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const id = (await params).provider;
  const provider = getOAuthProvider(id);
  if (!provider || !isOAuthProviderId(id)) return done("/?error=unknown_provider");
  if (!provider.isConfigured()) return done("/?error=not_configured");

  const query = request.nextUrl.searchParams;
  if (query.get("error")) return done("/?error=access_denied");

  // The flow cookie must belong to this provider, or a callback could be replayed across providers.
  const flow = readOAuthCookie(request.cookies.get(OAUTH_COOKIE)?.value);
  const code = query.get("code");
  if (!flow || flow.provider !== id || !code || !statesMatch(flow.state, query.get("state"))) {
    return done("/?error=state_mismatch");
  }

  try {
    const tokens = await provider.exchangeCode(code, flow.verifier);
    // Granular consent lets users untick scopes; without mail access we can't do anything.
    if (!provider.hasRequiredScope(tokens.scope)) return done("/?error=scope_missing");
    if (!tokens.refreshToken) return done("/?error=no_refresh_token");

    const { email } = await provider.fetchProfile(tokens.accessToken);
    await saveConnection({ provider: id, mailbox: email, refreshToken: tokens.refreshToken, scopes: tokens.scope });
    return done(`/?connected=${encodeURIComponent(email)}`);
  } catch (err) {
    console.error(`[ghost-hub] ${provider.label} OAuth callback failed:`, err instanceof OAuthError ? err.code : err);
    return done("/?error=exchange_failed");
  }
}
