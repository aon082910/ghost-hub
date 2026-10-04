import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { listConnections } from "@/lib/mailboxes";
import { listNewsletters, listPending, type NewsletterRow } from "@/lib/newsletters/store";
import { keepSender, markUnsubscribed, queueForReview } from "../actions";
import { SiteHeader } from "../site-header";
import { SelectToolbar } from "./select-toolbar";

const SHOW_LIMIT = 300;

type Show = "active" | "unsubscribed" | "kept" | "all";
type MethodFilter = "one-click" | "link" | "mailto" | "none";
const SHOWS: { id: Show; label: string }[] = [
  { id: "active", label: "To clean up" },
  { id: "unsubscribed", label: "Unsubscribed" },
  { id: "kept", label: "Kept" },
  { id: "all", label: "All" },
];
const METHODS: { id: MethodFilter; label: string }[] = [
  { id: "one-click", label: "One-click" },
  { id: "link", label: "Web page" },
  { id: "mailto", label: "Email" },
  { id: "none", label: "No info" },
];

const MESSAGES: Record<string, string> = {
  nothing_selected: "Tick at least one sender first.",
  nothing_queued: "None of the selected senders can be unsubscribed automatically. Open their unsubscribe page or email instead.",
};

type Params = Record<string, string | string[] | undefined>;
const one = (sp: Params, k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
const isOpen = (n: NewsletterRow) => n.status === "subscribed" || n.status === "failed";

const chip = (active: boolean) =>
  `rounded-full border px-2.5 py-1 text-xs transition ${
    active ? "border-emerald-700 bg-emerald-950/50 text-emerald-300" : "border-zinc-800 text-zinc-400 hover:border-zinc-600"
  }`;
const smallBtn = "rounded-md border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 transition hover:border-zinc-500";
const fmt = (d: Date) => d.toLocaleDateString("en-US", { dateStyle: "medium" });

export default async function Newsletters(props: PageProps<"/newsletters">) {
  await requireSession();
  const sp = await props.searchParams;
  const show = (SHOWS.find((s) => s.id === one(sp, "show"))?.id ?? "active") as Show;
  const method = METHODS.find((m) => m.id === one(sp, "method"))?.id;
  const showSpam = one(sp, "spam") === "1";

  const [everyone, pending, connections] = await Promise.all([listNewsletters(), listPending(), listConnections()]);
  // Spam-only senders are set aside unless asked for: they aren't lists you signed up to.
  const spamOnlyCount = everyone.filter((n) => n.spamOnly).length;
  const all = showSpam ? everyone : everyone.filter((n) => !n.spamOnly);
  const multiMailbox = connections.length > 1;

  const matchesShow = (n: NewsletterRow) =>
    show === "all" || (show === "active" ? isOpen(n) : show === "unsubscribed" ? n.status === "unsubscribed" : n.status === "ignored");
  const shown = all.filter((n) => matchesShow(n) && (!method || n.method.method === method));

  const open = all.filter(isOpen);
  const summary = {
    senders: all.length,
    toClean: open.length,
    automatic: open.filter((n) => n.method.method === "one-click").length,
    unsubscribed: all.filter((n) => n.status === "unsubscribed").length,
    stillSending: all.filter((n) => n.stillSending).length,
  };

  const href = (next: { show?: Show; method?: MethodFilter; spam?: boolean }) => {
    const p = new URLSearchParams();
    const sh = "show" in next ? next.show : show;
    const m = "method" in next ? next.method : method;
    const sp1 = "spam" in next ? next.spam : showSpam;
    if (sh && sh !== "active") p.set("show", sh);
    if (m) p.set("method", m);
    if (sp1) p.set("spam", "1");
    const qs = p.toString();
    return qs ? `/newsletters?${qs}` : "/newsletters";
  };

  const error = one(sp, "error");
  const done = one(sp, "unsubscribed");
  const note = error
    ? { tone: "error" as const, text: MESSAGES[error] ?? "Something went wrong." }
    : done !== undefined
      ? {
          tone: Number(one(sp, "failed") ?? 0) > 0 ? ("error" as const) : ("ok" as const),
          text: `Unsubscribed from ${done} sender${done === "1" ? "" : "s"}${Number(one(sp, "failed") ?? 0) > 0 ? `; ${one(sp, "failed")} couldn't be done automatically (see below)` : ""}.`,
        }
      : null;

  return (
    <main className="mx-auto max-w-3xl px-4 py-12">
      <SiteHeader current="/newsletters" />

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
          No newsletters found yet.{" "}
          <Link href="/" className="text-emerald-400 underline">
            Scan a mailbox
          </Link>{" "}
          to find the senders that email you in bulk.
        </section>
      ) : (
        <>
          <section aria-label="Summary" className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Tile label="Senders" value={summary.senders} />
            <Tile label="To clean up" value={summary.toClean} />
            <Tile label="One-click" value={summary.automatic} hint="Can be unsubscribed automatically" />
            <Tile label="Unsubscribed" value={summary.unsubscribed} />
            <Tile label="Still sending" value={summary.stillSending} tone={summary.stillSending ? "text-amber-300" : undefined} hint="Kept emailing after you unsubscribed" />
          </section>

          {pending.length > 0 && (
            <p className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-900 bg-emerald-950/30 px-4 py-3 text-sm text-emerald-200">
              <span>
                {pending.length} unsubscribe{pending.length === 1 ? "" : "s"} waiting for your review. Nothing has been sent.
              </span>
              <Link href="/newsletters/review" className="rounded-md bg-emerald-500 px-3 py-1 text-xs font-medium text-zinc-950 hover:bg-emerald-400">
                Review
              </Link>
            </p>
          )}

          <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-5">
            <h2 className="font-medium text-zinc-100">Newsletter senders</h2>
            <p className="mt-1 text-sm text-zinc-400">
              Pick senders, review exactly what will be sent, then approve. Only senders that support one-click unsubscribe
              (RFC 8058) are done for you; for the rest, Ghost-Hub shows you the page or address to use.
            </p>

            <div className="mt-3 space-y-2" aria-label="Filters">
              <div className="flex flex-wrap gap-2">
                {SHOWS.map((s) => (
                  <Link key={s.id} href={href({ show: s.id })} className={chip(show === s.id)}>
                    {s.label}
                  </Link>
                ))}
              </div>
              {spamOnlyCount > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={href({ spam: !showSpam })} className={chip(showSpam)}>
                    {showSpam ? "Showing" : "Hiding"} {spamOnlyCount.toLocaleString("en-US")} spam-only sender{spamOnlyCount === 1 ? "" : "s"}
                  </Link>
                  <span className="text-xs text-zinc-500">Senders whose mail only ever reached your Spam folder. Don&apos;t unsubscribe from spam.</span>
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <Link href={href({ method: undefined })} className={chip(!method)}>
                  Any method
                </Link>
                {METHODS.map((m) => (
                  <Link key={m.id} href={href({ method: method === m.id ? undefined : m.id })} className={chip(method === m.id)}>
                    {m.label}
                  </Link>
                ))}
              </div>
            </div>

            {shown.length === 0 ? (
              <p className="mt-4 text-sm text-zinc-500">No senders match these filters.</p>
            ) : (
              <form className="mt-4">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <SelectToolbar label="Select all one-click" />
                  <button
                    formAction={queueForReview}
                    className="rounded-md bg-emerald-500 px-3 py-1.5 text-xs font-medium text-zinc-950 transition hover:bg-emerald-400"
                  >
                    Review selected
                  </button>
                </div>
                <ul className="divide-y divide-zinc-900">
                  {shown.slice(0, SHOW_LIMIT).map((n) => (
                    <SenderRow key={n.id} n={n} showMailbox={multiMailbox} />
                  ))}
                </ul>
                {shown.length > SHOW_LIMIT && (
                  <p className="mt-3 text-xs text-zinc-500">Showing the {SHOW_LIMIT} busiest of {shown.length.toLocaleString("en-US")}. Use the filters to narrow it down.</p>
                )}
              </form>
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

function SenderRow({ n, showMailbox }: { n: NewsletterRow; showMailbox: boolean }) {
  const selectable = isOpen(n) && n.method.method === "one-click" && !n.blocked && !n.spamOnly;
  const title = n.senderName || n.senderEmail;
  return (
    <li className="flex gap-3 py-3">
      <input
        type="checkbox"
        name="select"
        value={n.id}
        disabled={!selectable}
        aria-label={`Select ${title}`}
        className="mt-1 h-4 w-4 shrink-0 accent-emerald-500 disabled:opacity-30"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-sm text-zinc-100">{title}</span>
          <MethodBadge n={n} />
          <StatusBadge n={n} />
          {n.spamOnly && (
            <span
              title="All of this sender's mail was in your Spam folder"
              className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400"
            >
              Spam only
            </span>
          )}
        </div>
        <div className="truncate text-xs text-zinc-500">
          {n.senderEmail} · {n.messageCount.toLocaleString("en-US")} emails, last {fmt(n.lastSeen)}
          {showMailbox && ` · ${n.mailbox}`}
        </div>
        {n.blocked && (
          <div className="mt-1 text-xs text-red-300">
            Link withheld: {n.blocked} Ghost-Hub won&apos;t contact it or offer it to you.
          </div>
        )}
        {n.spamOnly && <div className="mt-1 text-xs text-zinc-500">Looks like spam. Mark it as spam in your mail app; unsubscribing can confirm your address is live.</div>}
        {n.lastError && <div className="mt-1 text-xs text-amber-400">{n.lastError}</div>}
        {n.stillSending && n.unsubscribedAt && (
          <div className="mt-1 text-xs text-amber-400">
            Still emailing you after you unsubscribed on {fmt(n.unsubscribedAt)}. Consider marking it as spam or blocking the sender.
          </div>
        )}
        <Manual n={n} />
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        {n.status === "ignored" ? (
          <button formAction={keepSender.bind(null, n.id, false)} className={smallBtn}>
            Stop keeping
          </button>
        ) : isOpen(n) ? (
          <button formAction={keepSender.bind(null, n.id, true)} className={smallBtn} title="Hide this sender from cleanup">
            Keep
          </button>
        ) : null}
      </div>
    </li>
  );
}

/** For senders that can't be done automatically: the link or address to use, plus a way to record that you did. */
function Manual({ n }: { n: NewsletterRow }) {
  if (!isOpen(n) || n.blocked || n.spamOnly) return null;
  const m = n.method;
  if (m.method !== "link" && m.method !== "mailto") return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
      {m.method === "link" ? (
        <a href={m.url} target="_blank" rel="noopener noreferrer" className="text-emerald-400 underline">
          Open unsubscribe page ({new URL(m.url).hostname})
        </a>
      ) : (
        <a href={m.mailto} className="text-emerald-400 underline">
          Open in your mail app
        </a>
      )}
      <button formAction={markUnsubscribed.bind(null, n.id)} className={smallBtn}>
        I&apos;ve unsubscribed
      </button>
    </div>
  );
}

function MethodBadge({ n }: { n: NewsletterRow }) {
  if (n.blocked) {
    return <span className="rounded border border-red-900 bg-red-950/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-red-300">Blocked</span>;
  }
  const label = { "one-click": "One-click", link: "Web page", mailto: "Email", none: "No info" }[n.method.method];
  const style = n.method.method === "one-click" ? "border-emerald-900 bg-emerald-950/40 text-emerald-300" : "border-zinc-800 bg-zinc-900 text-zinc-400";
  return <span className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${style}`}>{label}</span>;
}

function StatusBadge({ n }: { n: NewsletterRow }) {
  if (n.status === "unsubscribed")
    return <span className="rounded border border-sky-900 bg-sky-950/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-sky-300">Unsubscribed</span>;
  if (n.status === "failed")
    return <span className="rounded border border-amber-900 bg-amber-950/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-300">Failed</span>;
  if (n.status === "ignored")
    return <span className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">Kept</span>;
  return null;
}
