import { registrableFromHost } from "../scan/classify";
import type { Breach } from "./hibp";
import type { BreachMatch } from "./risk";

export type BreachIndex = Map<string, Omit<BreachMatch, "confirmed">[]>;

/** Group breaches by the registrable domain they name, remembering whether it was the bare domain or a subdomain. */
export function indexBreaches(breaches: Breach[]): BreachIndex {
  const index: BreachIndex = new Map();
  for (const b of breaches) {
    const registrable = registrableFromHost(b.domain);
    if (!registrable) continue;
    const scope = b.domain === registrable || b.domain === `www.${registrable}` ? "domain" : "subdomain";
    const list = index.get(registrable) ?? [];
    list.push({ ...b, scope });
    index.set(registrable, list);
  }
  return index;
}

/**
 * Breaches that name a service's domain. A breach counts as confirmed when the user's own address (checked via
 * HIBP with their key) is in it.
 */
export function matchService(domain: string, index: BreachIndex, confirmedNames: ReadonlySet<string>): BreachMatch[] {
  return (index.get(domain) ?? []).map((b) => ({ ...b, confirmed: confirmedNames.has(b.name) }));
}
