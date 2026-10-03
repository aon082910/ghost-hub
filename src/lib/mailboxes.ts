import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { accounts, messagesSeen, newsletters, oauthTokens, scans } from "@/db/schema";
import { decrypt, encrypt } from "./crypto";
import { GoogleAuthError, refreshAccessToken, revokeToken } from "./google";

const PROVIDER = "google";

export async function saveConnection(input: { mailbox: string; refreshToken: string; scopes: string }) {
  const values = {
    provider: PROVIDER,
    mailbox: input.mailbox,
    refreshTokenEnc: encrypt(input.refreshToken),
    scopes: input.scopes,
    needsReauth: false,
  };
  await getDb()
    .insert(oauthTokens)
    .values(values)
    .onConflictDoUpdate({
      target: [oauthTokens.provider, oauthTokens.mailbox],
      set: { ...values, connectedAt: new Date() },
    });
  accessTokenCache.delete(input.mailbox);
}

export async function listConnections() {
  return getDb()
    .select({
      mailbox: oauthTokens.mailbox,
      provider: oauthTokens.provider,
      connectedAt: oauthTokens.connectedAt,
      needsReauth: oauthTokens.needsReauth,
    })
    .from(oauthTokens)
    .orderBy(oauthTokens.connectedAt);
}

const accessTokenCache = new Map<string, { token: string; expiresAt: number }>();
const EXPIRY_SKEW_MS = 60_000;

/**
 * A valid Gmail access token for the mailbox, refreshing when needed. If Google rejects the
 * refresh token, the connection is flagged `needsReauth` so the UI can prompt a reconnect.
 */
export async function getAccessToken(mailbox: string): Promise<string> {
  const cached = accessTokenCache.get(mailbox);
  if (cached && cached.expiresAt > Date.now() + EXPIRY_SKEW_MS) return cached.token;

  const db = getDb();
  const [row] = await db
    .select()
    .from(oauthTokens)
    .where(and(eq(oauthTokens.provider, PROVIDER), eq(oauthTokens.mailbox, mailbox)));
  if (!row) throw new Error(`No connection for ${mailbox}`);

  try {
    const { accessToken, expiresIn } = await refreshAccessToken(decrypt(row.refreshTokenEnc));
    accessTokenCache.set(mailbox, { token: accessToken, expiresAt: Date.now() + expiresIn * 1000 });
    return accessToken;
  } catch (err) {
    if (err instanceof GoogleAuthError && err.code === "invalid_grant") {
      await db.update(oauthTokens).set({ needsReauth: true }).where(eq(oauthTokens.id, row.id));
      accessTokenCache.delete(mailbox);
    }
    throw err;
  }
}

/**
 * Remove a mailbox connection: revoke the token at Google (best effort), then delete it.
 * With `wipe`, also delete everything discovered from that mailbox.
 */
export async function disconnectMailbox(mailbox: string, opts: { wipe: boolean }) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(oauthTokens)
    .where(and(eq(oauthTokens.provider, PROVIDER), eq(oauthTokens.mailbox, mailbox)));
  if (!row) return { revoked: false, found: false };

  let revoked = false;
  try {
    revoked = await revokeToken(decrypt(row.refreshTokenEnc));
  } catch {
    // Undecryptable token (e.g. ENCRYPTION_KEY changed): nothing to revoke, still disconnect locally.
  }

  await db.transaction(async (tx) => {
    if (opts.wipe) {
      await tx.delete(accounts).where(eq(accounts.mailbox, mailbox));
      await tx.delete(newsletters).where(eq(newsletters.mailbox, mailbox));
      await tx.delete(messagesSeen).where(eq(messagesSeen.mailbox, mailbox));
      await tx.delete(scans).where(eq(scans.mailbox, mailbox));
    }
    await tx.delete(oauthTokens).where(eq(oauthTokens.id, row.id));
  });
  accessTokenCache.delete(mailbox);
  return { revoked, found: true };
}
