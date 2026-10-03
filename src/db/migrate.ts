import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getDb, pingDb } from "./index";

const ATTEMPTS = 20;
const DELAY_MS = 3000;

/**
 * Apply pending migrations. On Unraid the Postgres container may start after this one, so
 * wait for the database before giving up.
 */
export async function runMigrations() {
  for (let i = 1; i <= ATTEMPTS; i++) {
    if (await pingDb()) break;
    if (i === ATTEMPTS) throw new Error(`Database not reachable after ${ATTEMPTS} attempts (DATABASE_URL)`);
    console.warn(`[ghost-hub] waiting for database (${i}/${ATTEMPTS})...`);
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }
  await migrate(getDb(), { migrationsFolder: path.join(process.cwd(), "drizzle") });
  console.log("[ghost-hub] database migrations applied");
}
