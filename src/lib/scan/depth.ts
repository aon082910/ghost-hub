/** How far back a scan reaches. A first scan of a very large mailbox is slow, so it can be limited to recent mail. */
export const DEPTHS = [
  { id: "all", label: "All mail" },
  { id: "5y", label: "Last 5 years" },
  { id: "2y", label: "Last 2 years" },
  { id: "1y", label: "Last year" },
  { id: "90d", label: "Last 90 days" },
] as const;

export type Depth = (typeof DEPTHS)[number]["id"];

export const isDepth = (v: unknown): v is Depth => typeof v === "string" && DEPTHS.some((d) => d.id === v);

/** The earliest date a scan should reach, or undefined for the whole mailbox. */
export function sinceFor(depth: Depth, now = new Date()): Date | undefined {
  const d = new Date(now);
  switch (depth) {
    case "5y":
      d.setUTCFullYear(d.getUTCFullYear() - 5);
      return d;
    case "2y":
      d.setUTCFullYear(d.getUTCFullYear() - 2);
      return d;
    case "1y":
      d.setUTCFullYear(d.getUTCFullYear() - 1);
      return d;
    case "90d":
      d.setUTCDate(d.getUTCDate() - 90);
      return d;
    default:
      return undefined;
  }
}
