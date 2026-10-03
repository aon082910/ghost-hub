import { requireSession } from "@/lib/auth";
import { isGoogleConfigured } from "@/lib/google";
import { listConnections } from "@/lib/mailboxes";
import { disconnect } from "./actions";
import { logout } from "./login/actions";

const ERRORS: Record<string, string> = {
  not_configured: "Google OAuth isn't configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, then restart.",
  access_denied: "Google sign-in was cancelled or denied.",
  state_mismatch: "That sign-in attempt expired or didn't match. Please try connecting again.",
  scope_missing: "Ghost-Hub needs permission to read your Gmail. Connect again and leave the Gmail box ticked.",
  no_refresh_token: "Google didn't return a long-lived token. Remove Ghost-Hub at myaccount.google.com/permissions, then connect again.",
  exchange_failed: "Couldn't complete the Google sign-in. Check the server logs and your OAuth client settings.",
};

const LATER_STEPS = [
  { title: "Scan", detail: "Discover every service you've signed up for." },
  { title: "Dashboard", detail: "Accounts, breach risk, newsletters, shadow profiles." },
  { title: "Take action", detail: "Deletion guides and bulk unsubscribe, review-first." },
];

function banner(sp: Record<string, string | string[] | undefined>) {
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
  const error = one("error");
  if (error) return { tone: "error" as const, text: ERRORS[error] ?? "Something went wrong." };
  const connected = one("connected");
  if (connected) return { tone: "ok" as const, text: `Connected ${connected}.` };
  const gone = one("disconnected");
  if (gone) {
    const revoke =
      one("revoke") === "revoked"
        ? "Access was revoked at Google."
        : "Couldn't reach Google to revoke access. Remove Ghost-Hub at myaccount.google.com/permissions to be sure.";
    return {
      tone: "ok" as const,
      text: `Disconnected ${gone}${one("wiped") ? " and deleted its data" : ""}. ${revoke}`,
    };
  }
  return null;
}

export default async function Home(props: PageProps<"/">) {
  await requireSession();
  const [sp, connections] = await Promise.all([props.searchParams, listConnections()]);
  const configured = isGoogleConfigured();
  const note = banner(sp);

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
          className={`mb-6 rounded-lg border px-4 py-3 text-sm ${
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
          Read-only Gmail access through your own Google OAuth client. Email content is processed in memory and never
          stored.
        </p>

        {connections.length > 0 && (
          <ul className="mt-4 space-y-2">
            {connections.map((c) => (
              <li
                key={c.mailbox}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-800 px-3 py-2"
              >
                <div>
                  <div className="text-sm text-zinc-100">{c.mailbox}</div>
                  <div className="text-xs text-zinc-500">
                    Connected {c.connectedAt.toLocaleDateString("en-US")}
                    {c.needsReauth && <span className="ml-2 text-amber-400">Google rejected the token. Reconnect.</span>}
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

        <div className="mt-4">
          {configured ? (
            <a
              href="/api/auth/google/start"
              className="inline-block rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 transition hover:bg-emerald-400"
            >
              {connections.length > 0 ? "Connect another Gmail account" : "Connect Gmail"}
            </a>
          ) : (
            <p className="text-sm text-amber-300">
              Google OAuth isn&apos;t set up yet. Create a client by following docs/SETUP-GOOGLE-OAUTH.md, put
              GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in your environment, and restart.
            </p>
          )}
        </div>
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
