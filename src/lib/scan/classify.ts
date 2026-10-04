import { parse as parseDomain } from "tldts";
import type { MessageHeader } from "./types";

export type Category = "account" | "subscription" | "receipt" | "newsletter";

/** Higher wins when several messages from one service disagree. Mirrored in the SQL upsert. */
export const CATEGORY_RANK: Record<Category, number> = { account: 4, subscription: 3, receipt: 2, newsletter: 1 };

export type Classification = {
  /** Registrable domain of the sender, e.g. `paypal.com`. */
  domain: string;
  name: string;
  category: Category | null;
  newsletter: null | {
    senderEmail: string;
    senderName: string | null;
    listUnsubscribe: string | null;
    oneClick: boolean;
  };
};

/** Senders here are people, not services. */
const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "rocketmail.com", "outlook.com", "hotmail.com", "live.com",
  "msn.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.net",
  "mail.com", "zoho.com", "fastmail.com", "hey.com", "tutanota.com", "yandex.com", "yahoo.co.uk", "hotmail.co.uk",
  "btinternet.com", "comcast.net", "att.net", "sbcglobal.net", "verizon.net", "cox.net", "charter.net",
]);

// Subjects that mean "an account exists / something happened to it".
const ACCOUNT = [
  /\bwelcome to\b/, /\bwelcome aboard\b/, /\bthanks? (?:you )?for (?:signing up|registering|joining|creating)/,
  /\b(?:verify|confirm|activate) your (?:e-?mail|account|address|registration|sign-?up)/,
  /\b(?:confirm|verification|activation) (?:code|link|e-?mail)\b/, /\byour (?:new )?account (?:has been )?(?:created|is ready|was created)/,
  /\baccount (?:created|activation|confirmation|verification)\b/, /\bcomplete your (?:registration|sign-?up|profile)/,
  /\breset your password\b/, /\bpassword (?:reset|changed|was changed|recovery)\b/, /\b(?:new|unusual|suspicious) (?:sign-?in|log-?in|device|login)\b/,
  /\bsecurity alert\b/, /\bsign-?in (?:attempt|alert|notification)\b/, /\bverify it'?s you\b/, /\bone-time (?:code|password)\b/,
  /\byour (?:verification|security|login|sign-?in) code\b/, /\bgetting started\b/, /\bset up your account\b/,
];

const BILLING = [
  /\bsubscription\b/, /\bmembership\b/, /\b(?:auto-?)?renew(?:al|s|ed|ing)?\b/, /\bfree trial\b/, /\btrial (?:ends|ending|has ended|expires)\b/,
  /\bbilling\b/, /\bpayment (?:method|failed|due|declined|reminder)\b/, /\bupcoming (?:charge|payment|renewal)\b/, /\bplan (?:change|upgrade|downgrade|has been)\b/,
];

const ORDER = [
  /\b(?:your )?receipt\b/, /\border (?:confirmation|confirmed|#|number|received|shipped|has shipped|update)\b/, /\byour order\b/, /\binvoice\b/,
  /\bpayment (?:received|confirmation|successful|processed)\b/, /\bthank you for your (?:order|purchase|payment)\b/, /\bshipping (?:confirmation|update|notification)\b/,
  /\bdelivery (?:update|notification|confirmation)\b/, /\bpurchase (?:confirmation|receipt)\b/,
];

/** Automated sender names that suggest the service has you on file. Human-ish ones (support, info, team) are left out. */
const TRANSACTIONAL_LOCAL =
  /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|noreply|notifications?|notify|accounts?|security|billing|orders?|receipts?|alerts?|mailer|account[-_.]?security|verify|verification|password)$/;

/** The registrable domain of a hostname (`mail.example.co.uk` → `example.co.uk`), or null for IPs and unknown TLDs. */
export function registrableFromHost(host: string): string | null {
  const p = parseDomain(host.trim().toLowerCase());
  return p.domain && p.isIcann ? p.domain : null;
}

export function registrableDomain(email: string): string | null {
  const host = email.split("@")[1];
  return host ? registrableFromHost(host) : null;
}

const titleCase = (s: string) => s.replace(/(^|[-\s])([a-z])/g, (_, a, b) => a + b.toUpperCase());
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** "paypal.com" → "Paypal", but keep the sender's own casing when it clearly names the service ("PayPal"). */
export function serviceName(domain: string, fromName: string | null): string {
  const label = domain.split(".")[0];
  const fallback = titleCase(label);
  if (!fromName) return fallback;
  const cleaned = fromName
    .replace(/["']/g, "")
    .replace(/\b(?:no-?reply|do not reply|team|support|customer (?:service|care)|notifications?|security|accounts?|billing|inc\.?|llc|ltd\.?)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned && squash(cleaned) === squash(label) ? cleaned : fallback;
}

const isBulk = (m: MessageHeader) =>
  Boolean(m.listUnsubscribe || m.listId) || /\b(?:bulk|list|junk)\b/i.test(m.precedence ?? "");

/**
 * Decide what a message says about the sender. Returns null `category` for mail that doesn't indicate a
 * service relationship (people, one-off conversations). `ownAddress` is the scanned mailbox, so the user's
 * own mail is never counted as a service.
 */
export function classify(m: MessageHeader, ownAddress: string): Classification | null {
  const from = m.fromEmail.trim().toLowerCase();
  if (!from || from === ownAddress.toLowerCase()) return null;
  const domain = registrableDomain(from);
  if (!domain || FREE_MAIL.has(domain)) return null;
  const ownDomain = registrableDomain(ownAddress);
  if (ownDomain && ownDomain === domain && !FREE_MAIL.has(ownDomain)) return null; // mail from your own domain

  const subject = m.subject.toLowerCase();
  const local = from.split("@")[0];
  const bulk = isBulk(m);

  let category: Category | null = null;
  if (ACCOUNT.some((r) => r.test(subject))) category = "account";
  else if (BILLING.some((r) => r.test(subject))) category = "subscription";
  else if (ORDER.some((r) => r.test(subject))) category = "receipt";
  else if (bulk) category = "newsletter";
  else if (TRANSACTIONAL_LOCAL.test(local)) category = "account";

  const newsletter = m.listUnsubscribe
    ? {
        senderEmail: from,
        senderName: m.fromName,
        listUnsubscribe: m.listUnsubscribe.slice(0, 2000),
        oneClick: /one-click/i.test(m.listUnsubscribePost ?? "") && /<https:\/\//i.test(m.listUnsubscribe),
      }
    : bulk && category === "newsletter"
      ? { senderEmail: from, senderName: m.fromName, listUnsubscribe: null, oneClick: false }
      : null;

  return { domain, name: serviceName(domain, m.fromName), category, newsletter };
}

/** `"Name" <a@b.com>` or `a@b.com` → parts. Used by the IMAP and header-based sources. */
export function parseAddress(value: string): { email: string; name: string | null } | null {
  const angle = value.match(/^\s*(?:"?([^"<]*?)"?\s*)?<([^<>\s]+@[^<>\s]+)>/);
  if (angle) return { email: angle[2].toLowerCase(), name: angle[1]?.trim() || null };
  const bare = value.match(/([^\s<>"',;]+@[^\s<>"',;]+)/);
  return bare ? { email: bare[1].toLowerCase(), name: null } : null;
}

/** Parse a raw RFC 5322 header block (unfolding continuation lines) into lowercase-name → value. First wins. */
export function parseHeaderBlock(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const unfolded = raw.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    if (!(name in out)) out[name] = line.slice(i + 1).trim();
  }
  return out;
}
