import { NextResponse } from "next/server";
import { pingDb } from "@/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const db = await pingDb();
  return NextResponse.json({ ok: db, db }, { status: db ? 200 : 503 });
}
