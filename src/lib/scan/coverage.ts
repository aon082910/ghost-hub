import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { scans } from "@/db/schema";

export type Coverage =
  /** A full scan finished: everything Ghost-Hub knows about this mailbox is complete. */
  | { kind: "complete" }
  /** Only recent mail has been scanned (from `since`). */
  | { kind: "limited"; since: Date }
  /** A full scan started but never finished (cancelled, failed or interrupted). */
  | { kind: "unfinished" }
  | { kind: "none" };

type ScanRow = { status: string; since: Date | null; messagesProcessed: number };

/** What a mailbox's scan history says about how much of it has been read. Pure, so it's easy to test. */
export function coverageOf(history: ScanRow[]): Coverage {
  if (history.some((s) => s.status === "done" && s.since === null)) return { kind: "complete" };
  const limited = history.filter((s) => s.status === "done" && s.since !== null);
  if (limited.length) {
    // Several limited scans: the widest reach is what's been covered.
    return { kind: "limited", since: new Date(Math.min(...limited.map((s) => s.since!.getTime()))) };
  }
  if (history.some((s) => s.messagesProcessed > 0)) return { kind: "unfinished" };
  return { kind: "none" };
}

/** Coverage for every mailbox that's been scanned at all. */
export async function loadCoverage(): Promise<Map<string, Coverage>> {
  const rows = await getDb()
    .select({ mailbox: scans.mailbox, status: scans.status, since: scans.since, messagesProcessed: scans.messagesProcessed })
    .from(scans)
    .orderBy(desc(scans.startedAt));
  const byMailbox = new Map<string, ScanRow[]>();
  for (const r of rows) {
    const list = byMailbox.get(r.mailbox) ?? [];
    list.push(r);
    byMailbox.set(r.mailbox, list);
  }
  return new Map([...byMailbox].map(([mailbox, history]) => [mailbox, coverageOf(history)]));
}

export async function coverageFor(mailbox: string): Promise<Coverage> {
  const history = await getDb()
    .select({ status: scans.status, since: scans.since, messagesProcessed: scans.messagesProcessed })
    .from(scans)
    .where(eq(scans.mailbox, mailbox));
  return coverageOf(history);
}
