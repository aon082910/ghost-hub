import { createHash } from "node:crypto";
import { z } from "zod";
import { devOverride } from "../dev-override";
import { UnsafeUrlError } from "../newsletters/ssrf";
import { fetchPage, type GetTransport } from "./http";
import { appliesTo, openUrl, requestUrl, type Site } from "./sites";

export type Verdict = "found" | "not_found" | "unknown";

/** Decide from a response whether the profile exists. Pure. "unknown" means blocked, changed or inconclusive. */
export function evaluate(site: Site, status: number, body: string): Verdict {
  if (site.notFoundStatus?.includes(status)) return "not_found";
  if (!site.foundStatus.includes(status)) return "unknown";
  if (site.notFoundText && body.includes(site.notFoundText)) return "not_found";
  if (site.foundText && !body.includes(site.foundText)) return "unknown";
  return "found";
}

export type CheckResult = {
  status: "found" | "not_found" | "error";
  /** Where a person can open the profile (set when found). */
  url?: string;
  /** Why we couldn't tell, when status is "error". */
  detail?: string;
};

function describeStatus(status: number): string {
  if (status === 403) return "The site blocks automated requests";
  if (status === 429) return "The site is rate limiting requests";
  if (status >= 500) return `The site had an error (HTTP ${status})`;
  return `Unexpected answer (HTTP ${status})`;
}

export function describeNetworkError(err: unknown): string {
  if (err instanceof UnsafeUrlError) return "Skipped: the address wasn't safe to contact";
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "ENOTPUBLIC") return "Skipped: the name resolves to a private address";
  if (code === "ETIMEDOUT") return "The site took too long to respond";
  return "Couldn't reach the site";
}

/** Look one username up on one site. Never throws: every failure comes back as an "error" result with a reason. */
export async function checkSite(site: Site, username: string, transport?: GetTransport): Promise<CheckResult> {
  if (!appliesTo(site, username)) return { status: "error", detail: "This username can't exist on this site" };
  try {
    const page = await fetchPage(requestUrl(site, username), transport);
    if (page.kind === "redirected_away") return { status: "error", detail: `The site sent the request to ${page.host}` };
    const verdict = evaluate(site, page.status, page.body);
    if (verdict === "found") return { status: "found", url: openUrl(site, username) };
    if (verdict === "not_found") return { status: "not_found" };
    return { status: "error", detail: describeStatus(page.status) };
  } catch (err) {
    return { status: "error", detail: describeNetworkError(err) };
  }
}

const gravatarBase = () => devOverride("GRAVATAR_API_URL", "https://api.gravatar.com/v3/profiles");

const gravatarProfile = z.object({
  profile_url: z.string().optional(),
  display_name: z.string().optional(),
  verified_accounts: z.array(z.object({ service_label: z.string().optional(), url: z.string().optional() })).default([]),
});

export type LinkedAccount = { service: string; url: string };
export type GravatarResult =
  | { status: "found"; profileUrl: string; linked: LinkedAccount[] }
  | { status: "not_found" }
  | { status: "error"; detail: string };

/** Accept only a plain https URL, so a value from a third party can never become a `javascript:` link. */
const httpsUrl = (value: string | undefined): string | null => {
  if (!value || value.length > 2048) return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
};

/** The hash Gravatar identifies an address by. Only this leaves the machine, never the address itself. */
export const gravatarHash = (email: string) => createHash("sha256").update(email.trim().toLowerCase()).digest("hex");

/**
 * Does Gravatar have a public profile for this address, and which accounts has its owner linked to it? Asked by hash,
 * so the address is never sent. Needs no key (100 requests an hour).
 */
export async function checkGravatar(email: string, transport?: GetTransport): Promise<GravatarResult> {
  try {
    const page = await fetchPage(`${gravatarBase()}/${gravatarHash(email)}`, transport);
    if (page.kind === "redirected_away") return { status: "error", detail: `Gravatar sent the request to ${page.host}` };
    if (page.status === 404) return { status: "not_found" };
    if (page.status !== 200) return { status: "error", detail: describeStatus(page.status) };

    const parsed = gravatarProfile.safeParse(JSON.parse(page.body));
    if (!parsed.success) return { status: "error", detail: "Gravatar's answer wasn't in the expected format" };
    const linked: LinkedAccount[] = [];
    for (const a of parsed.data.verified_accounts) {
      const url = httpsUrl(a.url);
      if (url && a.service_label) linked.push({ service: a.service_label.slice(0, 40), url });
    }
    return { status: "found", profileUrl: httpsUrl(parsed.data.profile_url) ?? `https://gravatar.com/${gravatarHash(email)}`, linked: linked.slice(0, 20) };
  } catch (err) {
    return { status: "error", detail: err instanceof SyntaxError ? "Gravatar's answer wasn't in the expected format" : describeNetworkError(err) };
  }
}
