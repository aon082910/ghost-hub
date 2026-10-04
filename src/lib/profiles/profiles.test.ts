import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UnsafeUrlError, assertSafeUrl } from "../newsletters/ssrf";
import { checkGravatar, checkSite, evaluate, gravatarHash } from "./check";
import { USER_AGENT, fetchPage, type GetResponse, type GetTransport } from "./http";
import { appliesTo, isValidUsername, loadSites, openUrl, parseSites, requestUrl, siteById, type Site } from "./sites";
import { safeLookup } from "../newsletters/ssrf";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const site = (id: string) => siteById(id)!;
const reply = (status: number, body = "", location?: string): GetResponse => ({ status, body, location });
const transportOf = (...responses: GetResponse[]) => {
  let i = 0;
  return vi.fn<GetTransport>(async () => responses[Math.min(i++, responses.length - 1)]);
};

describe("the site list", () => {
  const sites = loadSites();

  it("is a sizeable list of unique, https-only sites", () => {
    expect(sites.length).toBeGreaterThanOrEqual(25);
    expect(new Set(sites.map((s) => s.id)).size).toBe(sites.length);
    for (const s of sites) {
      expect(s.url, s.id).toMatch(/^https:\/\/.*\{u\}/);
      if (s.profileUrl) expect(s.profileUrl, s.id).toMatch(/^https:\/\/.*\{u\}/);
    }
  });

  it("can tell 'not found' apart from 'found' for every site, or it isn't listed", () => {
    for (const s of sites) expect(Boolean(s.notFoundStatus?.length || s.notFoundText), s.id).toBe(true);
  });

  it("only ever contacts public hostnames, whatever username is used", () => {
    for (const s of sites) {
      for (const u of ["testuser1", "a-b_c.d", "Zed99"]) {
        if (!appliesTo(s, u)) continue;
        expect(() => assertSafeUrl(requestUrl(s, u)), `${s.id} ${u}`).not.toThrow();
      }
    }
  });

  it("has patterns that accept ordinary names and reject names the site couldn't have", () => {
    expect(appliesTo(site("github"), "octocat")).toBe(true);
    expect(appliesTo(site("github"), "octo-cat")).toBe(true);
    expect(appliesTo(site("github"), "octo_cat")).toBe(false); // GitHub has no underscores
    expect(appliesTo(site("github"), "-octocat")).toBe(false);
    expect(appliesTo(site("minecraft"), "ab")).toBe(false);
    expect(appliesTo(site("minecraft"), "a".repeat(17))).toBe(false);
    expect(appliesTo(site("minecraft"), "Notch")).toBe(true);
    expect(appliesTo(site("tumblr"), "-x")).toBe(false);
    expect(appliesTo(site("tumblr"), "my-blog")).toBe(true);
    expect(appliesTo(site("bluesky"), "jay")).toBe(true);
    expect(appliesTo(site("bluesky"), "jay.bsky")).toBe(false); // the handle suffix is added for you
    expect(appliesTo(site("dockerhub"), "Library")).toBe(false); // lowercase only
  });

  it("gives every site a known public account, and both it and the live check's invented name fit that site's rules", () => {
    const ABSENT = "ghubzz93217x"; // keep in sync with sites.live.test.ts
    for (const s of sites) {
      expect(s.known, `${s.id} needs a "known" username`).toBeTruthy();
      expect(appliesTo(s, s.known!), `${s.id}: known account ${s.known} must satisfy the site's own pattern`).toBe(true);
      expect(appliesTo(s, ABSENT), `${s.id}: the invented name must be valid here, or the live check can't test not-found`).toBe(true);
    }
  });

  it("refuses unsafe usernames before any URL is built", () => {
    for (const u of ["", "a b", "../etc", "x/y", "x?y=1", "x#y", "a..b", "a".repeat(41), "naïve", "%2e%2e", "x\ny", "x\u0000y", "<script>", "a@b.com"]) {
      expect(isValidUsername(u), JSON.stringify(u)).toBe(false);
      expect(appliesTo(site("github"), u), JSON.stringify(u)).toBe(false);
    }
    for (const u of ["a", "user_name", "first.last", "a-b", "X".repeat(40)]) expect(isValidUsername(u), u).toBe(true);
  });

  it("fills in the username, and uses the web page address when it differs from the one asked", () => {
    expect(requestUrl(site("lichess"), "DrNykterstein")).toBe("https://lichess.org/api/user/DrNykterstein");
    expect(openUrl(site("lichess"), "DrNykterstein")).toBe("https://lichess.org/@/DrNykterstein");
    expect(requestUrl(site("tumblr"), "my-blog")).toBe("https://my-blog.tumblr.com");
    expect(openUrl(site("github"), "octocat")).toBe("https://github.com/octocat"); // no separate profileUrl
    expect(requestUrl(site("bluesky"), "jay")).toContain("actor=jay.bsky.social");
  });
});

describe("parseSites", () => {
  const ok = { id: "x", name: "X", url: "https://x.com/{u}", foundStatus: [200], notFoundStatus: [404] };
  it("accepts a valid entry", () => expect(parseSites([ok])).toHaveLength(1));
  it("rejects duplicates, insecure or placeholder-less URLs, bad patterns and missing rules", () => {
    expect(() => parseSites([ok, ok])).toThrow(/Duplicate/);
    expect(() => parseSites([{ ...ok, url: "http://x.com/{u}" }])).toThrow(/https/);
    expect(() => parseSites([{ ...ok, url: "https://x.com/user" }])).toThrow(/\{u\}/);
    expect(() => parseSites([{ ...ok, profileUrl: "ftp://x.com/{u}" }])).toThrow();
    expect(() => parseSites([{ ...ok, pattern: "([" }])).toThrow();
    expect(() => parseSites([{ ...ok, foundStatus: [] }])).toThrow();
    expect(() => parseSites([{ ...ok, id: "Bad Id" }])).toThrow();
    expect(() => parseSites({ not: "a list" })).toThrow();
  });
});

describe("a different site list can be supplied only outside production", () => {
  const file = path.join(os.tmpdir(), `ghosthub-sites-${process.pid}.json`);
  const write = () => fs.writeFileSync(file, JSON.stringify([{ id: "fake", name: "Fake", url: "https://fake.example.org/{u}", foundStatus: [200], notFoundStatus: [404] }]));

  it("uses it in development and test builds", async () => {
    write();
    vi.stubEnv("GHOSTHUB_PROFILE_SITES_FILE", file);
    vi.stubEnv("NODE_ENV", "test");
    const { loadSites: fresh } = await import("./sites");
    expect(fresh().map((s) => s.id)).toEqual(["fake"]);
  });

  it("ignores it in production", async () => {
    write();
    vi.stubEnv("GHOSTHUB_PROFILE_SITES_FILE", file);
    vi.stubEnv("NODE_ENV", "production");
    const { loadSites: fresh } = await import("./sites");
    expect(fresh().length).toBeGreaterThanOrEqual(25);
    expect(fresh().some((s) => s.id === "github")).toBe(true);
    fs.rmSync(file, { force: true });
  });
});

describe("evaluate", () => {
  const status: Site = { id: "s", name: "S", url: "https://s.com/{u}", foundStatus: [200], notFoundStatus: [404] };
  it("maps status codes", () => {
    expect(evaluate(status, 200, "")).toBe("found");
    expect(evaluate(status, 404, "")).toBe("not_found");
    for (const s of [0, 301, 400, 401, 403, 410, 429, 500, 503]) expect(evaluate(status, s, ""), String(s)).toBe("unknown");
  });

  it("handles sites whose not-found answer is a different status (Bluesky, Codeforces, Minecraft)", () => {
    expect(evaluate(site("bluesky"), 400, '{"error":"InvalidRequest","message":"Profile not found"}')).toBe("not_found");
    expect(evaluate(site("bluesky"), 200, '{"did":"did:plc:abc"}')).toBe("found");
    expect(evaluate(site("codeforces"), 400, '{"status":"FAILED"}')).toBe("not_found");
    expect(evaluate(site("minecraft"), 204, "")).toBe("not_found");
    expect(evaluate(site("minecraft"), 404, "")).toBe("not_found");
    expect(evaluate(site("minecraft"), 200, '{"id":"x","name":"Notch"}')).toBe("found");
  });

  // Bodies captured from the live sites for a name that exists and one that doesn't.
  it("reads the body for sites that answer 200 either way", () => {
    expect(evaluate(site("hackernews"), 200, "No such user.")).toBe("not_found");
    expect(evaluate(site("hackernews"), 200, '<html lang="en" op="user"><head><meta name="referrer" content="origin">')).toBe("found");
    expect(evaluate(site("steam"), 200, "<title>Steam Community :: Error</title>")).toBe("not_found");
    expect(evaluate(site("steam"), 200, "<title>Steam Community :: Rabscuttle</title>")).toBe("found");
    expect(evaluate(site("duolingo"), 200, '{"users":[]}')).toBe("not_found");
    expect(evaluate(site("duolingo"), 200, '{"users":[{"id":14,"bio":""}]}')).toBe("found");
    expect(evaluate(site("wikipedia"), 200, '{"batchcomplete":"","query":{"users":[{"name":"Nobody","missing":""}]}}')).toBe("not_found");
    expect(evaluate(site("wikipedia"), 200, '{"batchcomplete":"","query":{"users":[{"userid":24,"name":"Jimbo Wales"}]}}')).toBe("found");
  });

  it("won't claim 'found' when the expected content is missing (a changed page or a challenge wall)", () => {
    expect(evaluate(site("wikipedia"), 200, "<html><title>Client Challenge</title></html>")).toBe("unknown");
    expect(evaluate(site("wikipedia"), 200, "")).toBe("unknown");
  });
});

describe("checkSite", () => {
  const gh = () => site("github");

  it("reports found with a link to open, and not found", async () => {
    expect(await checkSite(site("lichess"), "bob", transportOf(reply(200, "{}")))).toEqual({ status: "found", url: "https://lichess.org/@/bob" });
    expect(await checkSite(gh(), "bob", transportOf(reply(404)))).toEqual({ status: "not_found" });
  });

  it("explains blocks, rate limits and server errors instead of guessing", async () => {
    expect(await checkSite(gh(), "bob", transportOf(reply(403)))).toMatchObject({ status: "error", detail: expect.stringMatching(/blocks automated/) });
    expect(await checkSite(gh(), "bob", transportOf(reply(429)))).toMatchObject({ status: "error", detail: expect.stringMatching(/rate limiting/) });
    expect(await checkSite(gh(), "bob", transportOf(reply(503)))).toMatchObject({ status: "error", detail: expect.stringMatching(/HTTP 503/) });
    expect(await checkSite(gh(), "bob", transportOf(reply(418)))).toMatchObject({ status: "error", detail: expect.stringMatching(/HTTP 418/) });
  });

  it("follows same-host redirects, but stops at one that leaves the site", async () => {
    const t = transportOf(reply(301, "", "/bob/"), reply(200, "ok"));
    expect(await checkSite(gh(), "bob", t)).toMatchObject({ status: "found" });
    expect(t).toHaveBeenCalledTimes(2);
    const away = await checkSite(site("youtube"), "somebody", transportOf(reply(302, "", "https://consent.youtube.com/m?continue=x")));
    expect(away).toMatchObject({ status: "error", detail: expect.stringContaining("consent.youtube.com") });
  });

  it("skips usernames a site can't have without making any request", async () => {
    const t = transportOf(reply(200));
    expect(await checkSite(gh(), "no_underscores_here", t)).toMatchObject({ status: "error", detail: expect.stringMatching(/can't exist/) });
    expect(t).not.toHaveBeenCalled();
  });

  it("never throws, whatever goes wrong on the network", async () => {
    const fail = (code: string): GetTransport => async () => {
      throw Object.assign(new Error(code), { code });
    };
    expect(await checkSite(gh(), "bob", fail("ETIMEDOUT"))).toMatchObject({ status: "error", detail: expect.stringMatching(/too long/) });
    expect(await checkSite(gh(), "bob", fail("ENOTPUBLIC"))).toMatchObject({ status: "error", detail: expect.stringMatching(/private address/) });
    expect(await checkSite(gh(), "bob", fail("ECONNREFUSED"))).toMatchObject({ status: "error", detail: expect.stringMatching(/Couldn't reach/) });
    expect(await checkSite(gh(), "bob", async () => { throw new Error("weird"); })).toMatchObject({ status: "error" });
  });

  it("refuses a site entry that isn't https instead of contacting it", async () => {
    const bad = { id: "bad", name: "Bad", url: "http://bad.example.org/{u}", foundStatus: [200] } as Site;
    const t = transportOf(reply(200));
    expect(await checkSite(bad, "bob", t)).toMatchObject({ status: "error", detail: expect.stringMatching(/wasn't safe/) });
    expect(t).not.toHaveBeenCalled();
  });
});

describe("fetchPage", () => {
  it("sends an honest User-Agent and the connect-time address guard", async () => {
    const t = transportOf(reply(200, "hi"));
    expect(await fetchPage("https://github.com/bob", t)).toEqual({ kind: "ok", status: 200, body: "hi" });
    const req = t.mock.calls[0][0];
    expect(req.headers["user-agent"]).toBe(USER_AGENT);
    expect(USER_AGENT).toMatch(/Ghost-Hub/);
    expect(req.headers).not.toHaveProperty("cookie");
    expect(req.lookup).toBe(safeLookup);
    expect(req.maxBytes).toBe(64 * 1024);
    expect(req.timeoutMs).toBe(10_000);
  });

  it("never contacts an unsafe address", async () => {
    const t = transportOf(reply(200));
    for (const u of ["http://github.com/x", "https://127.0.0.1/x", "https://localhost/x", "https://169.254.169.254/", "https://u:p@github.com/x", "https://github.com:8443/x"]) {
      await expect(fetchPage(u, t), u).rejects.toBeInstanceOf(UnsafeUrlError);
    }
    expect(t).not.toHaveBeenCalled();
  });

  it("follows up to three same-host hops, then gives up quietly", async () => {
    const hop = (n: number) => reply(302, "", `/r${n}`);
    const t = transportOf(hop(1), hop(2), hop(3), hop(4));
    const page = await fetchPage("https://github.com/bob", t);
    expect(page).toMatchObject({ kind: "ok", status: 302 });
    expect(t).toHaveBeenCalledTimes(4);
  });

  it("refuses to be redirected somewhere else, including private addresses, without ever requesting it", async () => {
    for (const to of ["https://evil.example.org/x", "https://127.0.0.1/x", "https://169.254.169.254/latest", "http://internal/x", "//other.org/x"]) {
      const t = transportOf(reply(302, "", to));
      const page = await fetchPage("https://github.com/bob", t);
      expect(page.kind, to).toBe("redirected_away");
      expect(t, to).toHaveBeenCalledTimes(1);
    }
  });

  it("won't downgrade to http on the same host, and shrugs off an unparsable Location", async () => {
    await expect(fetchPage("https://github.com/bob", transportOf(reply(301, "", "http://github.com/bob")))).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(await fetchPage("https://github.com/bob", transportOf(reply(301, "", "http://[bad")))).toMatchObject({ kind: "ok", status: 301 });
  });
});

describe("Gravatar", () => {
  const profile = {
    display_name: "Beau Lebens",
    profile_url: "https://gravatar.com/beau",
    verified_accounts: [
      { service_label: "GitHub", url: "https://github.com/beaulebens" },
      { service_label: "Instagram", url: "https://instagram.com/beaulebens" },
    ],
  };

  it("hashes the address the way Gravatar expects: SHA-256 of the trimmed, lowercased address", () => {
    expect(gravatarHash("beau@dentedreality.com.au")).toBe("a919f0e9932ec2c866cf67ec327efb57b47ff3085acd375529af076d1ac56f27");
    expect(gravatarHash("  Beau@DentedReality.com.au ")).toBe(gravatarHash("beau@dentedreality.com.au"));
  });

  it("asks by hash only, so the address never leaves the machine", async () => {
    const t = transportOf(reply(200, JSON.stringify(profile)));
    await checkGravatar("beau@dentedreality.com.au", t);
    const url = t.mock.calls[0][0].url;
    expect(url.href).toBe("https://api.gravatar.com/v3/profiles/a919f0e9932ec2c866cf67ec327efb57b47ff3085acd375529af076d1ac56f27");
    expect(url.href).not.toMatch(/beau|dentedreality|@/i);
    expect(JSON.stringify(t.mock.calls[0][0].headers)).not.toMatch(/beau|@/i);
  });

  it("returns the profile and its linked accounts", async () => {
    expect(await checkGravatar("a@b.com", transportOf(reply(200, JSON.stringify(profile))))).toEqual({
      status: "found",
      profileUrl: "https://gravatar.com/beau",
      linked: [
        { service: "GitHub", url: "https://github.com/beaulebens" },
        { service: "Instagram", url: "https://instagram.com/beaulebens" },
      ],
    });
  });

  it("drops linked accounts that aren't plain https links (they become clickable on screen)", async () => {
    const hostile = {
      ...profile,
      profile_url: "javascript:alert(1)",
      verified_accounts: [
        { service_label: "Evil", url: "javascript:alert(1)" },
        { service_label: "Data", url: "data:text/html,x" },
        { service_label: "Plain", url: "http://insecure.example.org/x" },
        { service_label: "Long", url: "https://x.com/" + "a".repeat(3000) },
        { service_label: "Nolabel", url: "https://ok.example.org/x" },
        { url: "https://nolabel.example.org/x" },
        { service_label: "Good", url: "https://good.example.org/x" },
        { service_label: "Garbage", url: "not a url" },
      ],
    };
    const r = await checkGravatar("a@b.com", transportOf(reply(200, JSON.stringify(hostile))));
    expect(r).toMatchObject({ status: "found" });
    if (r.status !== "found") throw new Error("expected found");
    expect(r.linked.map((l) => l.service)).toEqual(["Nolabel", "Good"]);
    expect(r.profileUrl).toBe(`https://gravatar.com/${gravatarHash("a@b.com")}`); // falls back rather than trusting the bad URL
  });

  it("reports not found, and explains failures", async () => {
    expect(await checkGravatar("a@b.com", transportOf(reply(404)))).toEqual({ status: "not_found" });
    expect(await checkGravatar("a@b.com", transportOf(reply(429)))).toMatchObject({ status: "error", detail: expect.stringMatching(/rate limiting/) });
    expect(await checkGravatar("a@b.com", transportOf(reply(500)))).toMatchObject({ status: "error" });
    expect(await checkGravatar("a@b.com", transportOf(reply(200, "not json")))).toMatchObject({ status: "error", detail: expect.stringMatching(/expected format/) });
    expect(await checkGravatar("a@b.com", transportOf(reply(200, JSON.stringify([1, 2]))))).toMatchObject({ status: "error" });
    expect(await checkGravatar("a@b.com", async () => { throw Object.assign(new Error("x"), { code: "ETIMEDOUT" }); })).toMatchObject({ status: "error" });
  });
});
