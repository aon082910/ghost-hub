import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { listPending } from "@/lib/newsletters/store";
import { approveReviewed, cancelReview, removeFromReview } from "../../actions";
import { SiteHeader } from "../../site-header";

export default async function Review() {
  await requireSession();
  const items = await listPending();
  const n = items.length;

  return (
    <main className="mx-auto max-w-3xl px-4 py-12">
      <SiteHeader current="/newsletters" />

      <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-5">
        <h2 className="font-medium text-zinc-100">Review before anything is sent</h2>

        {n === 0 ? (
          <p className="mt-2 text-sm text-zinc-400">
            Nothing is waiting.{" "}
            <Link href="/newsletters" className="text-emerald-400 underline">
              Back to newsletters
            </Link>
          </p>
        ) : (
          <form>
            <p className="mt-2 text-sm text-zinc-400">
              Approving sends one small web request to each address below, asking that sender to remove you from its list. This
              is the standard one-click unsubscribe (RFC 8058) that mail apps use.
            </p>
            <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-zinc-500">
              <li>Each request is a single POST to the exact address shown. No cookies or logins are sent.</li>
              <li>Redirects aren&apos;t followed and replies are ignored apart from the status code.</li>
              <li>Addresses on private networks, plain http links and unusual ports are refused.</li>
              <li>No email is sent from your account.</li>
            </ul>

            <ul className="mt-4 divide-y divide-zinc-900">
              {items.map((i) => (
                <li key={i.actionId} className="flex items-start justify-between gap-3 py-3">
                  <input type="hidden" name="action" value={i.actionId} />
                  <div className="min-w-0">
                    <div className="truncate text-sm text-zinc-100">{i.senderName || i.senderEmail}</div>
                    <div className="truncate text-xs text-zinc-500">
                      {i.senderEmail} · {i.messageCount.toLocaleString("en-US")} emails · {i.mailbox}
                    </div>
                    <div className="mt-1 text-xs text-zinc-400">
                      Will contact <span className="text-zinc-200">{i.host}</span>
                    </div>
                    <code className="mt-0.5 block break-all text-[11px] text-zinc-500">{i.url}</code>
                  </div>
                  <button
                    formAction={removeFromReview.bind(null, i.actionId)}
                    className="shrink-0 rounded-md border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 transition hover:border-zinc-500"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                formAction={approveReviewed}
                className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 transition hover:bg-emerald-400"
              >
                Approve and unsubscribe from {n} sender{n === 1 ? "" : "s"}
              </button>
              <button formAction={cancelReview} className="text-sm text-zinc-400 transition hover:text-zinc-100">
                Cancel, send nothing
              </button>
            </div>
          </form>
        )}
      </section>
    </main>
  );
}
