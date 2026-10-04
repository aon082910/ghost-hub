import { describe, expect, it } from "vitest";
import { checkGravatar, checkSite } from "./check";
import { appliesTo, loadSites } from "./sites";

/**
 * Opt-in check of the bundled site list against the real internet. Sites change (a redesign, new bot protection),
 * so run this when you suspect an entry has gone stale, or before releasing:
 *
 *   LIVE_SITES=1 npx vitest run src/lib/profiles/sites.live.test.ts        (bash)
 *   $env:LIVE_SITES=1; npx vitest run src/lib/profiles/sites.live.test.ts  (PowerShell)
 *
 * It makes about two polite requests per site: one for a well-known public account (must be "found") and one for a
 * name nobody has (must be "not found"). A failing site should be fixed in sites.json or removed.
 */
const live = process.env.LIVE_SITES === "1";
export const ABSENT = "ghubzz93217x"; // 12 lowercase letters and digits: valid on every site's pattern (some cap at 15)
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!live)("live site check", () => {
  for (const site of loadSites()) {
    it(`${site.name}: finds a known account and doesn't invent one`, async () => {
      const known = site.known!;
      expect(appliesTo(site, ABSENT), "the absent name must be valid for this site").toBe(true);

      const present = await checkSite(site, known);
      await pause(500);
      const absent = await checkSite(site, ABSENT);
      await pause(500);

      expect(present, `${known} should exist: ${JSON.stringify(present)}`).toMatchObject({ status: "found" });
      expect(absent, `${ABSENT} should not exist: ${JSON.stringify(absent)}`).toMatchObject({ status: "not_found" });
    }, 40_000);
  }
});

describe.skipIf(!live)("live Gravatar check", () => {
  it("finds the profile used in Gravatar's own documentation (by hash), and none for an invented address", async () => {
    const found = await checkGravatar("beau@dentedreality.com.au");
    expect(found, JSON.stringify(found)).toMatchObject({ status: "found" });
    if (found.status === "found") {
      expect(found.profileUrl).toMatch(/^https:\/\/gravatar\.com\//);
      expect(found.linked.length).toBeGreaterThan(0);
    }
    await pause(500);
    expect(await checkGravatar("ghosthub-nobody-93217@example.com")).toEqual({ status: "not_found" });
  }, 40_000);
});
