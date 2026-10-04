import { and, asc, eq, inArray, like, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { mailboxConnections, profileIdentifiers, shadowProfiles } from "@/db/schema";
import type { CheckResult, GravatarResult } from "./check";
import { isValidUsername } from "./sites";

/** A small cap: this is for your own handles, not for looking people up. */
export const MAX_USERNAMES = 10;
const USERNAME = "username";
const EMAIL = "email";
const LINKED = "linked:";

export type AddResult = { ok: true; value: string } | { ok: false; code: "invalid" | "limit" | "duplicate"; error: string };

/** Usernames are compared case-insensitively, so they're stored lowercase and without a leading @. */
export const normalizeUsername = (raw: string) => raw.trim().replace(/^@/, "").toLowerCase();

export async function addUsername(raw: string): Promise<AddResult> {
  const value = normalizeUsername(raw);
  if (!isValidUsername(value)) {
    return { ok: false, code: "invalid", error: "Use 1-40 letters, numbers, dots, dashes or underscores." };
  }
  const db = getDb();
  const existing = await db.select({ id: profileIdentifiers.id }).from(profileIdentifiers).where(eq(profileIdentifiers.type, USERNAME));
  if (existing.length >= MAX_USERNAMES) return { ok: false, code: "limit", error: `You can add up to ${MAX_USERNAMES} usernames. Remove one first.` };
  const inserted = await db.insert(profileIdentifiers).values({ type: USERNAME, value }).onConflictDoNothing().returning({ id: profileIdentifiers.id });
  return inserted.length ? { ok: true, value } : { ok: false, code: "duplicate", error: `${value} is already on your list.` };
}

/** Remove a username and everything found for it. */
export async function removeUsername(id: string): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    const [row] = await tx.delete(profileIdentifiers).where(and(eq(profileIdentifiers.id, id), eq(profileIdentifiers.type, USERNAME))).returning();
    if (!row) return false;
    await tx.delete(shadowProfiles).where(and(eq(shadowProfiles.identifierType, USERNAME), eq(shadowProfiles.identifier, row.value)));
    return true;
  });
}

export async function connectedEmails(): Promise<string[]> {
  const rows = await getDb().selectDistinct({ mailbox: mailboxConnections.mailbox }).from(mailboxConnections).orderBy(asc(mailboxConnections.mailbox));
  return rows.map((r) => r.mailbox);
}

export async function listUsernames() {
  return getDb().select().from(profileIdentifiers).where(eq(profileIdentifiers.type, USERNAME)).orderBy(asc(profileIdentifiers.createdAt));
}

/** The part before the @ of each connected address, when it could be a username and isn't on the list yet. */
export async function suggestUsernames(): Promise<string[]> {
  const have = new Set((await listUsernames()).map((u) => u.value));
  const out = new Set<string>();
  for (const email of await connectedEmails()) {
    const local = email.split("@")[0].toLowerCase();
    if (isValidUsername(local) && !have.has(local)) out.add(local);
  }
  return [...out];
}

/**
 * Record one site's answer for a username. A failed check (blocked, timed out) never replaces an earlier real
 * answer, so a flaky site can't make a found profile disappear.
 */
export async function saveSiteResult(username: string, site: string, openUrl: string, r: CheckResult, now = new Date()) {
  const values = {
    identifierType: USERNAME,
    identifier: username,
    site,
    url: r.status === "found" ? (r.url ?? openUrl) : null,
    status: r.status,
    detail: r.detail ?? null,
    checkedAt: now,
  };
  const set = { url: values.url, status: values.status, detail: values.detail, checkedAt: now };
  const insert = getDb().insert(shadowProfiles).values(values);
  if (r.status === "error") {
    await insert.onConflictDoUpdate({
      target: [shadowProfiles.identifierType, shadowProfiles.identifier, shadowProfiles.site],
      set,
      setWhere: eq(shadowProfiles.status, "error"),
    });
  } else {
    await insert.onConflictDoUpdate({ target: [shadowProfiles.identifierType, shadowProfiles.identifier, shadowProfiles.site], set });
  }
}

/** Record Gravatar's answer for a connected address, replacing the accounts it linked last time. */
export async function saveGravatarResult(email: string, r: GravatarResult, now = new Date()) {
  await getDb().transaction(async (tx) => {
    const base = { identifierType: EMAIL, identifier: email, site: "gravatar", checkedAt: now };
    if (r.status === "error") {
      await tx
        .insert(shadowProfiles)
        .values({ ...base, status: "error", detail: r.detail })
        .onConflictDoUpdate({
          target: [shadowProfiles.identifierType, shadowProfiles.identifier, shadowProfiles.site],
          set: { status: "error", detail: r.detail, checkedAt: now },
          setWhere: eq(shadowProfiles.status, "error"),
        });
      return;
    }
    const row = r.status === "found" ? { status: "found", url: r.profileUrl, detail: null } : { status: "not_found", url: null, detail: null };
    await tx
      .insert(shadowProfiles)
      .values({ ...base, ...row })
      .onConflictDoUpdate({ target: [shadowProfiles.identifierType, shadowProfiles.identifier, shadowProfiles.site], set: { ...row, checkedAt: now } });

    await tx.delete(shadowProfiles).where(and(eq(shadowProfiles.identifierType, EMAIL), eq(shadowProfiles.identifier, email), like(shadowProfiles.site, `${LINKED}%`)));
    if (r.status === "found" && r.linked.length) {
      await tx.insert(shadowProfiles).values(
        r.linked.map((l, i) => ({
          ...base,
          site: `${LINKED}${l.service.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${i}`,
          status: "found",
          url: l.url,
          detail: l.service,
        })),
      );
    }
  });
}

/** When anything was last checked for each identifier, to enforce the cooldown. */
export async function lastChecked(type: "username" | "email", identifiers: string[]): Promise<Map<string, Date>> {
  if (!identifiers.length) return new Map();
  const rows = await getDb()
    .select({ identifier: shadowProfiles.identifier, at: sql<Date>`max(${shadowProfiles.checkedAt})` })
    .from(shadowProfiles)
    .where(and(eq(shadowProfiles.identifierType, type), inArray(shadowProfiles.identifier, identifiers)))
    .groupBy(shadowProfiles.identifier);
  return new Map(rows.map((r) => [r.identifier, new Date(r.at)]));
}

export type ProfileRow = typeof shadowProfiles.$inferSelect;

export async function loadResults(): Promise<ProfileRow[]> {
  return getDb().select().from(shadowProfiles).orderBy(asc(shadowProfiles.identifier), asc(shadowProfiles.site));
}

/** Remove what was found for a connected address (used when that mailbox's data is wiped). */
export async function deleteEmailResults(email: string) {
  await getDb().delete(shadowProfiles).where(and(eq(shadowProfiles.identifierType, EMAIL), eq(shadowProfiles.identifier, email)));
}
