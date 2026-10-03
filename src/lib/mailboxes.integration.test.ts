import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Runs against a real Postgres. Skipped unless TEST_DATABASE_URL is set, e.g.
 *   TEST_DATABASE_URL=postgres://ghosthub:...@localhost:5432/ghosthub_test npm test
 * The database is migrated and the tables this test touches are emptied between tests.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("mailboxes (integration)", () => {
  // Imported lazily so the env is set before @/lib/env first parses it.
  let m: typeof import("./mailboxes");
  let schema: typeof import("@/db/schema");
  let db: ReturnType<typeof import("@/db").getDb>;
  let decrypt: typeof import("./crypto").decrypt;

  const fetchMock = vi.fn<typeof fetch>();

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.ADMIN_PASSWORD = "correct-horse";
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    process.env.GOOGLE_CLIENT_ID = "client-id";
    process.env.GOOGLE_CLIENT_SECRET = "client-secret";
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    const dbMod = await import("@/db");
    db = dbMod.getDb();
    await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
    schema = await import("@/db/schema");
    m = await import("./mailboxes");
    decrypt = (await import("./crypto")).decrypt;
    vi.stubGlobal("fetch", fetchMock);
  });

  beforeEach(async () => {
    fetchMock.mockReset();
    for (const t of [schema.accounts, schema.newsletters, schema.messagesSeen, schema.scans, schema.oauthTokens]) {
      await db.delete(t);
    }
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  const tokenOk = (access: string) =>
    new Response(JSON.stringify({ access_token: access, expires_in: 3600 }), { status: 200 });

  it("stores the refresh token encrypted and upserts on reconnect", async () => {
    await m.saveConnection({ mailbox: "a@gmail.com", refreshToken: "rt-1", scopes: "s" });
    const [row] = await db.select().from(schema.oauthTokens);
    expect(row.refreshTokenEnc).not.toContain("rt-1");
    expect(decrypt(row.refreshTokenEnc)).toBe("rt-1");

    await db.update(schema.oauthTokens).set({ needsReauth: true });
    await m.saveConnection({ mailbox: "a@gmail.com", refreshToken: "rt-2", scopes: "s" });
    const rows = await db.select().from(schema.oauthTokens);
    expect(rows).toHaveLength(1);
    expect(decrypt(rows[0].refreshTokenEnc)).toBe("rt-2");
    expect(rows[0].needsReauth).toBe(false); // reconnecting clears the flag
  });

  it("refreshes an access token once and serves it from cache afterwards", async () => {
    await m.saveConnection({ mailbox: "cache@gmail.com", refreshToken: "rt", scopes: "s" });
    fetchMock.mockResolvedValue(tokenOk("access-1"));
    expect(await m.getAccessToken("cache@gmail.com")).toBe("access-1");
    expect(await m.getAccessToken("cache@gmail.com")).toBe("access-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("flags needsReauth when Google answers invalid_grant", async () => {
    await m.saveConnection({ mailbox: "stale@gmail.com", refreshToken: "rt", scopes: "s" });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    await expect(m.getAccessToken("stale@gmail.com")).rejects.toMatchObject({ code: "invalid_grant" });
    const [conn] = await m.listConnections();
    expect(conn.needsReauth).toBe(true);
  });

  it("does not flag needsReauth for transient errors", async () => {
    await m.saveConnection({ mailbox: "flaky@gmail.com", refreshToken: "rt", scopes: "s" });
    fetchMock.mockResolvedValue(new Response("bad gateway", { status: 502 }));
    await expect(m.getAccessToken("flaky@gmail.com")).rejects.toMatchObject({ code: "http_502" });
    expect((await m.listConnections())[0].needsReauth).toBe(false);
  });

  it("errors for an unknown mailbox", async () => {
    await expect(m.getAccessToken("nobody@gmail.com")).rejects.toThrow(/No connection/);
  });

  async function seedDiscoveredData(mailbox: string) {
    const now = new Date();
    await db.insert(schema.accounts).values({ mailbox, domain: "example.com", name: "Example", firstSeen: now, lastSeen: now });
    await db.insert(schema.newsletters).values({ mailbox, senderEmail: "news@example.com", domain: "example.com", lastSeen: now });
    await db.insert(schema.messagesSeen).values({ mailbox, messageId: "m1" });
    await db.insert(schema.scans).values({ mailbox });
  }

  const counts = async () => ({
    accounts: (await db.select().from(schema.accounts)).length,
    newsletters: (await db.select().from(schema.newsletters)).length,
    messagesSeen: (await db.select().from(schema.messagesSeen)).length,
    scans: (await db.select().from(schema.scans)).length,
  });

  it("disconnect revokes at Google and keeps discovered data", async () => {
    await m.saveConnection({ mailbox: "keep@gmail.com", refreshToken: "rt-keep", scopes: "s" });
    await seedDiscoveredData("keep@gmail.com");
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

    expect(await m.disconnectMailbox("keep@gmail.com", { wipe: false })).toEqual({ revoked: true, found: true });
    const body = fetchMock.mock.calls[0][1]!.body as URLSearchParams;
    expect(body.get("token")).toBe("rt-keep"); // the decrypted token was revoked
    expect(await m.listConnections()).toHaveLength(0);
    expect(await counts()).toEqual({ accounts: 1, newsletters: 1, messagesSeen: 1, scans: 1 });
  });

  it("disconnect with wipe deletes only that mailbox's data, even if revoke fails", async () => {
    await m.saveConnection({ mailbox: "gone@gmail.com", refreshToken: "rt", scopes: "s" });
    await m.saveConnection({ mailbox: "other@gmail.com", refreshToken: "rt", scopes: "s" });
    await seedDiscoveredData("gone@gmail.com");
    await seedDiscoveredData("other@gmail.com");
    fetchMock.mockRejectedValue(new Error("offline"));

    expect(await m.disconnectMailbox("gone@gmail.com", { wipe: true })).toEqual({ revoked: false, found: true });
    expect((await m.listConnections()).map((c) => c.mailbox)).toEqual(["other@gmail.com"]);
    expect(await counts()).toEqual({ accounts: 1, newsletters: 1, messagesSeen: 1, scans: 1 });
    expect((await db.select().from(schema.accounts))[0].mailbox).toBe("other@gmail.com");
  });

  it("disconnecting an unknown mailbox is a no-op", async () => {
    expect(await m.disconnectMailbox("nobody@gmail.com", { wipe: true })).toEqual({ revoked: false, found: false });
  });
});
