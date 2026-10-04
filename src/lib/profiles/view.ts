import { siteById } from "./sites";
import type { ProfileRow } from "./store";

export type FoundProfile = { key: string; name: string; url: string; via?: string };
export type ProfileGroup = {
  type: "username" | "email";
  identifier: string;
  checkedAt: Date | null;
  found: FoundProfile[];
  notFound: number;
  /** Sites that couldn't give an answer, with why. */
  unclear: { name: string; detail: string }[];
};

const nameOf = (site: string) => (site === "gravatar" ? "Gravatar" : (siteById(site)?.name ?? site));

/** Plain https links only: these end up as clickable links, and the data came from the network. */
const isHttps = (u: string | null): u is string => {
  if (!u) return false;
  try {
    return new URL(u).protocol === "https:";
  } catch {
    return false;
  }
};

/**
 * Arrange stored results for display: one group per identifier (usernames you added, then connected addresses), with
 * what was found first. Identifiers with no results yet still get a group, so you can see they're pending.
 */
export function buildGroups(rows: ProfileRow[], usernames: string[], emails: string[]): ProfileGroup[] {
  const groups: ProfileGroup[] = [
    ...usernames.map((identifier) => blank("username", identifier)),
    ...emails.map((identifier) => blank("email", identifier)),
  ];
  const byKey = new Map(groups.map((g) => [`${g.type}:${g.identifier}`, g]));

  for (const r of rows) {
    const g = byKey.get(`${r.identifierType}:${r.identifier}`);
    if (!g) continue; // results for something no longer on the list are not shown
    if (!g.checkedAt || r.checkedAt > g.checkedAt) g.checkedAt = r.checkedAt;

    if (r.status === "found" && isHttps(r.url)) {
      const linked = r.site.startsWith("linked:");
      g.found.push({ key: r.site, name: linked ? (r.detail ?? "Linked account") : nameOf(r.site), url: r.url, via: linked ? "Gravatar" : undefined });
    } else if (r.status === "not_found") g.notFound++;
    else if (r.status === "error") g.unclear.push({ name: nameOf(r.site), detail: r.detail ?? "Couldn't check" });
  }
  for (const g of groups) {
    g.found.sort((a, b) => Number(Boolean(a.via)) - Number(Boolean(b.via)) || a.name.localeCompare(b.name));
    g.unclear.sort((a, b) => a.name.localeCompare(b.name));
  }
  return groups;
}

const blank = (type: "username" | "email", identifier: string): ProfileGroup => ({ type, identifier, checkedAt: null, found: [], notFound: 0, unclear: [] });
