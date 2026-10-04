import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { accounts, actions, breachChecks, mailboxBreaches, mailboxConnections, messagesSeen, newsletters, scans } from "@/db/schema";
import { decrypt, encrypt } from "./crypto";
import { IMAP_PORT, type ImapCredentials } from "./imap";
import { OAuthError, getOAuthProvider } from "./oauth";

export type ProviderKind = "google" | "microsoft" | "imap";

type SaveInput =
  | { provider: "google" | "microsoft"; mailbox: string; refreshToken: string; scopes: string }
  | { provider: "imap"; mailbox: string; imap: ImapCredentials };

/** Insert or replace a connection. Reconnecting clears `needsReauth`. */
export async function saveConnection(input: SaveInput) {
  const base =
    input.provider === "imap"
      ? {
          authType: "password",
          credentialEnc: encrypt(input.imap.pass),
          scopes: null,
          imapHost: input.imap.host,
          imapPort: input.imap.port,
        }
      : {
          authType: "oauth",
          credentialEnc: encrypt(input.refreshToken),
          scopes: input.scopes,
          imapHost: null,
          imapPort: null,
        };
  const values = { provider: input.provider, mailbox: input.mailbox, needsReauth: false, ...base };
  await getDb()
    .insert(mailboxConnections)
    .values(values)
    .onConflictDoUpdate({
      target: [mailboxConnections.provider, mailboxConnections.mailbox],
      set: { ...values, connectedAt: new Date() },
    });
  accessTokenCache.delete(input.mailbox);
}

export async function listConnections() {
  return getDb()
    .select({
      mailbox: mailboxConnections.mailbox,
      provider: mailboxConnections.provider,
      connectedAt: mailboxConnections.connectedAt,
      needsReauth: mailboxConnections.needsReauth,
    })
    .from(mailboxConnections)
    .orderBy(mailboxConnections.connectedAt);
}

/** The stored connection for a mailbox address, if any (credential still encrypted). */
export async function findConnection(mailbox: string) {
  const [row] = await getDb().select().from(mailboxConnections).where(eq(mailboxConnections.mailbox, mailbox));
  return row;
}

const accessTokenCache = new Map<string, { token: string; expiresAt: number }>();
const EXPIRY_SKEW_MS = 60_000;

/**
 * A valid API access token for an OAuth mailbox (Google or Microsoft), refreshing when needed.
 * If the provider rejects the refresh token the connection is flagged `needsReauth`. Providers
 * that rotate refresh tokens (Microsoft) have the new one stored.
 */
export async function getAccessToken(mailbox: string): Promise<string> {
  const cached = accessTokenCache.get(mailbox);
  if (cached && cached.expiresAt > Date.now() + EXPIRY_SKEW_MS) return cached.token;

  const row = await findConnection(mailbox);
  if (!row) throw new Error(`No connection for ${mailbox}`);
  const provider = row.authType === "oauth" ? getOAuthProvider(row.provider) : null;
  if (!provider) throw new Error(`${mailbox} is not an OAuth mailbox`);

  const db = getDb();
  try {
    const current = decrypt(row.credentialEnc);
    const tokens = await provider.refreshAccessToken(current);
    if (tokens.refreshToken && tokens.refreshToken !== current) {
      await db
        .update(mailboxConnections)
        .set({ credentialEnc: encrypt(tokens.refreshToken) })
        .where(eq(mailboxConnections.id, row.id));
    }
    accessTokenCache.set(mailbox, { token: tokens.accessToken, expiresAt: Date.now() + tokens.expiresIn * 1000 });
    return tokens.accessToken;
  } catch (err) {
    if (err instanceof OAuthError && err.code === "invalid_grant") {
      await db.update(mailboxConnections).set({ needsReauth: true }).where(eq(mailboxConnections.id, row.id));
      accessTokenCache.delete(mailbox);
    }
    throw err;
  }
}

/** Decrypted IMAP login for a password-based mailbox. */
export async function getImapCredentials(mailbox: string): Promise<ImapCredentials> {
  const row = await findConnection(mailbox);
  if (!row || row.authType !== "password" || !row.imapHost) throw new Error(`${mailbox} is not an IMAP mailbox`);
  return { host: row.imapHost, port: row.imapPort ?? IMAP_PORT, user: row.mailbox, pass: decrypt(row.credentialEnc) };
}

export type DisconnectResult =
  | { found: false }
  | {
      found: true;
      provider: string;
      /** true/false when a revoke was attempted; null when the provider can't revoke (user must do it). */
      revoked: boolean | null;
    };

/**
 * Remove a mailbox connection, revoking the OAuth token at the provider where that's possible,
 * then delete it. With `wipe`, also delete everything discovered from that mailbox.
 */
export async function disconnectMailbox(mailbox: string, opts: { wipe: boolean }): Promise<DisconnectResult> {
  const row = await findConnection(mailbox);
  if (!row) return { found: false };

  let revoked: boolean | null = null;
  const provider = row.authType === "oauth" ? getOAuthProvider(row.provider) : null;
  if (provider?.revoke) {
    try {
      revoked = await provider.revoke(decrypt(row.credentialEnc));
    } catch {
      // Undecryptable credential (e.g. ENCRYPTION_KEY changed): nothing to revoke, still disconnect locally.
      revoked = false;
    }
  }

  await getDb().transaction(async (tx) => {
    if (opts.wipe) {
      await tx.delete(accounts).where(eq(accounts.mailbox, mailbox));
      // The review log refers to newsletters by id, so it goes first.
      await tx.delete(actions).where(
        and(
          eq(actions.targetType, "newsletter"),
          inArray(actions.targetId, tx.select({ id: sql<string>`${newsletters.id}::text` }).from(newsletters).where(eq(newsletters.mailbox, mailbox))),
        ),
      );
      await tx.delete(newsletters).where(eq(newsletters.mailbox, mailbox));
      await tx.delete(messagesSeen).where(eq(messagesSeen.mailbox, mailbox));
      await tx.delete(scans).where(eq(scans.mailbox, mailbox));
      await tx.delete(mailboxBreaches).where(eq(mailboxBreaches.mailbox, mailbox));
      await tx.delete(breachChecks).where(eq(breachChecks.mailbox, mailbox));
    }
    await tx.delete(mailboxConnections).where(and(eq(mailboxConnections.id, row.id)));
  });
  accessTokenCache.delete(mailbox);
  return { found: true, provider: row.provider, revoked };
}
