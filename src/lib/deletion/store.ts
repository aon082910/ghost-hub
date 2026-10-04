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
  const d = domain.trim().toLowerCase();
  if (!DOMAIN.test(d)) return false;
  return getDb().transaction(async (tx) => {
    const rows = await tx
      .update(accounts)
      .set({ status, deletedAt: status === "deleted" ? now : null })
      .where(eq(accounts.domain, d))
      .returning({ id: accounts.id });
    if (rows.length === 0) return false;

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
    return true;
  });
}

/** Audit rows for a service's decisions, newest first. */
export async function auditFor(domain: string) {
  return getDb()
    .select()
    .from(actions)
    .where(and(eq(actions.targetType, "account"), eq(actions.targetId, domain.toLowerCase())));
}
