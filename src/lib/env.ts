import { z } from "zod";

const schema = z.object({
  APP_URL: z.url().default("http://localhost:3000"),
  ADMIN_PASSWORD: z.string().min(8, "ADMIN_PASSWORD must be at least 8 characters"),
  ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, "base64").length === 32, {
      message: "ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)",
    }),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),
  /** "common" accepts personal and work/school accounts; use "consumers" or a tenant id to narrow it. */
  MICROSOFT_TENANT: z.string().min(1).default("common"),
  HIBP_API_KEY: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/**
 * Validated environment. Parsed lazily on first use so `next build` doesn't need
 * runtime secrets; throws a readable error listing every bad variable.
 */
export function getEnv(): Env {
  if (cached) return cached;
  const raw = Object.fromEntries(
    Object.entries(process.env).map(([k, v]) => [k, v === "" ? undefined : v]),
  );
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join("\n")}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test helper: drop the memoized env. */
export function resetEnvCache() {
  cached = undefined;
}
