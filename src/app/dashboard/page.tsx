import Link from "next/link";
import type { AssessedBreach, Level } from "@/lib/breaches/risk";
import { catalogStatus, loadChecks } from "@/lib/breaches/store";
import { LEVELS, decisionCounts, filterServices, isLevel, isShow, loadServices, summarize, type ServiceRisk, type Show } from "@/lib/dashboard";
import { DIFFICULTY_HINT, DIFFICULTY_LABEL, guidesFor, type Difficulty } from "@/lib/deletion/guides";
import { CATEGORIES, isCategory } from "@/lib/discovered";
import { requireSession } from "@/lib/auth";
import { listConnections } from "@/lib/mailboxes";
import { loadCoverage } from "@/lib/scan/coverage";
import { checkMailbox, keepService, markServiceDeleted, refreshBreaches, restoreService } from "../actions";
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
  hibp_disabled: "Have I Been Pwned lookups are turned off in Settings.",
  hibp_key_missing: "Add a Have I Been Pwned API key in Settings to check your own addresses.",
  hibp_key_rejected: "Have I Been Pwned rejected the API key. Check it in Settings.",
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
  const show: Show = isShow(one(sp, "show")) ? (one(sp, "show") as Show) : "active";
  const showSpam = one(sp, "spam") === "1";

  const [all, status, connections, checks, coverage] = await Promise.all([loadServices(), catalogStatus(), listConnections(), loadChecks(), loadCoverage()]);
  const partial = [...coverage].filter(([, c]) => c.kind === "limited" || c.kind === "unfinished");
  // The tiles and type counts describe what's still on your list; the decisions you've made are counted separately.
  // Services whose every email was in your Spam folder are set aside unless asked for: they're almost never accounts.
  const spamOnlyCount = all.filter((s) => s.spamOnly).length;
  const pool = showSpam ? all : all.filter((s) => !s.spamOnly);
  const summary = summarize(pool.filter((s) => s.state === "active"));
  const decisions = decisionCounts(pool);
  const shown = filterServices(pool, { category: cat, level, breachedOnly, show });
  const note = banner(sp);

  const href = (next: { cat?: string; risk?: string; breached?: boolean; show?: Show; spam?: boolean }) => {
    const p = new URLSearchParams();
    if ("spam" in next ? next.spam : showSpam) p.set("spam", "1");
    const c = "cat" in next ? next.cat : cat;
    const r = "risk" in next ? next.risk : level;
    const b = "breached" in next ? next.breached : breachedOnly;
    const sh = "show" in next ? next.show : show;
    if (sh && sh !== "active") p.set("show", sh);
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
          {partial.length > 0 && (
            <p role="note" className="mb-6 rounded-lg border border-amber-900 bg-amber-950/30 px-4 py-3 text-xs text-amber-200">
              {partial.map(([mailbox, c]) => (
                <span key={mailbox} className="block">
                  {mailbox}:{" "}
                  {c.kind === "limited"
                    ? `only mail from ${c.since.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })} on has been scanned.`
                    : "the last full scan didn't finish."}
                </span>
              ))}
              <span className="mt-1 block text-amber-300/80">
                Older sign-ups can be missing, and a service&apos;s first email may look later than it was, which can lower its risk score.
                Run a full scan from the Mailboxes page for the complete picture.
              </span>
            </p>
          )}

          <section aria-label="Summary" className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Tile label="Services" value={summary.total} />
            <Tile label="High risk" value={summary.high} tone={summary.high ? "text-red-300" : undefined} />
            <Tile label="Medium risk" value={summary.medium} tone={summary.medium ? "text-amber-300" : undefined} />
            <Tile label="Known breach" value={summary.breached} />
            <Tile label="Forgotten" value={summary.dormant} hint="No email in 2+ years" />
          </section>
          {(decisions.deleted > 0 || decisions.kept > 0) && (
            <p className="-mt-3 mb-6 text-xs text-zinc-500">
              {decisions.deleted} deleted · {decisions.kept} kept
              {decisions.stillEmailing > 0 && (
                <span className="text-amber-400">
                  {" "}
                  · {decisions.stillEmailing} still emailing you after you deleted {decisions.stillEmailing === 1 ? "it" : "them"}
                </span>
              )}
            </p>
          )}

          <BreachPanel status={status} connections={connections} checks={checks} />

          <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="font-medium text-zinc-100">Your services</h2>
              <p className="text-xs text-zinc-500">
                To-do list of what&apos;s left:{" "}
                <a href="/api/export/checklist?format=md" download className="text-emerald-400 underline">
                  Markdown
                </a>{" "}
                ·{" "}
                <a href="/api/export/checklist?format=csv" download className="text-emerald-400 underline">
                  CSV
                </a>
              </p>
            </div>
            <div className="mt-3 space-y-2" aria-label="Filters">
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    ["active", `To review (${decisions.active})`],
                    ["deleted", `Deleted (${decisions.deleted})`],
                    ["kept", `Kept (${decisions.kept})`],
                    ["all", "All"],
                  ] as const
                ).map(([id, label]) => (
                  <Link key={id} href={href({ show: id })} className={chip(show === id)}>
                    {label}
                  </Link>
                ))}
              </div>
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
              {spamOnlyCount > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={href({ spam: !showSpam })} className={chip(showSpam)}>
                    {showSpam ? "Showing" : "Hiding"} {spamOnlyCount.toLocaleString("en-US")} spam-only service{spamOnlyCount === 1 ? "" : "s"}
                  </Link>
                  <span className="text-xs text-zinc-500">Companies whose email only ever reached your Spam folder, so probably not accounts of yours.</span>
                </div>
              )}
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
          Breach lookups are turned off in{" "}
          <Link href="/settings#breach" className="text-emerald-400 underline">
            Settings
          </Link>
          , so Ghost-Hub makes no calls to Have I Been Pwned. Scores use only how you use each service.
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
                Optional: add a Have I Been Pwned API key in{" "}
                <Link href="/settings#breach" className="text-emerald-400 underline">
                  Settings
                </Link>{" "}
                (a paid key from haveibeenpwned.com/API/Key) to check whether your own addresses appear in breaches. That confirms which breaches really
                affected you instead of estimating from dates.
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
              {s.domain}
              {s.domains.length > 1 && ` +${s.domains.length - 1} more`} · {CATEGORY_SINGULAR[s.category]} · {s.messages.toLocaleString("en-US")} emails, {years}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {s.spamOnly && (
              <span className="text-[10px] uppercase tracking-wide text-zinc-500" title="Every email from this company was in your Spam folder">
                Spam only
              </span>
            )}
            {s.state !== "active" && (
              <span className={`text-[10px] uppercase tracking-wide ${s.stillEmailing ? "text-amber-400" : "text-zinc-500"}`}>
                {s.stillEmailing ? "Still emailing" : s.state === "deleted" ? "Deleted" : "Kept"}
              </span>
            )}
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
            {s.domains.length > 1 && <p className="mt-1 text-zinc-500">Counts every address this company emails you from: {s.domains.join(", ")}.</p>}
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

          <DeleteSection s={s} />
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

const DIFFICULTY_STYLE: Record<Difficulty, string> = {
  easy: "border-emerald-900 bg-emerald-950/40 text-emerald-300",
  medium: "border-amber-900 bg-amber-950/40 text-amber-300",
  hard: "border-red-900 bg-red-950/40 text-red-300",
  impossible: "border-red-900 bg-red-950/40 text-red-300",
  limited: "border-zinc-800 bg-zinc-900 text-zinc-400",
};

const smallBtn = "rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 transition hover:border-zinc-500";

/** The guides for every domain of a company, each guide once (domains of one company usually share a guide). */
function uniqueGuides(domains: string[]) {
  const seen = new Set<string>();
  return domains
    .flatMap((d) => guidesFor(d))
    .filter((g) => {
      const key = g.name + "|" + (g.openUrl ?? "");
      return !seen.has(key) && !!seen.add(key);
    })
    .slice(0, 3);
}

/** How to delete the account, and the buttons to record what you decided. Ghost-Hub never deletes anything itself. */
function DeleteSection({ s }: { s: ServiceRisk }) {
  const guides = uniqueGuides(s.domains);
  return (
    <div>
      <div className="mb-1 font-medium text-zinc-300">Delete this account</div>

      {s.stillEmailing && s.deletedAt && (
        <p className="mb-2 text-amber-400">
          You marked this deleted on {fmtDate(s.deletedAt)}, but it has emailed you since (latest {fmtDate(s.lastSeen)}). The account may not have been
          deleted, or the company still has you on a mailing list. Check the steps below, then ask them to remove you.
        </p>
      )}

      {guides.length === 0 ? (
        <p>
          There&apos;s no step-by-step guide for this service yet. Look for &quot;Delete account&quot; or &quot;Close account&quot; in its account
          settings, or{" "}
          <a
            href={`https://duckduckgo.com/?q=${encodeURIComponent(`how to delete ${s.name} account`)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-emerald-400 underline"
          >
            search for how
          </a>
          .
        </p>
      ) : (
        <ul className="space-y-3">
          {guides.map((g) => (
            <li key={g.name + (g.openUrl ?? "")}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-zinc-200">{g.name}</span>
                <span className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${DIFFICULTY_STYLE[g.difficulty]}`} title={DIFFICULTY_HINT[g.difficulty]}>
                  {DIFFICULTY_LABEL[g.difficulty]}
                </span>
              </div>
              <p className="mt-0.5 text-zinc-500">{DIFFICULTY_HINT[g.difficulty]}</p>
              {g.notes.length > 0 && (
                <p className="mt-1">
                  {g.notes.map((seg, i) =>
                    seg.href ? (
                      <a key={i} href={seg.href} target="_blank" rel="noopener noreferrer" className="text-emerald-400 underline">
                        {seg.text}
                      </a>
                    ) : (
                      <span key={i}>{seg.text}</span>
                    ),
                  )}
                </p>
              )}
              <div className="mt-1 flex flex-wrap items-center gap-3">
                {g.openUrl && (
                  <a href={g.openUrl} target="_blank" rel="noopener noreferrer" className="text-emerald-400 underline">
                    Open the deletion page
                  </a>
                )}
                {g.mailto && (
                  <a href={g.mailto} className="text-emerald-400 underline">
                    Email a deletion request
                  </a>
                )}
                {g.insecure && (
                  <span className="text-amber-400">
                    Only an insecure (http) address is published, so no link is offered. Search for the company&apos;s support page.
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-zinc-500">
        Ghost-Hub can&apos;t delete accounts for you. Do it on the company&apos;s site, then record it here. After your next scan, it will tell you if they keep
        emailing.
      </p>

      <form className="mt-2 flex flex-wrap gap-2">
        {s.state === "active" ? (
          <>
            <button formAction={markServiceDeleted.bind(null, s.domains)} className={smallBtn}>
              I&apos;ve deleted it
            </button>
            <button formAction={keepService.bind(null, s.domains)} className={smallBtn} title="Hide this from cleanup">
              Keep it
            </button>
          </>
        ) : (
          <button formAction={restoreService.bind(null, s.domains)} className={smallBtn}>
            {s.state === "deleted" ? "I haven't deleted it, put it back" : "Stop keeping it"}
          </button>
        )}
      </form>
    </div>
  );
}
