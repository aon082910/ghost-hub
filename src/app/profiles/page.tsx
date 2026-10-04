import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { getProfileJob } from "@/lib/profiles/runner";
import { MAX_USERNAMES, connectedEmails, listUsernames, loadResults, suggestUsernames } from "@/lib/profiles/store";
import { loadSites } from "@/lib/profiles/sites";
import { buildGroups, type ProfileGroup } from "@/lib/profiles/view";
import { cancelProfileCheck, checkProfiles, removeProfileUsername } from "../actions";
import { SiteHeader } from "../site-header";
import { ProfileProgress } from "./profile-progress";
import { UsernameForm } from "./username-form";

const MESSAGES: Record<string, { tone: "ok" | "error"; text: string }> = {
  confirm: { tone: "error", text: "Please confirm the username is your own." },
  invalid: { tone: "error", text: "Use 1-40 letters, numbers, dots, dashes or underscores." },
  duplicate: { tone: "error", text: "That username is already on your list." },
  limit: { tone: "error", text: `You can add up to ${MAX_USERNAMES} usernames. Remove one first.` },
  recent: { tone: "ok", text: "Everything was checked in the last few minutes. Give it a little while before checking again." },
  nothing: { tone: "error", text: "Nothing to check yet. Add a username or connect a mailbox first." },
  running: { tone: "ok", text: "A check is already running." },
};

type Params = Record<string, string | string[] | undefined>;
const one = (sp: Params, k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);

function banner(sp: Params) {
  const error = one(sp, "error");
  if (error) return MESSAGES[error] ?? { tone: "error" as const, text: "Something went wrong." };
  const info = one(sp, "info");
  if (info) return MESSAGES[info] ?? null;
  if (one(sp, "started")) return { tone: "ok" as const, text: `Checking ${one(sp, "started")} places in the background.` };
  if (one(sp, "added")) return { tone: "ok" as const, text: `Added ${one(sp, "added")}. Press "Check now" to look it up.` };
  if (one(sp, "removed")) return { tone: "ok" as const, text: "Removed, along with everything found for it." };
  return null;
}

const smallBtn = "rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 transition hover:border-zinc-500";
const fmt = (d: Date) => d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

export default async function Profiles(props: PageProps<"/profiles">) {
  await requireSession();
  const sp = await props.searchParams;
  const [usernames, emails, rows, suggestions] = await Promise.all([listUsernames(), connectedEmails(), loadResults(), suggestUsernames()]);
  const groups = buildGroups(rows, usernames.map((u) => u.value), emails);
  const idByUsername = new Map(usernames.map((u) => [u.value, u.id]));
  const job = getProfileJob();
  const note = banner(sp);
  const totalFound = groups.reduce((n, g) => n + g.found.length, 0);

  return (
    <main className="mx-auto max-w-3xl px-4 py-12">
      <SiteHeader current="/profiles" />

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

      <section className="mb-6 rounded-xl border border-zinc-800 bg-zinc-950 p-5">
        <h2 className="font-medium text-zinc-100">Where else you show up</h2>
        <p className="mt-1 text-sm text-zinc-400">
          Finds public profiles under your own usernames, and the accounts linked to your own email addresses, so you know what&apos;s
          out there under your name.
        </p>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-zinc-500">
          <li>
            <span className="text-zinc-400">Usernames:</span> opens the public profile page on {loadSites().length} sites, the same as visiting it in a
            browser. No logins, and nothing is sent about you but the username.
          </li>
          <li>
            <span className="text-zinc-400">Email addresses:</span> only addresses you&apos;ve connected, asked of Gravatar by a hash, so the address
            itself is never sent.
          </li>
          <li>Phone numbers aren&apos;t looked up (there&apos;s no safe public way to), and sign-up forms aren&apos;t probed.</li>
          <li>Only for your own identifiers. Each username needs your confirmation, and a recently checked one is skipped for a few minutes.</li>
        </ul>
      </section>

      <section className="mb-6 rounded-xl border border-zinc-800 bg-zinc-950 p-5">
        <h2 className="font-medium text-zinc-100">Your identifiers</h2>

        <ul className="mt-3 space-y-2">
          {groups.map((g) => (
            <li key={`${g.type}:${g.identifier}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-800 px-3 py-2">
              <div>
                <div className="text-sm text-zinc-100">
                  {g.identifier}
                  <span className="ml-2 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
                    {g.type === "email" ? "Email" : "Username"}
                  </span>
                </div>
                <div className="text-xs text-zinc-500">{g.checkedAt ? `Checked ${fmt(g.checkedAt)}` : "Not checked yet"}</div>
              </div>
              {g.type === "username" && idByUsername.has(g.identifier) && (
                <form>
                  <button formAction={removeProfileUsername.bind(null, idByUsername.get(g.identifier)!)} className={smallBtn} title="Remove it and everything found for it">
                    Remove
                  </button>
                </form>
              )}
            </li>
          ))}
          {groups.length === 0 && <li className="text-sm text-zinc-500">Nothing yet. Add a username below, or connect a mailbox.</li>}
        </ul>

        <div className="mt-4 border-t border-zinc-900 pt-4">
          <h3 className="mb-2 text-sm text-zinc-300">Add a username</h3>
          <UsernameForm suggestions={suggestions} atLimit={usernames.length >= MAX_USERNAMES} />
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-zinc-900 pt-4">
          {job?.running ? (
            <>
              <ProfileProgress initial={job} />
              <form>
                <button formAction={cancelProfileCheck} className={smallBtn}>
                  Cancel
                </button>
              </form>
            </>
          ) : (
            <form>
              <button
                formAction={checkProfiles}
                className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 transition hover:bg-emerald-400"
              >
                Check now
              </button>
            </form>
          )}
        </div>
      </section>

      {groups.some((g) => g.checkedAt) && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-5">
          <h2 className="font-medium text-zinc-100">What was found</h2>
          <p className="mt-1 text-sm text-zinc-400">
            {totalFound === 0
              ? "No public profiles found."
              : `${totalFound} public profile${totalFound === 1 ? "" : "s"} found. Open each one to check it's really yours.`}
          </p>
          <div className="mt-3 space-y-4">
            {groups.filter((g) => g.checkedAt).map((g) => (
              <GroupResults key={`${g.type}:${g.identifier}`} g={g} />
            ))}
          </div>
        </section>
      )}

      {groups.length === 0 && (
        <p className="mt-4 text-xs text-zinc-500">
          Need an address to look up? <Link href="/" className="text-emerald-400 underline">Connect a mailbox</Link> first.
        </p>
      )}
    </main>
  );
}

function GroupResults({ g }: { g: ProfileGroup }) {
  return (
    <div>
      <div className="text-sm text-zinc-300">{g.identifier}</div>
      {g.found.length === 0 ? (
        <p className="mt-1 text-xs text-zinc-500">Nothing found.</p>
      ) : (
        <ul className="mt-1 divide-y divide-zinc-900">
          {g.found.map((f) => (
            <li key={f.key} className="flex items-center justify-between gap-3 py-1.5">
              <div className="min-w-0 text-sm text-zinc-100">
                {f.name}
                {f.via && <span className="ml-2 text-xs text-zinc-500">linked via {f.via}</span>}
              </div>
              <a href={f.url} target="_blank" rel="noopener noreferrer" className="shrink-0 text-xs text-emerald-400 underline">
                Open
              </a>
            </li>
          ))}
        </ul>
      )}
      {g.type === "email" ? (
        <>
          {g.found.length === 0 && g.notFound > 0 && <p className="mt-1 text-xs text-zinc-500">This address has no public Gravatar profile.</p>}
          {g.unclear.length > 0 && <p className="mt-1 text-xs text-zinc-500">Couldn&apos;t check Gravatar.</p>}
        </>
      ) : (
        <p className="mt-1 text-xs text-zinc-500">
          Not found on {g.notFound} site{g.notFound === 1 ? "" : "s"}
          {g.unclear.length > 0 && `; couldn't check ${g.unclear.length}`}.
        </p>
      )}
      {g.unclear.length > 0 && (
        <details className="mt-1 text-xs text-zinc-500">
          <summary className="cursor-pointer text-zinc-400">Which sites couldn&apos;t be checked</summary>
          <ul className="mt-1 space-y-0.5">
            {g.unclear.map((u) => (
              <li key={u.name}>
                {u.name}: {u.detail}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
