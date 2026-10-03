import { NextResponse } from "next/server";
import { encrypt } from "@/lib/crypto";
import { getEnv } from "@/lib/env";
import { buildAuthUrl, createPkce, createState, isGoogleConfigured } from "@/lib/google";
import { OAUTH_COOKIE, OAUTH_COOKIE_MAX_AGE, appUrl } from "@/lib/oauth-flow";

export const dynamic = "force-dynamic";

/** Begin the Google OAuth flow. Requires a logged-in session (enforced by src/proxy.ts). */
export async function GET() {
  if (!isGoogleConfigured()) return NextResponse.redirect(appUrl("/?error=not_configured"));

  const state = createState();
  const { verifier, challenge } = createPkce();

  const res = NextResponse.redirect(buildAuthUrl({ state, challenge }));
  res.cookies.set(OAUTH_COOKIE, encrypt(JSON.stringify({ state, verifier })), {
    httpOnly: true,
    sameSite: "lax", // must survive the top-level redirect back from Google
    secure: getEnv().APP_URL.startsWith("https://"),
    path: "/api/auth/google",
    maxAge: OAUTH_COOKIE_MAX_AGE,
  });
  return res;
}
