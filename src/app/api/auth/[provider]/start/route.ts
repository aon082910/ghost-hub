import { NextResponse } from "next/server";
import { encrypt } from "@/lib/crypto";
import { getEnv } from "@/lib/env";
import { createPkce, createState, getOAuthProvider } from "@/lib/oauth";
import { OAUTH_COOKIE, OAUTH_COOKIE_MAX_AGE, OAUTH_COOKIE_PATH, appUrl } from "@/lib/oauth-flow";

export const dynamic = "force-dynamic";

/** Begin an OAuth flow. Requires a logged-in session (enforced by src/proxy.ts). */
export async function GET(_request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const provider = getOAuthProvider((await params).provider);
  if (!provider) return NextResponse.redirect(appUrl("/?error=unknown_provider"));
  if (!provider.isConfigured()) return NextResponse.redirect(appUrl("/?error=not_configured"));

  const state = createState();
  const { verifier, challenge } = createPkce();

  const res = NextResponse.redirect(provider.buildAuthUrl({ state, challenge }));
  res.cookies.set(OAUTH_COOKIE, encrypt(JSON.stringify({ provider: provider.id, state, verifier })), {
    httpOnly: true,
    sameSite: "lax", // must survive the top-level redirect back from the provider
    secure: getEnv().APP_URL.startsWith("https://"),
    path: OAUTH_COOKIE_PATH,
    maxAge: OAUTH_COOKIE_MAX_AGE,
  });
  return res;
}
