import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { aggregate } from "./engine";
import type { MailSource, MessageHeader, PagesOptions } from "./types";

/**
 * Runs against a real Postgres. Skipped unless TEST_DATABASE_URL is set (see mailboxes.integration.test.ts).
 */
const url = process.env.TEST_DATABASE_URL;
const ME = "me@gmail.com";

let n = 0;
const mk = (o: Partial<MessageHeader> & { fromEmail: string; subject: string }): MessageHeader => ({
  id: `m${++n}`,
  date: new Date("2024-01-01T00:00:00Z"),
  fromName: null,
  ...o,
});

/** A source that serves fixed pages, honouring skip like a real one, and can fail or abort partway. */
class FakeSource implements MailSource {
  closed = false;
  constructor(
    private readonly pagesData: MessageHeader[][],
    private readonly opts: { failAfterPages?: number; ignoreSkip?: boolean; onPage?: (i: number) => void } = {},
  ) {}
  async total() {
    return this.pagesData.flat().length;
  }
  async *pages({ skip, signal }: PagesOptions) {
    let i = 0;
    for (const page of this.pagesData) {
      signal?.throwIfAborted();
      if (this.opts.failAfterPages !== undefined && i >= this.opts.failAfterPages) throw new Error("network down");
      const fresh = this.opts.ignoreSkip ? page : page.filter((m) => !skip(m.id));
      this.opts.onPage?.(i);
      i++;
      if (fresh.length) yield fresh;
    }
  }
  async close() {
    this.closed = true;
  }
}

describe("aggregate (pure)", () => {
  it("merges messages per service and keeps the strongest category and the widest date range", () => {
    const r = aggregate(
      [
        mk({ fromEmail: "news@shop.com", subject: "Sale", listUnsubscribe: "<https://shop.com/u>", date: new Date("2024-03-01") }),
        mk({ fromEmail: "orders@shop.com", subject: "Order confirmation #1", date: new Date("2022-03-01") }),
        mk({ fromEmail: "x@shop.com", subject: "Welcome to Shop", date: new Date("2021-03-01") }),
        mk({ fromEmail: "friend@gmail.com", subject: "Welcome to Shop" }),
      ],
      ME,
      new Date("2025-01-01"),
    );
    expect(r.accounts).toHaveLength(1);
    expect(r.accounts[0]).toMatchObject({ domain: "shop.com", category: "account", count: 3 });
    expect(r.accounts[0].first.toISOString()).toBe("2021-03-01T00:00:00.000Z");
    expect(r.accounts[0].last.toISOString()).toBe("2024-03-01T00:00:00.000Z");
    expect(r.newsletters).toHaveLength(1);
  });

  it("replaces missing, ancient and far-future dates with 'now'", () => {
    const now = new Date("2025-06-01T00:00:00Z");
    for (const date of [new Date(0), new Date("1970-01-02"), new Date("2099-01-01"), new Date("nonsense")]) {
      const r = aggregate([mk({ fromEmail: "a@svc.com", subject: "Welcome to Svc", date })], ME, now);
      expect(r.accounts[0].first.toISOString()).toBe(now.toISOString());
    }
  });

  it("newest unsubscribe link wins within a batch, but an older link fills a gap", () => {
    const r = aggregate(
      [
        mk({ fromEmail: "n@s.com", subject: "x", listUnsubscribe: "<https://s.com/old>", date: new Date("2023-01-01") }),
        mk({ fromEmail: "n@s.com", subject: "y", listUnsubscribe: "<https://s.com/new>", listUnsubscribePost: "List-Unsubscribe=One-Click", date: new Date("2024-01-01") }),
        mk({ fromEmail: "n@s.com", subject: "z", listId: "<l>", date: new Date("2025-01-01") }), // newest, but no link
      ],
      ME,
      new Date("2026-01-01"),
    );
    expect(r.newsletters[0]).toMatchObject({ listUnsubscribe: "<https://s.com/new>", oneClick: true, count: 3 });
  });
});

describe.skipIf(!url)("scan engine (integration)", () => {
  let runScan: typeof import("./engine").runScan;
  let schema: typeof import("@/db/schema");
  let db: ReturnType<typeof import("@/db").getDb>;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.ADMIN_PASSWORD = "correct-horse";
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    db = (await import("@/db")).getDb();
    await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
    schema = await import("@/db/schema");
    runScan = (await import("./engine")).runScan;
  });

  beforeEach(async () => {
    for (const t of [schema.accounts, schema.newsletters, schema.messagesSeen, schema.scans]) await db.delete(t);
  });

  afterAll(async () => {
    for (const t of [schema.accounts, schema.newsletters, schema.messagesSeen, schema.scans]) await db.delete(t);
  });

  async function newScan(mailbox = ME) {
    const [row] = await db.insert(schema.scans).values({ mailbox }).returning({ id: schema.scans.id });
    return row.id;
  }
  const scanRow = async (id: string) => (await db.select().from(schema.scans).where(eq(schema.scans.id, id)))[0];
  const allAccounts = async () =>
    (await db.select().from(schema.accounts)).sort((a, b) => a.domain.localeCompare(b.domain));

  const welcome = (domain: string, date = "2024-01-01") =>
    mk({ fromEmail: `hello@${domain}`, subject: `Welcome to ${domain}`, date: new Date(date) });

  it("records services, counts, dates, progress and marks the scan done", async () => {
    const pages = [
      [welcome("alpha.com", "2024-05-01"), mk({ fromEmail: "orders@beta.com", subject: "Order confirmation #9", date: new Date("2023-01-01") })],
      [welcome("alpha.com", "2019-02-02"), mk({ fromEmail: "friend@gmail.com", subject: "hi" })],
    ];
    const id = await newScan();
    const source = new FakeSource(pages);
    expect(await runScan({ scanId: id, mailbox: ME, source })).toBe("done");

    const accs = await allAccounts();
    expect(accs.map((a) => [a.domain, a.category, a.messageCount])).toEqual([
      ["alpha.com", "account", 2],
      ["beta.com", "receipt", 1],
    ]);
    expect(accs[0].firstSeen.toISOString()).toBe("2019-02-02T00:00:00.000Z");
    expect(accs[0].lastSeen.toISOString()).toBe("2024-05-01T00:00:00.000Z");

    const scan = await scanRow(id);
    expect(scan).toMatchObject({ status: "done", messagesTotal: 4, messagesProcessed: 4, error: null });
    expect(scan.finishedAt).not.toBeNull();
    expect(source.closed).toBe(true);
    // every message, including ignored ones, is remembered so it's never fetched again
    expect(await db.select().from(schema.messagesSeen)).toHaveLength(4);
  });

  it("scanning again adds nothing: seen messages are skipped", async () => {
    const pages = [[welcome("alpha.com"), welcome("beta.com")]];
    await runScan({ scanId: await newScan(), mailbox: ME, source: new FakeSource(pages) });
    const before = await allAccounts();

    const id2 = await newScan();
    expect(await runScan({ scanId: id2, mailbox: ME, source: new FakeSource(pages) })).toBe("done");
    expect(await allAccounts()).toEqual(before);
    expect((await scanRow(id2)).messagesProcessed).toBe(2); // resumed scans start at what's already done
  });

  it("never double counts even if a source ignores skip and re-delivers messages", async () => {
    const pages = [[welcome("alpha.com"), welcome("alpha.com")]];
    await runScan({ scanId: await newScan(), mailbox: ME, source: new FakeSource(pages) });
    await runScan({ scanId: await newScan(), mailbox: ME, source: new FakeSource(pages, { ignoreSkip: true }) });
    expect((await allAccounts())[0].messageCount).toBe(2);
  });

  it("a mid-scan failure keeps finished pages, reports the error, and a rerun completes with exact totals", async () => {
    const pages = [[welcome("a.com"), welcome("b.com")], [welcome("a.com"), welcome("c.com")], [welcome("b.com")]];
    const id = await newScan();
    expect(await runScan({ scanId: id, mailbox: ME, source: new FakeSource(pages, { failAfterPages: 1 }) })).toBe("failed");
    const failed = await scanRow(id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("network down");
    expect(failed.messagesProcessed).toBe(2);
    expect((await allAccounts()).map((a) => [a.domain, a.messageCount])).toEqual([["a.com", 1], ["b.com", 1]]);

    expect(await runScan({ scanId: await newScan(), mailbox: ME, source: new FakeSource(pages) })).toBe("done");
    expect((await allAccounts()).map((a) => [a.domain, a.messageCount])).toEqual([["a.com", 2], ["b.com", 2], ["c.com", 1]]);
  });

  it("cancelling stops after the current page and records 'cancelled', not 'failed'", async () => {
    const pages = [[welcome("a.com")], [welcome("b.com")], [welcome("c.com")]];
    const controller = new AbortController();
    const id = await newScan();
    const source = new FakeSource(pages, { onPage: (i) => i === 0 && queueMicrotask(() => controller.abort()) });
    expect(await runScan({ scanId: id, mailbox: ME, source, signal: controller.signal })).toBe("cancelled");
    const scan = await scanRow(id);
    expect(scan.status).toBe("cancelled");
    expect(scan.error).toBeNull();
    expect((await allAccounts()).length).toBeLessThan(3);
    expect(source.closed).toBe(true);

    // and the next scan picks up the rest
    await runScan({ scanId: await newScan(), mailbox: ME, source: new FakeSource(pages) });
    expect((await allAccounts()).map((a) => a.domain)).toEqual(["a.com", "b.com", "c.com"]);
  });

  it("upgrades a service's category as stronger evidence arrives, never downgrades", async () => {
    const run = (m: MessageHeader[]) => async () => runScan({ scanId: await newScan(), mailbox: ME, source: new FakeSource([m]) });
    await run([mk({ fromEmail: "n@svc.com", subject: "Sale", listUnsubscribe: "<https://svc.com/u>" })])();
    expect((await allAccounts())[0].category).toBe("newsletter");
    await run([mk({ fromEmail: "b@svc.com", subject: "Your receipt" })])();
    expect((await allAccounts())[0].category).toBe("receipt");
    await run([mk({ fromEmail: "b@svc.com", subject: "Your subscription renews" })])();
    expect((await allAccounts())[0].category).toBe("subscription");
    await run([mk({ fromEmail: "b@svc.com", subject: "Welcome to Svc" })])();
    expect((await allAccounts())[0].category).toBe("account");
    await run([mk({ fromEmail: "n@svc.com", subject: "Another sale", listUnsubscribe: "<https://svc.com/u>" })])();
    const a = (await allAccounts())[0];
    expect(a.category).toBe("account"); // a newsletter after an account doesn't demote it
    expect(a.messageCount).toBe(5);
  });

  it("keeps the earliest first_seen and latest last_seen across scans", async () => {
    for (const date of ["2022-06-01", "2020-01-01", "2024-09-09", "2021-01-01"]) {
      await runScan({ scanId: await newScan(), mailbox: ME, source: new FakeSource([[welcome("dates.com", date)]]) });
    }
    const a = (await allAccounts())[0];
    expect(a.messageCount).toBe(4);
    expect(a.firstSeen.toISOString()).toBe("2020-01-01T00:00:00.000Z");
    expect(a.lastSeen.toISOString()).toBe("2024-09-09T00:00:00.000Z");
  });

  it("stores newsletters with the newest unsubscribe link and accumulates counts", async () => {
    const scan = async (link: string | undefined, date: string, post?: string) =>
      runScan({
        scanId: await newScan(),
        mailbox: ME,
        source: new FakeSource([[mk({ fromEmail: "news@shop.com", fromName: "Shop", subject: "Deals", listUnsubscribe: link, listId: "<l>", listUnsubscribePost: post, date: new Date(date) })]]),
      });

    await scan("<https://shop.com/u/2023>", "2023-01-01");
    await scan("<https://shop.com/u/2024>", "2024-01-01", "List-Unsubscribe=One-Click");
    await scan("<https://shop.com/u/2021>", "2021-01-01"); // older mail turns up later: must not overwrite
    await scan(undefined, "2025-01-01"); // newest has no link: keep the last good one

    const [n] = await db.select().from(schema.newsletters);
    expect(n).toMatchObject({
      senderEmail: "news@shop.com",
      senderName: "Shop",
      domain: "shop.com",
      messageCount: 4,
      listUnsubscribe: "<https://shop.com/u/2024>",
      oneClick: true,
    });
    expect(n.lastSeen.toISOString()).toBe("2025-01-01T00:00:00.000Z");
  });

  it("keeps mailboxes separate", async () => {
    await runScan({ scanId: await newScan("a@gmail.com"), mailbox: "a@gmail.com", source: new FakeSource([[welcome("x.com")]]) });
    await runScan({ scanId: await newScan("b@gmail.com"), mailbox: "b@gmail.com", source: new FakeSource([[welcome("x.com")]]) });
    const rows = await allAccounts();
    expect(rows.map((r) => [r.mailbox, r.messageCount])).toEqual([["a@gmail.com", 1], ["b@gmail.com", 1]]);
  });

  it("turns known errors into friendly messages and never leaks raw credentials", async () => {
    const { OAuthError } = await import("../oauth");
    // A source that fails as soon as it's used.
    const boom = (err: unknown): MailSource => ({
      total: async () => {
        throw err;
      },
      pages: () =>
        (async function* (): AsyncGenerator<MessageHeader[]> {
          throw err;
        })(),
      close: async () => {},
    });

    const id1 = await newScan();
    await runScan({ scanId: id1, mailbox: ME, source: boom(new OAuthError("invalid_grant", "Token has been expired or revoked.")) });
    expect((await scanRow(id1)).error).toMatch(/Reconnect this mailbox/);

    const id2 = await newScan();
    await runScan({ scanId: id2, mailbox: ME, source: boom(Object.assign(new Error("x"), { authenticationFailed: true })) });
    expect((await scanRow(id2)).error).toMatch(/app password/);

    const id3 = await newScan();
    await runScan({ scanId: id3, mailbox: ME, source: boom(Object.assign(new Error("getaddrinfo"), { code: "ENOTFOUND" })) });
    expect((await scanRow(id3)).error).toMatch(/Couldn't reach/);

    const id5 = await newScan();
    await runScan({ scanId: id5, mailbox: ME, source: boom(new DOMException("The operation was aborted due to timeout", "TimeoutError")) });
    expect((await scanRow(id5)).error).toMatch(/took too long/);

    const id6 = await newScan();
    await runScan({ scanId: id6, mailbox: ME, source: boom(new Error("Unsupported state or unable to authenticate data")) });
    expect((await scanRow(id6)).error).toMatch(/ENCRYPTION_KEY.*reconnect/);

    const id4 = await newScan();
    await runScan({ scanId: id4, mailbox: ME, source: boom(new Error("x".repeat(1000))) });
    expect((await scanRow(id4)).error!.length).toBeLessThan(400);
  });
});
