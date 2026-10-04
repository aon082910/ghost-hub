import fs from "node:fs";
import { z } from "zod";
import { devOverride } from "../dev-override";
import bundled from "./sites.json";

/**
 * Which public pages say "this username exists". Plain data, so adding or fixing a site is a one-line change.
 * A site is only listed if it answers differently for a name that exists and one that doesn't without needing a
 * login, JavaScript, or getting around bot protection. Sites that block automated requests are left out.
 */
const siteSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  /** Where to ask. `{u}` is replaced by the username. */
  url: z.string(),
  /** Where a person would open the profile, when different from `url` (e.g. the API URL isn't a web page). */
  profileUrl: z.string().optional(),
  /** Usernames this site could never have; skipped for those instead of risking a false answer. */
  pattern: z.string().optional(),
  foundStatus: z.array(z.number().int()).min(1),
  notFoundStatus: z.array(z.number().int()).optional(),
  /** On a "found" status, a body containing this still means the profile doesn't exist. */
  notFoundText: z.string().optional(),
  /** On a "found" status, the body must contain this or the answer is "can't tell". */
  foundText: z.string().optional(),
  /** A well-known public account on this site, used only by the opt-in live check that keeps this list honest. */
  known: z.string().optional(),
});
export type Site = z.infer<typeof siteSchema>;

/** The username rules shared by every site. Anything else is refused before a request is built. */
export const USERNAME = /^[A-Za-z0-9._-]{1,40}$/;
export const isValidUsername = (u: string) => USERNAME.test(u) && !u.includes("..");

export function parseSites(json: unknown): Site[] {
  const sites = z.array(siteSchema).parse(json);
  const seen = new Set<string>();
  for (const s of sites) {
    if (seen.has(s.id)) throw new Error(`Duplicate site id: ${s.id}`);
    seen.add(s.id);
    for (const [field, value] of [["url", s.url], ["profileUrl", s.profileUrl]] as const) {
      if (value === undefined) continue;
      if (!value.startsWith("https://") || !value.includes("{u}")) throw new Error(`${s.id}.${field} must be an https URL containing {u}`);
    }
    if (s.pattern) new RegExp(s.pattern); // throws on a bad pattern
  }
  return sites;
}

let cached: Site[] | undefined;

/** The bundled list. In non-production builds a different file can be supplied to test against a local fake. */
export function loadSites(): Site[] {
  if (cached) return cached;
  const override = devOverride("GHOSTHUB_PROFILE_SITES_FILE", "");
  cached = parseSites(override ? JSON.parse(fs.readFileSync(override, "utf8")) : bundled);
  return cached;
}

export const siteById = (id: string) => loadSites().find((s) => s.id === id);

export function appliesTo(site: Site, username: string): boolean {
  return isValidUsername(username) && (!site.pattern || new RegExp(site.pattern).test(username));
}

const fill = (template: string, username: string) => template.replaceAll("{u}", encodeURIComponent(username));
export const requestUrl = (site: Site, username: string) => fill(site.url, username);
export const openUrl = (site: Site, username: string) => fill(site.profileUrl ?? site.url, username);
