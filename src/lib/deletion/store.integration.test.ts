import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { MailSource, MessageHeader, PagesOptions } from "../scan/types";

/** Runs against a real Postgres. Skipped unless TEST_DATABASE_URL is set. */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("account deletion decisions (integration)", () => {
  let store: typeof import("./store");
  let dash: typeof import("../dashboard");
  let engine: typeof import("../scan/engine");
  let mailboxes: typeof import("../mailboxes");
  let schema: typeof import("@/db/schema");
  let db: ReturnType<typeof import("@/db").getDb>;
  const A = "a@gmail.com";
  const B = "b@gmail.com";
  const NOW = new Date("2026-06-01T00:00:00Z");
  const DAY = 86_400_000;

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
    engine = await import("../scan/engine");
    mailboxes = await import("../mailboxes");
  });

  const wipe = async () => {
    for (const t of [schema.actions, schema.accounts, schema.messagesSeen, schema.scans, schema.mailboxConnections, schema.breaches, schema.mailboxBreaches]) await db.delete(t);
  };
  beforeEach(wipe);
  afterAll(wipe);

  async function seed(mailbox: string, domain: string, o: Partial<typeof schema.accounts.$inferInsert> = {}) {
    await db.insert(schema.accounts).values({
      mailbox, domain, name: domain.split(".")[0], category: "account", firstSeen: new Date("2020-01-01"), lastSeen: new Date("2026-05-01"), messageCount: 5, ...o,
    });
  }
  const rows = async (domain: string) => db.select().from(schema.accounts).where(eq(schema.accounts.domain, domain));
  const service = async (domain: string) => (await dash.loadServices(NOW)).find((s) => s.domain === domain)!;

  it("marks a service deleted in every mailbox, stamps the time, and keeps an audit row", async () => {
    await seed(A, "shop.com");
    await seed(B, "shop.com");
    await seed(A, "other.com");
    expect(await store.setServiceStatus("shop.com", "deleted", NOW)).toBe(true);

    const shop = await rows("shop.com");
    expect(shop.map((r) => r.status)).toEqual(["deleted", "deleted"]);
    expect(shop.every((r) => r.deletedAt?.getTime() === NOW.getTime())).toBe(true);
    expect((await rows("other.com"))[0]).toMatchObject({ status: "active", deletedAt: null }); // untouched

    const audit = await store.auditFor("shop.com");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ kind: "delete_account", status: "executed", details: { method: "manual" } });
  });

  it("restores a service (clearing the timestamp, with its own audit row) and 'keep' leaves no trail", async () => {
    await seed(A, "shop.com");
    await store.setServiceStatus("shop.com", "deleted", NOW);
    await store.setServiceStatus("shop.com", "active", NOW);
    expect((await rows("shop.com"))[0]).toMatchObject({ status: "active", deletedAt: null });
    expect((await store.auditFor("shop.com")).map((a) => a.kind).sort()).toEqual(["delete_account", "restore_account"]);

    await seed(A, "keepme.com");
    await store.setServiceStatus("keepme.com", "ignored");
    expect((await rows("keepme.com"))[0]).toMatchObject({ status: "ignored", deletedAt: null });
    expect(await store.auditFor("keepme.com")).toHaveLength(0);
  });

  it("returns false for services that don't exist and refuses anything that isn't a domain", async () => {
    await seed(A, "shop.com");
    expect(await store.setServiceStatus("nothere.com", "deleted")).toBe(false);
    for (const bad of ["", "localhost", "a b.com", "shop.com'; drop table accounts;--", "shop.com/x", "-bad.com", "https://shop.com", "x".repeat(300) + ".com"]) {
      expect(await store.setServiceStatus(bad, "deleted"), JSON.stringify(bad.slice(0, 40))).toBe(false);
    }
    expect((await rows("shop.com"))[0].status).toBe("active");
    expect((await db.select().from(schema.actions)).length).toBe(0);
  });

  it("is case-insensitive about the domain", async () => {
    await seed(A, "shop.com");
    expect(await store.setServiceStatus("  SHOP.com ", "deleted")).toBe(true);
    expect((await rows("shop.com"))[0].status).toBe("deleted");
  });

  it("only shows a service as deleted when every mailbox agrees", async () => {
    await seed(A, "shop.com");
    await store.setServiceStatus("shop.com", "deleted", NOW);
    expect((await service("shop.com")).state).toBe("deleted");
    await seed(B, "shop.com"); // a second mailbox turns up later and still has it
    const s = await service("shop.com");
    expect(s.state).toBe("active");
    expect(s.mailboxes).toBe(2);
  });

  it("flags a deleted service that kept emailing for more than 3 days afterwards", async () => {
    await seed(A, "quiet.com", { lastSeen: new Date(NOW.getTime() - 20 * DAY) });
    await seed(A, "grace.com", { lastSeen: new Date(NOW.getTime() - 8 * DAY) });
    await seed(A, "ignoring.com", { lastSeen: new Date(NOW.getTime() - 2 * DAY) });
    await seed(A, "alive.com", { lastSeen: new Date(NOW.getTime() - 2 * DAY) });
    const deletedAt = new Date(NOW.getTime() - 10 * DAY);
    for (const d of ["quiet.com", "grace.com", "ignoring.com"]) await store.setServiceStatus(d, "deleted", deletedAt);

    const by = Object.fromEntries((await dash.loadServices(NOW)).map((s) => [s.domain, s.stillEmailing]));
    expect(by).toEqual({ "quiet.com": false, "grace.com": false, "ignoring.com": true, "alive.com": false });
    expect(dash.decisionCounts(await dash.loadServices(NOW))).toEqual({ active: 1, deleted: 3, kept: 0, stillEmailing: 1 });
  });

  it("a rescan keeps the decision and surfaces mail that arrived after it", async () => {
    await seed(A, "shop.com", { lastSeen: new Date(NOW.getTime() - 30 * DAY) });
    await store.setServiceStatus("shop.com", "deleted", new Date(NOW.getTime() - 10 * DAY));
    expect((await service("shop.com")).stillEmailing).toBe(false);

    const fresh: MessageHeader = {
      id: "after-delete", date: new Date(NOW.getTime() - 1 * DAY), fromEmail: "orders@shop.com", fromName: "Shop", subject: "Your receipt",
    };
    const source: MailSource = {
      total: async () => 1,
      pages: ({ skip }: PagesOptions) => (async function* () { if (!skip(fresh.id)) yield [fresh]; })(),
      close: async () => {},
    };
    const [scan] = await db.insert(schema.scans).values({ mailbox: A }).returning({ id: schema.scans.id });
    expect(await engine.runScan({ scanId: scan.id, mailbox: A, source })).toBe("done");

    const row = (await rows("shop.com"))[0];
    expect(row.status).toBe("deleted"); // the scan must not undo the user's decision
    expect(row.messageCount).toBe(6);
    const s = await service("shop.com");
    expect(s).toMatchObject({ state: "deleted", stillEmailing: true });
  });

  it("filters by what the user decided", async () => {
    await seed(A, "active.com");
    await seed(A, "gone.com");
    await seed(A, "kept.com");
    await store.setServiceStatus("gone.com", "deleted", NOW);
    await store.setServiceStatus("kept.com", "ignored");
    const all = await dash.loadServices(NOW);
    const names = (show?: "active" | "deleted" | "kept" | "all") => dash.filterServices(all, { show }).map((s) => s.domain).sort();
    expect(names("active")).toEqual(["active.com"]);
    expect(names("deleted")).toEqual(["gone.com"]);
    expect(names("kept")).toEqual(["kept.com"]);
    expect(names("all")).toEqual(["active.com", "gone.com", "kept.com"]);
    expect(names(undefined)).toEqual(["active.com", "gone.com", "kept.com"]); // no show = no status filtering
    expect(dash.summarize(all.filter((s) => s.state === "active")).total).toBe(1);
  });

  it("wiping a mailbox removes the audit trail for services nothing else still has, and only those", async () => {
    await mailboxes.saveConnection({ provider: "google", mailbox: A, refreshToken: "rt", scopes: "s" });
    await seed(A, "only-a.com");
    await seed(A, "both.com");
    await seed(B, "both.com");
    await store.setServiceStatus("only-a.com", "deleted", NOW);
    await store.setServiceStatus("both.com", "deleted", NOW);

    await mailboxes.disconnectMailbox(A, { wipe: true });
    expect(await store.auditFor("only-a.com")).toHaveLength(0);
    expect(await store.auditFor("both.com")).toHaveLength(1);
    expect(await rows("both.com")).toHaveLength(1);
  });
});
