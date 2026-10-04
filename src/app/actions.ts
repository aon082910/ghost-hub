"use server";

import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { ImapConnectError, parseImapForm, verifyImapLogin } from "@/lib/imap";
import { disconnectMailbox, findConnection, saveConnection } from "@/lib/mailboxes";
import { HibpError } from "@/lib/breaches/hibp";
import { HibpDisabledError, HibpKeyMissingError, checkMailboxBreaches, refreshCatalog } from "@/lib/breaches/store";
import { approvePending, markUnsubscribedManually, queueUnsubscribes, rejectPending, setKept } from "@/lib/newsletters/store";
import { cancelProfileScan, startProfileScan } from "@/lib/profiles/runner";
import { setServiceStatuses } from "@/lib/deletion/store";
import { addUsername, removeUsername } from "@/lib/profiles/store";
import { isDepth, sinceFor } from "@/lib/scan/depth";
import { resetScanData } from "@/lib/scan/reset";
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
  const depth = formData.get("depth");
  // "Start over" recounts everything. It never runs while a scan is going, and a scan already running is simply returned.
  if (formData.get("fresh") === "on") await resetScanData(mailbox);
  await startScan(mailbox, { since: isDepth(depth) ? sinceFor(depth) : undefined, includeJunk: formData.get("includeJunk") === "on" });
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every string value submitted under `name` that is a well-formed id. Nothing else from the form is trusted. */
const ids = (formData: FormData, name: string) =>
  formData.getAll(name).filter((v): v is string => typeof v === "string" && UUID.test(v));

/** Stage the selected senders for review. Sends nothing. */
export async function queueForReview(formData: FormData) {
  await requireSession();
  const selected = ids(formData, "select");
  if (selected.length === 0) redirect("/newsletters?error=nothing_selected");
  const { queued, skipped } = await queueUnsubscribes(selected);
  if (queued === 0) redirect(`/newsletters?error=nothing_queued&skipped=${skipped.length}`);
  redirect("/newsletters/review");
}

/** Approve exactly the items the user was shown on the review page, then send them. */
export async function approveReviewed(formData: FormData) {
  await requireSession();
  const shown = ids(formData, "action");
  if (shown.length === 0) redirect("/newsletters");
  const { succeeded, failed } = await approvePending({ actionIds: shown });
  redirect(`/newsletters?unsubscribed=${succeeded}&failed=${failed}`);
}

/**
 * The id arrives bound to the action (`action.bind(null, id)`), not through the form: a button's own name and value
 * aren't included in the submission when it uses `formAction`. It is still validated like any other input.
 */
export async function removeFromReview(actionId: string) {
  await requireSession();
  if (UUID.test(actionId)) await rejectPending([actionId]);
  redirect("/newsletters/review");
}

export async function cancelReview() {
  await requireSession();
  await rejectPending();
  redirect("/newsletters");
}

/** The user unsubscribed themselves (opened the link, or sent the email) and wants it recorded. */
export async function markUnsubscribed(newsletterId: string) {
  await requireSession();
  if (UUID.test(newsletterId)) await markUnsubscribedManually(newsletterId);
  redirect("/newsletters");
}

/** Hide a sender from cleanup (`kept` true) or put it back. */
export async function keepSender(newsletterId: string, kept: boolean) {
  await requireSession();
  if (UUID.test(newsletterId)) await setKept(newsletterId, kept);
  redirect("/newsletters");
}

/** Add a username the user says is theirs. They must tick the confirmation: this is for their own handles only. */
export async function addProfileUsername(formData: FormData) {
  await requireSession();
  if (formData.get("confirm") !== "yes") redirect("/profiles?error=confirm");
  const raw = formData.get("username");
  const result = typeof raw === "string" ? await addUsername(raw) : ({ ok: false, code: "invalid" } as const);
  if (!result.ok) redirect(`/profiles?error=${result.code}`);
  redirect(`/profiles?added=${encodeURIComponent(result.value)}`);
}

export async function removeProfileUsername(id: string) {
  await requireSession();
  if (UUID.test(id)) await removeUsername(id);
  redirect("/profiles?removed=1");
}

/** Check every identifier that is due. Runs in the background; the page shows progress. */
export async function checkProfiles() {
  await requireSession();
  const r = await startProfileScan();
  redirect(r.started ? `/profiles?started=${r.total}` : `/profiles?info=${r.reason}`);
}

export async function cancelProfileCheck() {
  await requireSession();
  cancelProfileScan();
  redirect("/profiles");
}

/**
 * The user deleted the account themselves (Ghost-Hub never does) and is recording it. The company's domains are
 * bound to the action rather than read from the form, and validated again before they touch the database.
 */
export async function markServiceDeleted(domains: string[]) {
  await requireSession();
  await setServiceStatuses(domains, "deleted");
  redirect("/dashboard");
}

/** Hide a service from cleanup because the user wants to keep the account. */
export async function keepService(domains: string[]) {
  await requireSession();
  await setServiceStatuses(domains, "ignored");
  redirect("/dashboard");
}

/** Put a deleted or kept service back on the active list. */
export async function restoreService(domains: string[]) {
  await requireSession();
  await setServiceStatuses(domains, "active");
  redirect("/dashboard");
}
