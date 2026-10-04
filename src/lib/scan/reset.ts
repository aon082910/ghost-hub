import { and, eq, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { accounts, messagesSeen, newsletters, scans } from "@/db/schema";
import { isScanning } from "./registry";

/**
 * Forget what past scans counted so the next scan recounts every message from scratch. Used when a mailbox's counts
 * should be rebuilt (for example to pick up what a newer version of Ghost-Hub records, like which mail was spam).
 *
 * The services and senders themselves stay, so what you decided about them (deleted, kept, unsubscribed) is not lost.
 * Their counts go to zero and are hidden until a scan finds them again. Returns false, changing nothing, while a scan
 * of this mailbox is running.
 */
export async function resetScanData(mailbox: string): Promise<boolean> {
  if (isScanning(mailbox)) return false;
  await getDb().transaction(async (tx) => {
    await tx.update(accounts).set({ messageCount: 0, spamCount: 0 }).where(eq(accounts.mailbox, mailbox));
    await tx.update(newsletters).set({ messageCount: 0, spamCount: 0 }).where(eq(newsletters.mailbox, mailbox));
    await tx.delete(messagesSeen).where(eq(messagesSeen.mailbox, mailbox));
    await tx.delete(scans).where(and(eq(scans.mailbox, mailbox), ne(scans.status, "running")));
  });
  return true;
}
