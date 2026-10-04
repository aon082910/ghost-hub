import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { GetResponse, GetTransport } from "./http";

/** Runs against a real Postgres. Skipped unless TEST_DATABASE_URL is set. */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("profile store and runner (integration)", () => {
  let store: typeof import("./store");
  let runner: typeof import("./runner");
  let check: typeof import("./check");
  let sites: typeof import("./sites");
  let mailboxes: typeof import("../mailboxes");
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
    store = await import("./store");
    runner = await import("./runner");
    check = await import("./check");
    sites = await import("./sites");
    mailboxes = await import("../mailboxes");
  });

  const wipe = async () => {
    for (const t of [schema.shadowProfiles, schema.profileIdentifiers, schema.mailboxConnections]) await db.delete(t);
  };
  beforeEach(async () => {
    (globalThis as { __ghostHubProfileJob?: unknown }).__ghostHubProfileJob = undefined;
    await wipe();
  });
  afterAll(wipe);

  const rows = async () => store.loadResults();
  const find = async (type: string, identifier: string, site: string) => (await rows()).find((r) => r.identifierType === type && r.identifier === identifier && r.site === site);
  const connect = (mailbox: string) => mailboxes.saveConnection({ provider: "google", mailbox, refreshToken: "rt", scopes: "s" });

  describe("usernames", () => {
    it("normalises (trim, leading @, lowercase) and refuses duplicates in any casing", async () => {
      expect(await store.addUsername("  @Octo.Cat ")).toEqual({ ok: true, value: "octo.cat" });
      expect(await store.addUsername("OCTO.CAT")).toMatchObject({ ok: false, error: expect.stringMatching(/already/) });
      expect((await store.listUsernames()).map((u) => u.value)).toEqual(["octo.cat"]);
    });

    it("rejects names that could be used to build odd URLs", async () => {
      for (const bad of ["", "   ", "a b", "../etc/passwd", "x/y", "x?y=1", "a..b", "a".repeat(41), "naïve", "a@b.com", "<script>"]) {
        expect(await store.addUsername(bad), JSON.stringify(bad)).toMatchObject({ ok: false });
      }
      expect(await store.listUsernames()).toEqual([]);
    });

    it(`stops at ${10} usernames`, async () => {
      for (let i = 0; i < 10; i++) expect((await store.addUsername(`user${i}`)).ok).toBe(true);
      expect(await store.addUsername("one-too-many")).toMatchObject({ ok: false, error: expect.stringMatching(/up to 10/) });
    });

    it("removing a username deletes its results and nothing else", async () => {
      const a = await store.addUsername("alice");
      await store.addUsername("bob");
      if (!a.ok) throw new Error("setup");
      await store.saveSiteResult("alice", "github", "https://github.com/alice", { status: "found", url: "https://github.com/alice" });
      await store.saveSiteResult("bob", "github", "https://github.com/bob", { status: "found", url: "https://github.com/bob" });
      const id = (await store.listUsernames()).find((u) => u.value === "alice")!.id;
      expect(await store.removeUsername(id)).toBe(true);
      expect(await store.removeUsername(id)).toBe(false);
      expect((await store.listUsernames()).map((u) => u.value)).toEqual(["bob"]);
      expect((await rows()).map((r) => r.identifier)).toEqual(["bob"]);
    });

    it("suggests usable local parts of connected addresses, minus ones already added", async () => {
      await connect("test.user@gmail.com");
      await connect("john+news@gmail.com"); // '+' can't be in a username
      await connect("alice@outlook.com");
      await store.addUsername("alice");
      expect(await store.suggestUsernames()).toEqual(["test.user"]);
    });
  });

  describe("saving results", () => {
    it("a failed check never replaces an earlier real answer", async () => {
      await store.saveSiteResult("alice", "github", "https://github.com/alice", { status: "found", url: "https://github.com/alice" });
      await store.saveSiteResult("alice", "github", "https://github.com/alice", { status: "error", detail: "The site blocks automated requests" });
      expect(await find("username", "alice", "github")).toMatchObject({ status: "found", url: "https://github.com/alice", detail: null });

      await store.saveSiteResult("alice", "codeberg", "https://codeberg.org/alice", { status: "not_found" });
      await store.saveSiteResult("alice", "codeberg", "https://codeberg.org/alice", { status: "error", detail: "timeout" });
      expect(await find("username", "alice", "codeberg")).toMatchObject({ status: "not_found" });
    });

    it("a new real answer does replace an old one, and a first-time error is kept with its reason", async () => {
      await store.saveSiteResult("alice", "github", "https://github.com/alice", { status: "found", url: "https://github.com/alice" });
      await store.saveSiteResult("alice", "github", "https://github.com/alice", { status: "not_found" });
      expect(await find("username", "alice", "github")).toMatchObject({ status: "not_found", url: null });

      await store.saveSiteResult("alice", "steam", "https://steamcommunity.com/id/alice", { status: "error", detail: "The site is rate limiting requests" });
      expect(await find("username", "alice", "steam")).toMatchObject({ status: "error", detail: "The site is rate limiting requests", url: null });
      await store.saveSiteResult("alice", "steam", "https://steamcommunity.com/id/alice", { status: "found", url: "https://steamcommunity.com/id/alice" });
      expect(await find("username", "alice", "steam")).toMatchObject({ status: "found", detail: null });
    });

    it("stores Gravatar's profile and linked accounts, and replaces the links on a recheck", async () => {
      const email = "me@gmail.com";
      await store.saveGravatarResult(email, {
        status: "found",
        profileUrl: "https://gravatar.com/me",
        linked: [{ service: "GitHub", url: "https://github.com/me" }, { service: "Mastodon", url: "https://mastodon.social/@me" }],
      });
      let all = (await rows()).filter((r) => r.identifier === email);
      expect(all.find((r) => r.site === "gravatar")).toMatchObject({ status: "found", url: "https://gravatar.com/me" });
      expect(all.filter((r) => r.site.startsWith("linked:")).map((r) => [r.detail, r.url]).sort()).toEqual([["GitHub", "https://github.com/me"], ["Mastodon", "https://mastodon.social/@me"]]);

      await store.saveGravatarResult(email, { status: "found", profileUrl: "https://gravatar.com/me", linked: [{ service: "GitHub", url: "https://github.com/me" }] });
      all = (await rows()).filter((r) => r.identifier === email);
      expect(all.filter((r) => r.site.startsWith("linked:"))).toHaveLength(1);

      await store.saveGravatarResult(email, { status: "error", detail: "The site is rate limiting requests" }); // keeps what we knew
      expect((await rows()).filter((r) => r.identifier === email && r.site.startsWith("linked:"))).toHaveLength(1);
      expect(await find("email", email, "gravatar")).toMatchObject({ status: "found" });

      await store.saveGravatarResult(email, { status: "not_found" }); // the profile is gone, so are its links
      all = (await rows()).filter((r) => r.identifier === email);
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ site: "gravatar", status: "not_found" });
    });

    it("reports when each identifier was last checked", async () => {
      await store.saveSiteResult("alice", "github", "u", { status: "not_found" }, new Date("2026-01-01T00:00:00Z"));
      await store.saveSiteResult("alice", "codeberg", "u", { status: "not_found" }, new Date("2026-02-01T00:00:00Z"));
      const m = await store.lastChecked("username", ["alice", "nobody"]);
      expect(m.get("alice")?.toISOString()).toBe("2026-02-01T00:00:00.000Z");
      expect(m.has("nobody")).toBe(false);
      expect((await store.lastChecked("username", [])).size).toBe(0);
    });
  });

  describe("the background run", () => {
    const profileJson = JSON.stringify({ display_name: "Me", profile_url: "https://gravatar.com/me", verified_accounts: [{ service_label: "GitHub", url: "https://github.com/me" }] });
    const json = (status: number, body = ""): GetResponse => ({ status, body });

    /** A pretend internet: GitHub knows `alice`, Gravatar knows one address, everything else says 404. */
    function internet(opts: { gate?: Promise<void>; seen?: string[]; fail?: string } = {}): GetTransport {
      return async ({ url }) => {
        opts.seen?.push(url.href);
        if (opts.gate) await opts.gate;
        if (url.hostname === opts.fail) throw Object.assign(new Error("boom"), { code: "ECONNRESET" });
        if (url.hostname === "github.com") return json(url.pathname === "/alice" ? 200 : 404);
        if (url.hostname === "api.gravatar.com") return url.pathname.endsWith(check.gravatarHash("me@gmail.com")) ? json(200, profileJson) : json(404);
        // Some sites say "no such user" with a 200 and a marker in the page; the rest use 404 (or 400 for a couple).
        const textSite = sites.loadSites().find((x) => x.notFoundText && new URL(sites.requestUrl(x, "alice")).hostname === url.hostname);
        if (textSite) return json(200, textSite.notFoundText);
        const statusSite = sites.loadSites().find((x) => new URL(sites.requestUrl(x, "alice")).hostname === url.hostname);
        return json(statusSite?.notFoundStatus?.[0] ?? 404);
      };
    }
    const done = async () => {
      for (let i = 0; i < 200; i++) {
        if (!runner.getProfileJob()?.running) return;
        await new Promise((r) => setTimeout(r, 15));
      }
      throw new Error("job did not finish");
    };

    it("checks every applicable site for each username and Gravatar for each connected address", async () => {
      const seen: string[] = [];
      await store.addUsername("alice");
      await connect("me@gmail.com");
      const r = await runner.startProfileScan({ transport: internet({ seen }) });
      expect(r).toMatchObject({ started: true, skippedRecent: 0 });
      await done();

      const job = runner.getProfileJob()!;
      expect(job).toMatchObject({ running: false, done: r.started ? r.total : -1, errors: 0 });
      expect(job.found).toBe(2); // alice on GitHub + the Gravatar profile
      expect(await find("username", "alice", "github")).toMatchObject({ status: "found", url: "https://github.com/alice" });
      expect(await find("username", "alice", "codeberg")).toMatchObject({ status: "not_found" });
      expect(await find("email", "me@gmail.com", "gravatar")).toMatchObject({ status: "found" });
      expect((await rows()).filter((x) => x.site.startsWith("linked:"))).toHaveLength(1);
      // sites that can't have this username are skipped, not recorded (alice has no ".", digits...: all patterns allow it except a few)
      const sitesChecked = (await rows()).filter((x) => x.identifierType === "username").length;
      expect(sitesChecked).toBe(r.started ? r.total - 1 : -1);
    });

    it("only ever looks up your own identifiers", async () => {
      const seen: string[] = [];
      await store.addUsername("alice");
      await connect("me@gmail.com");
      await store.saveSiteResult("stranger", "github", "u", { status: "found", url: "https://github.com/stranger" }); // not on the list
      await runner.startProfileScan({ transport: internet({ seen }) });
      await done();
      const requested = seen.join("\n");
      expect(requested).toContain("alice");
      expect(requested).toContain(check.gravatarHash("me@gmail.com"));
      expect(requested).not.toMatch(/stranger/);
      expect(requested).not.toMatch(/me@gmail|%40/); // the address itself is never sent
      expect(await find("username", "stranger", "github")).toMatchObject({ status: "found" }); // and it's untouched
    });

    it("has nothing to do without identifiers", async () => {
      expect(await runner.startProfileScan({ transport: internet() })).toEqual({ started: false, reason: "nothing", skippedRecent: 0 });
      expect(runner.getProfileJob()).toBeNull();
    });

    it("won't recheck an identifier within the cooldown, but will afterwards", async () => {
      await store.addUsername("alice");
      const t = internet();
      const first = await runner.startProfileScan({ transport: t, now: new Date("2026-06-01T12:00:00Z") });
      expect(first.started).toBe(true);
      await done();
      expect(await runner.startProfileScan({ transport: t, now: new Date("2026-06-01T12:05:00Z") })).toEqual({ started: false, reason: "recent", skippedRecent: 1 });
      const later = await runner.startProfileScan({ transport: t, now: new Date("2026-06-01T12:11:00Z") });
      expect(later.started).toBe(true);
      await done();
    });

    it("runs one job at a time", async () => {
      await store.addUsername("alice");
      let open!: () => void;
      const gate = new Promise<void>((r) => (open = r));
      const first = await runner.startProfileScan({ transport: internet({ gate }) });
      expect(first.started).toBe(true);
      expect(runner.getProfileJob()).toMatchObject({ running: true });
      expect(await runner.startProfileScan({ transport: internet() })).toMatchObject({ started: false, reason: "running" });
      open();
      await done();
      expect(runner.getProfileJob()!.running).toBe(false);
    });

    it("two simultaneous starts produce a single job", async () => {
      await store.addUsername("alice");
      const results = await Promise.all([runner.startProfileScan({ transport: internet() }), runner.startProfileScan({ transport: internet() })]);
      expect(results.map((r) => r.started).sort()).toEqual([false, true]);
      await done();
    });

    it("can be cancelled, stops picking up new sites, and keeps what it finished", async () => {
      await store.addUsername("alice");
      let first = true;
      const t: GetTransport = async ({ url }) => {
        if (first) {
          first = false;
          runner.cancelProfileScan();
        }
        await new Promise((r) => setTimeout(r, 10));
        return json(url.hostname === "github.com" && url.pathname === "/alice" ? 200 : 404, "No such user.");
      };
      const r = await runner.startProfileScan({ transport: t });
      await done();
      const job = runner.getProfileJob()!;
      expect(job.cancelled).toBe(true);
      expect(job.done).toBeLessThan(r.started ? r.total : 0);
      expect(runner.cancelProfileScan()).toBe(false); // nothing running any more
    });

    it("a site that fails is counted and explained without stopping the others", async () => {
      await store.addUsername("alice");
      await runner.startProfileScan({ transport: internet({ fail: "codeberg.org" }) });
      await done();
      expect(runner.getProfileJob()).toMatchObject({ errors: 1 });
      expect(await find("username", "alice", "codeberg")).toMatchObject({ status: "error", detail: expect.stringMatching(/Couldn't reach/) });
      expect(await find("username", "alice", "github")).toMatchObject({ status: "found" });
    });

    it("rescanning keeps real answers when a site now fails", async () => {
      await store.addUsername("alice");
      await runner.startProfileScan({ transport: internet(), now: new Date("2026-06-01T00:00:00Z") });
      await done();
      await runner.startProfileScan({ transport: internet({ fail: "github.com" }), now: new Date("2026-06-02T00:00:00Z") });
      await done();
      expect(await find("username", "alice", "github")).toMatchObject({ status: "found", url: "https://github.com/alice" });
    });

    it("wiping a mailbox removes what was found for that address, but not your usernames' results", async () => {
      await connect("me@gmail.com");
      await store.addUsername("alice");
      await runner.startProfileScan({ transport: internet() });
      await done();
      await mailboxes.disconnectMailbox("me@gmail.com", { wipe: true });
      const left = await rows();
      expect(left.some((r) => r.identifierType === "email")).toBe(false);
      expect(left.some((r) => r.identifierType === "username" && r.identifier === "alice")).toBe(true);
    });
  });
});
