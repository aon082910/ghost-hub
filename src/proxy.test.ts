import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "./lib/env";
import { SESSION_COOKIE, createSessionToken } from "./lib/session";
import { PUBLIC_PATHS, config, proxy } from "./proxy";

beforeEach(() => {
  process.env.ADMIN_PASSWORD = "correct-horse-battery";
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.DATABASE_URL = "postgres://x:y@localhost:5432/z";
  process.env.APP_URL = "http://localhost:3000";
  resetEnvCache();
});

const req = (path: string, cookie?: string) =>
  new NextRequest(`http://localhost:3000${path}`, { headers: cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {} });
const passesThrough = (res: Response) => res.headers.get("x-middleware-next") === "1";

describe("the sign-in gate", () => {
  it("lets the login page, the health check and robots.txt through while signed out", () => {
    expect(PUBLIC_PATHS).toEqual(["/login", "/api/health", "/robots.txt"]);
    for (const p of PUBLIC_PATHS) expect(passesThrough(proxy(req(p))), p).toBe(true);
  });

  it("sends signed-out browsers to the login page", () => {
    for (const p of ["/", "/dashboard", "/newsletters", "/newsletters/review", "/profiles", "/some/other/page"]) {
      const res = proxy(req(p));
      expect(res.status, p).toBe(307);
      expect(new URL(res.headers.get("location")!).pathname, p).toBe("/login");
    }
  });

  it("answers signed-out API calls with 401 JSON, never a redirect", async () => {
    for (const p of ["/api/scans/00000000-0000-0000-0000-000000000000", "/api/profiles/progress", "/api/auth/google/start", "/api/auth/microsoft/callback"]) {
      const res = proxy(req(p));
      expect(res.status, p).toBe(401);
      expect(await res.json(), p).toEqual({ error: "Unauthorized" });
    }
  });

  it("lets a valid session through to everything", () => {
    const token = createSessionToken();
    for (const p of ["/", "/dashboard", "/api/profiles/progress", "/api/auth/google/start"]) expect(passesThrough(proxy(req(p, token))), p).toBe(true);
  });

  it("rejects forged, expired and malformed session cookies", () => {
    const [exp, sig] = createSessionToken().split(".");
    for (const bad of ["", "garbage", `${exp}.${sig}x`, `${Number(exp) + 9999}.${sig}`, `1.${sig}`, `${exp}`]) {
      expect(proxy(req("/dashboard", bad)).status, JSON.stringify(bad)).toBe(307);
    }
  });

  it("doesn't treat look-alike paths as public", () => {
    for (const p of ["/login/", "/login/x", "/robots.txt/x", "/api/health/x", "/Login", "/api/healthz", "/robots.txt.bak"]) {
      expect(passesThrough(proxy(req(p))), p).toBe(false);
    }
  });

  it("only skips the gate for static files and images", () => {
    const re = new RegExp(`^${config.matcher[0].replace(/\(\?!/, "(?!").replace(/\\\\/g, "\\")}$`);
    const gated = (p: string) => re.test(p);
    for (const p of ["/", "/dashboard", "/robots.txt", "/api/health", "/login", "/newsletters/review"]) expect(gated(p), p).toBe(true);
    for (const p of ["/_next/static/chunk.js", "/_next/image", "/icon.png", "/apple-icon.png", "/logo.svg"]) expect(gated(p), p).toBe(false);
  });
});
