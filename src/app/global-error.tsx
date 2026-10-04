"use client";

/** Last-resort page for an error in the root layout itself, so it can't rely on any shared styling. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#09090b", color: "#e4e4e7", fontFamily: "system-ui, sans-serif" }}>
        <main style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div style={{ maxWidth: 360, textAlign: "center" }}>
            <h1 style={{ fontSize: 20 }}>Something went wrong</h1>
            <p style={{ color: "#a1a1aa", fontSize: 14 }}>Ghost-Hub couldn&apos;t load. Try again, and check the server logs if it keeps happening.</p>
            {error.digest && <p style={{ color: "#52525b", fontSize: 12, fontFamily: "monospace" }}>Reference: {error.digest}</p>}
            <button
              onClick={reset}
              style={{ marginTop: 8, padding: "8px 16px", borderRadius: 8, border: 0, background: "#10b981", color: "#09090b", fontWeight: 600, cursor: "pointer" }}
            >
              Try again
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
