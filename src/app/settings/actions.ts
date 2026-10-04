"use server";

import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { googleConfig, microsoftConfig } from "@/lib/config";
import { SettingsError, ensureSettingsLoaded, saveSettings, type SettingKey } from "@/lib/settings";

const text = (v: FormDataEntryValue | null) => (typeof v === "string" ? v.trim() : "");

type Section = "google" | "microsoft" | "breach";

/** Save, then go back to the page with a banner. redirect() throws, so it must stay outside the try. */
async function apply(changes: Partial<Record<SettingKey, string | null>>, section: Section, done: "saved" | "removed" = "saved"): Promise<never> {
  try {
    await saveSettings(changes);
  } catch (err) {
    if (err instanceof SettingsError) redirect(`/settings?error=bad_${err.field}#${section}`);
    throw err;
  }
  redirect(`/settings?${done}=${section}#${section}`);
}

/** Server Actions are public POST endpoints, so each one re-checks the session. */
export async function saveGoogle(formData: FormData) {
  await requireSession();
  await ensureSettingsLoaded();
  const id = text(formData.get("clientId"));
  const secret = text(formData.get("clientSecret"));
  if (!id) redirect("/settings?error=missing_google_client_id#google");
  // A blank secret keeps the one already saved (or set in the environment).
  if (!secret && !googleConfig().clientSecret.value) redirect("/settings?error=missing_google_client_secret#google");
  await apply({ google_client_id: id, ...(secret ? { google_client_secret: secret } : {}) }, "google");
}

export async function removeGoogle() {
  await requireSession();
  await apply({ google_client_id: null, google_client_secret: null }, "google", "removed");
}

export async function saveMicrosoft(formData: FormData) {
  await requireSession();
  await ensureSettingsLoaded();
  const id = text(formData.get("clientId"));
  const secret = text(formData.get("clientSecret"));
  const tenant = text(formData.get("tenant")) || "common";
  if (!id) redirect("/settings?error=missing_microsoft_client_id#microsoft");
  if (!secret && !microsoftConfig().clientSecret.value) redirect("/settings?error=missing_microsoft_client_secret#microsoft");
  await apply({ microsoft_client_id: id, microsoft_tenant: tenant, ...(secret ? { microsoft_client_secret: secret } : {}) }, "microsoft");
}

export async function removeMicrosoft() {
  await requireSession();
  await apply({ microsoft_client_id: null, microsoft_client_secret: null, microsoft_tenant: null }, "microsoft", "removed");
}

export async function saveBreach(formData: FormData) {
  await requireSession();
  const key = text(formData.get("apiKey"));
  await apply({ hibp_enabled: formData.get("enabled") === "on" ? "true" : "false", ...(key ? { hibp_api_key: key } : {}) }, "breach");
}

/** Forget what was saved here, so the environment's values (or the defaults) apply again. */
export async function resetBreach() {
  await requireSession();
  await apply({ hibp_enabled: null, hibp_api_key: null }, "breach", "removed");
}
