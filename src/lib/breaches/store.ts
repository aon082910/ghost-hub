import { eq, lt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { breachChecks, breaches, mailboxBreaches } from "@/db/schema";
import { chunk } from "../scan/http";
import { hibpApiKey, hibpEnabled as hibpEnabledSetting } from "../config";
import { findConnection } from "../mailboxes";
import { fetchCatalog, fetchMailboxBreaches, type Breach } from "./hibp";

export class HibpDisabledError extends Error {
  constructor() {
    super("Have I Been Pwned lookups are turned off in Settings");
    this.name = "HibpDisabledError";
  }
}
export class HibpKeyMissingError extends Error {
  constructor() {
    super("No Have I Been Pwned API key is saved in Settings");
    this.name = "HibpKeyMissingError";
  }
}

const STALE_MS = 7 * 86_400_000;

export const hibpEnabled = () => hibpEnabledSetting();
export const hibpKeyConfigured = () => Boolean(hibpApiKey());

type Deps = { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> };

/**
 * Download HIBP's public breach list and replace the stored copy. Nothing about the user is sent. Entries that
 * disappeared upstream are removed, but an empty or unusable response never wipes the stored list.
 */
export async function refreshCatalog(deps: Deps = {}): Promise<{ count: number }> {
  if (!hibpEnabled()) throw new HibpDisabledError();
  const { breaches: fresh } = await fetchCatalog(deps);
  if (fresh.length === 0) throw new Error("Have I Been Pwned returned no usable breaches; keeping the existing list");

  const started = new Date();
  await getDb().transaction(async (tx) => {
    for (const group of chunk(fresh, 200)) {
      await tx
        .insert(breaches)
        .values(
          group.map((b) => ({
            name: b.name,
            title: b.title,
            domain: b.domain,
            breachDate: b.breachDate,
            pwnCount: b.pwnCount,
            dataClasses: b.dataClasses,
            isVerified: b.isVerified,
            fetchedAt: started,
          })),
        )
        .onConflictDoUpdate({
          target: breaches.name,
          set: {
            title: sql`excluded.title`,
            domain: sql`excluded.domain`,
            breachDate: sql`excluded.breach_date`,
            pwnCount: sql`excluded.pwn_count`,
            dataClasses: sql`excluded.data_classes`,
            isVerified: sql`excluded.is_verified`,
            fetchedAt: started,
          },
        });
    }
    await tx.delete(breaches).where(lt(breaches.fetchedAt, started));
  });
  return { count: fresh.length };
}

export async function loadCatalog(): Promise<Breach[]> {
  const rows = await getDb().select().from(breaches);
  return rows
    .filter((r): r is typeof r & { domain: string } => r.domain !== null)
    .map((r) => ({
      name: r.name,
      title: r.title,
      domain: r.domain,
      breachDate: r.breachDate,
      pwnCount: r.pwnCount,
      dataClasses: r.dataClasses,
      isVerified: r.isVerified,
    }));
}

export type CatalogStatus = {
  enabled: boolean;
  keyConfigured: boolean;
  count: number;
  lastFetched: Date | null;
  stale: boolean;
};

export async function catalogStatus(now = new Date()): Promise<CatalogStatus> {
  const rows = await getDb().select({ at: breaches.fetchedAt }).from(breaches);
  const lastFetched = rows.reduce<Date | null>((m, r) => (!m || r.at > m ? r.at : m), null);
  return {
    enabled: hibpEnabled(),
    keyConfigured: hibpKeyConfigured(),
    count: rows.length,
    lastFetched,
    stale: !lastFetched || now.getTime() - lastFetched.getTime() > STALE_MS,
  };
}

/** Refresh the list if it's missing or a week old. Best effort: a failure never interrupts the caller. */
export async function ensureFreshCatalog(deps: Deps = {}): Promise<void> {
  try {
    if (!hibpEnabled()) return;
    if ((await catalogStatus()).stale) await refreshCatalog(deps);
  } catch (err) {
    console.warn("[ghost-hub] couldn't refresh the breach list:", err instanceof Error ? err.message : err);
  }
}

/**
 * Ask HIBP which breaches a connected mailbox address is in. This sends the address to HIBP and needs the user's
 * own API key, so it only runs on request.
 */
export async function checkMailboxBreaches(mailbox: string, deps: Deps = {}): Promise<{ breachCount: number }> {
  if (!hibpEnabled()) throw new HibpDisabledError();
  const key = hibpApiKey();
  if (!key) throw new HibpKeyMissingError();
  if (!(await findConnection(mailbox))) throw new Error(`No connection for ${mailbox}`);

  const names = [...new Set(await fetchMailboxBreaches(mailbox, key, deps))];
  await getDb().transaction(async (tx) => {
    await tx.delete(mailboxBreaches).where(eq(mailboxBreaches.mailbox, mailbox));
    if (names.length) await tx.insert(mailboxBreaches).values(names.map((breachName) => ({ mailbox, breachName })));
    await tx
      .insert(breachChecks)
      .values({ mailbox, breachCount: names.length, checkedAt: new Date() })
      .onConflictDoUpdate({ target: breachChecks.mailbox, set: { breachCount: names.length, checkedAt: new Date() } });
  });
  return { breachCount: names.length };
}

/** Names of breaches any connected mailbox address is known to be in. */
export async function loadConfirmedNames(): Promise<Set<string>> {
  const rows = await getDb().select({ name: mailboxBreaches.breachName }).from(mailboxBreaches);
  return new Set(rows.map((r) => r.name));
}

export async function loadChecks() {
  return new Map((await getDb().select().from(breachChecks)).map((c) => [c.mailbox, c]));
}
