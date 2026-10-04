import { loadCatalog, loadConfirmedNames } from "./breaches/store";
import { indexBreaches, matchService } from "./breaches/match";
import { assessRisk, type Level, type RiskResult } from "./breaches/risk";
import { listDiscovered, type DiscoveredService } from "./discovered";
import type { Category } from "./scan/classify";

const STILL_EMAILING_AFTER_MS = 3 * 86_400_000;

export type ServiceRisk = DiscoveredService & {
  risk: RiskResult;
  /** The user marked it deleted, yet it kept emailing more than 3 days later (seen on a later scan). */
  stillEmailing: boolean;
};

export const LEVELS: Level[] = ["high", "medium", "low", "minimal"];
export const isLevel = (v: string | undefined): v is Level => v !== undefined && (LEVELS as string[]).includes(v);

/** Every discovered service with its risk assessment, riskiest first. */
export async function loadServices(now = new Date()): Promise<ServiceRisk[]> {
  const [services, catalog, confirmed] = await Promise.all([listDiscovered(undefined, 10_000), loadCatalog(), loadConfirmedNames()]);
  const index = indexBreaches(catalog);
  return services
    .map((s) => ({
      ...s,
      stillEmailing: s.state === "deleted" && s.deletedAt !== null && s.lastSeen.getTime() > s.deletedAt.getTime() + STILL_EMAILING_AFTER_MS,
      risk: assessRisk(
        { category: s.category, firstSeen: s.firstSeen, lastSeen: s.lastSeen, breaches: matchService(s.domain, index, confirmed) },
        now,
      ),
    }))
    .sort((a, b) => b.risk.score - a.risk.score || b.messages - a.messages || a.name.localeCompare(b.name));
}

export type Show = "active" | "deleted" | "kept" | "all";
export const SHOWS: Show[] = ["active", "deleted", "kept", "all"];
export const isShow = (v: string | undefined): v is Show => v !== undefined && (SHOWS as string[]).includes(v);

/** `show` left out means no filtering by what the user has decided. */
export type DashboardFilter = { category?: Category; level?: Level; breachedOnly?: boolean; show?: Show };

export const matchesShow = (s: ServiceRisk, show: Show | undefined) =>
  !show || show === "all" || (show === "active" ? s.state === "active" : show === "deleted" ? s.state === "deleted" : s.state === "ignored");

export function filterServices(all: ServiceRisk[], f: DashboardFilter): ServiceRisk[] {
  return all.filter(
    (s) =>
      matchesShow(s, f.show) &&
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

/** What the user has done, across every service (not just the ones on screen). */
export function decisionCounts(all: ServiceRisk[]) {
  return {
    active: all.filter((s) => s.state === "active").length,
    deleted: all.filter((s) => s.state === "deleted").length,
    kept: all.filter((s) => s.state === "ignored").length,
    stillEmailing: all.filter((s) => s.stillEmailing).length,
  };
}

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
