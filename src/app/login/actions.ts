"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getEnv } from "@/lib/env";
import { globalLoginLimiter, loginLimiter } from "@/lib/rate-limit";
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  checkAdminPassword,
  createSessionToken,
} from "@/lib/session";

export type LoginState = { error?: string };

async function clientKey() {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "local";
}

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const key = await clientKey();
  // Evaluate both so every attempt is counted against each limiter.
  const allowed = [loginLimiter.hit(key), globalLoginLimiter.hit("global")];
  if (!allowed.every(Boolean)) {
    return { error: "Too many attempts. Try again in 15 minutes." };
  }

  const password = formData.get("password");
  if (typeof password !== "string" || !checkAdminPassword(password)) {
    return { error: "Incorrect password." };
  }

  loginLimiter.reset(key);
  (await cookies()).set(SESSION_COOKIE, createSessionToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure: getEnv().APP_URL.startsWith("https://"),
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  redirect("/");
}

export async function logout() {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}
