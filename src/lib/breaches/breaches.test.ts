import { describe, expect, it, vi } from "vitest";
import sample from "./hibp-sample.fixture.json";
import { HIBP_USER_AGENT, HibpError, fetchCatalog, fetchMailboxBreaches, parseCatalog, type Breach } from "./hibp";
import { indexBreaches, matchService } from "./match";
import { assessRisk, exposureFor, levelFor, severity, type BreachMatch, type RiskInput } from "./risk";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("parseCatalog (real HIBP sample)", () => {
  const { breaches, skipped } = parseCatalog(sample);
  const names = breaches.map((b) => b.name);

  it("keeps real breaches that name a domain", () => {
    expect(names).toEqual(expect.arrayContaining(["Adobe", "LinkedIn", "Dropbox", "000webhost", "123RF", "126", "AdultFriendFinder", "17173", "BTSec"]));
    expect(skipped).toBe(0);
  });

  it("drops fabricated, spam lists, malware, stealer logs, retired and domain-less entries", () => {
    for (const n of ["JustDate", "Acuity", "Emotet", "AlienStealerLogs", "2844Breaches", "Ticketek"]) expect(names, n).not.toContain(n);
  });

  it("maps fields and normalises the domain", () => {
    expect(breaches.find((b) => b.name === "Adobe")).toMatchObject({
      domain: "adobe.com",
      breachDate: "2013-10-04",
      isVerified: true,
      dataClasses: expect.arrayContaining(["Passwords", "Password hints"]),
    });
    expect(breaches.find((b) => b.name === "17173")!.isVerified).toBe(false);
  });

  it("skips malformed entries instead of failing the whole refresh, and rejects non-lists", () => {
    const r = parseCatalog([{ Name: "Ok", Domain: "ok.com", DataClasses: ["Passwords"] }, {}, null, { Name: 5 }, "x"]);
    expect(r.breaches.map((b) => b.name)).toEqual(["Ok"]);
    expect(r.skipped).toBe(4);
    expect(() => parseCatalog({ breaches: [] })).toThrow(/expected a list/);
  });

  it("lowercases domains and only accepts ISO breach dates", () => {
    const r = parseCatalog([
      { Name: "A", Domain: " EXAMPLE.com ", BreachDate: "2020-05-06" },
      { Name: "B", Domain: "b.com", BreachDate: "May 2020" },
      { Name: "C", Domain: "c.com", BreachDate: null },
    ]).breaches;
    expect(r.map((b) => [b.domain, b.breachDate])).toEqual([["example.com", "2020-05-06"], ["b.com", null], ["c.com", null]]);
  });
});

describe("HIBP requests", () => {
  it("fetches the catalog with the required User-Agent and no key", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json(sample));
    const r = await fetchCatalog({ fetchImpl });
    expect(r.breaches.length).toBeGreaterThan(5);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://haveibeenpwned.com/api/v3/breaches");
    const h = new Headers(init!.headers);
    expect(h.get("user-agent")).toBe(HIBP_USER_AGENT);
    expect(h.get("hibp-api-key")).toBeNull();
  });

  it("surfaces HTTP errors from the catalog", async () => {
    await expect(fetchCatalog({ fetchImpl: async () => json({}, 503) })).rejects.toMatchObject({ name: "HibpError", status: 503 });
  });

  it("looks up a mailbox with the key, URL-encoding the address, and returns breach names", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json([{ Name: "Adobe" }, { Name: "LinkedIn" }, { nope: 1 }]));
    expect(await fetchMailboxBreaches("me+tag@gmail.com", "KEY", { fetchImpl })).toEqual(["Adobe", "LinkedIn"]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://haveibeenpwned.com/api/v3/breachedaccount/me%2Btag%40gmail.com?truncateResponse=true");
    expect(new Headers(init!.headers).get("hibp-api-key")).toBe("KEY");
  });

  it("treats 404 as 'in no breaches' and 401 as a bad key", async () => {
    expect(await fetchMailboxBreaches("a@b.com", "K", { fetchImpl: async () => new Response("", { status: 404 }) })).toEqual([]);
    await expect(fetchMailboxBreaches("a@b.com", "K", { fetchImpl: async () => json({}, 401) })).rejects.toMatchObject({ status: 401 });
  });

  it("waits out one 429 (honouring Retry-After) and then succeeds; a second 429 fails", async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    const once = vi.fn<typeof fetch>().mockResolvedValueOnce(json({}, 429, { "retry-after": "3" })).mockResolvedValueOnce(json([{ Name: "X" }]));
    expect(await fetchMailboxBreaches("a@b.com", "K", { fetchImpl: once, sleep })).toEqual(["X"]);
    expect(sleep).toHaveBeenCalledWith(3000);

    const twice = vi.fn<typeof fetch>(async () => json({}, 429, { "retry-after": "999" }));
    await expect(fetchMailboxBreaches("a@b.com", "K", { fetchImpl: twice, sleep })).rejects.toBeInstanceOf(HibpError);
    expect(sleep).toHaveBeenLastCalledWith(30_000); // capped
  });

  it("rejects a non-list body", async () => {
    await expect(fetchMailboxBreaches("a@b.com", "K", { fetchImpl: async () => json({ x: 1 }) })).rejects.toThrow(/Unexpected response/);
  });
});

describe("matching breaches to services", () => {
  const b = (name: string, domain: string): Breach => ({ name, title: name, domain, breachDate: "2020-01-01", pwnCount: 1, dataClasses: ["Passwords"], isVerified: true });
  const index = indexBreaches([b("Adobe", "adobe.com"), b("AdobeAgain", "www.adobe.com"), b("Forum", "forums.example.com"), b("Reg", "shop.example.co.uk"), b("Bad", "10.0.0.1"), b("Bad2", "localhost")]);

  it("indexes by registrable domain and records whether the breach was the bare domain or a subdomain", () => {
    expect(index.get("adobe.com")!.map((x) => [x.name, x.scope])).toEqual([["Adobe", "domain"], ["AdobeAgain", "domain"]]);
    expect(index.get("example.com")![0]).toMatchObject({ name: "Forum", scope: "subdomain" });
    expect(index.get("example.co.uk")![0]).toMatchObject({ name: "Reg", scope: "subdomain" });
  });

  it("ignores breaches whose domain isn't a real hostname", () => {
    expect([...index.keys()].sort()).toEqual(["adobe.com", "example.co.uk", "example.com"]);
  });

  it("marks breaches the user's address is in as confirmed", () => {
    const m = matchService("adobe.com", index, new Set(["Adobe"]));
    expect(m.map((x) => [x.name, x.confirmed])).toEqual([["Adobe", true], ["AdobeAgain", false]]);
    expect(matchService("nothing.com", index, new Set())).toEqual([]);
  });
});

describe("severity tiers", () => {
  it("is set by the worst class present", () => {
    expect(severity(["Email addresses", "Passwords"])).toEqual({ points: 50, tier: "credentials" });
    expect(severity(["Email addresses", "Credit cards", "Names"]).tier).toBe("financial");
    expect(severity(["Email addresses", "Phone numbers"]).tier).toBe("identity");
    expect(severity(["Email addresses", "Usernames", "IP addresses"]).tier).toBe("basic");
    expect(severity([]).tier).toBe("basic");
    // credentials outrank financial when both leaked
    expect(severity(["Credit cards", "Password hints"]).tier).toBe("credentials");
  });
});

describe("risk assessment", () => {
  const now = new Date("2026-06-01T00:00:00Z");
  const mk = (o: Partial<BreachMatch> = {}): BreachMatch => ({
    name: "B", title: "B", domain: "x.com", breachDate: "2020-01-01", pwnCount: 1, dataClasses: ["Email addresses", "Passwords"],
    isVerified: true, scope: "domain", confirmed: false, ...o,
  });
  const input = (o: Partial<RiskInput> = {}): RiskInput => ({
    category: "account", firstSeen: new Date("2018-01-01"), lastSeen: new Date("2026-05-01"), breaches: [], ...o,
  });
  const score = (o: Partial<RiskInput>) => assessRisk(input(o), now).score;

  it("an active account with no known breach is low risk", () => {
    expect(assessRisk(input(), now)).toMatchObject({ score: 15, level: "low", factors: [{ points: 15 }] });
  });

  it("scores each category's baseline", () => {
    expect(score({ category: "subscription" })).toBe(10);
    expect(score({ category: "receipt" })).toBe(5);
    expect(score({ category: "newsletter" })).toBe(0);
    expect(assessRisk(input({ category: "newsletter" }), now).level).toBe("minimal");
  });

  it("flags a forgotten account (no mail for 2+ years) but not for receipts or newsletters", () => {
    const old = { lastSeen: new Date("2023-01-01") };
    expect(score(old)).toBe(30);
    expect(score({ ...old, category: "subscription" })).toBe(25);
    expect(score({ ...old, category: "receipt" })).toBe(5);
    expect(score({ ...old, category: "newsletter" })).toBe(0);
    expect(score({ lastSeen: new Date("2024-07-01") })).toBe(15); // under 2 years
  });

  it("a confirmed password breach is high risk; likely is medium; one that predates you is low", () => {
    expect(assessRisk(input({ breaches: [mk({ confirmed: true })] }), now)).toMatchObject({ score: 65, level: "high" });
    expect(assessRisk(input({ breaches: [mk()] }), now)).toMatchObject({ score: 55, level: "medium" });
    expect(assessRisk(input({ firstSeen: new Date("2021-01-01"), breaches: [mk()] }), now)).toMatchObject({ score: 30, level: "low" });
  });

  it("works out exposure from when the service first emailed you, with a 30-day grace", () => {
    const first = new Date("2020-02-01");
    expect(exposureFor(mk({ breachDate: "2020-01-15" }), first).exposure).toBe("likely"); // 17 days before: probably affected
    expect(exposureFor(mk({ breachDate: "2019-12-01" }), first).exposure).toBe("before"); // 62 days before
    expect(exposureFor(mk({ breachDate: null }), first)).toEqual({ exposure: "unknown", factor: 0.6 });
    expect(exposureFor(mk({ breachDate: "2010-01-01", confirmed: true }), first).exposure).toBe("confirmed"); // confirmed trumps dates
  });

  it("discounts unverified breaches, subdomain-scoped breaches and newsletters", () => {
    expect(assessRisk(input({ breaches: [mk({ isVerified: false })] }), now).score).toBe(35); // 15 + 20
    expect(assessRisk(input({ breaches: [mk({ scope: "subdomain" })] }), now).score).toBe(35); // 15 + 20
    expect(assessRisk(input({ category: "newsletter", breaches: [mk()] }), now).score).toBe(20); // 0 + 20
  });

  it("grades other data classes lower than passwords", () => {
    expect(score({ breaches: [mk({ confirmed: true, dataClasses: ["Credit cards"] })] })).toBe(45); // 15 + 30
    expect(score({ breaches: [mk({ confirmed: true, dataClasses: ["Phone numbers"] })] })).toBe(33); // 15 + 18
    expect(score({ breaches: [mk({ confirmed: true, dataClasses: ["Email addresses"] })] })).toBe(23); // 15 + 8
  });

  it("counts only the three worst breaches and caps their contribution at 60", () => {
    const many = Array.from({ length: 5 }, (_, i) => mk({ name: `B${i}`, confirmed: true }));
    const r = assessRisk(input({ breaches: many }), now);
    expect(r.score).toBe(75); // 15 + capped 60
    expect(r.factors.find((f) => /5 known breaches/.test(f.label))!.points).toBe(60);
    expect(r.breaches).toHaveLength(5); // all are still listed for the user
  });

  it("orders the listed breaches worst first, then newest", () => {
    const r = assessRisk(
      input({
        breaches: [
          mk({ name: "Old", confirmed: true, breachDate: "2012-01-01" }),
          mk({ name: "Mild", confirmed: true, dataClasses: ["Usernames"] }),
          mk({ name: "New", confirmed: true, breachDate: "2022-01-01" }),
        ],
      }),
      now,
    );
    expect(r.breaches.map((b) => b.name)).toEqual(["New", "Old", "Mild"]);
  });

  it("factors always add up to the score (before the cap) and use singular wording for one breach", () => {
    const r = assessRisk(input({ lastSeen: new Date("2022-01-01"), breaches: [mk({ confirmed: true })] }), now);
    expect(r.factors.reduce((s, f) => s + f.points, 0)).toBe(r.score);
    expect(r.factors.map((f) => f.label).join("|")).toMatch(/1 known breach of this service/);
  });

  it("maps scores to levels at the boundaries", () => {
    expect([0, 14, 15, 34, 35, 59, 60, 100].map(levelFor)).toEqual(["minimal", "minimal", "low", "low", "medium", "medium", "high", "high"]);
  });
});
