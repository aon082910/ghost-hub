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
    process.env.MICROSOFT_CLIENT_ID = "ms-client-id";
    process.env.MICROSOFT_CLIENT_SECRET = "ms-client-secret";
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
    for (const t of [schema.accounts, schema.newsletters, schema.messagesSeen, schema.scans, schema.mailboxConnections]) {
      await db.delete(t);
    }
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  const tokenOk = (access: string) =>
    new Response(JSON.stringify({ access_token: access, expires_in: 3600 }), { status: 200 });

  const oauth = (mailbox: string, refreshToken = "rt", provider: "google" | "microsoft" = "google") =>
    m.saveConnection({ provider, mailbox, refreshToken, scopes: "s" });

  it("stores the credential encrypted and upserts on reconnect", async () => {
    await oauth("a@gmail.com", "rt-1");
    const [row] = await db.select().from(schema.mailboxConnections);
    expect(row.credentialEnc).not.toContain("rt-1");
    expect(decrypt(row.credentialEnc)).toBe("rt-1");
    expect(row).toMatchObject({ provider: "google", authType: "oauth", imapHost: null });

    await db.update(schema.mailboxConnections).set({ needsReauth: true });
    await oauth("a@gmail.com", "rt-2");
    const rows = await db.select().from(schema.mailboxConnections);
    expect(rows).toHaveLength(1);
    expect(decrypt(rows[0].credentialEnc)).toBe("rt-2");
    expect(rows[0].needsReauth).toBe(false); // reconnecting clears the flag
  });

  it("refuses one address through two providers, because everything is filed under the address", async () => {
    await oauth("same@example.com", "g", "google");
    await expect(oauth("same@example.com", "m", "microsoft")).rejects.toMatchObject({ name: "MailboxConflictError", existingProvider: "google" });
    const imap = { host: "imap.example.com", port: 993, user: "same@example.com", pass: "pw" };
    await expect(m.saveConnection({ provider: "imap", mailbox: imap.user, imap })).rejects.toBeInstanceOf(m.MailboxConflictError);
    const rows = await db.select().from(schema.mailboxConnections);
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe("google"); // the refused attempt changed nothing
    expect(decrypt(rows[0].credentialEnc)).toBe("g");
  });

  it("holds any number of accounts from one provider, and says when a connect only refreshed one", async () => {
    expect(await oauth("one@gmail.com", "rt-1")).toEqual({ replaced: false });
    expect(await oauth("two@gmail.com", "rt-2")).toEqual({ replaced: false });
    expect(await oauth("three@gmail.com", "rt-3")).toEqual({ replaced: false });
    expect(await oauth("outlook@outlook.com", "rt-4", "microsoft")).toEqual({ replaced: false });
    expect(await oauth("outlook2@hotmail.com", "rt-5", "microsoft")).toEqual({ replaced: false });
    expect((await m.listConnections()).map((c) => c.mailbox).sort()).toEqual(["one@gmail.com", "outlook2@hotmail.com", "outlook@outlook.com", "three@gmail.com", "two@gmail.com"]);

    expect(await oauth("two@gmail.com", "rt-2b")).toEqual({ replaced: true }); // same account again
    expect(await m.listConnections()).toHaveLength(5);
    expect(decrypt((await m.findConnection("two@gmail.com"))!.credentialEnc)).toBe("rt-2b");
    expect(decrypt((await m.findConnection("one@gmail.com"))!.credentialEnc)).toBe("rt-1"); // the others are untouched
  });

  it("deleting one account's data leaves the other accounts of the same provider alone", async () => {
    await oauth("a@gmail.com");
    await oauth("b@gmail.com");
    for (const mailbox of ["a@gmail.com", "b@gmail.com"]) {
      await db.insert(schema.accounts).values({ mailbox, domain: "shop.com", name: "Shop", category: "account", firstSeen: new Date(), lastSeen: new Date(), messageCount: 3 });
      await db.insert(schema.messagesSeen).values({ mailbox, messageId: "x1" });
    }
    await m.disconnectMailbox("a@gmail.com", { wipe: true });
    expect((await m.listConnections()).map((c) => c.mailbox)).toEqual(["b@gmail.com"]);
    expect((await db.select().from(schema.accounts)).map((r) => r.mailbox)).toEqual(["b@gmail.com"]);
    expect((await db.select().from(schema.messagesSeen)).map((r) => r.mailbox)).toEqual(["b@gmail.com"]);
  });

  it("stores an IMAP app password encrypted with its server, and reads it back", async () => {
    const imap = { host: "imap.mail.yahoo.com", port: 993, user: "me@yahoo.com", pass: "app-pass" };
    await m.saveConnection({ provider: "imap", mailbox: imap.user, imap });
    const [row] = await db.select().from(schema.mailboxConnections);
    expect(row).toMatchObject({ provider: "imap", authType: "password", imapHost: imap.host, imapPort: 993 });
    expect(row.credentialEnc).not.toContain("app-pass");
    expect(await m.getImapCredentials(imap.user)).toEqual(imap);
    await expect(m.getAccessToken(imap.user)).rejects.toThrow(/not an OAuth mailbox/);
    await oauth("g@gmail.com");
    await expect(m.getImapCredentials("g@gmail.com")).rejects.toThrow(/not an IMAP mailbox/);
  });

  it("refreshes an access token once and serves it from cache afterwards", async () => {
    await oauth("cache@gmail.com");
    fetchMock.mockResolvedValue(tokenOk("access-1"));
    expect(await m.getAccessToken("cache@gmail.com")).toBe("access-1");
    expect(await m.getAccessToken("cache@gmail.com")).toBe("access-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stores a rotated refresh token (Microsoft) but leaves an unchanged one alone", async () => {
    await oauth("rot@outlook.com", "old-rt", "microsoft");
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ access_token: "a", refresh_token: "new-rt", expires_in: 3600 }), { status: 200 }),
    );
    expect(await m.getAccessToken("rot@outlook.com")).toBe("a");
    const [row] = await db.select().from(schema.mailboxConnections);
    expect(decrypt(row.credentialEnc)).toBe("new-rt");
    // The refresh request used the OLD token.
    expect((fetchMock.mock.calls[0][1]!.body as URLSearchParams).get("refresh_token")).toBe("old-rt");
  });

  it("flags needsReauth when the provider answers invalid_grant", async () => {
    await oauth("stale@gmail.com");
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    await expect(m.getAccessToken("stale@gmail.com")).rejects.toMatchObject({ code: "invalid_grant" });
    expect((await m.listConnections())[0].needsReauth).toBe(true);
  });

  it("does not flag needsReauth for transient errors", async () => {
    await oauth("flaky@gmail.com");
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
    await oauth("keep@gmail.com", "rt-keep");
    await seedDiscoveredData("keep@gmail.com");
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

    expect(await m.disconnectMailbox("keep@gmail.com", { wipe: false })).toEqual({
      found: true,
      provider: "google",
      revoked: true,
    });
    const body = fetchMock.mock.calls[0][1]!.body as URLSearchParams;
    expect(body.get("token")).toBe("rt-keep"); // the decrypted token was revoked
    expect(await m.listConnections()).toHaveLength(0);
    expect(await counts()).toEqual({ accounts: 1, newsletters: 1, messagesSeen: 1, scans: 1 });
  });

  it("disconnect with wipe deletes only that mailbox's data, even if revoke fails", async () => {
    await oauth("gone@gmail.com");
    await oauth("other@gmail.com");
    await seedDiscoveredData("gone@gmail.com");
    await seedDiscoveredData("other@gmail.com");
    fetchMock.mockRejectedValue(new Error("offline"));

    expect(await m.disconnectMailbox("gone@gmail.com", { wipe: true })).toEqual({
      found: true,
      provider: "google",
      revoked: false,
    });
    expect((await m.listConnections()).map((c) => c.mailbox)).toEqual(["other@gmail.com"]);
    expect(await counts()).toEqual({ accounts: 1, newsletters: 1, messagesSeen: 1, scans: 1 });
    expect((await db.select().from(schema.accounts))[0].mailbox).toBe("other@gmail.com");
  });

  it("disconnect reports revoked=null for providers that can't revoke (Microsoft, IMAP) without calling out", async () => {
    await oauth("ms@outlook.com", "rt", "microsoft");
    await m.saveConnection({
      provider: "imap",
      mailbox: "me@yahoo.com",
      imap: { host: "imap.mail.yahoo.com", port: 993, user: "me@yahoo.com", pass: "p" },
    });
    expect(await m.disconnectMailbox("ms@outlook.com", { wipe: false })).toEqual({ found: true, provider: "microsoft", revoked: null });
    expect(await m.disconnectMailbox("me@yahoo.com", { wipe: false })).toEqual({ found: true, provider: "imap", revoked: null });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await m.listConnections()).toHaveLength(0);
  });

  it("disconnecting an unknown mailbox is a no-op", async () => {
    expect(await m.disconnectMailbox("nobody@gmail.com", { wipe: true })).toEqual({ found: false });
  });
});
