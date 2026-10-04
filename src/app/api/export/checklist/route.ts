import { checklistItems, toCsv, toMarkdown } from "@/lib/checklist";
import { loadServices } from "@/lib/dashboard";

export const dynamic = "force-dynamic";

/**
 * Download the account checklist as Markdown or CSV. Requires a logged-in session (enforced by src/proxy.ts), and is
 * never cached, because it lists the user's accounts.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const csv = url.searchParams.get("format") === "csv";
  const now = new Date();
  const items = checklistItems(await loadServices(now), { includeNewsletters: url.searchParams.get("newsletters") === "1" });

  const stamp = now.toISOString().slice(0, 10);
  return new Response(csv ? toCsv(items) : toMarkdown(items, now), {
    headers: {
      "content-type": csv ? "text/csv; charset=utf-8" : "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="ghost-hub-checklist-${stamp}.${csv ? "csv" : "md"}"`,
      "cache-control": "no-store",
    },
  });
}
