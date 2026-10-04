import { z } from "zod";
import { devOverride } from "../dev-override";

/** HIBP requires a descriptive User-Agent on every request. */
export const HIBP_USER_AGENT = "Ghost-Hub (self-hosted; +https://github.com/aon082910/ghost-hub)";

const base = () => devOverride("HIBP_BASE_URL", "https://haveibeenpwned.com/api/v3");

export class HibpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HibpError";
  }
}

export type Breach = {
  name: string;
  title: string;
  /** As reported by HIBP; may be a subdomain such as `forums.example.com`. */
  domain: string;
  /** ISO date (YYYY-MM-DD) or null when unknown. */
  breachDate: string | null;
  pwnCount: number | null;
  dataClasses: string[];
  isVerified: boolean;
};

const entry = z.object({
  Name: z.string().min(1),
  Title: z.string().optional(),
  Domain: z.string().nullish(),
  BreachDate: z.string().nullish(),
  PwnCount: z.number().nullish(),
  DataClasses: z.array(z.string()).default([]),
  IsVerified: z.boolean().default(true),
  IsFabricated: z.boolean().default(false),
  IsSpamList: z.boolean().default(false),
  IsMalware: z.boolean().default(false),
  IsStealerLog: z.boolean().default(false),
  IsRetired: z.boolean().default(false),
});

/**
 * Turn the raw catalog into the breaches worth matching to a service: ones that name a domain, and aren't
 * fabricated, spam lists, malware / stealer logs (which aren't about a service) or retired. Malformed
 * entries are skipped rather than failing the whole refresh.
 */
export function parseCatalog(json: unknown): { breaches: Breach[]; skipped: number } {
  if (!Array.isArray(json)) throw new Error("Unexpected response from Have I Been Pwned (expected a list)");
  const breaches: Breach[] = [];
  let skipped = 0;
  for (const raw of json) {
    const p = entry.safeParse(raw);
    if (!p.success) {
      skipped++;
      continue;
    }
    const e = p.data;
    const domain = e.Domain?.trim().toLowerCase();
    if (!domain || e.IsFabricated || e.IsSpamList || e.IsMalware || e.IsStealerLog || e.IsRetired) continue;
    breaches.push({
      name: e.Name,
      title: e.Title || e.Name,
      domain,
      breachDate: e.BreachDate && /^\d{4}-\d{2}-\d{2}$/.test(e.BreachDate) ? e.BreachDate : null,
      pwnCount: e.PwnCount ?? null,
      dataClasses: e.DataClasses,
      isVerified: e.IsVerified,
    });
  }
  return { breaches, skipped };
}

type Deps = { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> };

/** The public breach list. No API key and nothing about the user is sent. */
export async function fetchCatalog({ fetchImpl = fetch }: Deps = {}) {
  const res = await fetchImpl(`${base()}/breaches`, {
    headers: { "user-agent": HIBP_USER_AGENT, accept: "application/json" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new HibpError(res.status, `Have I Been Pwned returned HTTP ${res.status}`);
  return parseCatalog(await res.json());
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Names of the breaches a mailbox address appears in. This sends the address to Have I Been Pwned and needs
 * the user's own API key, so it only runs when they've configured one and asked for it.
 */
export async function fetchMailboxBreaches(
  email: string,
  apiKey: string,
  { fetchImpl = fetch, sleep = defaultSleep }: Deps = {},
): Promise<string[]> {
  const url = `${base()}/breachedaccount/${encodeURIComponent(email)}?truncateResponse=true`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(url, {
      headers: { "hibp-api-key": apiKey, "user-agent": HIBP_USER_AGENT, accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 404) return []; // HIBP's way of saying "not found in any breach"
    if (res.status === 401) throw new HibpError(401, "Have I Been Pwned rejected the API key");
    if (res.status === 429 && attempt === 0) {
      const wait = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(wait) && wait >= 0 ? Math.min(wait, 30) * 1000 : 2000);
      continue;
    }
    if (!res.ok) throw new HibpError(res.status, `Have I Been Pwned returned HTTP ${res.status}`);
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) throw new HibpError(res.status, "Unexpected response from Have I Been Pwned");
    return body.flatMap((b) => (typeof b?.Name === "string" ? [b.Name as string] : []));
  }
}
