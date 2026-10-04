import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { MailSource, MessageHeader, PagesOptions } from "./types";

/** Runs against a real Postgres. Skipped unless TEST_DATABASE_URL is set. */
const url = process.env.TEST_DATABASE_URL;
const ME = "me@yahoo.com";
const NOW = new Date("2026-06-01T00:00:00Z");

class ListSource implements MailSource {
  constructor(private readonly all: MessageHeader[]) {}
  async total() {
    return this.all.length;
  }
  async *pages({ skip }: PagesOptions) {
    const wanted = this.all.filter((m) => !skip(m.id));
    if (wanted.length) yield wanted;
  }
  async close() {}
}

describe.skipIf(!url)("spam-only services and rescanning from scratch (integration)", () => {
  let engine: typeof import("./engine");
  let reset: typeof import("./reset");
  let dash: typeof import("../dashboard");
  let news: typeof import("../newsletters/store");
  let deletion: typeof import("../deletion/store");
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
    reset = await import("./reset");
    dash = await import("../dashboard");
    news = await import("../newsletters/store");
    deletion = await import("../deletion/store");
  });

  const wipe = async () => {
    for (const t of [schema.actions, schema.accounts, schema.newsletters, schema.messagesSeen, schema.scans, schema.breaches]) await db.delete(t);
  };
  beforeEach(wipe);
  afterAll(wipe);

  const m = (id: string, from: string, subject: string, junk: boolean, extra: Partial<MessageHeader> = {}): MessageHeader => ({
    id, date: new Date("2025-03-03T00:00:00Z"), fromEmail: from, fromName: null, subject, junk, ...extra,
  });
  const MAIL = [
    m("a1", "hi@realshop.com", "Welcome to RealShop", false),
    m("a2", "hi@realshop.com", "Your order receipt", false),
    m("s1", "x@scamco.com", "Verify your account", true),
    m("s2", "x@scamco.com", "Verify your account today", true),
    m("mix1", "hi@mixed.com", "Welcome to Mixed", true),
    m("mix2", "hi@mixed.com", "Your order receipt", false),
    m("n1", "deals@spammer.com", "Big sale", true, { listUnsubscribe: "<https://spammer.com/u>", listUnsubscribePost: "List-Unsubscribe=One-Click" }),
    m("n2", "news@realnews.com", "This week", false, { listUnsubscribe: "<https://realnews.com/u>", listUnsubscribePost: "List-Unsubscribe=One-Click" }),
  ];

  async function scan(messages: MessageHeader[]) {
    const [row] = await db.insert(schema.scans).values({ mailbox: ME }).returning({ id: schema.scans.id });
    return engine.runScan({ scanId: row.id, mailbox: ME, source: new ListSource(messages) });
  }

  it("stores spam counts and flags only services whose every message was spam", async () => {
    expect(await scan(MAIL)).toBe("done");
    const by = Object.fromEntries((await dash.loadServices(NOW)).map((s) => [s.domain, s]));
    expect(by["realshop.com"]).toMatchObject({ messages: 2, spamCount: 0, spamOnly: false });
    expect(by["scamco.com"]).toMatchObject({ messages: 2, spamCount: 2, spamOnly: true });
    expect(by["mixed.com"]).toMatchObject({ messages: 2, spamCount: 1, spamOnly: false }); // one real message is enough
  });

  it("flags spam-only newsletter senders and refuses to queue an unsubscribe for them", async () => {
    await scan(MAIL);
    const rows = await news.listNewsletters();
    const spammer = rows.find((n) => n.senderEmail === "deals@spammer.com")!;
    const real = rows.find((n) => n.senderEmail === "news@realnews.com")!;
    expect(spammer.spamOnly).toBe(true);
    expect(real.spamOnly).toBe(false);

    const r = await news.queueUnsubscribes([spammer.id, real.id]);
    expect(r.queued).toBe(1);
    expect(r.skipped).toEqual([{ id: spammer.id, reason: expect.stringMatching(/only seen in spam/) }]);
  });

  it("rescanning from scratch recounts everything exactly once and keeps your decisions", async () => {
    await scan(MAIL.map((x) => ({ ...x, junk: undefined }))); // an older scan that didn't record spam
    expect((await dash.loadServices(NOW)).every((s) => !s.spamOnly)).toBe(true);
    await deletion.setServiceStatus("realshop.com", "deleted", NOW);
    const [seenBefore] = await db.select().from(schema.messagesSeen).limit(1);
    expect(seenBefore).toBeTruthy();

    expect(await reset.resetScanData(ME)).toBe(true);
    expect(await db.select().from(schema.messagesSeen)).toHaveLength(0);
    expect(await dash.loadServices(NOW)).toHaveLength(0); // nothing re-found yet: zero-count rows stay hidden
    expect(await news.listNewsletters()).toHaveLength(0);
    expect(await db.select().from(schema.accounts)).not.toHaveLength(0); // but the rows (and decisions) are kept

    await scan(MAIL);
    const by = Object.fromEntries((await dash.loadServices(NOW)).map((s) => [s.domain, s]));
    expect(by["realshop.com"]).toMatchObject({ messages: 2, spamCount: 0, state: "deleted" }); // not 4, and still deleted
    expect(by["scamco.com"]).toMatchObject({ messages: 2, spamCount: 2, spamOnly: true });
  });
});
