import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";

// robots.txt must be readable while signed out, or crawlers would be redirected to the login page instead of told to stay away.
export const PUBLIC_PATHS = ["/login", "/api/health", "/robots.txt"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PATHS.includes(pathname)) return NextResponse.next();

  if (verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();

  // API callers get a 401; browsers get sent to the login page.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
