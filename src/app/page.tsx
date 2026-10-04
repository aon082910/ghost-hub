import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { IMAP_PRESETS } from "@/lib/imap";
import { listConnections } from "@/lib/mailboxes";
import { OAUTH_PROVIDERS, getOAuthProvider } from "@/lib/oauth";
import { CATEGORIES, discoveredCounts, isCategory, listDiscovered } from "@/lib/discovered";
import { isScanning, latestScan } from "@/lib/scan/registry";
import { cancelMailboxScan, disconnect, scanMailbox } from "./actions";
import { ImapForm } from "./imap-form";
import { logout } from "./login/actions";
import { ScanProgress } from "./scan-progress";

const ERRORS: Record<string, string> = {
  not_configured: "That provider isn't configured. Set its client ID and secret (see the docs folder), then restart.",
  unknown_provider: "Unknown provider.",
  access_denied: "Sign-in was cancelled or denied.",
  state_mismatch: "That sign-in attempt expired or didn't match. Please try connecting again.",
  scope_missing: "Ghost-Hub needs permission to read your mail. Connect again and leave the mail permission ticked.",
  no_refresh_token:
    "The provider didn't return a long-lived token. Remove Ghost-Hub from your account's app permissions, then connect again.",
  exchange_failed: "Couldn't complete the sign-in. Check the server logs and your OAuth app settings.",
};

const PROVIDER_NAME: Record<string, string> = { google: "Gmail", microsoft: "Outlook", imap: "IMAP" };

const CATEGORY_LABEL = { account: "Accounts", subscription: "Subscriptions", receipt: "Receipts", newsletter: "Newsletters" } as const;
const CATEGORY_SINGULAR = { account: "Account", subscription: "Subscription", receipt: "Receipt", newsletter: "Newsletter" } as const;
const CATEGORY_HINT = {
  account: "Sign-up, verification, security and sign-in emails",
  subscription: "Billing, renewals and trials",
  receipt: "Orders, invoices and shipping",
  newsletter: "Marketing and mailing lists only",
} as const;

const LATER_STEPS = [
  { title: "Dashboard", detail: "Breach risk, deletion guides and linked profiles." },
  { title: "Take action", detail: "Deletion guides and bulk unsubscribe, review-first." },
];

type Params = Record<string, string | string[] | undefined>;

function banner(sp: Params) {
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
  const error = one("error");
  if (error) return { tone: "error" as const, text: ERRORS[error] ?? "Something went wrong." };

  const connected = one("connected");
  if (connected) return { tone: "ok" as const, text: `Connected ${connected}.` };

  const gone = one("disconnected");
  if (gone === "missing") return { tone: "error" as const, text: "That mailbox was already disconnected." };
  if (gone) {
    const provider = getOAuthProvider(one("provider") ?? "");
    const url = provider?.manageAccessUrl;
    const label = provider?.label ?? "your provider";
    const revoke = {
      revoked: `Access was revoked at ${label}.`,
      failed: `Couldn't reach ${label} to revoke access. Remove Ghost-Hub in your account's app permissions to be sure${url ? `: ${url}` : "."}`,
      manual: provider
        ? `${label} can't revoke access remotely. Remove Ghost-Hub in your account's app permissions: ${url}`
        : "Delete the app password you created for Ghost-Hub in your account's security settings.",
    }[one("revoke") ?? "manual"];
    return {
      tone: "ok" as const,
      text: `Disconnected ${gone}${one("wiped") ? " and deleted its data" : ""}. ${revoke ?? ""}`,
    };
  }
  return null;
}

export default async function Home(props: PageProps<"/">) {
  await requireSession();
  const [sp, connections] = await Promise.all([props.searchParams, listConnections()]);
  const note = banner(sp);
  const scansByMailbox = new Map(await Promise.all(connections.map(async (c) => [c.mailbox, await latestScan(c.mailbox)] as const)));
  const cat = typeof sp.cat === "string" && isCategory(sp.cat) ? sp.cat : undefined;
  const [counts, services] = await Promise.all([discoveredCounts(), listDiscovered(cat)]);
  const totalServices = Object.values(counts).reduce((a, b) => a + b, 0);
  const oauthButtons = Object.values(OAUTH_PROVIDERS).map((p) => ({
    id: p.id,
    label: p.label,
    configured: p.isConfigured(),
  }));
  const presets = IMAP_PRESETS.map((p) => ({
    id: p.id,
    label: p.label,
    appPasswordUrl: p.appPasswordUrl,
    needsHost: p.host === null,
  }));

  return (
    <main className="mx-auto max-w-3xl px-4 py-12">
      <header className="mb-8 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-zinc-50">Ghost-Hub</h1>
        <form action={logout}>
          <button className="text-sm text-zinc-400 transition hover:text-zinc-100">Sign out</button>
        </form>
      </header>

      {note && (
        <p
          role={note.tone === "error" ? "alert" : "status"}
          className={`mb-6 break-words rounded-lg border px-4 py-3 text-sm ${
            note.tone === "error"
              ? "border-red-900 bg-red-950/40 text-red-300"
              : "border-emerald-900 bg-emerald-950/40 text-emerald-300"
          }`}
        >
          {note.text}
        </p>
      )}

      <section className="mb-3 rounded-xl border border-zinc-800 bg-zinc-950 p-5">
        <h2 className="font-medium text-zinc-100">1. Connect your inbox</h2>
        <p className="mt-1 text-sm text-zinc-400">
          Read-only access to Gmail, Outlook and Microsoft 365 through your own OAuth app, or to Yahoo, AOL, iCloud and
          other IMAP mailboxes with an app password. Email content is processed in memory and never stored.
        </p>

        {connections.length > 0 && (
          <ul className="mt-4 space-y-2">
            {connections.map((c) => (
              <li
                key={c.mailbox}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-800 px-3 py-2"
              >
                <div>
                  <div className="text-sm text-zinc-100">
                    {c.mailbox}
                    <span className="ml-2 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
                      {PROVIDER_NAME[c.provider] ?? c.provider}
                    </span>
                  </div>
                  <div className="text-xs text-zinc-500">
                    Connected {c.connectedAt.toLocaleDateString("en-US")}
                    {c.needsReauth && <span className="ml-2 text-amber-400">Login rejected. Reconnect.</span>}
                  </div>
                </div>
                <form action={disconnect} className="flex gap-2">
                  <input type="hidden" name="mailbox" value={c.mailbox} />
                  <button
                    name="intent"
                    value="disconnect"
                    className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 transition hover:border-zinc-500"
                  >
                    Disconnect
                  </button>
                  <button
                    name="intent"
                    value="wipe"
                    className="rounded-md border border-red-900 px-2.5 py-1 text-xs text-red-300 transition hover:border-red-700"
                  >
                    Disconnect and delete data
                  </button>
                </form>
                <ScanStatus mailbox={c.mailbox} scan={scansByMailbox.get(c.mailbox) ?? null} />
              </li>
            ))}
          </ul>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          {oauthButtons.map((p) =>
            p.configured ? (
              <a
                key={p.id}
                href={`/api/auth/${p.id}/start`}
                className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 transition hover:bg-emerald-400"
              >
                Connect {PROVIDER_NAME[p.id]}
              </a>
            ) : (
              <span key={p.id} className="rounded-lg border border-dashed border-zinc-700 px-3 py-2 text-xs text-zinc-500">
                {PROVIDER_NAME[p.id]}: set up docs/SETUP-{p.id.toUpperCase()}-OAUTH.md
              </span>
            ),
          )}
        </div>

        <details className="mt-4 rounded-lg border border-zinc-800 p-3">
          <summary className="cursor-pointer text-sm text-zinc-300">Connect Yahoo, AOL, iCloud or another IMAP mailbox</summary>
          <div className="mt-3">
            <ImapForm presets={presets} />
          </div>
        </details>
      </section>

      <section className="mb-3 rounded-xl border border-zinc-800 bg-zinc-950 p-5">
        <h2 className="font-medium text-zinc-100">2. Discovered services</h2>
        {totalServices === 0 ? (
          <p className="mt-1 text-sm text-zinc-400">
            Nothing yet. Connect a mailbox and press Scan. Ghost-Hub reads message headers only (sender, subject and
            date), never message bodies, and doesn&apos;t keep subjects.
          </p>
        ) : (
          <>
            <p className="mt-1 text-sm text-zinc-400">{totalServices.toLocaleString("en-US")} services found across your mailboxes.</p>
            <nav className="mt-3 flex flex-wrap gap-2 text-xs" aria-label="Filter by type">
              <Link href="/" className={chip(!cat)}>All ({totalServices})</Link>
              {CATEGORIES.map((c) => (
                <Link key={c} href={`/?cat=${c}`} className={chip(cat === c)} title={CATEGORY_HINT[c]}>
                  {CATEGORY_LABEL[c]} ({counts[c]})
                </Link>
              ))}
            </nav>
            <ul className="mt-3 divide-y divide-zinc-900">
              {services.map((s) => (
                <li key={s.domain} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm text-zinc-100">{s.name}</div>
                    <div className="truncate text-xs text-zinc-500">{s.domain}</div>
                  </div>
                  <div className="shrink-0 text-right text-xs text-zinc-500">
                    <div>
                      <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-300">
                        {CATEGORY_SINGULAR[s.category]}
                      </span>
                    </div>
                    <div className="mt-1">
                      {s.messages.toLocaleString("en-US")} msgs, {s.firstSeen.getUTCFullYear()}
                      {s.lastSeen.getUTCFullYear() !== s.firstSeen.getUTCFullYear() ? `-${s.lastSeen.getUTCFullYear()}` : ""}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <ol start={3} className="space-y-3">
        {LATER_STEPS.map((s, i) => (
          <li key={s.title} className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
            <div className="flex items-center justify-between">
              <span className="font-medium text-zinc-100">
                {i + 3}. {s.title}
              </span>
              <span className="text-xs text-zinc-500">Planned</span>
            </div>
            <p className="mt-1 text-sm text-zinc-400">{s.detail}</p>
          </li>
        ))}
      </ol>
    </main>
  );
}

const chip = (active: boolean) =>
  `rounded-full border px-2.5 py-1 transition ${
    active ? "border-emerald-700 bg-emerald-950/50 text-emerald-300" : "border-zinc-800 text-zinc-400 hover:border-zinc-600"
  }`;

type LatestScan = Awaited<ReturnType<typeof latestScan>>;

function ScanStatus({ mailbox, scan }: { mailbox: string; scan: LatestScan }) {
  const running = scan?.status === "running" && isScanning(mailbox);
  const btn = "rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 transition hover:border-zinc-500";

  if (running && scan) {
    return (
      <div className="w-full">
        <ScanProgress
          scanId={scan.id}
          initial={{ status: scan.status, processed: scan.messagesProcessed, total: scan.messagesTotal, error: null }}
        />
        <form action={cancelMailboxScan} className="mt-2">
          <input type="hidden" name="mailbox" value={mailbox} />
          <button className={btn}>Cancel scan</button>
        </form>
      </div>
    );
  }

  const when = scan?.finishedAt?.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  const summary = !scan
    ? "Not scanned yet."
    : scan.status === "done"
      ? `Scanned ${scan.messagesProcessed.toLocaleString("en-US")} messages, ${when}.`
      : scan.status === "cancelled"
        ? `Scan cancelled after ${scan.messagesProcessed.toLocaleString("en-US")} messages. Scanning again continues where it stopped.`
        : null;

  return (
    <div className="flex w-full flex-wrap items-center justify-between gap-2 border-t border-zinc-900 pt-2">
      <p className={`text-xs ${scan?.status === "failed" ? "text-amber-400" : "text-zinc-500"}`}>
        {scan?.status === "failed" ? `Last scan failed: ${scan.error ?? "unknown error"}` : summary}
      </p>
      <form action={scanMailbox}>
        <input type="hidden" name="mailbox" value={mailbox} />
        <button className="rounded-md bg-emerald-500 px-3 py-1 text-xs font-medium text-zinc-950 transition hover:bg-emerald-400">
          {scan ? "Scan again" : "Scan"}
        </button>
      </form>
    </div>
  );
}
