import { loadCatalog, loadConfirmedNames } from "./breaches/store";
import { indexBreaches, matchService } from "./breaches/match";
import { assessRisk, type Level, type RiskResult } from "./breaches/risk";
import { listDiscovered, type DiscoveredService } from "./discovered";
import type { Category } from "./scan/classify";

export type ServiceRisk = DiscoveredService & { risk: RiskResult };

export const LEVELS: Level[] = ["high", "medium", "low", "minimal"];
export const isLevel = (v: string | undefined): v is Level => v !== undefined && (LEVELS as string[]).includes(v);

/** Every discovered service with its risk assessment, riskiest first. */
export async function loadServices(now = new Date()): Promise<ServiceRisk[]> {
  const [services, catalog, confirmed] = await Promise.all([listDiscovered(undefined, 10_000), loadCatalog(), loadConfirmedNames()]);
  const index = indexBreaches(catalog);
  return services
    .map((s) => ({
      ...s,
      risk: assessRisk(
        { category: s.category, firstSeen: s.firstSeen, lastSeen: s.lastSeen, breaches: matchService(s.domain, index, confirmed) },
        now,
      ),
    }))
    .sort((a, b) => b.risk.score - a.risk.score || b.messages - a.messages || a.name.localeCompare(b.name));
}

export type DashboardFilter = { category?: Category; level?: Level; breachedOnly?: boolean };

export function filterServices(all: ServiceRisk[], f: DashboardFilter): ServiceRisk[] {
  return all.filter(
    (s) =>
      (!f.category || s.category === f.category) &&
      (!f.level || s.risk.level === f.level) &&
      (!f.breachedOnly || s.risk.breaches.length > 0),
  );
}

export type Summary = {
  total: number;
  high: number;
  medium: number;
  breached: number;
  dormant: number;
  byCategory: Record<Category, number>;
};

export function summarize(all: ServiceRisk[]): Summary {
  const byCategory: Record<Category, number> = { account: 0, subscription: 0, receipt: 0, newsletter: 0 };
  let high = 0;
  let medium = 0;
  let breached = 0;
  let dormant = 0;
  for (const s of all) {
    byCategory[s.category]++;
    if (s.risk.level === "high") high++;
    if (s.risk.level === "medium") medium++;
    if (s.risk.breaches.length > 0) breached++;
    if (s.risk.dormant) dormant++;
  }
  return { total: all.length, high, medium, breached, dormant, byCategory };
}
