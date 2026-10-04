import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { MailSource, MessageHeader, PagesOptions } from "./types";

/** Runs against a real Postgres. Skipped unless TEST_DATABASE_URL is set. */
const url = process.env.TEST_DATABASE_URL;
const ME = "me@gmail.com";

/** A mailbox that honours `since` the way a real source does, and records what it was asked. */
class WindowedSource implements MailSource {
  totalSince: Date | undefined | "unset" = "unset";
  pagesSince: Date | undefined | "unset" = "unset";
  constructor(private readonly all: MessageHeader[]) {}
  includeJunkSeen: boolean | undefined | "unset" = "unset";
  async total(since?: Date, includeJunk?: boolean) {
    this.totalSince = since;
    this.includeJunkSeen = includeJunk;
    return this.all.filter((m) => !since || m.date >= since).length;
  }
  pagesIncludeJunk: boolean | undefined | "unset" = "unset";
  async *pages({ skip, since, includeJunk }: PagesOptions) {
    this.pagesSince = since;
    this.pagesIncludeJunk = includeJunk;
    const wanted = this.all.filter((m) => (!since || m.date >= since) && !skip(m.id));
    if (wanted.length) yield wanted;
  }
  async close() {}
}

describe.skipIf(!url)("limited-depth scans (integration)", () => {
  let engine: typeof import("./engine");
  let coverage: typeof import("./coverage");
  let schema: typeof import("@/db/schema");
  let db: ReturnType<typeof import("@/db").getDb>;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.ADMIN_PASSWORD = "correct-horse-battery";
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    db = (await import("@/db")).getDb();
    await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
    schema = await import("@/db/schema");
    engine = await import("./engine");
    coverage = await import("./coverage");
  });

  const wipe = async () => {
    for (const t of [schema.accounts, schema.newsletters, schema.messagesSeen, schema.scans]) await db.delete(t);
  };
  beforeEach(wipe);
  afterAll(wipe);

  const msg = (id: string, date: string): MessageHeader => ({
    id, date: new Date(date), fromEmail: "hello@shop.com", fromName: "Shop", subject: "Welcome to Shop",
  });
  const ALL = [msg("old1", "2019-03-01"), msg("old2", "2021-05-05"), msg("new1", "2025-09-09"), msg("new2", "2026-02-02")];
  const SINCE = new Date("2024-01-01T00:00:00Z");

  async function scan(source: MailSource, since?: Date, includeJunk?: boolean) {
    const [row] = await db.insert(schema.scans).values({ mailbox: ME, since: since ?? null, includeJunk: includeJunk ?? false }).returning({ id: schema.scans.id });
    const outcome = await engine.runScan({ scanId: row.id, mailbox: ME, source, since, includeJunk });
    return { id: row.id, outcome };
  }
  const shop = async () => (await db.select().from(schema.accounts).where(eq(schema.accounts.domain, "shop.com")))[0];

  it("hands the date to the source for both the estimate and the pages, and records it on the scan", async () => {
    const source = new WindowedSource(ALL);
    const { id, outcome } = await scan(source, SINCE);
    expect(outcome).toBe("done");
    expect(source.totalSince).toEqual(SINCE);
    expect(source.pagesSince).toEqual(SINCE);
    const [row] = await db.select().from(schema.scans).where(eq(schema.scans.id, id));
    expect(row).toMatchObject({ since: SINCE, messagesTotal: 2, messagesProcessed: 2, status: "done" });
  });

  it("hands includeJunk to the source for both the estimate and the pages, and records it on the scan", async () => {
    const source = new WindowedSource(ALL);
    const { id } = await scan(source, undefined, true);
    expect(source.includeJunkSeen).toBe(true);
    expect(source.pagesIncludeJunk).toBe(true);
    const [row] = await db.select().from(schema.scans).where(eq(schema.scans.id, id));
    expect(row.includeJunk).toBe(true);

    const plain = new WindowedSource(ALL);
    const { id: id2 } = await scan(plain);
    expect(plain.pagesIncludeJunk).toBeFalsy();
    expect((await db.select().from(schema.scans).where(eq(schema.scans.id, id2)))[0].includeJunk).toBe(false);
  });

  it("a full scan passes no date", async () => {
    const source = new WindowedSource(ALL);
    await scan(source);
    expect(source.totalSince).toBeUndefined();
    expect(source.pagesSince).toBeUndefined();
  });

  it("only marks what it read as seen, so a later full scan completes the picture without double counting", async () => {
    await scan(new WindowedSource(ALL), SINCE);
    expect((await db.select().from(schema.messagesSeen)).map((r) => r.messageId).sort()).toEqual(["new1", "new2"]);
    let s = await shop();
    expect(s.messageCount).toBe(2);
    expect(s.firstSeen.toISOString()).toBe("2025-09-09T00:00:00.000Z"); // later than reality: that's the partial-scan caveat

    await scan(new WindowedSource(ALL)); // now everything
    s = await shop();
    expect(s.messageCount).toBe(4); // exact: the two recent messages weren't counted again
    expect(s.firstSeen.toISOString()).toBe("2019-03-01T00:00:00.000Z"); // corrected
    expect((await db.select().from(schema.messagesSeen)).length).toBe(4);
  });

  it("widening the window picks up only the extra mail", async () => {
    await scan(new WindowedSource(ALL), new Date("2025-01-01T00:00:00Z"));
    expect((await shop()).messageCount).toBe(2);
    await scan(new WindowedSource(ALL), new Date("2020-01-01T00:00:00Z"));
    expect((await shop()).messageCount).toBe(3); // old2 (2021) joined; old1 (2019) is still out of reach
  });

  it("coverage reflects the scan history stored in the database", async () => {
    expect((await coverage.coverageFor(ME)).kind).toBe("none");
    await scan(new WindowedSource(ALL), SINCE);
    expect(await coverage.coverageFor(ME)).toEqual({ kind: "limited", since: SINCE });
    expect((await coverage.loadCoverage()).get(ME)).toEqual({ kind: "limited", since: SINCE });
    await scan(new WindowedSource(ALL));
    expect(await coverage.coverageFor(ME)).toEqual({ kind: "complete" });
  });

  it("a cancelled full scan after a limited one still reads as limited", async () => {
    await scan(new WindowedSource(ALL), SINCE);
    const [row] = await db.insert(schema.scans).values({ mailbox: ME, status: "cancelled", messagesProcessed: 40 }).returning({ id: schema.scans.id });
    expect(row.id).toBeTruthy();
    expect(await coverage.coverageFor(ME)).toEqual({ kind: "limited", since: SINCE });
  });
});
