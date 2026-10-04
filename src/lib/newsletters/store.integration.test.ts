import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Transport } from "./oneclick";

/** Runs against a real Postgres. Skipped unless TEST_DATABASE_URL is set. */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("newsletter store (integration)", () => {
  let store: typeof import("./store");
  let mailboxes: typeof import("../mailboxes");
  let schema: typeof import("@/db/schema");
  let db: ReturnType<typeof import("@/db").getDb>;
  const A = "a@gmail.com";
  const B = "b@gmail.com";

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.ADMIN_PASSWORD = "correct-horse";
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    db = (await import("@/db")).getDb();
    await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
    schema = await import("@/db/schema");
    store = await import("./store");
    mailboxes = await import("../mailboxes");
  });

  const wipe = async () => {
    for (const t of [schema.actions, schema.newsletters, schema.accounts, schema.messagesSeen, schema.scans, schema.mailboxConnections]) await db.delete(t);
  };
  beforeEach(wipe);
  afterAll(wipe);

  const ONE_CLICK = "<https://news.example.com/unsub?id=1>, <mailto:u@news.example.com>";
  async function add(o: Partial<typeof schema.newsletters.$inferInsert> & { senderEmail: string }) {
    const [row] = await db
      .insert(schema.newsletters)
      .values({ mailbox: A, domain: "example.com", listUnsubscribe: ONE_CLICK, oneClick: true, messageCount: 10, lastSeen: new Date("2026-01-01"), ...o })
      .returning();
    return row;
  }
  const newsletter = async (id: string) => (await db.select().from(schema.newsletters).where(eq(schema.newsletters.id, id)))[0];
  const actionsFor = async (id: string) => db.select().from(schema.actions).where(eq(schema.actions.targetId, id));
  const transportOk = (status = 200) => vi.fn<Transport>(async () => ({ status }));

  it("lists senders busiest first, with the method each supports", async () => {
    await add({ senderEmail: "small@x.com", messageCount: 2, oneClick: false, listUnsubscribe: "<https://x.com/u>" });
    await add({ senderEmail: "big@x.com", messageCount: 50 });
    await add({ senderEmail: "mail@x.com", messageCount: 5, oneClick: false, listUnsubscribe: "<mailto:u@x.com>" });
    await add({ senderEmail: "none@x.com", messageCount: 1, oneClick: false, listUnsubscribe: null });
    const rows = await store.listNewsletters();
    expect(rows.map((r) => [r.senderEmail, r.method.method])).toEqual([
      ["big@x.com", "one-click"], ["mail@x.com", "mailto"], ["small@x.com", "link"], ["none@x.com", "none"],
    ]);
  });

  it("withholds links that point somewhere unsafe, so they're neither offered nor selectable", async () => {
    await add({ senderEmail: "ok@x.com", messageCount: 9 });
    await add({ senderEmail: "metadata@x.com", messageCount: 8, listUnsubscribe: "<https://169.254.169.254/latest/meta-data>" });
    await add({ senderEmail: "local@x.com", messageCount: 7, oneClick: false, listUnsubscribe: "<https://router.local/u>" });
    await add({ senderEmail: "mail@x.com", messageCount: 6, oneClick: false, listUnsubscribe: "<mailto:u@x.com>" });
    const by = Object.fromEntries((await store.listNewsletters()).map((r) => [r.senderEmail, r.blocked]));
    expect(by["ok@x.com"]).toBeNull();
    expect(by["metadata@x.com"]).toMatch(/IP address/);
    expect(by["local@x.com"]).toMatch(/public internet/);
    expect(by["mail@x.com"]).toBeNull(); // mailto has no web link to judge
  });

  it("flags a sender that kept mailing more than 3 days after you unsubscribed", async () => {
    const unsub = new Date("2026-03-01T00:00:00Z");
    const mk = (email: string, lastSeen: string, status = "unsubscribed") => add({ senderEmail: email, status, unsubscribedAt: unsub, lastSeen: new Date(lastSeen) });
    await mk("quiet@x.com", "2026-02-28");
    await mk("grace@x.com", "2026-03-03"); // within the 3-day grace: probably already in flight
    await mk("ignoring@x.com", "2026-03-10");
    await mk("kept@x.com", "2026-03-10", "subscribed"); // not unsubscribed, so nothing to be "still" doing
    const by = Object.fromEntries((await store.listNewsletters()).map((r) => [r.senderEmail, r.stillSending]));
    expect(by).toEqual({ "quiet@x.com": false, "grace@x.com": false, "ignoring@x.com": true, "kept@x.com": false });
  });

  it("queueing only stages one-click senders and sends nothing", async () => {
    const one = await add({ senderEmail: "one@x.com" });
    const link = await add({ senderEmail: "link@x.com", oneClick: false, listUnsubscribe: "<https://x.com/u>" });
    const mail = await add({ senderEmail: "mail@x.com", oneClick: false, listUnsubscribe: "<mailto:u@x.com>" });
    const done = await add({ senderEmail: "done@x.com", status: "unsubscribed" });
    const kept = await add({ senderEmail: "kept@x.com", status: "ignored" });
    const ghost = "00000000-0000-0000-0000-000000000000";

    const r = await store.queueUnsubscribes([one.id, link.id, mail.id, done.id, kept.id, ghost, one.id]);
    expect(r.queued).toBe(1);
    expect(r.skipped.map((s) => s.reason).sort()).toEqual(["already ignored", "already unsubscribed", "can't be unsubscribed automatically", "can't be unsubscribed automatically", "not found"]);
    expect(await newsletter(one.id)).toMatchObject({ status: "subscribed", unsubscribedAt: null }); // staging changes nothing
    expect((await actionsFor(one.id))[0]).toMatchObject({ kind: "unsubscribe", status: "pending", details: { method: "one-click", host: "news.example.com" } });
  });

  it("won't stage the same sender twice, and refuses links that point inside your network", async () => {
    const s = await add({ senderEmail: "a@x.com" });
    expect((await store.queueUnsubscribes([s.id])).queued).toBe(1);
    expect(await store.queueUnsubscribes([s.id])).toMatchObject({ queued: 0, skipped: [{ reason: "already waiting for review" }] });
    expect(await actionsFor(s.id)).toHaveLength(1);

    const unsafe = ["<https://127.0.0.1/u>", "<https://169.254.169.254/latest>", "<https://localhost/u>", "<https://printer.local/u>", "<https://example.com:8443/u>"];
    for (const [i, bad] of unsafe.entries()) {
      const row = await add({ senderEmail: `bad-${i}@x.com`, listUnsubscribe: bad });
      const r = await store.queueUnsubscribes([row.id]);
      expect(r.queued, bad).toBe(0);
      expect(r.skipped[0].reason, bad).toMatch(/unsubscribe link/);
    }
  });

  it("lists exactly where each approved request would go", async () => {
    const s = await add({ senderEmail: "a@x.com", senderName: "Acme" });
    await store.queueUnsubscribes([s.id]);
    expect(await store.listPending()).toEqual([
      expect.objectContaining({ newsletterId: s.id, senderEmail: "a@x.com", senderName: "Acme", host: "news.example.com", url: "https://news.example.com/unsub?id=1" }),
    ]);
  });

  it("approving sends one request per sender, built from the stored header, then records the result", async () => {
    const s = await add({ senderEmail: "a@x.com" });
    await store.queueUnsubscribes([s.id]);
    const t = transportOk(200);
    const r = await store.approvePending({ transport: t });
    expect(r).toMatchObject({ succeeded: 1, failed: 0 });
    expect(t).toHaveBeenCalledTimes(1);
    expect(vi.mocked(t).mock.calls[0][0].url.href).toBe("https://news.example.com/unsub?id=1");
    expect(vi.mocked(t).mock.calls[0][0].body).toBe("List-Unsubscribe=One-Click");

    const n = await newsletter(s.id);
    expect(n.status).toBe("unsubscribed");
    expect(n.unsubscribedAt).toBeInstanceOf(Date);
    expect((await actionsFor(s.id))[0]).toMatchObject({ status: "executed", details: { message: "Unsubscribed.", httpStatus: 200 } });
    expect((await actionsFor(s.id))[0].executedAt).not.toBeNull();
    expect(await store.listPending()).toEqual([]);
  });

  it("failures are recorded with a reason, mark the sender failed, and can be tried again", async () => {
    const at = (n: string) => add({ senderEmail: `${n}@x.com`, listUnsubscribe: `<https://news.example.com/${n}>` });
    const rows = [await at("a"), await at("b"), await at("c")];
    await store.queueUnsubscribes(rows.map((r) => r.id));
    const statusByPath: Record<string, number> = { "/a": 500, "/b": 302, "/c": 204 };
    const t = vi.fn<Transport>(async ({ url }) => ({ status: statusByPath[url.pathname] }));

    const r = await store.approvePending({ transport: t });
    expect(r).toMatchObject({ succeeded: 1, failed: 2 });
    const all = await store.listNewsletters();
    const failed = all.filter((n) => n.status === "failed");
    expect(failed.map((n) => [n.senderEmail, n.lastError]).sort()).toEqual([
      ["a@x.com", "The sender's server answered HTTP 500."],
      ["b@x.com", "The sender redirected to another page. Open the unsubscribe link yourself to finish."],
    ]);
    expect(all.filter((n) => n.status === "unsubscribed").map((n) => n.senderEmail)).toEqual(["c@x.com"]);

    // a failed sender can be staged again
    expect((await store.queueUnsubscribes(failed.map((f) => f.id))).queued).toBe(2);
  });

  it("two simultaneous approvals send each request exactly once", async () => {
    const rows = await Promise.all(["a", "b", "c", "d", "e"].map((n) => add({ senderEmail: `${n}@x.com`, listUnsubscribe: `<https://news.example.com/u/${n}>` })));
    await store.queueUnsubscribes(rows.map((r) => r.id));
    const t = vi.fn<Transport>(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { status: 200 };
    });
    const [x, y] = await Promise.all([store.approvePending({ transport: t }), store.approvePending({ transport: t })]);
    expect(t).toHaveBeenCalledTimes(5);
    expect(x.succeeded + y.succeeded).toBe(5);
    const urls = vi.mocked(t).mock.calls.map((c) => c[0].url.href).sort();
    expect(new Set(urls).size).toBe(5); // no URL hit twice
  });

  it("approving specific items leaves the rest waiting", async () => {
    const a = await add({ senderEmail: "a@x.com", listUnsubscribe: "<https://news.example.com/a>" });
    const b = await add({ senderEmail: "b@x.com", listUnsubscribe: "<https://news.example.com/b>" });
    await store.queueUnsubscribes([a.id, b.id]);
    const pending = await store.listPending();
    const t = transportOk();
    await store.approvePending({ actionIds: [pending.find((p) => p.senderEmail === "a@x.com")!.actionId], transport: t });
    expect(t).toHaveBeenCalledTimes(1);
    expect((await newsletter(a.id)).status).toBe("unsubscribed");
    expect((await newsletter(b.id)).status).toBe("subscribed");
    expect((await store.listPending()).map((p) => p.senderEmail)).toEqual(["b@x.com"]);
  });

  it("re-checks at approval time: a sender whose header changed is not contacted blindly", async () => {
    const s = await add({ senderEmail: "a@x.com" });
    await store.queueUnsubscribes([s.id]);
    const t = transportOk();

    // the header now only offers mailto: nothing automatic is possible
    await db.update(schema.newsletters).set({ listUnsubscribe: "<mailto:u@x.com>", oneClick: false }).where(eq(schema.newsletters.id, s.id));
    expect(await store.listPending()).toEqual([]);
    expect(await store.approvePending({ transport: t })).toMatchObject({ succeeded: 0, failed: 1 });
    expect(t).not.toHaveBeenCalled();
    expect((await newsletter(s.id)).status).toBe("failed");
  });

  it("re-validates the address at approval time even if it was safe when staged", async () => {
    const s = await add({ senderEmail: "a@x.com" });
    await store.queueUnsubscribes([s.id]);
    await db.update(schema.newsletters).set({ listUnsubscribe: "<https://169.254.169.254/latest/meta-data>" }).where(eq(schema.newsletters.id, s.id));
    const t = transportOk();
    const r = await store.approvePending({ transport: t });
    expect(r).toMatchObject({ succeeded: 0, failed: 1 });
    expect(t).not.toHaveBeenCalled();
    expect((await actionsFor(s.id))[0].details).toMatchObject({ message: expect.stringMatching(/IP address/) });
  });

  it("rejecting sends nothing and leaves the sender subscribed", async () => {
    const a = await add({ senderEmail: "a@x.com", listUnsubscribe: "<https://news.example.com/a>" });
    const b = await add({ senderEmail: "b@x.com", listUnsubscribe: "<https://news.example.com/b>" });
    await store.queueUnsubscribes([a.id, b.id]);
    const first = (await store.listPending())[0];
    expect(await store.rejectPending([first.actionId])).toBe(1);
    expect(await store.listPending()).toHaveLength(1);
    expect(await store.rejectPending()).toBe(1); // clear the rest
    const t = transportOk();
    expect(await store.approvePending({ transport: t })).toMatchObject({ succeeded: 0, failed: 0 });
    expect(t).not.toHaveBeenCalled();
    expect((await newsletter(a.id)).status).toBe("subscribed");
    expect((await store.queueUnsubscribes([a.id])).queued).toBe(1); // and it can be staged again
  });

  it("manual unsubscribes are recorded once and only for senders still subscribed", async () => {
    const s = await add({ senderEmail: "a@x.com", oneClick: false, listUnsubscribe: "<https://x.com/u>" });
    expect(await store.markUnsubscribedManually(s.id)).toBe(true);
    expect(await store.markUnsubscribedManually(s.id)).toBe(false);
    expect(await newsletter(s.id)).toMatchObject({ status: "unsubscribed" });
    expect((await newsletter(s.id)).unsubscribedAt).toBeInstanceOf(Date);
    expect(await actionsFor(s.id)).toMatchObject([{ status: "executed", details: { method: "manual" } }]);
    expect(await store.markUnsubscribedManually("00000000-0000-0000-0000-000000000000")).toBe(false);
  });

  it("keeping a sender hides it from cleanup and can be undone, but not after unsubscribing", async () => {
    const s = await add({ senderEmail: "a@x.com" });
    expect(await store.setKept(s.id, true)).toBe(true);
    expect((await newsletter(s.id)).status).toBe("ignored");
    expect((await store.queueUnsubscribes([s.id])).queued).toBe(0);
    expect(await store.setKept(s.id, false)).toBe(true);
    expect((await newsletter(s.id)).status).toBe("subscribed");

    const done = await add({ senderEmail: "done@x.com", status: "unsubscribed" });
    expect(await store.setKept(done.id, true)).toBe(false);
    expect(await store.setKept(s.id, false)).toBe(false); // not currently kept
  });

  it("wiping a mailbox removes its newsletters and their review log, and only those", async () => {
    await mailboxes.saveConnection({ provider: "google", mailbox: A, refreshToken: "rt", scopes: "s" });
    const mine = await add({ senderEmail: "a@x.com", mailbox: A });
    const theirs = await add({ senderEmail: "b@x.com", mailbox: B });
    await store.queueUnsubscribes([mine.id, theirs.id]);
    await store.approvePending({ transport: transportOk() });

    await mailboxes.disconnectMailbox(A, { wipe: true });
    expect(await db.select().from(schema.newsletters).where(eq(schema.newsletters.mailbox, A))).toHaveLength(0);
    expect(await actionsFor(mine.id)).toHaveLength(0);
    expect(await db.select().from(schema.newsletters).where(eq(schema.newsletters.mailbox, B))).toHaveLength(1);
    expect(await actionsFor(theirs.id)).toHaveLength(1);
  });
});
