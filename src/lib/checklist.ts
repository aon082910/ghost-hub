import type { ServiceRisk } from "./dashboard";
import { DIFFICULTY_LABEL, guidesFor, type Difficulty } from "./deletion/guides";

/**
 * A to-do list for moving accounts off an email address (or cleaning them up): one row per company still on your
 * list, riskiest first, with a link to its site and, where there is one, how to delete it. Built from what the dashboard
 * already shows; nothing is fetched. Names come from email headers, so they're untrusted and escaped for each format.
 */
export type ChecklistItem = {
  name: string;
  domain: string;
  /** Other domains of the same company, folded into this row. */
  alsoDomains: string[];
  category: string;
  emails: number;
  firstEmail: string;
  lastEmail: string;
  riskLevel: string;
  riskScore: number;
  breaches: string[];
  /** The company's own website, from its (validated) domain. */
  siteUrl: string;
  deletion: { difficulty: Difficulty; url: string | null } | null;
};

export type ChecklistOptions = { includeNewsletters?: boolean };

const day = (d: Date) => d.toISOString().slice(0, 10);
// Control characters and line separators are replaced so a name can't break out of its line or cell.
const clean = (s: string, max = 80) =>
  [...s]
    .map((ch) => {
      const c = ch.codePointAt(0)!;
      return c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 ? " " : ch;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

/** What's still to do: services you haven't deleted or chosen to keep, minus spam-only ones, minus newsletters unless asked for. */
export function checklistItems(services: ServiceRisk[], opts: ChecklistOptions = {}): ChecklistItem[] {
  return services
    .filter((s) => s.state === "active" && !s.spamOnly && (opts.includeNewsletters || s.category !== "newsletter"))
    .map((s) => {
      const guide = guidesFor(s.domain)[0] ?? s.domains.flatMap((d) => guidesFor(d))[0];
      return {
        name: clean(s.name) || s.domain,
        domain: s.domain,
        alsoDomains: s.domains.filter((d) => d !== s.domain),
        category: s.category,
        emails: s.messages,
        firstEmail: day(s.firstSeen),
        lastEmail: day(s.lastSeen),
        riskLevel: s.risk.level,
        riskScore: s.risk.score,
        breaches: s.risk.breaches.map((b) => clean(b.title || b.name)),
        siteUrl: `https://${s.domain}`,
        deletion: guide ? { difficulty: guide.difficulty, url: guide.openUrl } : null,
      };
    })
    .sort((a, b) => b.riskScore - a.riskScore || b.lastEmail.localeCompare(a.lastEmail) || a.domain.localeCompare(b.domain));
}

/** Escape text so it can't turn into markdown formatting, links, HTML or a table. */
const md = (s: string) => s.replace(/[\\`*_{}[\]<>()#+\-!|~&]/g, "\\$&");

const LEVEL_ORDER = ["high", "medium", "low", "minimal"];
const LEVEL_TITLE: Record<string, string> = { high: "High risk", medium: "Medium risk", low: "Low risk", minimal: "Minimal risk" };

export function toMarkdown(items: ChecklistItem[], now = new Date()): string {
  const out: string[] = [
    "# Ghost-Hub account checklist",
    "",
    `Made ${day(now)}. ${items.length} service${items.length === 1 ? "" : "s"} still on your list, riskiest first.`,
    "For each one: sign in, change the email address (or delete the account), then tick it off.",
    "",
  ];
  for (const level of LEVEL_ORDER) {
    const group = items.filter((i) => i.riskLevel === level);
    if (!group.length) continue;
    out.push(`## ${LEVEL_TITLE[level]} (${group.length})`, "");
    for (const i of group) {
      const also = i.alsoDomains.length ? ` (also ${i.alsoDomains.map(md).join(", ")})` : "";
      out.push(`- [ ] **${md(i.name)}** - ${md(i.domain)}${also}`);
      out.push(`  - ${i.emails} email${i.emails === 1 ? "" : "s"}, ${i.firstEmail} to ${i.lastEmail} - ${i.category}, risk ${i.riskScore}`);
      out.push(`  - Site: <${i.siteUrl}>`);
      if (i.breaches.length) out.push(`  - Known breaches: ${i.breaches.map(md).join(", ")}`);
      if (i.deletion) {
        out.push(`  - Deleting it: ${DIFFICULTY_LABEL[i.deletion.difficulty]}${i.deletion.url ? ` - <${i.deletion.url}>` : ""}`);
      }
    }
    out.push("");
  }
  return out.join("\n");
}

/** A spreadsheet must not run a cell as a formula, so a value that starts like one is made plain text. */
const cell = (v: string | number) => {
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

export function toCsv(items: ChecklistItem[]): string {
  const header = ["Done", "Service", "Domain", "Also domains", "Category", "Emails", "First email", "Last email", "Risk", "Score", "Known breaches", "Site", "Deletion difficulty", "Deletion page"];
  const rows = items.map((i) => [
    "",
    i.name,
    i.domain,
    i.alsoDomains.join(" "),
    i.category,
    i.emails,
    i.firstEmail,
    i.lastEmail,
    i.riskLevel,
    i.riskScore,
    i.breaches.join("; "),
    i.siteUrl,
    i.deletion ? DIFFICULTY_LABEL[i.deletion.difficulty] : "",
    i.deletion?.url ?? "",
  ]);
  return [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
