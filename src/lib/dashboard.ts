import { loadCatalog, loadConfirmedNames } from "./breaches/store";
import { indexBreaches, matchService } from "./breaches/match";
import { assessRisk, type Level, type RiskResult } from "./breaches/risk";
import { groupByCompany } from "./deletion/companies";
import { listDiscovered, type DiscoveredService } from "./discovered";
import { CATEGORY_RANK, type Category } from "./scan/classify";

const STILL_EMAILING_AFTER_MS = 3 * 86_400_000;

/** One company: the domains it emails from, folded into the busiest one (`domain`). */
export type CompanyService = DiscoveredService & {
  /** Every domain folded into this row, `domain` first. One entry when nothing was merged. */
  domains: string[];
};

export type ServiceRisk = CompanyService & {
  /** Every message from this company was in a Spam/Junk folder: probably not a service you signed up for. */
  spamOnly: boolean;
  risk: RiskResult;
  /** The user marked it deleted, yet it kept emailing more than 3 days later (seen on a later scan). */
  stillEmailing: boolean;
};

export const LEVELS: Level[] = ["high", "medium", "low", "minimal"];
export const isLevel = (v: string | undefined): v is Level => v !== undefined && (LEVELS as string[]).includes(v);

const MAX_MERGED_DOMAINS = 50;

/** True when there is mail and none of it was outside a Spam/Junk folder. */
export const isSpamOnly = (s: { messages: number; spamCount: number }) => s.messages > 0 && s.spamCount >= s.messages;

/**
 * Fold services that are the same company (per the deletion-guide dataset, see `groupByCompany`) into one row, so a
 * company that emails from several domains is scored, shown and recorded once. The busiest domain leads; counts add up,
 * dates widen, the strongest category wins, and the row only reads "deleted" or "kept" when every domain agrees.
 */
export function mergeCompanies(services: DiscoveredService[]): CompanyService[] {
  const byDomain = new Map(services.map((s) => [s.domain, s]));
  return groupByCompany(services.map((s) => s.domain)).map((group) => {
    const members = group
      .slice(0, MAX_MERGED_DOMAINS)
      .map((d) => byDomain.get(d)!)
      .sort((a, b) => b.messages - a.messages || a.domain.localeCompare(b.domain));
    const [lead] = members;
    if (members.length === 1) return { ...lead, domains: [lead.domain] };
    const all = (state: DiscoveredService["state"]) => members.every((m) => m.state === state);
    const deletedAts = members.flatMap((m) => (m.deletedAt ? [m.deletedAt.getTime()] : []));
    return {
      ...lead,
      domains: members.map((m) => m.domain),
      category: members.reduce((best, m) => (CATEGORY_RANK[m.category] > CATEGORY_RANK[best] ? m.category : best), lead.category),
      messages: members.reduce((n, m) => n + m.messages, 0),
      spamCount: members.reduce((n, m) => n + m.spamCount, 0),
      firstSeen: new Date(Math.min(...members.map((m) => m.firstSeen.getTime()))),
      lastSeen: new Date(Math.max(...members.map((m) => m.lastSeen.getTime()))),
      mailboxes: Math.max(...members.map((m) => m.mailboxes)),
      state: all("deleted") ? "deleted" : all("ignored") ? "ignored" : "active",
      deletedAt: deletedAts.length ? new Date(Math.max(...deletedAts)) : null,
    };
  });
}

/** Breaches naming any of the company's domains, each counted once even if several domains point at it. */
function breachesFor(domains: string[], index: ReturnType<typeof indexBreaches>, confirmed: ReadonlySet<string>) {
  const seen = new Set<string>();
  return domains.flatMap((d) => matchService(d, index, confirmed)).filter((b) => !seen.has(b.name) && !!seen.add(b.name));
}

/** Every discovered service with its risk assessment, riskiest first. */
export async function loadServices(now = new Date()): Promise<ServiceRisk[]> {
  const [services, catalog, confirmed] = await Promise.all([listDiscovered(undefined, 10_000), loadCatalog(), loadConfirmedNames()]);
  const index = indexBreaches(catalog);
  return mergeCompanies(services)
    .map((s) => ({
      ...s,
      spamOnly: isSpamOnly(s),
      stillEmailing: s.state === "deleted" && s.deletedAt !== null && s.lastSeen.getTime() > s.deletedAt.getTime() + STILL_EMAILING_AFTER_MS,
      risk: assessRisk(
        { category: s.category, firstSeen: s.firstSeen, lastSeen: s.lastSeen, breaches: breachesFor(s.domains, index, confirmed) },
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
