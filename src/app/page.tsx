import { requireSession } from "@/lib/auth";
import { IMAP_PRESETS } from "@/lib/imap";
import { listConnections } from "@/lib/mailboxes";
import { OAUTH_PROVIDERS, getOAuthProvider } from "@/lib/oauth";
import { disconnect } from "./actions";
import { ImapForm } from "./imap-form";
import { logout } from "./login/actions";

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

const LATER_STEPS = [
  { title: "Scan", detail: "Discover every service you've signed up for." },
  { title: "Dashboard", detail: "Accounts, breach risk, newsletters, linked profiles." },
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

      <ol start={2} className="space-y-3">
        {LATER_STEPS.map((s, i) => (
          <li key={s.title} className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
            <div className="flex items-center justify-between">
              <span className="font-medium text-zinc-100">
                {i + 2}. {s.title}
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
