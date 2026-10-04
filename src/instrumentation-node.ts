/** Start-up work that only makes sense on the Node.js server (kept out of instrumentation.ts so Edge never sees it). */
export async function startup() {
  try {
    // Fail fast on bad configuration, then bring the schema up to date before serving requests.
    const { getEnv } = await import("./lib/env");
    getEnv();
    const { runMigrations } = await import("./db/migrate");
    await runMigrations();
    const { markInterruptedScans } = await import("./lib/scan/registry");
    await markInterruptedScans();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ghost-hub] Cannot start: ${message}`);
    // A server that stays up with broken configuration just answers every request with an error, and looks healthy to
    // the Docker tab. In production, exit so the failure is obvious and a restart policy can retry; in development,
    // rethrow so the dev server shows the error overlay.
    if (process.env.NODE_ENV === "production") process.exit(1);
    throw err;
  }
}
