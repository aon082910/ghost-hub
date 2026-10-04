import { getEnv } from "./env";
import { getSetting, type SettingKey } from "./settings";

/** Where a value comes from: saved on the Settings page, the environment (.env / the container), or nowhere. */
export type Source = "ui" | "env" | "none";
export type Picked = { value: string | undefined; source: Source };

/** A saved setting wins over the environment. */
function pick(key: SettingKey, fromEnv: string | undefined): Picked {
  const saved = getSetting(key);
  if (saved !== undefined) return { value: saved, source: "ui" };
  if (fromEnv) return { value: fromEnv, source: "env" };
  return { value: undefined, source: "none" };
}

export function googleConfig() {
  const env = getEnv();
  return { clientId: pick("google_client_id", env.GOOGLE_CLIENT_ID), clientSecret: pick("google_client_secret", env.GOOGLE_CLIENT_SECRET) };
}

export function microsoftConfig() {
  const env = getEnv();
  return {
    clientId: pick("microsoft_client_id", env.MICROSOFT_CLIENT_ID),
    clientSecret: pick("microsoft_client_secret", env.MICROSOFT_CLIENT_SECRET),
    // The environment always has a value ("common" by default), so only a saved one counts as "ui".
    tenant: pick("microsoft_tenant", env.MICROSOFT_TENANT),
  };
}

export function hibpConfig() {
  const env = getEnv();
  const savedEnabled = getSetting("hibp_enabled");
  return {
    apiKey: pick("hibp_api_key", env.HIBP_API_KEY),
    enabled: savedEnabled !== undefined ? ({ value: savedEnabled === "true", source: "ui" } as const) : ({ value: env.HIBP_ENABLED, source: "env" } as const),
  };
}

export const googleCredentials = () => {
  const c = googleConfig();
  return c.clientId.value && c.clientSecret.value ? { clientId: c.clientId.value, clientSecret: c.clientSecret.value } : null;
};

export const microsoftCredentials = () => {
  const c = microsoftConfig();
  return c.clientId.value && c.clientSecret.value ? { clientId: c.clientId.value, clientSecret: c.clientSecret.value } : null;
};

export const microsoftTenant = () => microsoftConfig().tenant.value ?? "common";
export const hibpEnabled = () => hibpConfig().enabled.value;
export const hibpApiKey = () => hibpConfig().apiKey.value;
