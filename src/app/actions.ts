"use server";

import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { disconnectMailbox } from "@/lib/mailboxes";

/** Server Actions are public POST endpoints, so re-check the session here. */
export async function disconnect(formData: FormData) {
  await requireSession();
  const mailbox = formData.get("mailbox");
  if (typeof mailbox !== "string" || !mailbox) redirect("/");

  const wipe = formData.get("intent") === "wipe";
  const result = await disconnectMailbox(mailbox, { wipe });
  const note = !result.found ? "missing" : result.revoked ? "revoked" : "unrevoked";
  redirect(`/?disconnected=${encodeURIComponent(mailbox)}&revoke=${note}${wipe ? "&wiped=1" : ""}`);
}
