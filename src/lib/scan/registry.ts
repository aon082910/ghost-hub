import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { scans } from "@/db/schema";
import { ensureFreshCatalog } from "../breaches/store";
import { ensureSettingsLoaded } from "../settings";
import { describeScanError, runScan } from "./engine";
import { createSource } from "./sources";

type Running = { scanId: string; controller: AbortController };

// One scan per mailbox at a time. Kept on globalThis so dev hot reloads don't lose track of running scans.
const g = globalThis as unknown as { __ghostHubScans?: Map<string, Running> };
const running = () => (g.__ghostHubScans ??= new Map());

/**
 * Start a scan in the background and return immediately. If this mailbox is already being scanned,
 * returns the running scan instead of starting a second one.
 */
export async function startScan(mailbox: string, opts: { since?: Date; includeJunk?: boolean } = {}): Promise<{ scanId: string; alreadyRunning: boolean }> {
  const existing = running().get(mailbox);
  if (existing) return { scanId: existing.scanId, alreadyRunning: true };

  // Claim the slot synchronously, before any await, so two quick clicks can't both start a scan.
  const entry: Running = { scanId: randomUUID(), controller: new AbortController() };
  running().set(mailbox, entry);

  try {
    await getDb().insert(scans).values({ id: entry.scanId, mailbox, since: opts.since ?? null, includeJunk: opts.includeJunk ?? false });
  } catch (err) {
    running().delete(mailbox);
    throw err;
  }

  void (async () => {
    try {
      await ensureSettingsLoaded();
      const source = await createSource(mailbox);
      const outcome = await runScan({ scanId: entry.scanId, mailbox, source, signal: entry.controller.signal, since: opts.since, includeJunk: opts.includeJunk });
      // New services were just found, so make sure there's a recent breach list to score them against.
      if (outcome === "done") void ensureFreshCatalog();
    } catch (err) {
      // createSource failed (e.g. credential can't be decrypted); runScan handles its own failures.
      await getDb()
        .update(scans)
        .set({ status: "failed", error: describeScanError(err), finishedAt: new Date() })
        .where(eq(scans.id, entry.scanId))
        .catch(() => {});
    } finally {
      running().delete(mailbox);
    }
  })();

  return { scanId: entry.scanId, alreadyRunning: false };
}

/** Ask the running scan for this mailbox to stop after its current page. */
export function cancelScan(mailbox: string): boolean {
  const r = running().get(mailbox);
  r?.controller.abort();
  return Boolean(r);
}

export function isScanning(mailbox: string): boolean {
  return running().has(mailbox);
}

/** Scans left "running" by a crash or restart can never finish; mark them so they don't spin forever. */
export async function markInterruptedScans() {
  await getDb()
    .update(scans)
    .set({
      status: "failed",
      error: "Interrupted by a restart. Scan again to continue where it left off.",
      finishedAt: new Date(),
    })
    .where(eq(scans.status, "running"));
}

/** Latest scan per mailbox, for the UI. */
export async function latestScan(mailbox: string): Promise<typeof scans.$inferSelect | null> {
  const [row] = await getDb()
    .select()
    .from(scans)
    .where(and(eq(scans.mailbox, mailbox)))
    .orderBy(desc(scans.startedAt))
    .limit(1);
  return row ?? null;
}
