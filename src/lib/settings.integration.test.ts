import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/** Runs against a real Postgres. Skipped unless TEST_DATABASE_URL is set. */
const url = process.env.TEST_DATABASE_URL;
const KEY_A = Buffer.alloc(32, 7).toString("base64");
const KEY_B = Buffer.alloc(32, 9).toString("base64");

describe.skipIf(!url)("saved settings (integration)", () => {
  let settings: typeof import("./settings");
  let config: typeof import("./config");
  let oauth: typeof import("./oauth");
  let envMod: typeof import("./env");
  let schema: typeof import("@/db/schema");
  let db: ReturnType<typeof import("@/db").getDb>;

  const setEnv = (extra: Record<string, string | undefined> = {}) => {
    process.env.DATABASE_URL = url;
    process.env.ADMIN_PASSWORD = "correct-horse-battery";
    process.env.ENCRYPTION_KEY = KEY_A;
    process.env.APP_URL = "http://localhost:3000";
    for (const k of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET", "MICROSOFT_TENANT", "HIBP_API_KEY", "HIBP_ENABLED"]) {
      delete process.env[k];
    }
    for (const [k, v] of Object.entries(extra)) if (v !== undefined) process.env[k] = v;
    envMod.resetEnvCache();
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.ADMIN_PASSWORD = "correct-horse-battery";
    process.env.ENCRYPTION_KEY = KEY_A;
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    db = (await import("@/db")).getDb();
    await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
    schema = await import("@/db/schema");
    settings = await import("./settings");
    config = await import("./config");
    oauth = await import("./oauth");
    envMod = await import("./env");
  });

  const wipe = async () => {
    await db.delete(schema.settings);
  };
  beforeEach(async () => {
    await wipe();
    setEnv();
    await settings.loadSettings();
  });
  afterAll(async () => {
    await wipe();
    setEnv();
  });

  it("saves, reloads and reads values back; a value is trimmed", async () => {
    await settings.saveSettings({ google_client_id: "  123.apps.googleusercontent.com  ", google_client_secret: "s3cret" });
    expect(settings.getSetting("google_client_id")).toBe("123.apps.googleusercontent.com");
    expect(settings.getSetting("google_client_secret")).toBe("s3cret");
    await settings.loadSettings(); // survives a reload from the database
    expect(settings.getSetting("google_client_secret")).toBe("s3cret");
  });

  it("stores secrets encrypted and plain values as they are", async () => {
    await settings.saveSettings({ google_client_id: "id-123", google_client_secret: "super-secret-value", hibp_api_key: "hibp-key-value" });
    const rows = Object.fromEntries((await db.select().from(schema.settings)).map((r) => [r.key, r.value]));
    expect(rows.google_client_id).toBe("id-123");
    expect(rows.google_client_secret).not.toContain("super-secret-value");
    expect(rows.hibp_api_key).not.toContain("hibp-key-value");
    expect(Buffer.from(rows.google_client_secret, "base64").length).toBeGreaterThan(28); // iv + tag + data
  });

  it("a saved value wins over the environment, and removing it brings the environment back", async () => {
    setEnv({ GOOGLE_CLIENT_ID: "env-id", GOOGLE_CLIENT_SECRET: "env-secret" });
    expect(config.googleConfig().clientId).toEqual({ value: "env-id", source: "env" });

    await settings.saveSettings({ google_client_id: "ui-id" });
    expect(config.googleConfig().clientId).toEqual({ value: "ui-id", source: "ui" });
    expect(config.googleCredentials()).toEqual({ clientId: "ui-id", clientSecret: "env-secret" }); // each field on its own

    await settings.saveSettings({ google_client_id: null });
    expect(config.googleConfig().clientId).toEqual({ value: "env-id", source: "env" });
  });

  it("reports nothing set when neither has a value", () => {
    expect(config.googleConfig().clientId).toEqual({ value: undefined, source: "none" });
    expect(config.googleCredentials()).toBeNull();
    expect(config.microsoftCredentials()).toBeNull();
  });

  it("lets the OAuth providers work from saved values alone", async () => {
    expect(oauth.OAUTH_PROVIDERS.google.isConfigured()).toBe(false);
    await settings.saveSettings({ google_client_id: "ui-google-id", google_client_secret: "ui-google-secret" });
    expect(oauth.OAUTH_PROVIDERS.google.isConfigured()).toBe(true);
    const authUrl = new URL(oauth.OAUTH_PROVIDERS.google.buildAuthUrl({ state: "s", challenge: "c" }));
    expect(authUrl.searchParams.get("client_id")).toBe("ui-google-id");
    expect(authUrl.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/auth/google/callback");

    expect(oauth.OAUTH_PROVIDERS.microsoft.isConfigured()).toBe(false);
    await settings.saveSettings({ microsoft_client_id: "ms-id", microsoft_client_secret: "ms-secret", microsoft_tenant: "consumers" });
    expect(oauth.OAUTH_PROVIDERS.microsoft.isConfigured()).toBe(true);
    const ms = new URL(oauth.OAUTH_PROVIDERS.microsoft.buildAuthUrl({ state: "s", challenge: "c" }));
    expect(ms.pathname).toContain("/consumers/");
    expect(ms.searchParams.get("client_id")).toBe("ms-id");
  });

  it("defaults the Microsoft tenant to common", async () => {
    expect(config.microsoftTenant()).toBe("common");
    await settings.saveSettings({ microsoft_tenant: "contoso.onmicrosoft.com" });
    expect(config.microsoftTenant()).toBe("contoso.onmicrosoft.com");
  });

  it("the Have I Been Pwned switch and key can be saved, and fall back to the environment", async () => {
    setEnv({ HIBP_API_KEY: "env-key" });
    expect(config.hibpEnabled()).toBe(true);
    expect(config.hibpApiKey()).toBe("env-key");
    await settings.saveSettings({ hibp_enabled: "false", hibp_api_key: "ui-key" });
    expect(config.hibpEnabled()).toBe(false);
    expect(config.hibpApiKey()).toBe("ui-key");
    await settings.saveSettings({ hibp_enabled: null, hibp_api_key: null });
    expect(config.hibpEnabled()).toBe(true);
    expect(config.hibpApiKey()).toBe("env-key");
  });

  it("refuses bad values and saves none of a batch that contains one", async () => {
    const bad: [string, string][] = [
      ["google_client_id", "has space"],
      ["google_client_id", "x".repeat(513)],
      ["google_client_secret", "line\nbreak"],
      ["microsoft_tenant", "not/valid"],
      ["microsoft_tenant", "../etc"],
      ["hibp_enabled", "maybe"],
      ["hibp_api_key", "tab\there"],
    ];
    for (const [key, value] of bad) {
      await expect(settings.saveSettings({ google_client_secret: "good-secret", [key]: value } as never), `${key}=${JSON.stringify(value).slice(0, 20)}`).rejects.toBeInstanceOf(settings.SettingsError);
    }
    await expect(settings.saveSettings({ google_client_id: "   " })).rejects.toBeInstanceOf(settings.SettingsError);
    expect(await db.select().from(schema.settings)).toHaveLength(0); // the good secret in each batch wasn't saved either
  });

  it("ignores keys it doesn't know, so the form can't write arbitrary rows", async () => {
    await settings.saveSettings({ admin_password: "x", google_client_id: "id" } as never);
    expect((await db.select().from(schema.settings)).map((r) => r.key)).toEqual(["google_client_id"]);
  });

  it("treats a secret saved under a different ENCRYPTION_KEY as unset and says so", async () => {
    await settings.saveSettings({ google_client_id: "id-1", google_client_secret: "secret-1" });
    process.env.ENCRYPTION_KEY = KEY_B;
    envMod.resetEnvCache();
    await settings.loadSettings();
    expect(settings.getSetting("google_client_secret")).toBeUndefined();
    expect(settings.isUnreadable("google_client_secret")).toBe(true);
    expect(settings.getSetting("google_client_id")).toBe("id-1"); // plain values are unaffected
    expect(config.googleCredentials()).toBeNull();

    // Entering it again fixes it.
    await settings.saveSettings({ google_client_secret: "secret-2" });
    expect(settings.isUnreadable("google_client_secret")).toBe(false);
    expect(config.googleCredentials()).toEqual({ clientId: "id-1", clientSecret: "secret-2" });
  });

  it("never returns a secret in anything the page is given", async () => {
    await settings.saveSettings({ google_client_secret: "top-secret-xyz" });
    // The page reads only `.value` of a secret to decide whether to show "Saved"; the field itself is always rendered empty.
    expect(JSON.stringify(Object.keys(config.googleConfig()))).not.toContain("top-secret-xyz");
    expect(settings.isSecretKey("google_client_secret")).toBe(true);
    expect(settings.isSecretKey("google_client_id")).toBe(false);
  });
});
