import { z } from "zod";
import { isMailto } from "../newsletters/headers";
import { registrableFromHost } from "../scan/classify";
import bundled from "./guides.json";

/**
 * How to delete an account on each service, from the community-maintained JustDeleteMe dataset (MIT licensed, see
 * JUSTDELETEME-LICENSE.txt). It's bundled and refreshed with `npm run guides:update`, so no request is made at runtime.
 * Everything in it is third-party text, so it's validated on load and only ever shown as plain text and https links.
 */
const guideSchema = z.object({
  name: z.string().min(1),
  url: z.string(),
  difficulty: z.enum(["easy", "medium", "hard", "impossible", "limited"]),
  domains: z.array(z.string()).min(1),
  notes: z.string().optional(),
  email: z.string().optional(),
  emailSubject: z.string().optional(),
  emailBody: z.string().optional(),
});
export type Guide = z.infer<typeof guideSchema>;
export type Difficulty = Guide["difficulty"];

export const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  easy: "Easy",
  medium: "Medium",
  hard: "Hard",
  impossible: "Not offered",
  limited: "Depends where you live",
};
export const DIFFICULTY_HINT: Record<Difficulty, string> = {
  easy: "Can usually be done online in a few steps.",
  medium: "Takes some extra steps, such as cancelling a subscription first.",
  hard: "You may have to contact the company.",
  impossible: "The company doesn't offer account deletion. You can usually still remove your personal details.",
  limited: "What's available depends on your country or region.",
};

let all: Guide[] | undefined;
let index: Map<string, Guide[]> | undefined;

export function loadGuides(): Guide[] {
  all ??= z.array(guideSchema).parse(bundled);
  return all;
}

function buildIndex() {
  const map = new Map<string, Guide[]>();
  for (const g of loadGuides()) {
    const seen = new Set<string>();
    for (const d of g.domains) {
      const reg = registrableFromHost(d);
      if (!reg || seen.has(reg)) continue;
      seen.add(reg);
      const list = map.get(reg) ?? [];
      list.push(g);
      map.set(reg, list);
    }
  }
  return map;
}

const MAX_GUIDES = 3;

/**
 * Guides for a service's registrable domain (`github.com`). A guide that lists that exact domain comes before one that
 * only covers a subdomain of it. Capped so a large company with many products doesn't flood the screen.
 */
export function findGuides(domain: string): Guide[] {
  index ??= buildIndex();
  const d = domain.toLowerCase();
  const hits = index.get(d) ?? [];
  return [...hits].sort((a, b) => Number(b.domains.includes(d)) - Number(a.domains.includes(d))).slice(0, MAX_GUIDES);
}

export type Segment = { text: string; href?: string };

const MD_LINK = /\[([^\]\n]{1,120})\]\((https:\/\/[^\s)]{1,500})\)/g;

const plainHttps = (value: string): boolean => {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password;
  } catch {
    return false;
  }
};

/** Turn a note into text and links. HTML is stripped, and only `[text](https://...)` becomes a link. */
export function parseNotes(notes: string): Segment[] {
  const text = notes.replace(/<[^>]*>/g, "");
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(MD_LINK)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push(plainHttps(m[2]) ? { text: m[1], href: m[2] } : { text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out.filter((s) => s.text.length > 0);
}

export type GuideView = {
  name: string;
  difficulty: Difficulty;
  /** The deletion page, only when it's a plain https link. */
  openUrl: string | null;
  /** The company only publishes an insecure (http) address, so no link is offered. */
  insecure: boolean;
  notes: Segment[];
  /** A prefilled email request for the user's own mail app, when the company takes requests by email. */
  mailto: string | null;
};

export function viewGuide(g: Guide): GuideView {
  const https = plainHttps(g.url);
  const email = g.email && isMailto(`mailto:${g.email}`) ? g.email : null;
  const query = new URLSearchParams();
  if (g.emailSubject) query.set("subject", g.emailSubject);
  if (g.emailBody) query.set("body", g.emailBody);
  return {
    name: g.name,
    difficulty: g.difficulty,
    openUrl: https ? g.url : null,
    insecure: !https && g.url.toLowerCase().startsWith("http://"),
    notes: g.notes ? parseNotes(g.notes) : [],
    // URLSearchParams encodes spaces as "+", which mail apps show literally, so use %20.
    mailto: email ? `mailto:${email}${query.size ? `?${query.toString().replaceAll("+", "%20")}` : ""}` : null,
  };
}

export const guidesFor = (domain: string): GuideView[] => findGuides(domain).map(viewGuide);
