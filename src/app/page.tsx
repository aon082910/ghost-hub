import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { getEnv } from "@/lib/env";
import { setupNotes } from "@/lib/setup-checks";
import { IMAP_PRESETS } from "@/lib/imap";
import { listConnections } from "@/lib/mailboxes";
import { OAUTH_PROVIDERS, getOAuthProvider } from "@/lib/oauth";
import { loadServices, summarize } from "@/lib/dashboard";
import { DEPTHS } from "@/lib/scan/depth";
import { isScanning, latestScan } from "@/lib/scan/registry";
import { cancelMailboxScan, disconnect, scanAllMailboxes, scanMailbox } from "./actions";
import { ImapForm } from "./imap-form";
import { ScanProgress } from "./scan-progress";
import { googleConfig, microsoftConfig } from "@/lib/config";
import { ensureSettingsLoaded } from "@/lib/settings";
import { SiteHeader } from "./site-header";

const ERRORS: Record<string, string> = {
  not_configured: "That provider isn't set up yet. Add its client ID and secret on the Settings page.",
  unknown_provider: "Unknown provider.",
  access_denied: "Sign-in was cancelled or denied.",
  state_mismatch: "That sign-in attempt expired or didn't match. Please try connecting again.",
  scope_missing: "Ghost-Hub needs permission to read your mail. Connect again and leave the mail permission ticked.",
  no_refresh_token:
    "The provider didn't return a long-lived token. Remove Ghost-Hub from your account's app permissions, then connect again.",
  exchange_failed: "Couldn't complete the sign-in. Check the client ID, secret and redirect address on the Settings page.",
};

const PROVIDER_NAME: Record<string, string> = { google: "Gmail", microsoft: "Outlook", imap: "IMAP" };

const LATER_STEPS = [
  { title: "Take action", detail: "Deletion guides, bulk unsubscribe and linked profiles, review-first." },
];

type Params = Record<string, string | string[] | undefined>;

function banner(sp: Params) {
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
  const error = one("error");
  if (error === "mailbox_conflict") {
    const other = PROVIDER_NAME[one("with") ?? ""] ?? "another provider";
    return { tone: "error" as const, text: `That address is already connected through ${other}. Disconnect it first if you want to connect it this way instead.` };
  }
  if (error) return { tone: "error" as const, text: ERRORS[error] ?? "Something went wrong." };

  const connected = one("connected");
  if (connected) {
    return {
      tone: "ok" as const,
      text: one("again")
        ? `${connected} was already connected, so its login was refreshed. To add a different account, pick it (or "Use another account") on the sign-in screen.`
        : `Connected ${connected}.`,
    };
  }
  const scanning = one("scanning");
  if (scanning) return { tone: "ok" as const, text: `Started scanning ${scanning} mailbox${scanning === "1" ? "" : "es"}.` };

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
  await ensureSettingsLoaded();
  const setup = setupNotes({
    ...getEnv(),
    GOOGLE_CLIENT_ID: googleConfig().clientId.value,
    MICROSOFT_CLIENT_ID: microsoftConfig().clientId.value,
  });
  const scansByMailbox = new Map(await Promise.all(connections.map(async (c) => [c.mailbox, await latestScan(c.mailbox)] as const)));
  const summary = summarize((await loadServices()).filter((s) => s.state === "active" && !s.spamOnly));
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
      <SiteHeader current="/" />

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

      {setup.length > 0 && (
        <section aria-label="Setup notes" className="mb-3 rounded-xl border border-zinc-800 bg-zinc-950 p-4">
          <h2 className="text-sm font-medium text-zinc-200">Setup notes</h2>
          <ul className="mt-2 space-y-2">
            {setup.map((n) => (
              <li key={n.text} className={`flex gap-2 text-xs ${n.level === "warn" ? "text-amber-300" : "text-zinc-400"}`}>
                <span aria-hidden="true" className="mt-px shrink-0">
                  {n.level === "warn" ? "!" : "i"}
                </span>
                <span>{n.text}</span>
              </li>
            ))}
          </ul>
        </section>
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

        {connections.filter((c) => !c.needsReauth).length > 1 && (
          <form action={scanAllMailboxes} className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 px-3 py-2">
            <span className="text-xs text-zinc-300">Scan all {connections.filter((c) => !c.needsReauth).length} mailboxes</span>
            <select name="depth" defaultValue="all" aria-label="How far back to scan" className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-300">
              {DEPTHS.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1 text-xs text-zinc-400">
              <input type="checkbox" name="includeJunk" className="accent-emerald-500" />
              Include spam, trash &amp; sent
            </label>
            <button className="rounded-md bg-emerald-500 px-3 py-1 text-xs font-medium text-zinc-950 transition hover:bg-emerald-400">Scan all</button>
          </form>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          {oauthButtons.map((p) =>
            p.configured ? (
              <a
                key={p.id}
                href={`/api/auth/${p.id}/start`}
                className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 transition hover:bg-emerald-400"
              >
                {connections.some((c) => c.provider === p.id) ? `Add another ${PROVIDER_NAME[p.id]} account` : `Connect ${PROVIDER_NAME[p.id]}`}
              </a>
            ) : (
              <span key={p.id} className="rounded-lg border border-dashed border-zinc-700 px-3 py-2 text-xs text-zinc-500">
                {PROVIDER_NAME[p.id]}:{" "}
                <Link href={`/settings#${p.id}`} className="text-emerald-400 underline">
                  set it up in Settings
                </Link>
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
        {summary.total === 0 ? (
          <p className="mt-1 text-sm text-zinc-400">
            Nothing yet. Connect a mailbox and press Scan. Ghost-Hub reads message headers only (sender, subject and
            date), never message bodies, and doesn&apos;t keep subjects.
          </p>
        ) : (
          <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-zinc-400">
              {summary.total.toLocaleString("en-US")} services found
              {summary.high + summary.medium > 0
                ? `, ${(summary.high + summary.medium).toLocaleString("en-US")} worth a closer look.`
                : "."}
            </p>
            <Link
              href="/dashboard"
              className="rounded-md bg-emerald-500 px-3 py-1 text-xs font-medium text-zinc-950 transition hover:bg-emerald-400"
            >
              Open dashboard
            </Link>
          </div>
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
  const reach = scan?.since ? ` from ${scan.since.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })} on` : "";
  const summary = !scan
    ? "Not scanned yet."
    : scan.status === "done"
      ? `Scanned ${scan.messagesProcessed.toLocaleString("en-US")} messages${reach}${scan.includeJunk ? " (including spam, trash and sent)" : ""}, ${when}.`
      : scan.status === "cancelled"
        ? `Scan cancelled after ${scan.messagesProcessed.toLocaleString("en-US")} messages. Scanning again continues where it stopped.`
        : null;

  return (
    <div className="flex w-full flex-wrap items-center justify-between gap-2 border-t border-zinc-900 pt-2">
      <p className={`text-xs ${scan?.status === "failed" ? "text-amber-400" : "text-zinc-500"}`}>
        {scan?.status === "failed" ? `Last scan failed: ${scan.error ?? "unknown error"}` : summary}
      </p>
      <form action={scanMailbox} className="flex items-center gap-2">
        <input type="hidden" name="mailbox" value={mailbox} />
        <select
          name="depth"
          defaultValue="all"
          aria-label="How far back to scan"
          title="A first scan of a very large mailbox can take a while. You can scan recent mail first and the rest later."
          className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-300"
        >
          {DEPTHS.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
        <label
          className="flex items-center gap-1 text-xs text-zinc-400"
          title="Also read the Spam, Trash, Sent and Drafts folders, which are normally skipped. Useful for an old mailbox: it finds sign-ups that were deleted or filed as spam."
        >
          <input type="checkbox" name="includeJunk" className="accent-emerald-500" />
          Include spam, trash &amp; sent
        </label>
        {scan && (
          <label
            className="flex items-center gap-1 text-xs text-zinc-400"
            title="Forget the counts from earlier scans and recount every message. Your decisions (deleted, kept, unsubscribed) are kept."
          >
            <input type="checkbox" name="fresh" className="accent-emerald-500" />
            Start over
          </label>
        )}
        <button className="rounded-md bg-emerald-500 px-3 py-1 text-xs font-medium text-zinc-950 transition hover:bg-emerald-400">
          {scan ? "Scan again" : "Scan"}
        </button>
      </form>
    </div>
  );
}
