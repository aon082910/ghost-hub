"use server";

import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { ImapConnectError, parseImapForm, verifyImapLogin } from "@/lib/imap";
import { disconnectMailbox, saveConnection } from "@/lib/mailboxes";

export type ConnectImapState = { error?: string };

/** Server Actions are public POST endpoints, so each one re-checks the session. */
export async function disconnect(formData: FormData) {
  await requireSession();
  const mailbox = formData.get("mailbox");
  if (typeof mailbox !== "string" || !mailbox) redirect("/");

  const wipe = formData.get("intent") === "wipe";
  const result = await disconnectMailbox(mailbox, { wipe });
  if (!result.found) redirect("/?disconnected=missing");

  const revoke = result.revoked === null ? "manual" : result.revoked ? "revoked" : "failed";
  redirect(
    `/?disconnected=${encodeURIComponent(mailbox)}&provider=${result.provider}&revoke=${revoke}${wipe ? "&wiped=1" : ""}`,
  );
}

/** Connect a Yahoo / AOL / iCloud / custom IMAP mailbox with an app password. */
export async function connectImap(_prev: ConnectImapState, formData: FormData): Promise<ConnectImapState> {
  await requireSession();

  const parsed = parseImapForm(Object.fromEntries(formData));
  if (!parsed.ok) return { error: parsed.error };

  try {
    await verifyImapLogin(parsed.credentials);
  } catch (err) {
    if (err instanceof ImapConnectError) return { error: err.message };
    throw err;
  }

  await saveConnection({ provider: "imap", mailbox: parsed.credentials.user, imap: parsed.credentials });
  redirect(`/?connected=${encodeURIComponent(parsed.credentials.user)}`);
}
