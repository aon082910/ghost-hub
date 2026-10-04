import type { Category } from "../scan/classify";
import type { Breach } from "./hibp";

export type Scope = "domain" | "subdomain";
export type Exposure = "confirmed" | "likely" | "before" | "unknown";
export type Level = "high" | "medium" | "low" | "minimal";

/** A breach that names a service's domain. */
export type BreachMatch = Breach & {
  /** `subdomain` when the breach was of e.g. `forums.example.com` rather than `example.com` itself. */
  scope: Scope;
  /** The user's own address was found in this breach (needs an HIBP API key). */
  confirmed: boolean;
};

export type RiskInput = {
  category: Category;
  firstSeen: Date;
  lastSeen: Date;
  breaches: BreachMatch[];
};

export type RiskFactor = { label: string; points: number };

export type AssessedBreach = BreachMatch & { exposure: Exposure; points: number; severity: string };

export type RiskResult = {
  score: number;
  level: Level;
  factors: RiskFactor[];
  breaches: AssessedBreach[];
  /** No email from this account-like service in over 2 years. */
  dormant: boolean;
};

// How bad is the data that leaked? The worst class present sets the severity.
const CREDENTIALS = ["Passwords", "Password hints", "Security questions and answers", "Auth tokens", "Password history"];
const FINANCIAL = ["Credit cards", "Partial credit card data", "Bank account numbers", "Payment histories", "Financial transactions", "Credit status information"];
const IDENTITY = [
  "Government issued IDs", "Social security numbers", "Passport numbers", "Dates of birth", "Physical addresses", "Phone numbers",
  "Biometric data", "Driver's licenses", "Health insurance information", "Medical conditions", "Private messages",
];

const SEVERITY = { credentials: 50, financial: 30, identity: 18, basic: 8 } as const;

/** Severity points and tier name for a set of leaked data classes. */
export function severity(dataClasses: string[]): { points: number; tier: keyof typeof SEVERITY } {
  const has = (list: string[]) => dataClasses.some((c) => list.includes(c));
  if (has(CREDENTIALS)) return { points: SEVERITY.credentials, tier: "credentials" };
  if (has(FINANCIAL)) return { points: SEVERITY.financial, tier: "financial" };
  if (has(IDENTITY)) return { points: SEVERITY.identity, tier: "identity" };
  return { points: SEVERITY.basic, tier: "basic" };
}

const DAY = 86_400_000;
const GRACE_MS = 30 * DAY; // an account made just before the breach was probably caught up in it
const DORMANT_MS = 2 * 365 * DAY;

/** Did the breach plausibly include this account? Judged by when the service first emailed the user. */
export function exposureFor(breach: BreachMatch, firstSeen: Date): { exposure: Exposure; factor: number } {
  if (breach.confirmed) return { exposure: "confirmed", factor: 1 };
  const when = breach.breachDate ? Date.parse(breach.breachDate) : NaN;
  if (!Number.isFinite(when)) return { exposure: "unknown", factor: 0.6 };
  return when >= firstSeen.getTime() - GRACE_MS ? { exposure: "likely", factor: 0.8 } : { exposure: "before", factor: 0.3 };
}

const BASE: Record<Category, { points: number; label: string }> = {
  account: { points: 15, label: "You have a login with this service" },
  subscription: { points: 10, label: "Recurring or paid relationship" },
  receipt: { points: 5, label: "You've bought from this service" },
  newsletter: { points: 0, label: "" },
};

const MAX_BREACH_POINTS = 60;

export function levelFor(score: number): Level {
  return score >= 60 ? "high" : score >= 35 ? "medium" : score >= 15 ? "low" : "minimal";
}

/**
 * Score one service from 0 to 100 and explain why. Pure and deterministic so the numbers shown on the dashboard
 * can always be traced to a list of factors. It's a rule of thumb, not a verdict.
 */
export function assessRisk(input: RiskInput, now = new Date()): RiskResult {
  const factors: RiskFactor[] = [];
  const base = BASE[input.category];
  if (base.points) factors.push({ label: base.label, points: base.points });

  // Newsletters usually don't mean an account with credentials, so breaches count for less.
  const categoryFactor = input.category === "newsletter" ? 0.5 : 1;

  const assessed: AssessedBreach[] = input.breaches
    .map((b) => {
      const { exposure, factor } = exposureFor(b, input.firstSeen);
      const sev = severity(b.dataClasses);
      const points = Math.round(
        sev.points * factor * (b.isVerified ? 1 : 0.5) * (b.scope === "subdomain" ? 0.5 : 1) * categoryFactor,
      );
      return { ...b, exposure, points, severity: sev.tier };
    })
    .sort((a, b) => b.points - a.points || (b.breachDate ?? "").localeCompare(a.breachDate ?? ""));

  // Count the worst few breaches, not all of them: a fifth leak of the same password adds little.
  const breachPoints = Math.min(MAX_BREACH_POINTS, assessed.slice(0, 3).reduce((sum, b) => sum + b.points, 0));
  if (breachPoints > 0) {
    const n = assessed.length;
    factors.push({ label: `${n} known breach${n === 1 ? "" : "es"} of this service`, points: breachPoints });
  }

  const dormant =
    now.getTime() - input.lastSeen.getTime() > DORMANT_MS &&
    (input.category === "account" || input.category === "subscription");
  if (dormant) {
    factors.push({ label: "No email from this service in over 2 years: probably a forgotten account", points: 15 });
  }

  const score = Math.min(100, factors.reduce((sum, f) => sum + f.points, 0));
  return { score, level: levelFor(score), factors, breaches: assessed, dormant };
}
