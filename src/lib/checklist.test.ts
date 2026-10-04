import { describe, expect, it } from "vitest";
import { checklistItems, toCsv, toMarkdown } from "./checklist";
import type { ServiceRisk } from "./dashboard";

const NOW = new Date("2026-06-01T00:00:00Z");

function svc(o: Partial<ServiceRisk> & { domain: string }): ServiceRisk {
  return {
    name: o.domain,
    category: "account",
    messages: 3,
    spamCount: 0,
    firstSeen: new Date("2018-01-01T00:00:00Z"),
    lastSeen: new Date("2019-01-01T00:00:00Z"),
    mailboxes: 1,
    state: "active",
    deletedAt: null,
    domains: [o.domain],
    spamOnly: false,
    stillEmailing: false,
    risk: { score: 10, level: "low", factors: [], breaches: [], dormant: true } as unknown as ServiceRisk["risk"],
    ...o,
  };
}
const risk = (score: number, level: string, breaches: { name: string; title: string }[] = []) =>
  ({ score, level, factors: [], breaches, dormant: false }) as unknown as ServiceRisk["risk"];

describe("checklistItems", () => {
  const all = [
    svc({ domain: "usaa.com", name: "USAA", risk: risk(80, "high") }),
    svc({ domain: "quiet.com", risk: risk(5, "minimal") }),
    svc({ domain: "gone.com", state: "deleted" }),
    svc({ domain: "kept.com", state: "ignored" }),
    svc({ domain: "junk.xyz", spamOnly: true, spamCount: 3 }),
    svc({ domain: "news.com", category: "newsletter" }),
    svc({ domain: "paypal.com", risk: risk(60, "high", [{ name: "PP", title: "PayPal Leak" }]) }),
  ];

  it("lists only what is still to do, riskiest first", () => {
    expect(checklistItems(all).map((i) => i.domain)).toEqual(["usaa.com", "paypal.com", "quiet.com"]);
  });

  it("leaves out deleted, kept, spam-only and (by default) newsletter services", () => {
    const domains = checklistItems(all).map((i) => i.domain);
    for (const d of ["gone.com", "kept.com", "junk.xyz", "news.com"]) expect(domains).not.toContain(d);
    expect(checklistItems(all, { includeNewsletters: true }).map((i) => i.domain)).toContain("news.com");
  });

  it("carries the breach titles, the site and the deletion guide", () => {
    const pp = checklistItems(all).find((i) => i.domain === "paypal.com")!;
    expect(pp.breaches).toEqual(["PayPal Leak"]);
    expect(pp.siteUrl).toBe("https://paypal.com");
    expect(pp.deletion).not.toBeNull(); // PayPal is in the bundled guide dataset
  });

  it("shows merged domains once, with the others listed", () => {
    const [a] = checklistItems([svc({ domain: "amazon.com", domains: ["amazon.com", "amazon.co.uk"] })]);
    expect(a.alsoDomains).toEqual(["amazon.co.uk"]);
  });
});

describe("toMarkdown", () => {
  it("groups by risk with tick boxes and states the date and count", () => {
    const md = toMarkdown(checklistItems([svc({ domain: "usaa.com", name: "USAA", risk: risk(80, "high") }), svc({ domain: "quiet.com", risk: risk(5, "minimal") })]), NOW);
    expect(md).toContain("Made 2026-06-01. 2 services still on your list");
    expect(md.indexOf("## High risk (1)")).toBeLessThan(md.indexOf("## Minimal risk (1)"));
    expect(md).toContain("- [ ] **USAA**");
    expect(md).toContain("Site: <https://usaa.com>");
  });

  it("neutralises markdown, HTML and link syntax in names that came from email headers", () => {
    const name = "Evil [click](https://evil.test) <img src=x onerror=alert(1)> **bold** | `code`\nnew line";
    const md = toMarkdown(checklistItems([svc({ domain: "evil.com", name })]), NOW);
    const line = md.split("\n").find((l) => l.startsWith("- [ ]"))!;
    expect(line).not.toMatch(/(^|[^\\])\[click\]/);
    expect(line).not.toMatch(/(^|[^\\])</); // every < is escaped, so it renders as text, not HTML
    expect(line).not.toMatch(/(^|[^\\])\*\*bold/);
    expect(line).not.toContain("\n");
    expect(md.split("\n").filter((l) => l.startsWith("- [ ]"))).toHaveLength(1); // a newline in a name can't start a new item
  });

  it("is a readable message when there is nothing to do", () => {
    expect(toMarkdown([], NOW)).toContain("0 services still on your list");
  });
});

describe("toCsv", () => {
  it("has a header, one row per item and quotes every field", () => {
    const csv = toCsv(checklistItems([svc({ domain: "usaa.com", name: 'US, "AA"', risk: risk(80, "high") })]));
    const lines = csv.trimEnd().split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[0].startsWith('"Done","Service","Domain"')).toBe(true);
    expect(lines[1]).toContain('"US, ""AA"""');
  });

  it("stops spreadsheets running a cell as a formula", () => {
    for (const name of ["=HYPERLINK(\"http://evil.test\",\"x\")", "+1+1", "-2+3", "@SUM(A1)"]) {
      const csv = toCsv(checklistItems([svc({ domain: "evil.com", name })]));
      const second = csv.trimEnd().split("\r\n")[1];
      expect(second, name).toContain(`"'${name.replace(/"/g, '""')}"`);
      expect(second, name).not.toMatch(/(^|,)"[=+\-@]/);
    }
  });
});
