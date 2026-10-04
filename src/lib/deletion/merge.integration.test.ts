import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/** Runs against a real Postgres. Skipped unless TEST_DATABASE_URL is set. */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("companies that email from several domains (integration)", () => {
  let store: typeof import("./store");
  let dash: typeof import("../dashboard");
  let schema: typeof import("@/db/schema");
  let db: ReturnType<typeof import("@/db").getDb>;
  const A = "a@gmail.com";
  const B = "b@gmail.com";
  const NOW = new Date("2026-06-01T00:00:00Z");

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.ADMIN_PASSWORD = "correct-horse";
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    db = (await import("@/db")).getDb();
    await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
    schema = await import("@/db/schema");
    store = await import("./store");
    dash = await import("../dashboard");
  });

  const wipe = async () => {
    for (const t of [schema.actions, schema.accounts, schema.messagesSeen, schema.scans, schema.mailboxConnections, schema.breaches, schema.mailboxBreaches]) await db.delete(t);
  };
  beforeEach(wipe);
  afterAll(wipe);

  async function seed(mailbox: string, domain: string, o: Partial<typeof schema.accounts.$inferInsert> = {}) {
    await db.insert(schema.accounts).values({
      mailbox, domain, name: domain, category: "account", firstSeen: new Date("2020-01-01"), lastSeen: new Date("2026-05-01"), messageCount: 5, ...o,
    });
  }
  const status = async (domain: string) => (await db.select().from(schema.accounts).where(eq(schema.accounts.domain, domain))).map((r) => r.status);

  it("shows one row per company, led by its busiest domain, with the totals added up", async () => {
    await seed(A, "amazon.com", { name: "Amazon", messageCount: 30, firstSeen: new Date("2021-03-01"), lastSeen: new Date("2026-04-01"), category: "receipt" });
    await seed(A, "amazon.co.uk", { name: "Amazon UK", messageCount: 10, firstSeen: new Date("2018-02-01"), lastSeen: new Date("2026-05-20"), category: "account" });
    await seed(B, "amazon.de", { name: "Amazon DE", messageCount: 2 });
    await seed(A, "github.com", { name: "GitHub" });

    const all = await dash.loadServices(NOW);
    expect(all.map((s) => s.domain).sort()).toEqual(["amazon.com", "github.com"]);
    const amazon = all.find((s) => s.domain === "amazon.com")!;
    expect(amazon).toMatchObject({ name: "Amazon", messages: 42, category: "account", mailboxes: 1, state: "active" });
    expect(amazon.domains).toEqual(["amazon.com", "amazon.co.uk", "amazon.de"]);
    expect(amazon.firstSeen.toISOString()).toBe("2018-02-01T00:00:00.000Z");
    expect(amazon.lastSeen.toISOString()).toBe("2026-05-20T00:00:00.000Z");
    expect(all.find((s) => s.domain === "github.com")!.domains).toEqual(["github.com"]);
    expect(dash.summarize(all).total).toBe(2);
  });

  it("counts a breach once even when two of the company's domains point at it", async () => {
    await seed(A, "amazon.com");
    await seed(A, "amazon.co.uk");
    await db.insert(schema.breaches).values([
      { name: "AmazonLeak", title: "Amazon Leak", domain: "amazon.com", breachDate: "2019-01-01", pwnCount: 10, dataClasses: ["Email addresses"], isVerified: true, fetchedAt: NOW },
      { name: "AmazonUkLeak", title: "Amazon UK Leak", domain: "amazon.co.uk", breachDate: "2020-01-01", pwnCount: 10, dataClasses: ["Passwords"], isVerified: true, fetchedAt: NOW },
      { name: "AmazonLeak2", title: "Same name again", domain: "amazon.co.uk", breachDate: "2021-01-01", pwnCount: 10, dataClasses: ["Passwords"], isVerified: true, fetchedAt: NOW },
    ]);
    const [amazon] = await dash.loadServices(NOW);
    expect(amazon.risk.breaches.map((b) => b.name).sort()).toEqual(["AmazonLeak", "AmazonLeak2", "AmazonUkLeak"]);
    expect(new Set(amazon.risk.breaches.map((b) => b.name)).size).toBe(3);
  });

  it("recording a deletion applies to every domain of the company, with an audit row for each", async () => {
    await seed(A, "amazon.com");
    await seed(B, "amazon.co.uk");
    await seed(A, "github.com");
    const [amazon] = (await dash.loadServices(NOW)).filter((s) => s.domains.includes("amazon.com"));

    expect(await store.setServiceStatuses(amazon.domains, "deleted", NOW)).toBe(2);
    expect(await status("amazon.com")).toEqual(["deleted"]);
    expect(await status("amazon.co.uk")).toEqual(["deleted"]);
    expect(await status("github.com")).toEqual(["active"]); // untouched

    const merged = (await dash.loadServices(NOW)).find((s) => s.domains.includes("amazon.com"))!;
    expect(merged.state).toBe("deleted");
    expect(merged.deletedAt?.getTime()).toBe(NOW.getTime());
    expect((await db.select().from(schema.actions)).map((a) => a.targetId).sort()).toEqual(["amazon.co.uk", "amazon.com"]);
    expect(dash.filterServices(await dash.loadServices(NOW), { show: "active" }).map((s) => s.domain)).toEqual(["github.com"]);
    expect(dash.decisionCounts(await dash.loadServices(NOW))).toEqual({ active: 1, deleted: 1, kept: 0, stillEmailing: 0 });

    expect(await store.setServiceStatuses(merged.domains, "active", NOW)).toBe(2);
    expect((await dash.loadServices(NOW)).every((s) => s.state === "active")).toBe(true);
  });

  it("a company where only some domains were deleted still reads as active, and flags the later email", async () => {
    await seed(A, "amazon.com", { lastSeen: new Date("2026-05-20") });
    await seed(A, "amazon.co.uk", { lastSeen: new Date("2026-05-25") });
    await store.setServiceStatus("amazon.com", "deleted", new Date("2026-05-01"));
    const [amazon] = await dash.loadServices(NOW);
    expect(amazon.state).toBe("active"); // not everything was deleted
    expect(amazon.stillEmailing).toBe(false);

    await store.setServiceStatus("amazon.co.uk", "deleted", new Date("2026-05-02"));
    const [both] = await dash.loadServices(NOW);
    expect(both.state).toBe("deleted");
    expect(both.stillEmailing).toBe(true); // mail arrived on 20 and 25 May, well after 2 May
  });

  it("refuses a request with any invalid domain, applying none of it", async () => {
    await seed(A, "amazon.com");
    expect(await store.setServiceStatuses(["amazon.com", "not a domain"], "deleted", NOW)).toBe(0);
    expect(await store.setServiceStatuses(["amazon.com", "x'; drop table accounts;--"], "deleted", NOW)).toBe(0);
    expect(await store.setServiceStatuses([], "deleted", NOW)).toBe(0);
    expect(await store.setServiceStatuses(Array.from({ length: 51 }, (_, i) => `d${i}.com`), "deleted", NOW)).toBe(0);
    expect(await store.setServiceStatuses("amazon.com" as unknown as string[], "deleted", NOW)).toBe(0);
    expect(await status("amazon.com")).toEqual(["active"]);
    expect(await db.select().from(schema.actions)).toHaveLength(0);
  });

  it("keeping a company hides all of its domains", async () => {
    await seed(A, "microsoft.com");
    await seed(A, "xbox.com");
    await store.setServiceStatuses(["microsoft.com", "xbox.com"], "ignored", NOW);
    const all = await dash.loadServices(NOW);
    expect(all).toHaveLength(1);
    expect(all[0].state).toBe("ignored");
    expect(dash.filterServices(all, { show: "kept" })).toHaveLength(1);
  });
});
