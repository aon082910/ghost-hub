import { findGuides } from "./guides";

/**
 * Decide which discovered services are really one company, so `amazon.com` and `amazon.co.uk` (or `microsoft.com` and
 * `live.com`) appear once. The evidence is the deletion-guide dataset: a guide lists every domain a company uses, and
 * two services that appear in the same guide are the same company. Services with no guide are never merged, because
 * guessing from names would join unrelated sites.
 *
 * Returns groups of domains. Within a group the domains keep the order they were given in, and groups are ordered by
 * their first domain, so the result is deterministic. A domain that matches nothing is a group of one.
 */
export function groupByCompany(domains: string[]): string[][] {
  const unique = [...new Set(domains.map((d) => d.toLowerCase()))];
  const parent = new Map(unique.map((d) => [d, d]));
  const find = (d: string): string => {
    let root = d;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(d, root); // keep paths short
    return root;
  };

  // The first domain seen for each guide; every later domain in the same guide joins it.
  const firstFor = new Map<string, string>();
  for (const d of unique) {
    for (const g of findGuides(d)) {
      const key = g.name + "|" + g.url;
      const anchor = firstFor.get(key);
      if (anchor === undefined) firstFor.set(key, d);
      else {
        const a = find(anchor);
        const b = find(d);
        if (a !== b) parent.set(b, a);
      }
    }
  }

  const groups = new Map<string, string[]>();
  for (const d of unique) {
    const root = find(d);
    groups.set(root, [...(groups.get(root) ?? []), d]);
  }
  return [...groups.values()].sort((a, b) => unique.indexOf(a[0]) - unique.indexOf(b[0]));
}
