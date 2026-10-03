export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Fail fast on bad configuration, then bring the schema up to date before serving requests.
  const { getEnv } = await import("./lib/env");
  getEnv();
  const { runMigrations } = await import("./db/migrate");
  await runMigrations();
}
