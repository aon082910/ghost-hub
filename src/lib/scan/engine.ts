import { eq, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { accounts, messagesSeen, newsletters, scans } from "@/db/schema";
import { OAuthError } from "../oauth";
import { CATEGORY_RANK, classify, serviceName, type Category } from "./classify";
import type { MailSource, MessageHeader } from "./types";

export type AccountAgg = { domain: string; name: string; category: Category; count: number; first: Date; last: Date };
export type NewsletterAgg = {
  senderEmail: string;
  senderName: string | null;
  domain: string;
  listUnsubscribe: string | null;
  oneClick: boolean;
  count: number;
  last: Date;
};

const MIN_PLAUSIBLE = Date.UTC(1990, 0, 1);

/** Messages with a missing or nonsense date count as "now" instead of corrupting first/last seen. */
function safeDate(d: Date, now: Date): Date {
  const t = d.getTime();
  return Number.isFinite(t) && t >= MIN_PLAUSIBLE && t <= now.getTime() + 86_400_000 ? d : now;
}

/** Collapse a batch of messages into per-service and per-newsletter totals. Pure, so it's easy to test. */
export function aggregate(headers: MessageHeader[], mailbox: string, now = new Date()) {
  const acc = new Map<string, AccountAgg>();
  const news = new Map<string, NewsletterAgg>();

  for (const h of headers) {
    const c = classify(h, mailbox);
    if (!c) continue;
    const date = safeDate(h.date, now);

    if (c.category) {
      const cur = acc.get(c.domain);
      if (!cur) {
        acc.set(c.domain, { domain: c.domain, name: c.name, category: c.category, count: 1, first: date, last: date });
      } else {
        cur.count++;
        if (CATEGORY_RANK[c.category] > CATEGORY_RANK[cur.category]) cur.category = c.category;
        if (date < cur.first) cur.first = date;
        if (date > cur.last) cur.last = date;
        // Prefer a name that reflects the sender's own casing over the plain title-cased domain.
        if (cur.name === serviceName(c.domain, null) && c.name !== cur.name) cur.name = c.name;
      }
    }

    if (c.newsletter) {
      const n = c.newsletter;
      const cur = news.get(n.senderEmail);
      if (!cur) {
        news.set(n.senderEmail, { ...n, domain: c.domain, count: 1, last: date });
      } else {
        cur.count++;
        // Newest message's unsubscribe info wins.
        if (date >= cur.last) {
          cur.last = date;
          if (n.listUnsubscribe) {
            cur.listUnsubscribe = n.listUnsubscribe;
            cur.oneClick = n.oneClick;
          }
          cur.senderName = n.senderName ?? cur.senderName;
        } else if (!cur.listUnsubscribe && n.listUnsubscribe) {
          cur.listUnsubscribe = n.listUnsubscribe;
          cur.oneClick = n.oneClick;
        }
      }
    }
  }
  return { accounts: [...acc.values()], newsletters: [...news.values()] };
}

const rank = (col: SQL | SQL.Aliased) =>
  sql`(case ${col} when 'account' then 4 when 'subscription' then 3 when 'receipt' then 2 else 1 end)`;

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

/**
 * Save one page atomically: record which messages were seen and fold only the NEW ones into the totals.
 * Because both happen in one transaction, a crash can never leave a message counted but not marked
 * (double count on resume) or marked but not counted (silently lost).
 */
export async function savePage(tx: Tx, mailbox: string, page: MessageHeader[], now = new Date()) {
  if (!page.length) return;
  const inserted = await tx
    .insert(messagesSeen)
    .values(page.map((m) => ({ mailbox, messageId: m.id })))
    .onConflictDoNothing()
    .returning({ id: messagesSeen.messageId });
  const fresh = new Set(inserted.map((r) => r.id));
  const { accounts: accRows, newsletters: newsRows } = aggregate(
    page.filter((m) => fresh.has(m.id)),
    mailbox,
    now,
  );

  if (accRows.length) {
    await tx
      .insert(accounts)
      .values(
        accRows.map((a) => ({
          mailbox,
          domain: a.domain,
          name: a.name,
          category: a.category,
          firstSeen: a.first,
          lastSeen: a.last,
          messageCount: a.count,
        })),
      )
      .onConflictDoUpdate({
        target: [accounts.mailbox, accounts.domain],
        set: {
          messageCount: sql`${accounts.messageCount} + excluded.message_count`,
          firstSeen: sql`least(${accounts.firstSeen}, excluded.first_seen)`,
          lastSeen: sql`greatest(${accounts.lastSeen}, excluded.last_seen)`,
          category: sql`case when ${rank(sql`excluded.category`)} > ${rank(sql`${accounts.category}`)} then excluded.category else ${accounts.category} end`,
        },
      });
  }

  if (newsRows.length) {
    await tx
      .insert(newsletters)
      .values(
        newsRows.map((n) => ({
          mailbox,
          senderEmail: n.senderEmail,
          senderName: n.senderName,
          domain: n.domain,
          listUnsubscribe: n.listUnsubscribe,
          oneClick: n.oneClick,
          messageCount: n.count,
          lastSeen: n.last,
        })),
      )
      .onConflictDoUpdate({
        target: [newsletters.mailbox, newsletters.senderEmail],
        set: {
          messageCount: sql`${newsletters.messageCount} + excluded.message_count`,
          // Whichever side has the newer message supplies the unsubscribe link, falling back to the other.
          listUnsubscribe: sql`case when excluded.last_seen > ${newsletters.lastSeen} then coalesce(excluded.list_unsubscribe, ${newsletters.listUnsubscribe}) else coalesce(${newsletters.listUnsubscribe}, excluded.list_unsubscribe) end`,
          oneClick: sql`case when excluded.last_seen > ${newsletters.lastSeen} and excluded.list_unsubscribe is not null then excluded.one_click when ${newsletters.listUnsubscribe} is null then excluded.one_click else ${newsletters.oneClick} end`,
          senderName: sql`coalesce(excluded.sender_name, ${newsletters.senderName})`,
          lastSeen: sql`greatest(${newsletters.lastSeen}, excluded.last_seen)`,
        },
      });
  }
}

/** A short, user-facing reason a scan stopped. Never includes credentials. */
export function describeScanError(err: unknown): string {
  if (err instanceof OAuthError && err.code === "invalid_grant") {
    return "Your connection expired or was revoked. Reconnect this mailbox, then scan again.";
  }
  const e = err as { authenticationFailed?: boolean; code?: string; name?: string; message?: string };
  if (e?.name === "TimeoutError") return "The mail server took too long to respond. Try again; scanning continues where it stopped.";
  if (e?.authenticationFailed) return "The mail server rejected the saved login. Reconnect this mailbox with a new app password.";
  if (e?.code && /^(ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT)$/.test(e.code)) return "Couldn't reach the mail server. Try again in a moment.";
  const msg = e?.message ?? "Unknown error";
  return msg.length > 300 ? `${msg.slice(0, 300)}...` : msg;
}

export type RunScanInput = { scanId: string; mailbox: string; source: MailSource; signal?: AbortSignal };

/**
 * Run a scan to completion, cancellation or failure, recording progress in the `scans` row.
 * Safe to run again after any stop: already-seen messages are skipped, so it continues where it left off.
 */
export async function runScan({ scanId, mailbox, source, signal }: RunScanInput): Promise<"done" | "cancelled" | "failed"> {
  const db = getDb();
  const finish = (status: string, error: string | null = null) =>
    db.update(scans).set({ status, error, finishedAt: new Date() }).where(eq(scans.id, scanId));

  try {
    const seenRows = await db.select({ id: messagesSeen.messageId }).from(messagesSeen).where(eq(messagesSeen.mailbox, mailbox));
    const seen = new Set(seenRows.map((r) => r.id));

    const total = await source.total().catch(() => null);
    // Resumed scans start at the fraction already done instead of 0.
    await db.update(scans).set({ messagesTotal: total, messagesProcessed: Math.min(seen.size, total ?? seen.size) }).where(eq(scans.id, scanId));

    for await (const page of source.pages({ skip: (id) => seen.has(id), signal })) {
      signal?.throwIfAborted();
      await db.transaction(async (tx) => {
        await savePage(tx, mailbox, page);
        await tx
          .update(scans)
          .set({ messagesProcessed: sql`${scans.messagesProcessed} + ${page.length}` })
          .where(eq(scans.id, scanId));
      });
      for (const m of page) seen.add(m.id);
    }

    await finish("done");
    return "done";
  } catch (err) {
    if (signal?.aborted) {
      await finish("cancelled");
      return "cancelled";
    }
    await finish("failed", describeScanError(err));
    return "failed";
  } finally {
    await source.close().catch(() => {});
  }
}
