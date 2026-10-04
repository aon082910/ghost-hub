// Refresh the bundled account-deletion guides from the JustDeleteMe dataset (MIT licensed).
//   node scripts/update-deletion-guides.mjs
// Keeps only what Ghost-Hub shows (English text, the deletion page, difficulty, the domains it covers, and the
// email-request template when there is one), checks the shape, and rewrites src/lib/deletion/guides.json and the
// license file. Review the diff before committing: the data is community maintained.
import fs from "node:fs";

const BASE = "https://raw.githubusercontent.com/jdm-contrib/jdm/master";
const OUT = new URL("../src/lib/deletion/", import.meta.url);
const UA = "Ghost-Hub (dataset update; +https://github.com/aon082910/ghost-hub)";
const DIFFICULTIES = new Set(["easy", "medium", "hard", "impossible", "limited"]);

const get = async (path) => {
  const res = await fetch(`${BASE}/${path}`, { headers: { "user-agent": UA } });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res;
};

const raw = await (await get("_data/sites.json")).json();
if (!Array.isArray(raw) || raw.length < 1000) throw new Error(`Unexpected dataset (${Array.isArray(raw) ? raw.length : typeof raw} entries)`);

const str = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const guides = [];
for (const e of raw) {
  const name = str(e.name, 120);
  const url = str(e.url, 2048);
  const domains = Array.isArray(e.domains) ? e.domains.filter((d) => typeof d === "string" && /^[a-z0-9.-]+$/i.test(d)).map((d) => d.toLowerCase()) : [];
  if (!name || !url || !DIFFICULTIES.has(e.difficulty) || domains.length === 0) continue;
  try { new URL(url); } catch { continue; }
  guides.push({
    name, url, difficulty: e.difficulty, domains,
    ...(str(e.notes, 1500) && { notes: str(e.notes, 1500) }),
    ...(str(e.email, 254) && { email: str(e.email, 254) }),
    ...(str(e.email_subject, 200) && { emailSubject: str(e.email_subject, 200) }),
    ...(str(e.email_body, 2000) && { emailBody: str(e.email_body, 2000) }),
  });
}
if (guides.length < 1000) throw new Error(`Only ${guides.length} usable entries; refusing to overwrite`);

fs.writeFileSync(new URL("guides.json", OUT), JSON.stringify(guides));
fs.writeFileSync(new URL("JUSTDELETEME-LICENSE.txt", OUT), await (await get("LICENSE")).text());
console.log(`Wrote ${guides.length} of ${raw.length} entries (${Math.round(fs.statSync(new URL("guides.json", OUT)).size / 1024)} KB).`);
