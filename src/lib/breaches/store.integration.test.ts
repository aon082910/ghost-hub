import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import sample from "./hibp-sample.fixture.json";

/** Runs against a real Postgres. Skipped unless TEST_DATABASE_URL is set. */
const url = process.env.TEST_DATABASE_URL;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe.skipIf(!url)("breach store and dashboard (integration)", () => {
  let store: typeof import("./store");
  let dash: typeof import("../dashboard");
  let mailboxes: typeof import("../mailboxes");
  let envMod: typeof import("../env");
  let schema: typeof import("@/db/schema");
  let db: ReturnType<typeof import("@/db").getDb>;
  const ME = "me@gmail.com";

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.ADMIN_PASSWORD = "correct-horse";
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    process.env.HIBP_API_KEY = "test-key";
    delete process.env.HIBP_ENABLED;
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    db = (await import("@/db")).getDb();
    await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
    schema = await import("@/db/schema");
    store = await import("./store");
    dash = await import("../dashboard");
    mailboxes = await import("../mailboxes");
    envMod = await import("../env");
  });

  const wipe = async () => {
    for (const t of [
      schema.accounts, schema.newsletters, schema.messagesSeen, schema.scans,
      schema.mailboxBreaches, schema.breachChecks, schema.breaches, schema.mailboxConnections,
    ]) {
      await db.delete(t);
    }
  };
  beforeEach(wipe);
  afterAll(wipe);

  const catalogFetch = () => vi.fn<typeof fetch>(async () => json(sample));

  it("refresh stores only usable breaches and reports what it kept", async () => {
    const { count } = await store.refreshCatalog({ fetchImpl: catalogFetch() });
    const rows = await db.select().from(schema.breaches);
    expect(count).toBe(rows.length);
    expect(rows.map((r) => r.name)).toEqual(expect.arrayContaining(["Adobe", "LinkedIn", "Dropbox"]));
    expect(rows.map((r) => r.name)).not.toContain("JustDate");
    expect(rows.find((r) => r.name === "Adobe")).toMatchObject({ domain: "adobe.com", breachDate: "2013-10-04", isVerified: true });
    expect((await store.loadCatalog()).length).toBe(count);
  });

  it("a second refresh updates in place and removes breaches that vanished upstream", async () => {
    await store.refreshCatalog({ fetchImpl: catalogFetch() });
    const trimmed = sample.filter((b) => b.Name !== "Dropbox").map((b) => (b.Name === "Adobe" ? { ...b, PwnCount: 1 } : b));
    await store.refreshCatalog({ fetchImpl: async () => json(trimmed) });
    const rows = await db.select().from(schema.breaches);
    expect(rows.map((r) => r.name)).not.toContain("Dropbox");
    expect(rows.find((r) => r.name === "Adobe")!.pwnCount).toBe(1);
  });

  it("never wipes the stored list when the response is empty, broken or an error", async () => {
    await store.refreshCatalog({ fetchImpl: catalogFetch() });
    const before = (await db.select().from(schema.breaches)).length;
    await expect(store.refreshCatalog({ fetchImpl: async () => json([]) })).rejects.toThrow(/keeping the existing list/);
    await expect(store.refreshCatalog({ fetchImpl: async () => json({ oops: true }) })).rejects.toThrow();
    await expect(store.refreshCatalog({ fetchImpl: async () => json({}, 503) })).rejects.toThrow();
    expect((await db.select().from(schema.breaches)).length).toBe(before);
  });

  it("reports status and staleness", async () => {
    expect(await store.catalogStatus()).toMatchObject({ enabled: true, keyConfigured: true, count: 0, lastFetched: null, stale: true });
    await store.refreshCatalog({ fetchImpl: catalogFetch() });
    const fresh = await store.catalogStatus();
    expect(fresh.stale).toBe(false);
    expect(fresh.count).toBeGreaterThan(5);
    expect((await store.catalogStatus(new Date(Date.now() + 8 * 86_400_000))).stale).toBe(true);
  });

  it("ensureFreshCatalog refreshes only when missing or stale, and swallows failures", async () => {
    const f = catalogFetch();
    await store.ensureFreshCatalog({ fetchImpl: f });
    await store.ensureFreshCatalog({ fetchImpl: f });
    expect(f).toHaveBeenCalledTimes(1); // second call: already fresh
    await db.delete(schema.breaches);
    await expect(store.ensureFreshCatalog({ fetchImpl: async () => json({}, 500) })).resolves.toBeUndefined();
  });

  it("makes no HIBP call at all when disabled", async () => {
    process.env.HIBP_ENABLED = "false";
    envMod.resetEnvCache();
    try {
      const f = catalogFetch();
      await expect(store.refreshCatalog({ fetchImpl: f })).rejects.toThrow(/turned off/);
      await store.ensureFreshCatalog({ fetchImpl: f });
      await expect(store.checkMailboxBreaches(ME, { fetchImpl: f })).rejects.toThrow(/turned off/);
      expect(f).not.toHaveBeenCalled();
    } finally {
      delete process.env.HIBP_ENABLED;
      envMod.resetEnvCache();
    }
  });

  async function connect(mailbox = ME) {
    await mailboxes.saveConnection({ provider: "google", mailbox, refreshToken: "rt", scopes: "s" });
  }

  it("checks a mailbox, replaces its previous results, and records 'checked, none found'", async () => {
    await connect();
    const r1 = await store.checkMailboxBreaches(ME, {
      fetchImpl: async () => json([{ Name: "Adobe" }, { Name: "Adobe" }, { Name: "LinkedIn" }]),
    });
    expect(r1.breachCount).toBe(2); // de-duplicated
    expect([...(await store.loadConfirmedNames())].sort()).toEqual(["Adobe", "LinkedIn"]);

    const r2 = await store.checkMailboxBreaches(ME, { fetchImpl: async () => new Response("", { status: 404 }) });
    expect(r2.breachCount).toBe(0);
    expect((await store.loadConfirmedNames()).size).toBe(0);
    const checks = await store.loadChecks();
    expect(checks.get(ME)).toMatchObject({ breachCount: 0 });
    expect(checks.get(ME)!.checkedAt).toBeInstanceOf(Date);
  });

  it("needs a key and a connected mailbox, and a rejected key leaves earlier results alone", async () => {
    await connect();
    await store.checkMailboxBreaches(ME, { fetchImpl: async () => json([{ Name: "Adobe" }]) });
    await expect(store.checkMailboxBreaches(ME, { fetchImpl: async () => json({}, 401) })).rejects.toMatchObject({ status: 401 });
    expect([...(await store.loadConfirmedNames())]).toEqual(["Adobe"]);
    await expect(store.checkMailboxBreaches("stranger@gmail.com", { fetchImpl: async () => json([]) })).rejects.toThrow(/No connection/);

    const key = process.env.HIBP_API_KEY;
    delete process.env.HIBP_API_KEY;
    envMod.resetEnvCache();
    try {
      await expect(store.checkMailboxBreaches(ME)).rejects.toThrow(/No Have I Been Pwned API key/);
    } finally {
      process.env.HIBP_API_KEY = key;
      envMod.resetEnvCache();
    }
  });

  it("wiping a mailbox removes its breach results too", async () => {
    await connect();
    await store.checkMailboxBreaches(ME, { fetchImpl: async () => json([{ Name: "Adobe" }]) });
    await mailboxes.disconnectMailbox(ME, { wipe: true });
    expect((await db.select().from(schema.mailboxBreaches)).length).toBe(0);
    expect((await db.select().from(schema.breachChecks)).length).toBe(0);
  });

  async function seedAccount(mailbox: string, domain: string, category: string, first: string, last: string, messageCount = 5) {
    await db.insert(schema.accounts).values({
      mailbox, domain, name: domain.split(".")[0], category, firstSeen: new Date(first), lastSeen: new Date(last), messageCount,
    });
  }

  it("scores services against the stored catalog and sorts riskiest first", async () => {
    await store.refreshCatalog({ fetchImpl: catalogFetch() });
    await seedAccount(ME, "adobe.com", "account", "2012-01-01", "2026-05-01"); // password breach 2013: likely
    await seedAccount(ME, "quiet.example.org", "account", "2020-01-01", "2026-05-01"); // no breach
    await seedAccount(ME, "linkedin.com", "newsletter", "2012-01-01", "2026-05-01"); // breach, but newsletter
    const all = await dash.loadServices(new Date("2026-06-01"));
    expect(all.map((s) => s.domain)).toEqual(["adobe.com", "linkedin.com", "quiet.example.org"]);
    expect(all[0].risk).toMatchObject({ level: "medium", dormant: false });
    expect(all[0].risk.breaches[0]).toMatchObject({ name: "Adobe", exposure: "likely", confirmed: false });
    expect(all[2].risk.breaches).toEqual([]);
  });

  it("confirmed breaches (from the user's own address) raise the score", async () => {
    await store.refreshCatalog({ fetchImpl: catalogFetch() });
    await seedAccount(ME, "adobe.com", "account", "2012-01-01", "2026-05-01");
    const before = (await dash.loadServices(new Date("2026-06-01")))[0].risk.score;
    await connect();
    await store.checkMailboxBreaches(ME, { fetchImpl: async () => json([{ Name: "Adobe" }]) });
    const after = (await dash.loadServices(new Date("2026-06-01")))[0].risk;
    expect(after.score).toBeGreaterThan(before);
    expect(after.level).toBe("high");
    expect(after.breaches[0].confirmed).toBe(true);
  });

  it("merges a service across mailboxes and filters and summarises correctly", async () => {
    await store.refreshCatalog({ fetchImpl: catalogFetch() });
    await seedAccount("a@gmail.com", "adobe.com", "account", "2012-01-01", "2020-01-01", 3);
    await seedAccount("b@gmail.com", "adobe.com", "receipt", "2015-01-01", "2026-05-01", 4);
    await seedAccount(ME, "dropbox.com", "account", "2012-01-01", "2022-01-01"); // dormant + breached
    await seedAccount(ME, "plain.example.org", "newsletter", "2020-01-01", "2026-05-01");
    const all = await dash.loadServices(new Date("2026-06-01"));

    const adobe = all.find((s) => s.domain === "adobe.com")!;
    expect(adobe).toMatchObject({ messages: 7, mailboxes: 2, category: "account" }); // strongest category wins
    expect(adobe.firstSeen.getUTCFullYear()).toBe(2012);

    expect(dash.filterServices(all, { category: "newsletter" }).map((s) => s.domain)).toEqual(["plain.example.org"]);
    expect(dash.filterServices(all, { breachedOnly: true }).map((s) => s.domain).sort()).toEqual(["adobe.com", "dropbox.com"]);
    expect(dash.filterServices(all, { level: "minimal" }).map((s) => s.domain)).toEqual(["plain.example.org"]);
    expect(dash.filterServices(all, {})).toHaveLength(3);

    const s = dash.summarize(all);
    expect(s).toMatchObject({ total: 3, breached: 2, dormant: 1 });
    expect(s.byCategory).toEqual({ account: 2, subscription: 0, receipt: 0, newsletter: 1 });
  });
});
