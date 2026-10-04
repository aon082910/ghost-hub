import { NextResponse } from "next/server";
import { getProfileJob } from "@/lib/profiles/runner";

export const dynamic = "force-dynamic";

/** Progress of the current profile check, for the page to poll. Requires a signed-in session (src/proxy.ts). */
export async function GET() {
  return NextResponse.json(getProfileJob() ?? { running: false, total: 0, done: 0, found: 0, errors: 0 });
}
