import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailSource, MessageHeader, PagesOptions } from "./types";

/** Runs against a real Postgres. Skipped unless TEST_DATABASE_URL is set. */
const url = process.env.TEST_DATABASE_URL;
const ME = "me@gmail.com";

// A source that waits until released, so tests control when a scan finishes.
const gates = new Set<() => void>();
const release = () => {
  for (const open of gates) open();
  gates.clear();
};
let sourcesCreated = 0;
vi.mock("./sources", () => ({
  createSource: async (): Promise<MailSource> => {
    sourcesCreated++;
    const gate = new Promise<void>((r) => gates.add(r));
    return {
      total: async () => 1,
      pages: ({ signal }: PagesOptions) =>
        (async function* (): AsyncGenerator<MessageHeader[]> {
          signal?.throwIfAborted(); // like the real sources: checks current state, not just future events
          await Promise.race([
            gate,
            new Promise((_, rej) => signal?.addEventListener("abort", () => rej(signal.reason), { once: true })),
          ]);
          signal?.throwIfAborted();
          yield [{ id: "x1", date: new Date("2024-01-01"), fromEmail: "hello@svc.com", fromName: null, subject: "Welcome to Svc" }];
        })(),
      close: async () => {},
    };
  },
}));

describe.skipIf(!url)("scan registry (integration)", () => {
  let reg: typeof import("./registry");
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
    reg = await import("./registry");
  });

  const wipe = async () => {
    for (const t of [schema.accounts, schema.newsletters, schema.messagesSeen, schema.scans]) await db.delete(t);
  };
  beforeEach(async () => {
    sourcesCreated = 0;
    gates.clear();
    await wipe();
  });
  afterAll(wipe);

  const until = async (cond: () => Promise<boolean> | boolean) => {
    for (let i = 0; i < 100; i++) {
      if (await cond()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("timed out waiting for condition");
  };
  const statusOf = async (id: string) => (await db.select().from(schema.scans).where(eq(schema.scans.id, id)))[0].status;

  it("two simultaneous starts for one mailbox produce a single scan", async () => {
    const [a, b] = await Promise.all([reg.startScan(ME), reg.startScan(ME)]);
    expect(a.scanId).toBe(b.scanId);
    expect([a.alreadyRunning, b.alreadyRunning].sort()).toEqual([false, true]);
    expect(await db.select().from(schema.scans)).toHaveLength(1);
    expect(reg.isScanning(ME)).toBe(true);

    await until(() => sourcesCreated === 1);
    release();
    await until(() => !reg.isScanning(ME));
    expect(await statusOf(a.scanId)).toBe("done");
    expect(sourcesCreated).toBe(1);
  });

  it("different mailboxes scan independently, and a finished mailbox can scan again", async () => {
    const a = await reg.startScan("a@gmail.com");
    const b = await reg.startScan("b@gmail.com");
    expect(a.scanId).not.toBe(b.scanId);
    await until(() => sourcesCreated === 2);
    release();
    await until(() => !reg.isScanning("a@gmail.com") && !reg.isScanning("b@gmail.com"));

    const again = await reg.startScan("a@gmail.com");
    expect(again.alreadyRunning).toBe(false);
    await until(() => sourcesCreated === 3);
    release();
    await until(() => !reg.isScanning("a@gmail.com"));
  });

  it("cancelScan stops a running scan and reports whether there was one", async () => {
    expect(reg.cancelScan(ME)).toBe(false);
    const { scanId } = await reg.startScan(ME);
    await until(() => sourcesCreated === 1);
    expect(reg.cancelScan(ME)).toBe(true);
    await until(() => !reg.isScanning(ME));
    expect(await statusOf(scanId)).toBe("cancelled");
  });

  it("marks scans left running by a restart as failed, and leaves finished ones alone", async () => {
    const [orphan] = await db.insert(schema.scans).values({ mailbox: ME, status: "running" }).returning();
    const [done] = await db.insert(schema.scans).values({ mailbox: ME, status: "done" }).returning();
    await reg.markInterruptedScans();
    const o = (await db.select().from(schema.scans).where(eq(schema.scans.id, orphan.id)))[0];
    expect(o.status).toBe("failed");
    expect(o.error).toMatch(/Interrupted by a restart/);
    expect(o.finishedAt).not.toBeNull();
    expect(await statusOf(done.id)).toBe("done");
  });

  it("latestScan returns the newest scan for a mailbox, or null", async () => {
    expect(await reg.latestScan(ME)).toBeNull();
    await db.insert(schema.scans).values({ mailbox: ME, status: "done", startedAt: new Date("2024-01-01") });
    const [newer] = await db.insert(schema.scans).values({ mailbox: ME, status: "failed", startedAt: new Date("2025-01-01") }).returning();
    expect((await reg.latestScan(ME))?.id).toBe(newer.id);
    expect(await reg.latestScan("other@gmail.com")).toBeNull();
  });
});
