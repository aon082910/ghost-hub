import { inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { settings } from "@/db/schema";
import { decrypt, encrypt } from "./crypto";

/**
 * Settings that used to live only in `.env`, editable from the Settings page. A value saved there wins over the
 * environment; removing it falls back to the environment, so existing Docker and Unraid setups keep working.
 * Secrets are encrypted at rest (AES-256-GCM, the same key as mailbox tokens) and never sent back to the browser.
 */
export const SETTING_KEYS = [
  "google_client_id",
  "google_client_secret",
  "microsoft_client_id",
  "microsoft_client_secret",
  "microsoft_tenant",
  "hibp_api_key",
  "hibp_enabled",
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

const SECRET_KEYS: ReadonlySet<SettingKey> = new Set(["google_client_secret", "microsoft_client_secret", "hibp_api_key"]);
export const isSecretKey = (k: SettingKey) => SECRET_KEYS.has(k);

export class SettingsError extends Error {
  constructor(
    public readonly field: SettingKey,
    message: string,
  ) {
    super(message);
    this.name = "SettingsError";
  }
}

type Store = { loaded: boolean; values: Map<SettingKey, string>; unreadable: Set<SettingKey> };
// On globalThis so every bundle in the server process sees one copy, and a dev hot reload doesn't drop it.
const g = globalThis as unknown as { __ghostHubSettings?: Store };
const store = (): Store => (g.__ghostHubSettings ??= { loaded: false, values: new Map(), unreadable: new Set() });

/** Read every saved setting into memory. Called at start-up and after each save. */
export async function loadSettings(): Promise<void> {
  const rows = await getDb().select().from(settings).where(inArray(settings.key, [...SETTING_KEYS]));
  const values = new Map<SettingKey, string>();
  const unreadable = new Set<SettingKey>();
  for (const r of rows) {
    const key = r.key as SettingKey;
    try {
      values.set(key, isSecretKey(key) ? decrypt(r.value) : r.value);
    } catch {
      // ENCRYPTION_KEY changed since this was saved. Treated as not set, and the page says to enter it again.
      unreadable.add(key);
    }
  }
  const s = store();
  s.values = values;
  s.unreadable = unreadable;
  s.loaded = true;
}

/** The saved value, or undefined if nothing is saved (or it couldn't be read). Synchronous: served from memory. */
export const getSetting = (key: SettingKey): string | undefined => store().values.get(key);

/** A value was saved but can't be decrypted with the current ENCRYPTION_KEY. */
export const isUnreadable = (key: SettingKey): boolean => store().unreadable.has(key);

export const settingsLoaded = () => store().loaded;

/** Load once if start-up hasn't (a safety net for entry points that can run before it, such as a hot reload in development). */
export async function ensureSettingsLoaded(): Promise<void> {
  if (!store().loaded) await loadSettings();
}

const hasBadChar = (v: string) => [...v].some((ch) => ch.codePointAt(0)! <= 0x20 || ch.codePointAt(0) === 0x7f);

/** What to tell the user when a saved value is refused. Also shown by the Settings page. */
export const BAD_VALUE: Record<SettingKey, string> = {
  google_client_id: "The client ID can't contain spaces and must be under 512 characters.",
  google_client_secret: "The client secret can't contain spaces and must be under 1024 characters.",
  microsoft_client_id: "The application (client) ID can't contain spaces and must be under 512 characters.",
  microsoft_client_secret: "The client secret can't contain spaces and must be under 1024 characters.",
  microsoft_tenant: "The tenant must be common, organizations, consumers, a tenant ID or a domain name.",
  hibp_api_key: "The Have I Been Pwned API key can't contain spaces and must be under 256 characters.",
  hibp_enabled: "Must be on or off.",
};

const plain = (max: number) => (v: string) => v.length <= max && !hasBadChar(v);

const VALID: Record<SettingKey, (v: string) => boolean> = {
  google_client_id: plain(512),
  google_client_secret: plain(1024),
  microsoft_client_id: plain(512),
  microsoft_client_secret: plain(1024),
  microsoft_tenant: (v) => /^[A-Za-z0-9.-]{1,128}$/.test(v),
  hibp_api_key: plain(256),
  hibp_enabled: (v) => v === "true" || v === "false",
};

/**
 * Save or remove settings. A string saves (after trimming and validating every one first, so a bad value saves
 * nothing), `null` removes the saved value so the environment applies again.
 */
export async function saveSettings(changes: Partial<Record<SettingKey, string | null>>): Promise<void> {
  const writes: { key: SettingKey; value: string }[] = [];
  const removals: SettingKey[] = [];
  for (const [k, raw] of Object.entries(changes) as [SettingKey, string | null | undefined][]) {
    if (!(SETTING_KEYS as readonly string[]).includes(k) || raw === undefined) continue;
    if (raw === null) {
      removals.push(k);
      continue;
    }
    const value = raw.trim();
    if (!value) throw new SettingsError(k, "A value is required.");
    if (!VALID[k](value)) throw new SettingsError(k, BAD_VALUE[k]);
    writes.push({ key: k, value });
  }

  await getDb().transaction(async (tx) => {
    for (const w of writes) {
      const value = isSecretKey(w.key) ? encrypt(w.value) : w.value;
      await tx.insert(settings).values({ key: w.key, value }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
    }
    if (removals.length) await tx.delete(settings).where(inArray(settings.key, removals));
  });
  await loadSettings();
}
