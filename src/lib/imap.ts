import { ImapFlow } from "imapflow";
import { z } from "zod";

export type ImapPreset = {
  id: string;
  label: string;
  host: string | null; // null = user supplies it
  appPasswordUrl: string | null;
};

/** Providers reachable over IMAP with an app password. Yahoo's OAuth needs a commercial agreement. */
export const IMAP_PRESETS: ImapPreset[] = [
  { id: "yahoo", label: "Yahoo Mail", host: "imap.mail.yahoo.com", appPasswordUrl: "https://login.yahoo.com/account/security" },
  { id: "aol", label: "AOL Mail", host: "imap.aol.com", appPasswordUrl: "https://login.aol.com/account/security" },
  { id: "icloud", label: "iCloud Mail", host: "imap.mail.me.com", appPasswordUrl: "https://account.apple.com/account/manage" },
  { id: "custom", label: "Other IMAP server", host: null, appPasswordUrl: null },
];

export const IMAP_PORT = 993; // implicit TLS only. Plaintext and STARTTLS are not supported.

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

const inputSchema = z.object({
  preset: z.enum(IMAP_PRESETS.map((p) => p.id) as [string, ...string[]]),
  email: z.email("Enter a valid email address."),
  password: z.string().min(1, "Enter the app password."),
  host: z.string().trim().optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
});

export type ImapCredentials = { host: string; port: number; user: string; pass: string };

/** Validate the connect form and resolve the server. Returns a message on failure. */
export function parseImapForm(raw: Record<string, FormDataEntryValue | null>):
  | { ok: true; credentials: ImapCredentials }
  | { ok: false; error: string } {
  const parsed = inputSchema.safeParse({
    preset: raw.preset,
    email: typeof raw.email === "string" ? raw.email.trim() : raw.email,
    password: raw.password,
    host: raw.host || undefined,
    port: raw.port || undefined,
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };

  const { preset, email, password, host, port } = parsed.data;
  const resolved = IMAP_PRESETS.find((p) => p.id === preset)!.host ?? host;
  if (!resolved || !HOSTNAME.test(resolved)) return { ok: false, error: "Enter a valid IMAP server hostname." };
  return {
    ok: true,
    credentials: { host: resolved.toLowerCase(), port: port ?? IMAP_PORT, user: email.toLowerCase(), pass: password },
  };
}

export class ImapConnectError extends Error {
  constructor(
    public readonly code: "auth_failed" | "unreachable",
    message: string,
  ) {
    super(message);
    this.name = "ImapConnectError";
  }
}

/** The slice of ImapFlow we use, so tests can substitute a fake. */
export type ImapClientLike = {
  connect(): Promise<unknown>;
  status(path: string, query: { messages: true }): Promise<false | { messages?: number }>;
  logout(): Promise<unknown>;
  close(): void;
};

export function createImapClient(c: ImapCredentials): ImapClientLike {
  return new ImapFlow({
    host: c.host,
    port: c.port,
    secure: true,
    auth: { user: c.user, pass: c.pass },
    logger: false,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
}

/** Log in and open the inbox to prove the credentials work. Never logs the password. */
export async function verifyImapLogin(
  creds: ImapCredentials,
  makeClient: (c: ImapCredentials) => ImapClientLike = createImapClient,
): Promise<{ messages: number | null }> {
  const client = makeClient(creds);
  // ImapFlow emits 'error' on socket failures; without a listener Node would treat it as unhandled.
  (client as unknown as { on?: (e: string, f: () => void) => void }).on?.("error", () => {});
  try {
    await client.connect();
    const status = await client.status("INBOX", { messages: true });
    await client.logout();
    return { messages: status ? (status.messages ?? null) : null };
  } catch (err) {
    client.close();
    const e = err as { authenticationFailed?: boolean; responseText?: string; message?: string };
    if (e.authenticationFailed) {
      throw new ImapConnectError(
        "auth_failed",
        "The server rejected the email or app password. Use an app password, not your normal password.",
      );
    }
    throw new ImapConnectError("unreachable", `Couldn't reach ${creds.host}:${creds.port}. Check the server name.`);
  }
}
