import Link from "next/link";
import { logout } from "./login/actions";

const NAV = [
  { href: "/", label: "Mailboxes" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/newsletters", label: "Newsletters" },
] as const;

/** Title, navigation and sign-out shared by every signed-in page. */
export function SiteHeader({ current }: { current: (typeof NAV)[number]["href"] }) {
  return (
    <header className="mb-8 flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-6">
        <h1 className="text-2xl font-semibold text-zinc-50">Ghost-Hub</h1>
        <nav className="flex gap-4 text-sm" aria-label="Main">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              aria-current={n.href === current ? "page" : undefined}
              className={n.href === current ? "text-emerald-400" : "text-zinc-400 transition hover:text-zinc-100"}
            >
              {n.label}
            </Link>
          ))}
        </nav>
      </div>
      <form action={logout}>
        <button className="text-sm text-zinc-400 transition hover:text-zinc-100">Sign out</button>
      </form>
    </header>
  );
}
