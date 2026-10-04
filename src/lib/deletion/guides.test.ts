import { describe, expect, it } from "vitest";
import { findGuides, guidesFor, loadGuides, parseNotes, viewGuide, type Guide } from "./guides";

const guide = (o: Partial<Guide> = {}): Guide => ({ name: "Acme", url: "https://acme.example.org/delete", difficulty: "easy", domains: ["acme.example.org"], ...o });

describe("the bundled dataset", () => {
  const guides = loadGuides();

  it("is large and well formed", () => {
    expect(guides.length).toBeGreaterThan(2000);
    for (const g of guides) {
      expect(() => new URL(g.url), `${g.name}: ${g.url}`).not.toThrow();
      expect(g.domains.length, g.name).toBeGreaterThan(0);
    }
  });

  it("never lets a dangerous URL scheme through", () => {
    for (const g of guides) expect(g.url, g.name).not.toMatch(/^\s*(javascript|data|vbscript|file):/i);
    for (const g of guides) {
      const v = viewGuide(g);
      if (v.openUrl) expect(v.openUrl.startsWith("https://"), g.name).toBe(true);
      if (v.mailto) expect(v.mailto.startsWith("mailto:"), g.name).toBe(true);
    }
  });

  it("covers the services people actually have, matched by domain", () => {
    const names = (d: string) => findGuides(d).map((g) => g.name);
    expect(names("github.com")).toContain("GitHub");
    expect(names("dropbox.com")).toContain("Dropbox");
    expect(names("paypal.com")).toContain("PayPal");
    expect(names("spotify.com")).toContain("Spotify");
    expect(names("adobe.com")).toContain("Adobe");
    expect(names("linkedin.com")).toContain("LinkedIn");
    expect(names("netflix.com")).toContain("Netflix");
    expect(names("amazon.com").join(" ")).toMatch(/Amazon/);
    expect(findGuides("GitHub.com").length).toBeGreaterThan(0); // case-insensitive
  });

  it("returns nothing for a service it doesn't know, and never more than three guides", () => {
    expect(findGuides("no-such-service-93217.com")).toEqual([]);
    expect(findGuides("")).toEqual([]);
    for (const d of ["google.com", "microsoft.com", "amazon.com", "apple.com", "yahoo.com"]) expect(findGuides(d).length, d).toBeLessThanOrEqual(3);
  });

  it("prefers a guide that lists the exact domain over one that only covers a subdomain", () => {
    for (const d of ["github.com", "dropbox.com", "spotify.com"]) {
      const first = findGuides(d)[0];
      expect(first.domains, d).toContain(d);
    }
  });
});

describe("viewGuide", () => {
  it("offers a deletion page only for plain https links", () => {
    expect(viewGuide(guide())).toMatchObject({ openUrl: "https://acme.example.org/delete", insecure: false });
    expect(viewGuide(guide({ url: "http://acme.example.org/delete" }))).toMatchObject({ openUrl: null, insecure: true });
    for (const url of ["javascript:alert(1)", "data:text/html,x", "ftp://acme.example.org/x", "https://user:pw@acme.example.org/x", "not a url"]) {
      expect(viewGuide(guide({ url })), url).toMatchObject({ openUrl: null, insecure: false });
    }
  });

  it("builds a mail link from the template, encoding spaces and symbols", () => {
    const v = viewGuide(guide({ email: "privacy@acme.example.org", emailSubject: "Delete my account", emailBody: "Hi,\nplease delete my data & account." }));
    expect(v.mailto).toBe("mailto:privacy@acme.example.org?subject=Delete%20my%20account&body=Hi%2C%0Aplease%20delete%20my%20data%20%26%20account.");
    expect(viewGuide(guide({ email: "privacy@acme.example.org" })).mailto).toBe("mailto:privacy@acme.example.org");
  });

  it("ignores addresses that aren't plain addresses", () => {
    for (const email of ["not-an-email", "a b@x.com", "a@b", "x@y.com,z@w.com", "<x@y.com>", ""]) {
      expect(viewGuide(guide({ email })).mailto, email).toBeNull();
    }
    expect(viewGuide(guide()).mailto).toBeNull();
  });

  it("guidesFor returns display-ready views", () => {
    const v = guidesFor("github.com");
    expect(v[0]).toMatchObject({ name: "GitHub", difficulty: "easy" });
    expect(v[0].openUrl).toMatch(/^https:\/\/github\.com\//);
  });
});

describe("parseNotes", () => {
  it("returns plain text as one segment", () => {
    expect(parseNotes("Click Delete account and confirm.")).toEqual([{ text: "Click Delete account and confirm." }]);
    expect(parseNotes("")).toEqual([]);
  });

  it("turns https markdown links into links and keeps the surrounding text", () => {
    expect(parseNotes("Message an [administrator](https://bukkit.org/staff) and ask.")).toEqual([
      { text: "Message an " },
      { text: "administrator", href: "https://bukkit.org/staff" },
      { text: " and ask." },
    ]);
    const two = parseNotes("See [a](https://a.example.org/x) or [b](https://b.example.org/y)");
    expect(two.filter((s) => s.href)).toHaveLength(2);
  });

  it("never makes a link out of anything but plain https", () => {
    for (const bad of ["[click](javascript:alert(1))", "[click](http://insecure.example.org)", "[click](data:text/html,x)", "[click](https://user:pw@evil.example.org/)", "[click](//evil.example.org)"]) {
      const segments = parseNotes(`Go ${bad} now`);
      expect(segments.some((s) => s.href), bad).toBe(false);
      expect(segments.map((s) => s.text).join(""), bad).toContain("click");
    }
  });

  it("strips HTML so markup can't reach the page", () => {
    const text = parseNotes('Use the <a href="javascript:alert(1)" onclick="x()">form</a><script>alert(1)</script> now').map((s) => s.text).join("");
    expect(text).not.toMatch(/[<>]/);
    expect(text).not.toMatch(/href|onclick/);
  });

  it("copes with unbalanced and oversized input", () => {
    expect(parseNotes("[broken](https://x.example.org").map((s) => s.href)).toEqual([undefined]);
    expect(parseNotes("[" + "a".repeat(500) + "](https://x.example.org)").some((s) => s.href)).toBe(false); // label too long to match
    expect(parseNotes("x".repeat(100_000)).length).toBe(1);
  });
});
