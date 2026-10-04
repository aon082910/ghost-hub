import Link from "next/link";

export const metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-4 rounded-2xl border border-zinc-800 bg-zinc-950 p-8 text-center">
        <h1 className="text-xl font-semibold text-zinc-50">Page not found</h1>
        <p className="text-sm text-zinc-400">That page doesn&apos;t exist, or it has moved.</p>
        <Link href="/" className="inline-block rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 transition hover:bg-emerald-400">
          Back to Ghost-Hub
        </Link>
      </div>
    </main>
  );
}
