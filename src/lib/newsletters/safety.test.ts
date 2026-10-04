import { afterEach, describe, expect, it, vi } from "vitest";
import { chooseMethod, isMailto, parseListUnsubscribe } from "./headers";
import { ONE_CLICK_BODY, USER_AGENT, unsubscribeOneClick, type Transport } from "./oneclick";
import { UnsafeUrlError, assertSafeUrl, createSafeLookup, isPublicIp, safeLookup } from "./ssrf";

afterEach(() => vi.unstubAllEnvs());

describe("isPublicIp", () => {
  it.each(["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "2a00:1450:4001:81b::200e"])("%s is public", (ip) => {
    expect(isPublicIp(ip)).toBe(true);
  });

  it.each([
    "0.0.0.0", "10.0.0.1", "10.255.255.255", "100.64.0.1", "127.0.0.1", "127.255.255.254", "169.254.169.254", "172.16.0.1", "172.31.255.255",
    "192.168.0.1", "192.0.0.5", "192.0.2.7", "198.18.0.1", "198.19.255.255", "198.51.100.1", "203.0.113.9", "224.0.0.1", "239.255.255.255",
    "240.0.0.1", "255.255.255.255",
  ])("%s (IPv4 reserved) is blocked", (ip) => {
    expect(isPublicIp(ip)).toBe(false);
  });

  it.each([
    "::", "::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:8.8.8.8", "fc00::1", "fd12:3456::1", "fe80::1", "fe80::1%eth0", "febf::1", "ff02::1",
    "2001:db8::1", "2001::1", "64:ff9b::7f00:1", "2002:7f00:1::", "100::1",
    "::ffff:7f00:1", "0:0:0:0:0:ffff:7f00:1", "0000:0000:0000:0000:0000:ffff:7f00:0001", "::FFFF:10.0.0.1", "::ffff:a9fe:a9fe",
  ])("%s (IPv6 reserved or embeds IPv4) is blocked", (ip) => {
    expect(isPublicIp(ip)).toBe(false);
  });

  it("is exact at range boundaries", () => {
    for (const ip of ["172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "9.255.255.255", "11.0.0.0", "126.255.255.255", "128.0.0.1", "169.253.255.255", "169.255.0.0", "223.255.255.255"]) {
      expect(isPublicIp(ip), ip).toBe(true);
    }
    for (const ip of ["172.16.0.0", "172.31.255.255", "100.64.0.0", "100.127.255.255", "10.0.0.0", "169.254.0.0", "169.254.255.255", "198.18.0.0", "198.19.255.255"]) {
      expect(isPublicIp(ip), ip).toBe(false);
    }
  });

  it("treats anything that isn't an IP as not public", () => {
    for (const v of ["", "example.com", "999.1.1.1", "1.2.3", "localhost", " 8.8.8.8", "8.8.8.8 "]) expect(isPublicIp(v), v).toBe(false);
  });
});

describe("assertSafeUrl", () => {
  it("accepts ordinary https links, including long query strings and subdomains", () => {
    expect(assertSafeUrl("https://example.com/u?id=1&t=abc").hostname).toBe("example.com");
    expect(assertSafeUrl("https://email.news.example.co.uk/unsub/abc").hostname).toBe("email.news.example.co.uk");
    expect(assertSafeUrl("  https://example.com/x  ").href).toBe("https://example.com/x");
    expect(assertSafeUrl("https://example.com:443/x").port).toBe(""); // the default port is fine
    expect(assertSafeUrl("https://example.com./x").hostname).toBe("example.com.");
    expect(assertSafeUrl("https://bücher.de/x").hostname).toBe("xn--bcher-kva.de"); // punycode
  });

  const rejects = (reason: UnsafeUrlError["reason"], urls: string[]) => {
    for (const u of urls) {
      let caught: unknown;
      try {
        assertSafeUrl(u);
      } catch (e) {
        caught = e;
      }
      expect(caught, u).toBeInstanceOf(UnsafeUrlError);
      expect((caught as UnsafeUrlError).reason, u).toBe(reason);
    }
  };

  it("rejects anything that isn't https", () => rejects("not_https", ["http://example.com/u", "ftp://example.com/u", "javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "gopher://example.com"]));
  it("rejects embedded credentials", () => rejects("credentials", ["https://user:pass@example.com/u", "https://user@example.com/u", "https://:pw@example.com/"]));
  it("rejects non-default ports", () => rejects("port", ["https://example.com:8443/u", "https://example.com:80/u", "https://example.com:22/"]));

  it("rejects IP literals in every spelling", () =>
    rejects("ip_literal", [
      "https://8.8.8.8/u", "https://127.0.0.1/u", "https://169.254.169.254/latest/meta-data", "https://[::1]/u", "https://[2606:4700:4700::1111]/u",
      "https://2130706433/u", // decimal form of 127.0.0.1
      "https://0x7f.0.0.1/u", "https://0177.0.0.1/u", "https://127.1/u", "https://[::ffff:127.0.0.1]/u",
    ]));

  it("rejects names that aren't on the public internet", () =>
    rejects("host", [
      "https://localhost/u", "https://intranet/u", "https://router.local/u", "https://metadata.google.internal/u", "https://nas.lan/u",
      "https://printer.home/u", "https://x.corp/u", "https://1.0.0.127.in-addr.arpa/u", "https://foo.test/u", "https://foo.example/u", "https://foo.invalid/u",
    ]));

  it("rejects malformed and oversized values", () => {
    rejects("invalid", ["", "not a url", "https://", "//example.com/u", "https://" + "a".repeat(2100) + ".com"]);
  });

  it("only relaxes the rules in non-production builds when the override is set", () => {
    vi.stubEnv("GHOSTHUB_ALLOW_PRIVATE_UNSUBSCRIBE", "1");
    vi.stubEnv("NODE_ENV", "test");
    expect(assertSafeUrl("https://localhost:4443/u").hostname).toBe("localhost");
    expect(assertSafeUrl("http://127.0.0.1/u").hostname).toBe("127.0.0.1");
    vi.stubEnv("NODE_ENV", "production");
    expect(() => assertSafeUrl("https://localhost:4443/u")).toThrow(UnsafeUrlError); // ignored in production
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("GHOSTHUB_ALLOW_PRIVATE_UNSUBSCRIBE", "true");
    expect(() => assertSafeUrl("https://localhost:4443/u")).toThrow(UnsafeUrlError); // only the literal "1" counts
  });
});

describe("createSafeLookup (DNS check at connect time)", () => {
  type Addr = { address: string; family: number };
  const resolver = (addrs: Addr[] | Error) =>
    vi.fn((_host: string, _opts: object, cb: (err: NodeJS.ErrnoException | null, a: Addr[]) => void) => {
      if (addrs instanceof Error) cb(addrs, []);
      else cb(null, addrs);
    });
  const run = (lookup: ReturnType<typeof createSafeLookup>, opts: object = {}) =>
    new Promise<{ err: NodeJS.ErrnoException | null; address: unknown; family?: number }>((resolve) =>
      lookup("example.com", opts, (err, address, family) => resolve({ err, address, family })),
    );

  it("returns a single address for plain lookups and a list when 'all' is requested", async () => {
    const lookup = createSafeLookup(resolver([{ address: "93.184.216.34", family: 4 }, { address: "2606:2800::1", family: 6 }]));
    expect(await run(lookup)).toMatchObject({ err: null, address: "93.184.216.34", family: 4 });
    const all = await run(lookup, { all: true });
    expect(all.err).toBeNull();
    expect(all.address).toEqual([{ address: "93.184.216.34", family: 4 }, { address: "2606:2800::1", family: 6 }]);
  });

  it("always asks the resolver for every address", async () => {
    const r = resolver([{ address: "93.184.216.34", family: 4 }]);
    await run(createSafeLookup(r), { family: 4 });
    expect(r.mock.calls[0][1]).toMatchObject({ family: 4, all: true });
  });

  it("refuses a name that resolves to any private address, even alongside public ones", async () => {
    for (const bad of ["127.0.0.1", "10.0.0.5", "169.254.169.254", "::1", "fe80::1", "::ffff:192.168.0.1"]) {
      const lookup = createSafeLookup(resolver([{ address: "93.184.216.34", family: 4 }, { address: bad, family: bad.includes(":") ? 6 : 4 }]));
      const r = await run(lookup);
      expect(r.err?.code, bad).toBe("ENOTPUBLIC");
    }
  });

  it("refuses an empty answer and passes resolver errors through", async () => {
    expect((await run(createSafeLookup(resolver([])))).err?.code).toBe("ENOTPUBLIC");
    const nx = Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    expect((await run(createSafeLookup(resolver(nx)))).err?.code).toBe("ENOTFOUND");
  });

  it("the real lookup refuses localhost (resolved locally, no internet needed)", async () => {
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => safeLookup("localhost", {}, (e) => resolve(e)));
    expect(err?.code).toBe("ENOTPUBLIC");
  });
});

describe("parseListUnsubscribe", () => {
  it("sorts entries by scheme", () => {
    expect(parseListUnsubscribe("<https://a.com/u?id=1>, <mailto:unsub@a.com?subject=unsubscribe>, <http://a.com/old>")).toEqual({
      https: ["https://a.com/u?id=1"],
      http: ["http://a.com/old"],
      mailto: ["mailto:unsub@a.com?subject=unsubscribe"],
    });
    expect(parseListUnsubscribe("<mailto:u@a.com>,<HTTPS://A.com/u>").https).toEqual(["HTTPS://A.com/u"]);
  });

  it("ignores other schemes, malformed URLs, whitespace and control characters", () => {
    const r = parseListUnsubscribe("<javascript:alert(1)>, <data:text/html,x>, <ftp://a.com>, <https://>, <https://a.com/with space>, <https://a.com/x\u0000y>, <not a url>");
    expect(r).toEqual({ https: [], http: [], mailto: [] });
  });

  it("handles missing headers and caps how many entries it keeps", () => {
    expect(parseListUnsubscribe(undefined)).toEqual({ https: [], http: [], mailto: [] });
    expect(parseListUnsubscribe(null)).toEqual({ https: [], http: [], mailto: [] });
    expect(parseListUnsubscribe("")).toEqual({ https: [], http: [], mailto: [] });
    const many = Array.from({ length: 20 }, (_, i) => `<https://a.com/${i}>`).join(",");
    expect(parseListUnsubscribe(many).https).toHaveLength(5);
  });

  it("validates mailto addresses", () => {
    for (const ok of ["mailto:u@a.com", "mailto:unsub+tag@mail.a.com?subject=Unsubscribe", "mailto:u%40a.com"]) expect(isMailto(ok), ok).toBe(true);
    for (const bad of ["mailto:", "mailto:nobody", "mailto:a@b", "mailto:a b@c.com", "mailto:a@b.com,c@d.com", "mailto:<x>@a.com", "https://a.com", "mailto:%zz@a.com"]) {
      expect(isMailto(bad), bad).toBe(false);
    }
  });
});

describe("chooseMethod", () => {
  const link = "<https://a.com/u>, <mailto:u@a.com>";
  it("one-click needs the flag and an https link", () => {
    expect(chooseMethod(link, true)).toEqual({ method: "one-click", url: "https://a.com/u" });
    expect(chooseMethod(link, false)).toEqual({ method: "link", url: "https://a.com/u" });
  });
  it("falls back to mailto, then none", () => {
    expect(chooseMethod("<mailto:u@a.com>", false)).toEqual({ method: "mailto", mailto: "mailto:u@a.com" });
    expect(chooseMethod("<mailto:u@a.com>", true)).toEqual({ method: "mailto", mailto: "mailto:u@a.com" }); // flag without https is meaningless
    expect(chooseMethod(null, false)).toEqual({ method: "none" });
    expect(chooseMethod("", true)).toEqual({ method: "none" });
  });
  it("never offers an insecure http link", () => {
    expect(chooseMethod("<http://a.com/u>", true)).toEqual({ method: "none" });
    expect(chooseMethod("<http://a.com/u>, <mailto:u@a.com>", false)).toEqual({ method: "mailto", mailto: "mailto:u@a.com" });
  });
});

describe("unsubscribeOneClick", () => {
  const ok = (status = 200): Transport => vi.fn(async () => ({ status }));

  it("POSTs the RFC 8058 body with fixed headers, and sets the safe lookup", async () => {
    const t = ok(200);
    expect(await unsubscribeOneClick("https://example.com/u?id=1", t)).toEqual({ ok: true, status: 200 });
    const req = vi.mocked(t).mock.calls[0][0];
    expect(req.url.href).toBe("https://example.com/u?id=1");
    expect(req.body).toBe(ONE_CLICK_BODY);
    expect(req.body).toBe("List-Unsubscribe=One-Click");
    expect(req.headers).toEqual({ "content-type": "application/x-www-form-urlencoded", "user-agent": USER_AGENT, accept: "*/*" });
    expect(req.headers).not.toHaveProperty("cookie");
    expect(req.headers).not.toHaveProperty("authorization");
    expect(req.lookup).toBe(safeLookup);
    expect(req.timeoutMs).toBe(15_000);
  });

  it("treats any 2xx as success", async () => {
    for (const s of [200, 201, 202, 204, 299]) expect(await unsubscribeOneClick("https://example.com/u", ok(s))).toMatchObject({ ok: true, status: s });
  });

  it("does not follow redirects and reports them for manual follow-up", async () => {
    for (const s of [301, 302, 303, 307, 308]) {
      const t = ok(s);
      const r = await unsubscribeOneClick("https://example.com/u", t);
      expect(r, String(s)).toMatchObject({ ok: false, reason: "redirect", status: s });
      expect(t).toHaveBeenCalledTimes(1);
    }
  });

  it("reports HTTP errors", async () => {
    for (const s of [400, 401, 404, 410, 429, 500, 503]) expect(await unsubscribeOneClick("https://example.com/u", ok(s))).toMatchObject({ ok: false, reason: "http_error", status: s });
    expect(await unsubscribeOneClick("https://example.com/u", ok(0))).toMatchObject({ ok: false, reason: "http_error" });
  });

  it("describes network failures without throwing", async () => {
    const fail = (code: string): Transport => async () => {
      throw Object.assign(new Error(code), { code });
    };
    expect(await unsubscribeOneClick("https://example.com/u", fail("ENOTPUBLIC"))).toMatchObject({ ok: false, reason: "blocked" });
    expect(await unsubscribeOneClick("https://example.com/u", fail("ETIMEDOUT"))).toMatchObject({ ok: false, reason: "timeout" });
    expect(await unsubscribeOneClick("https://example.com/u", fail("ECONNREFUSED"))).toMatchObject({ ok: false, reason: "network" });
    expect(await unsubscribeOneClick("https://example.com/u", fail("CERT_HAS_EXPIRED"))).toMatchObject({ ok: false, reason: "network" });
  });

  it("never reaches the network for an unsafe URL", async () => {
    const t = ok(200);
    for (const u of ["http://example.com/u", "https://127.0.0.1/u", "https://localhost/u", "https://u:p@example.com/u", "https://example.com:8443/u", "https://169.254.169.254/", "nonsense"]) {
      expect(await unsubscribeOneClick(u, t), u).toMatchObject({ ok: false, reason: "blocked" });
    }
    expect(t).not.toHaveBeenCalled();
  });

  it("with the dev override, skips the DNS guard so a local fake server can be used", async () => {
    vi.stubEnv("GHOSTHUB_ALLOW_PRIVATE_UNSUBSCRIBE", "1");
    vi.stubEnv("NODE_ENV", "test");
    const t = ok(200);
    expect(await unsubscribeOneClick("https://localhost:4443/u", t)).toMatchObject({ ok: true });
    expect(vi.mocked(t).mock.calls[0][0].lookup).toBeUndefined();
  });
});
