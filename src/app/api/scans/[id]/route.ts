import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { scans } from "@/db/schema";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Scan progress for the UI to poll. Requires a logged-in session (enforced by src/proxy.ts). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const [scan] = await getDb().select().from(scans).where(eq(scans.id, id));
  if (!scan) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({
    id: scan.id,
    status: scan.status,
    processed: scan.messagesProcessed,
    total: scan.messagesTotal,
    error: scan.error,
    finishedAt: scan.finishedAt,
  });
}
