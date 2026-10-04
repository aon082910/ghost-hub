"use client";

import Link from "next/link";

/**
 * Shown when a page fails to render. The message deliberately says nothing about the cause: details can contain
 * addresses or hostnames, and they're in the server log (with the digest below) for the person running the server.
 */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-4 rounded-2xl border border-zinc-800 bg-zinc-950 p-8 text-center">
        <h1 className="text-xl font-semibold text-zinc-50">Something went wrong</h1>
        <p className="text-sm text-zinc-400">
          Ghost-Hub hit a problem showing this page. Your data is safe. Try again, and if it keeps happening check the server logs.
        </p>
        {error.digest && <p className="font-mono text-xs text-zinc-600">Reference: {error.digest}</p>}
        <div className="flex justify-center gap-3">
          <button onClick={reset} className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 transition hover:bg-emerald-400">
            Try again
          </button>
          <Link href="/" className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300 transition hover:border-zinc-500">
            Home
          </Link>
        </div>
      </div>
    </main>
  );
}
