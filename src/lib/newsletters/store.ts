import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { actions, newsletters } from "@/db/schema";
import { mapLimit } from "../scan/http";
import { chooseMethod, type UnsubscribeMethod } from "./headers";
import { unsubscribeOneClick, type Transport } from "./oneclick";
import { UnsafeUrlError, assertSafeUrl } from "./ssrf";

const KIND = "unsubscribe";
const TARGET = "newsletter";
const STILL_SENDING_AFTER_MS = 3 * 86_400_000;
const CONCURRENCY = 3;

export type NewsletterRow = {
  id: string;
  mailbox: string;
  senderEmail: string;
  senderName: string | null;
  domain: string;
  messageCount: number;
  lastSeen: Date;
  status: string;
  unsubscribedAt: Date | null;
  method: UnsubscribeMethod;
  /**
   * Why a web link is being withheld, when it points somewhere unsafe (inside the user's network, plain http, an IP
   * address...). Such links are neither requested automatically nor offered to open by hand.
   */
  blocked: string | null;
  /** Mail kept arriving after the unsubscribe request. */
  stillSending: boolean;
  /** Why the last automatic attempt failed, when it did. */
  lastError: string | null;
};

const rowMethod = (r: { listUnsubscribe: string | null; oneClick: boolean }) => chooseMethod(r.listUnsubscribe, r.oneClick);

/** The reason a method's web link is unsafe to use, or null if it's fine (or there's no web link). */
function blockedReason(m: UnsubscribeMethod): string | null {
  if (m.method !== "one-click" && m.method !== "link") return null;
  try {
    assertSafeUrl(m.url);
    return null;
  } catch (err) {
    if (err instanceof UnsafeUrlError) return err.message;
    throw err;
  }
}

/** Newsletter senders across all mailboxes, busiest first. */
export async function listNewsletters(): Promise<NewsletterRow[]> {
  const db = getDb();
  const rows = await db.select().from(newsletters).orderBy(desc(newsletters.messageCount), asc(newsletters.senderEmail));
  if (!rows.length) return [];

  // Latest automatic attempt per sender, to explain failures.
  const attempts = await db
    .select({ targetId: actions.targetId, status: actions.status, details: actions.details, createdAt: actions.createdAt })
    .from(actions)
    .where(and(eq(actions.kind, KIND), eq(actions.targetType, TARGET), inArray(actions.targetId, rows.map((r) => r.id))))
    .orderBy(desc(actions.createdAt));
  const latest = new Map<string, (typeof attempts)[number]>();
  for (const a of attempts) if (!latest.has(a.targetId)) latest.set(a.targetId, a);

  return rows.map((r) => {
    const last = latest.get(r.id);
    const method = rowMethod(r);
    return {
      id: r.id,
      mailbox: r.mailbox,
      senderEmail: r.senderEmail,
      senderName: r.senderName,
      domain: r.domain,
      messageCount: r.messageCount,
      lastSeen: r.lastSeen,
      status: r.status,
      unsubscribedAt: r.unsubscribedAt,
      method,
      blocked: blockedReason(method),
      stillSending:
        r.status === "unsubscribed" && r.unsubscribedAt !== null && r.lastSeen.getTime() > r.unsubscribedAt.getTime() + STILL_SENDING_AFTER_MS,
      lastError: r.status === "failed" && last?.status === "failed" ? ((last.details?.message as string | undefined) ?? null) : null,
    };
  });
}

export type QueueResult = { queued: number; skipped: { id: string; reason: string }[] };

/**
 * Stage senders for review. Nothing is sent. Only one-click senders qualify; everything else is the user's to do
 * by hand. Safe to call twice: a sender that's already waiting isn't added again.
 */
export async function queueUnsubscribes(ids: string[]): Promise<QueueResult> {
  const db = getDb();
  const unique = [...new Set(ids)];
  const result: QueueResult = { queued: 0, skipped: [] };
  if (!unique.length) return result;

  const rows = await db.select().from(newsletters).where(inArray(newsletters.id, unique));
  const waiting = new Set(
    (
      await db
        .select({ targetId: actions.targetId })
        .from(actions)
        .where(and(eq(actions.kind, KIND), eq(actions.targetType, TARGET), eq(actions.status, "pending"), inArray(actions.targetId, unique)))
    ).map((a) => a.targetId),
  );
  const byId = new Map(rows.map((r) => [r.id, r]));

  const toInsert: (typeof actions.$inferInsert)[] = [];
  for (const id of unique) {
    const r = byId.get(id);
    if (!r) result.skipped.push({ id, reason: "not found" });
    else if (r.status !== "subscribed" && r.status !== "failed") result.skipped.push({ id, reason: `already ${r.status}` });
    else if (waiting.has(id)) result.skipped.push({ id, reason: "already waiting for review" });
    else {
      const m = rowMethod(r);
      if (m.method !== "one-click") {
        result.skipped.push({ id, reason: "can't be unsubscribed automatically" });
        continue;
      }
      try {
        const url = assertSafeUrl(m.url);
        toInsert.push({ kind: KIND, targetType: TARGET, targetId: id, status: "pending", details: { method: "one-click", host: url.hostname } });
      } catch (err) {
        if (!(err instanceof UnsafeUrlError)) throw err;
        result.skipped.push({ id, reason: err.message });
      }
    }
  }
  if (toInsert.length) await db.insert(actions).values(toInsert);
  result.queued = toInsert.length;
  return result;
}

export type PendingItem = {
  actionId: string;
  newsletterId: string;
  mailbox: string;
  senderEmail: string;
  senderName: string | null;
  /** What Ghost-Hub would contact, shown so the user can see exactly where a request goes. */
  host: string;
  url: string;
  messageCount: number;
};

/** Everything waiting for approval, with the exact destination of each request. */
export async function listPending(): Promise<PendingItem[]> {
  const db = getDb();
  const pending = await db
    .select()
    .from(actions)
    .where(and(eq(actions.kind, KIND), eq(actions.targetType, TARGET), eq(actions.status, "pending")))
    .orderBy(asc(actions.createdAt));
  if (!pending.length) return [];
  const rows = await db.select().from(newsletters).where(inArray(newsletters.id, pending.map((p) => p.targetId)));
  const byId = new Map(rows.map((r) => [r.id, r]));

  const items: PendingItem[] = [];
  for (const p of pending) {
    const r = byId.get(p.targetId);
    const m = r ? rowMethod(r) : null;
    if (!r || m?.method !== "one-click") continue; // the sender changed or vanished since it was queued
    items.push({
      actionId: p.id,
      newsletterId: r.id,
      mailbox: r.mailbox,
      senderEmail: r.senderEmail,
      senderName: r.senderName,
      host: new URL(m.url).hostname,
      url: m.url,
      messageCount: r.messageCount,
    });
  }
  return items;
}

export type ApprovalResult = { succeeded: number; failed: number; results: { senderEmail: string; ok: boolean; message: string }[] };

/**
 * The user approved what's waiting. Each action is claimed with a single conditional UPDATE, so a double click or
 * two browser tabs can never send the same request twice. The request is built from the sender's stored header at
 * this moment, not from anything the browser submitted, and re-validated.
 */
export async function approvePending(opts: { actionIds?: string[]; transport?: Transport } = {}): Promise<ApprovalResult> {
  const db = getDb();
  const claimed = await db
    .update(actions)
    .set({ status: "approved", decidedAt: new Date() })
    .where(
      and(
        eq(actions.kind, KIND),
        eq(actions.targetType, TARGET),
        eq(actions.status, "pending"),
        opts.actionIds ? inArray(actions.id, opts.actionIds) : undefined,
      ),
    )
    .returning();

  const result: ApprovalResult = { succeeded: 0, failed: 0, results: [] };
  await mapLimit(claimed, CONCURRENCY, async (action) => {
    const [row] = await db.select().from(newsletters).where(eq(newsletters.id, action.targetId));
    const m = row ? rowMethod(row) : null;

    let ok = false;
    let message = "This sender no longer offers one-click unsubscribe.";
    let status: number | undefined;
    if (row && m?.method === "one-click") {
      const outcome = await unsubscribeOneClick(m.url, opts.transport);
      ok = outcome.ok;
      status = outcome.status;
      message = outcome.ok ? "Unsubscribed." : outcome.message;
    }

    await db
      .update(actions)
      .set({
        status: ok ? "executed" : "failed",
        executedAt: new Date(),
        details: { ...(action.details ?? {}), message, ...(status ? { httpStatus: status } : {}) },
      })
      .where(eq(actions.id, action.id));
    if (row) {
      await db
        .update(newsletters)
        .set(ok ? { status: "unsubscribed", unsubscribedAt: new Date() } : { status: "failed" })
        .where(eq(newsletters.id, row.id));
    }
    if (ok) result.succeeded++;
    else result.failed++;
    result.results.push({ senderEmail: row?.senderEmail ?? action.targetId, ok, message });
  });
  return result;
}

/** Take items off the review list without sending anything. With no ids, clears everything waiting. */
export async function rejectPending(actionIds?: string[]): Promise<number> {
  const rows = await getDb()
    .update(actions)
    .set({ status: "rejected", decidedAt: new Date() })
    .where(
      and(
        eq(actions.kind, KIND),
        eq(actions.targetType, TARGET),
        eq(actions.status, "pending"),
        actionIds ? inArray(actions.id, actionIds) : undefined,
      ),
    )
    .returning({ id: actions.id });
  return rows.length;
}

/** The user unsubscribed by hand (opened the link or sent the email themselves) and is recording it. */
export async function markUnsubscribedManually(id: string): Promise<boolean> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(newsletters)
      .set({ status: "unsubscribed", unsubscribedAt: new Date() })
      .where(and(eq(newsletters.id, id), inArray(newsletters.status, ["subscribed", "failed"])))
      .returning({ id: newsletters.id });
    if (!updated.length) return false;
    await tx.insert(actions).values({
      kind: KIND,
      targetType: TARGET,
      targetId: id,
      status: "executed",
      decidedAt: new Date(),
      executedAt: new Date(),
      details: { method: "manual", message: "Marked as unsubscribed by you." },
    });
    return true;
  });
}

/** "Keep" a newsletter (hide it from cleanup suggestions) or put it back. */
export async function setKept(id: string, kept: boolean): Promise<boolean> {
  const rows = await getDb()
    .update(newsletters)
    .set({ status: kept ? "ignored" : "subscribed" })
    .where(and(eq(newsletters.id, id), inArray(newsletters.status, kept ? ["subscribed", "failed"] : ["ignored"])))
    .returning({ id: newsletters.id });
  return rows.length > 0;
}
