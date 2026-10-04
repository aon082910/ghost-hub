import Link from "next/link";
import type { AssessedBreach, Level } from "@/lib/breaches/risk";
import { catalogStatus, loadChecks } from "@/lib/breaches/store";
import { LEVELS, filterServices, isLevel, loadServices, summarize, type ServiceRisk } from "@/lib/dashboard";
import { CATEGORIES, isCategory } from "@/lib/discovered";
import { requireSession } from "@/lib/auth";
import { listConnections } from "@/lib/mailboxes";
import { checkMailbox, refreshBreaches } from "../actions";
import { SiteHeader } from "../site-header";

const SHOW_LIMIT = 200;

const CATEGORY_LABEL = { account: "Accounts", subscription: "Subscriptions", receipt: "Receipts", newsletter: "Newsletters" } as const;
const CATEGORY_SINGULAR = { account: "Account", subscription: "Subscription", receipt: "Receipt", newsletter: "Newsletter" } as const;
const LEVEL_LABEL: Record<Level, string> = { high: "High", medium: "Medium", low: "Low", minimal: "Minimal" };
const LEVEL_STYLE: Record<Level, string> = {
  high: "border-red-900 bg-red-950/50 text-red-300",
  medium: "border-amber-900 bg-amber-950/40 text-amber-300",
  low: "border-sky-900 bg-sky-950/40 text-sky-300",
  minimal: "border-zinc-800 bg-zinc-900 text-zinc-400",
};
const EXPOSURE_LABEL = {
  confirmed: "Your email address was in this breach",
  likely: "You were probably a customer at the time",
  before: "Happened before you first heard from them (probably not you)",
  unknown: "Breach date unknown",
} as const;

const MESSAGES: Record<string, string> = {
  hibp_disabled: "Have I Been Pwned lookups are turned off (HIBP_ENABLED=false).",
  hibp_key_missing: "Set HIBP_API_KEY to check your own addresses.",
  hibp_key_rejected: "Have I Been Pwned rejected the API key. Check HIBP_API_KEY.",
  hibp_rate: "Have I Been Pwned is rate limiting requests. Wait a minute and try again.",
  hibp_failed: "Couldn't reach Have I Been Pwned. Try again in a moment; see the server logs for details.",
};

type Params = Record<string, string | string[] | undefined>;
const one = (sp: Params, k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);

function banner(sp: Params) {
  const error = one(sp, "error");
  if (error) return { tone: "error" as const, text: MESSAGES[error] ?? "Something went wrong." };
  const refreshed = one(sp, "refreshed");
  if (refreshed) return { tone: "ok" as const, text: `Breach list updated: ${Number(refreshed).toLocaleString("en-US")} breaches.` };
  const checked = one(sp, "checked");
  if (checked) {
    const n = Number(one(sp, "found") ?? 0);
    return {
      tone: "ok" as const,
      text: n === 0 ? `${checked} wasn't found in any known breach.` : `${checked} appears in ${n} known breach${n === 1 ? "" : "es"}.`,
    };
  }
  return null;
}

const chip = (active: boolean) =>
  `rounded-full border px-2.5 py-1 text-xs transition ${
    active ? "border-emerald-700 bg-emerald-950/50 text-emerald-300" : "border-zinc-800 text-zinc-400 hover:border-zinc-600"
  }`;

const fmtDate = (d: Date | null) => (d ? d.toLocaleDateString("en-US", { dateStyle: "medium" }) : "never");

export default async function Dashboard(props: PageProps<"/dashboard">) {
  await requireSession();
  const sp = await props.searchParams;

  const cat = isCategory(one(sp, "cat")) ? (one(sp, "cat") as keyof typeof CATEGORY_LABEL) : undefined;
  const level = isLevel(one(sp, "risk")) ? (one(sp, "risk") as Level) : undefined;
  const breachedOnly = one(sp, "breached") === "1";

  const [all, status, connections, checks] = await Promise.all([loadServices(), catalogStatus(), listConnections(), loadChecks()]);
  const summary = summarize(all);
  const shown = filterServices(all, { category: cat, level, breachedOnly });
  const note = banner(sp);

  const href = (next: { cat?: string; risk?: string; breached?: boolean }) => {
    const p = new URLSearchParams();
    const c = "cat" in next ? next.cat : cat;
    const r = "risk" in next ? next.risk : level;
    const b = "breached" in next ? next.breached : breachedOnly;
    if (c) p.set("cat", c);
    if (r) p.set("risk", r);
    if (b) p.set("breached", "1");
    const qs = p.toString();
    return qs ? `/dashboard?${qs}` : "/dashboard";
  };

  return (
    <main className="mx-auto max-w-3xl px-4 py-12">
      <SiteHeader current="/dashboard" />

      {note && (
        <p
          role={note.tone === "error" ? "alert" : "status"}
          className={`mb-6 rounded-lg border px-4 py-3 text-sm ${
            note.tone === "error" ? "border-red-900 bg-red-950/40 text-red-300" : "border-emerald-900 bg-emerald-950/40 text-emerald-300"
          }`}
        >
          {note.text}
        </p>
      )}

      {all.length === 0 ? (
        <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-5 text-sm text-zinc-400">
          Nothing to show yet.{" "}
          <Link href="/" className="text-emerald-400 underline">
            Connect a mailbox and run a scan
          </Link>{" "}
          to see every service you&apos;ve signed up for, scored by risk.
        </section>
      ) : (
        <>
          <section aria-label="Summary" className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Tile label="Services" value={summary.total} />
            <Tile label="High risk" value={summary.high} tone={summary.high ? "text-red-300" : undefined} />
            <Tile label="Medium risk" value={summary.medium} tone={summary.medium ? "text-amber-300" : undefined} />
            <Tile label="Known breach" value={summary.breached} />
            <Tile label="Forgotten" value={summary.dormant} hint="No email in 2+ years" />
          </section>

          <BreachPanel status={status} connections={connections} checks={checks} />

          <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-5">
            <h2 className="font-medium text-zinc-100">Your services</h2>
            <div className="mt-3 space-y-2" aria-label="Filters">
              <div className="flex flex-wrap gap-2">
                <Link href={href({ cat: undefined })} className={chip(!cat)}>
                  All types
                </Link>
                {CATEGORIES.map((c) => (
                  <Link key={c} href={href({ cat: cat === c ? undefined : c })} className={chip(cat === c)}>
                    {CATEGORY_LABEL[c]} ({summary.byCategory[c]})
                  </Link>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <Link href={href({ risk: undefined })} className={chip(!level)}>
                  Any risk
                </Link>
                {LEVELS.map((l) => (
                  <Link key={l} href={href({ risk: level === l ? undefined : l })} className={chip(level === l)}>
                    {LEVEL_LABEL[l]}
                  </Link>
                ))}
                <Link href={href({ breached: !breachedOnly })} className={chip(breachedOnly)}>
                  Known breach only
                </Link>
              </div>
            </div>

            {shown.length === 0 ? (
              <p className="mt-4 text-sm text-zinc-500">No services match these filters.</p>
            ) : (
              <ul className="mt-4 divide-y divide-zinc-900">
                {shown.slice(0, SHOW_LIMIT).map((s) => (
                  <ServiceRow key={s.domain} s={s} />
                ))}
              </ul>
            )}
            {shown.length > SHOW_LIMIT && (
              <p className="mt-3 text-xs text-zinc-500">
                Showing the {SHOW_LIMIT} highest-risk of {shown.length.toLocaleString("en-US")}. Use the filters to narrow it down.
              </p>
            )}
          </section>
        </>
      )}
    </main>
  );
}

function Tile({ label, value, tone, hint }: { label: string; value: number; tone?: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3" title={hint}>
      <div className={`text-2xl font-semibold ${tone ?? "text-zinc-100"}`}>{value.toLocaleString("en-US")}</div>
      <div className="text-xs text-zinc-500">{label}</div>
    </div>
  );
}

function BreachPanel({
  status,
  connections,
  checks,
}: {
  status: Awaited<ReturnType<typeof catalogStatus>>;
  connections: Awaited<ReturnType<typeof listConnections>>;
  checks: Awaited<ReturnType<typeof loadChecks>>;
}) {
  const btn = "rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 transition hover:border-zinc-500";
  return (
    <section className="mb-6 rounded-xl border border-zinc-800 bg-zinc-950 p-5">
      <h2 className="font-medium text-zinc-100">Breach data</h2>
      {!status.enabled ? (
        <p className="mt-1 text-sm text-zinc-400">
          Breach lookups are turned off (<code>HIBP_ENABLED=false</code>), so Ghost-Hub makes no calls to Have I Been Pwned. Scores use only
          how you use each service.
        </p>
      ) : (
        <>
          <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-zinc-400">
              {status.count > 0
                ? `${status.count.toLocaleString("en-US")} known breaches, updated ${fmtDate(status.lastFetched)}${status.stale ? " (out of date)" : ""}.`
                : "The breach list hasn't been downloaded yet."}
            </p>
            <form action={refreshBreaches}>
              <button className={btn}>{status.count > 0 ? "Refresh breach list" : "Download breach list"}</button>
            </form>
          </div>
          <p className="mt-2 text-xs text-zinc-500">
            Downloads the public list from Have I Been Pwned and matches it to your services by domain. Nothing about you is sent.
          </p>

          <div className="mt-4 border-t border-zinc-900 pt-3">
            <h3 className="text-sm text-zinc-300">Your email addresses</h3>
            {status.keyConfigured ? (
              <>
                <ul className="mt-2 space-y-2">
                  {connections.map((c) => {
                    const check = checks.get(c.mailbox);
                    return (
                      <li key={c.mailbox} className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <div className="text-sm text-zinc-200">{c.mailbox}</div>
                          <div className="text-xs text-zinc-500">
                            {check
                              ? `Checked ${fmtDate(check.checkedAt)}: ${check.breachCount === 0 ? "not in any known breach" : `in ${check.breachCount} breach${check.breachCount === 1 ? "" : "es"}`}`
                              : "Not checked yet"}
                          </div>
                        </div>
                        <form action={checkMailbox}>
                          <input type="hidden" name="mailbox" value={c.mailbox} />
                          <button className={btn}>{check ? "Check again" : "Check"}</button>
                        </form>
                      </li>
                    );
                  })}
                </ul>
                <p className="mt-2 text-xs text-zinc-500">
                  Checking sends that address to Have I Been Pwned using your API key. Breaches that include it are marked as confirmed.
                </p>
              </>
            ) : (
              <p className="mt-1 text-xs text-zinc-500">
                Optional: set <code>HIBP_API_KEY</code> (a paid key from haveibeenpwned.com/API/Key) to check whether your own addresses appear
                in breaches. That confirms which breaches really affected you instead of estimating from dates.
              </p>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function ServiceRow({ s }: { s: ServiceRisk }) {
  const years =
    s.firstSeen.getUTCFullYear() === s.lastSeen.getUTCFullYear()
      ? `${s.firstSeen.getUTCFullYear()}`
      : `${s.firstSeen.getUTCFullYear()}-${s.lastSeen.getUTCFullYear()}`;
  return (
    <li className="py-2">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-sm text-zinc-100">{s.name}</div>
            <div className="truncate text-xs text-zinc-500">
              {s.domain} · {CATEGORY_SINGULAR[s.category]} · {s.messages.toLocaleString("en-US")} emails, {years}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {s.risk.breaches.length > 0 && (
              <span className="text-[10px] uppercase tracking-wide text-zinc-500">
                {s.risk.breaches.length} breach{s.risk.breaches.length === 1 ? "" : "es"}
              </span>
            )}
            <span className={`rounded border px-1.5 py-0.5 text-[11px] font-medium ${LEVEL_STYLE[s.risk.level]}`}>
              {LEVEL_LABEL[s.risk.level]} · {s.risk.score}
            </span>
          </div>
        </summary>

        <div className="mt-3 space-y-3 rounded-lg border border-zinc-900 bg-zinc-950/60 p-3 text-xs text-zinc-400">
          <div>
            <div className="mb-1 font-medium text-zinc-300">Why this score</div>
            {s.risk.factors.length === 0 ? (
              <p>Nothing raises the risk for this service.</p>
            ) : (
              <ul className="space-y-0.5">
                {s.risk.factors.map((f) => (
                  <li key={f.label} className="flex justify-between gap-3">
                    <span>{f.label}</span>
                    <span className="shrink-0 text-zinc-300">+{f.points}</span>
                  </li>
                ))}
              </ul>
            )}
            {s.mailboxes > 1 && <p className="mt-1 text-zinc-500">Found in {s.mailboxes} of your mailboxes.</p>}
          </div>

          {s.risk.breaches.length > 0 && (
            <div>
              <div className="mb-1 font-medium text-zinc-300">Known breaches</div>
              <ul className="space-y-2">
                {s.risk.breaches.map((b) => (
                  <BreachItem key={b.name} b={b} />
                ))}
              </ul>
            </div>
          )}
        </div>
      </details>
    </li>
  );
}

function BreachItem({ b }: { b: AssessedBreach }) {
  const when = b.breachDate ? new Date(b.breachDate).toLocaleDateString("en-US", { year: "numeric", month: "short", timeZone: "UTC" }) : "date unknown";
  const classes = b.dataClasses.slice(0, 6).join(", ") + (b.dataClasses.length > 6 ? ` +${b.dataClasses.length - 6} more` : "");
  return (
    <li>
      <div className="flex justify-between gap-3">
        <a
          href={`https://haveibeenpwned.com/PwnedWebsites#${encodeURIComponent(b.name)}`}
          target="_blank"
          rel="noreferrer"
          className="text-zinc-200 underline decoration-zinc-700 hover:decoration-zinc-400"
        >
          {b.title}
        </a>
        <span className="shrink-0 text-zinc-500">{when}</span>
      </div>
      <div className={b.exposure === "confirmed" ? "text-red-300" : undefined}>{EXPOSURE_LABEL[b.exposure]}</div>
      <div className="text-zinc-500">
        Leaked: {classes || "unknown"}
        {b.scope === "subdomain" && ` · breach was of ${b.domain}, not the main site`}
        {!b.isVerified && " · unverified"}
      </div>
    </li>
  );
}
