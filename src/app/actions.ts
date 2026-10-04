"use server";

import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { ImapConnectError, parseImapForm, verifyImapLogin } from "@/lib/imap";
import { disconnectMailbox, findConnection, saveConnection } from "@/lib/mailboxes";
import { HibpError } from "@/lib/breaches/hibp";
import { HibpDisabledError, HibpKeyMissingError, checkMailboxBreaches, refreshCatalog } from "@/lib/breaches/store";
import { cancelScan, startScan } from "@/lib/scan/registry";

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

/** Start scanning a connected mailbox in the background. Safe to click twice: it won't start a second scan. */
export async function scanMailbox(formData: FormData) {
  await requireSession();
  const mailbox = formData.get("mailbox");
  if (typeof mailbox !== "string" || !(await findConnection(mailbox))) redirect("/");
  await startScan(mailbox);
  redirect("/");
}

export async function cancelMailboxScan(formData: FormData) {
  await requireSession();
  const mailbox = formData.get("mailbox");
  if (typeof mailbox === "string") cancelScan(mailbox);
  redirect("/");
}

/** Short code for the dashboard to turn into a message. Details go to the server log, never the URL. */
function breachErrorCode(err: unknown): string {
  if (err instanceof HibpDisabledError) return "hibp_disabled";
  if (err instanceof HibpKeyMissingError) return "hibp_key_missing";
  if (err instanceof HibpError && err.status === 401) return "hibp_key_rejected";
  if (err instanceof HibpError && err.status === 429) return "hibp_rate";
  console.error("[ghost-hub] breach lookup failed:", err instanceof Error ? err.message : err);
  return "hibp_failed";
}

/** Download HIBP's public breach list. Sends nothing about the user. */
export async function refreshBreaches() {
  await requireSession();
  let target: string;
  try {
    const { count } = await refreshCatalog();
    target = `/dashboard?refreshed=${count}`;
  } catch (err) {
    target = `/dashboard?error=${breachErrorCode(err)}`;
  }
  redirect(target);
}

/** Look up one connected address in HIBP. Sends that address to HIBP using the user's own key. */
export async function checkMailbox(formData: FormData) {
  await requireSession();
  const mailbox = formData.get("mailbox");
  if (typeof mailbox !== "string" || !(await findConnection(mailbox))) redirect("/dashboard");
  let target: string;
  try {
    const { breachCount } = await checkMailboxBreaches(mailbox);
    target = `/dashboard?checked=${encodeURIComponent(mailbox)}&found=${breachCount}`;
  } catch (err) {
    target = `/dashboard?error=${breachErrorCode(err)}`;
  }
  redirect(target);
}
