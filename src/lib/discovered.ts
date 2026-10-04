import { desc, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { accounts } from "@/db/schema";
import { CATEGORY_RANK, type Category } from "./scan/classify";

export const CATEGORIES = Object.keys(CATEGORY_RANK).sort((a, b) => CATEGORY_RANK[b as Category] - CATEGORY_RANK[a as Category]) as Category[];

export function isCategory(v: string | undefined): v is Category {
  return v !== undefined && (CATEGORIES as string[]).includes(v);
}

const RANK_SQL = sql`(case ${accounts.category} when 'account' then 4 when 'subscription' then 3 when 'receipt' then 2 else 1 end)`;
const RANK_TO_CATEGORY: Record<number, Category> = { 4: "account", 3: "subscription", 2: "receipt", 1: "newsletter" };

export type DiscoveredService = {
  domain: string;
  name: string;
  category: Category;
  messages: number;
  firstSeen: Date;
  lastSeen: Date;
  mailboxes: number;
};

/** Services found across every connected mailbox, one row per domain, strongest evidence first. */
export async function listDiscovered(category?: Category, limit = 300): Promise<DiscoveredService[]> {
  const rank = sql<number>`max(${RANK_SQL})::int`;
  const rows = await getDb()
    .select({
      domain: accounts.domain,
      name: sql<string>`min(${accounts.name})`,
      rank,
      messages: sql<number>`sum(${accounts.messageCount})::int`,
      firstSeen: sql<Date>`min(${accounts.firstSeen})`,
      lastSeen: sql<Date>`max(${accounts.lastSeen})`,
      mailboxes: sql<number>`count(distinct ${accounts.mailbox})::int`,
    })
    .from(accounts)
    .groupBy(accounts.domain)
    .having(category ? sql`max(${RANK_SQL}) = ${CATEGORY_RANK[category]}` : undefined)
    .orderBy(desc(rank), desc(sql`sum(${accounts.messageCount})`))
    .limit(limit);

  return rows.map((r) => ({
    domain: r.domain,
    name: r.name,
    category: RANK_TO_CATEGORY[r.rank],
    messages: r.messages,
    firstSeen: new Date(r.firstSeen),
    lastSeen: new Date(r.lastSeen),
    mailboxes: r.mailboxes,
  }));
}

/** How many distinct services fall in each category. */
export async function discoveredCounts(): Promise<Record<Category, number>> {
  const rows = await getDb()
    .select({ rank: sql<number>`max(${RANK_SQL})::int` })
    .from(accounts)
    .groupBy(accounts.domain);
  const counts: Record<Category, number> = { account: 0, subscription: 0, receipt: 0, newsletter: 0 };
  for (const r of rows) counts[RANK_TO_CATEGORY[r.rank]]++;
  return counts;
}
