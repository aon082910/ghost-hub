import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { getEnv } from "@/lib/env";
import * as schema from "./schema";

// Reuse one pool across dev hot reloads.
const globalForDb = globalThis as unknown as { __ghostHubPool?: Pool };

function getPool(): Pool {
  globalForDb.__ghostHubPool ??= new Pool({ connectionString: getEnv().DATABASE_URL, max: 10 });
  return globalForDb.__ghostHubPool;
}

export function getDb() {
  return drizzle(getPool(), { schema });
}

export async function pingDb(): Promise<boolean> {
  try {
    await getPool().query("select 1");
    return true;
  } catch {
    return false;
  }
}
