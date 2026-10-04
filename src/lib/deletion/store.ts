import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { accounts, actions } from "@/db/schema";

export type ServiceStatus = "active" | "deleted" | "ignored";

// A registrable domain such as `example.co.uk`. Anything else is refused before it reaches the database.
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const KIND_DELETE = "delete_account";
const KIND_RESTORE = "restore_account";

/**
 * Record what the user decided about a service: they deleted the account, want to keep it (hide it from cleanup), or
 * are putting it back. Applies to that domain in every connected mailbox. Ghost-Hub never deletes anything itself, so
 * "deleted" is the user's word and an audit row says so. Returns false if no such service exists.
 */
export async function setServiceStatus(domain: string, status: ServiceStatus, now = new Date()): Promise<boolean> {
  return (await setServiceStatuses([domain], status, now)) > 0;
}

/** The most domains one request may name: a company's merged domains, never a bulk operation. */
export const MAX_DOMAINS = 50;

/**
 * Same as `setServiceStatus` for a company that emails from several domains, in one transaction. Every name is
 * validated; any invalid one rejects the whole request (returns 0) rather than applying part of it. Returns how many
 * of the named domains exist and were updated.
 */
export async function setServiceStatuses(domains: string[], status: ServiceStatus, now = new Date()): Promise<number> {
  if (!Array.isArray(domains)) return 0;
  const wanted = [...new Set(domains.map((d) => (typeof d === "string" ? d.trim().toLowerCase() : "")))];
  if (wanted.length === 0 || wanted.length > MAX_DOMAINS || !wanted.every((d) => DOMAIN.test(d))) return 0;
  return getDb().transaction(async (tx) => {
    let updated = 0;
    for (const d of wanted) {
      const rows = await tx
        .update(accounts)
        .set({ status, deletedAt: status === "deleted" ? now : null })
        .where(eq(accounts.domain, d))
        .returning({ id: accounts.id });
      if (rows.length === 0) continue;
      updated++;

      if (status === "deleted" || status === "active") {
        await tx.insert(actions).values({
          kind: status === "deleted" ? KIND_DELETE : KIND_RESTORE,
          targetType: "account",
          targetId: d,
          status: "executed",
          decidedAt: now,
          executedAt: now,
          details: { method: "manual", message: status === "deleted" ? "Marked as deleted by you." : "Put back on your list by you." },
        });
      }
    }
    return updated;
  });
}

/** Audit rows for a service's decisions, newest first. */
export async function auditFor(domain: string) {
  return getDb()
    .select()
    .from(actions)
    .where(and(eq(actions.targetType, "account"), eq(actions.targetId, domain.toLowerCase())));
}
