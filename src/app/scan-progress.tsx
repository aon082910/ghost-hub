"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

type Progress = { status: string; processed: number; total: number | null; error: string | null };

/** Polls the scan's progress and refreshes the page when it stops. */
export function ScanProgress({ scanId, initial }: { scanId: string; initial: Progress }) {
  const router = useRouter();
  const [p, setP] = useState(initial);

  useEffect(() => {
    if (p.status !== "running") return;
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/scans/${scanId}`, { cache: "no-store" });
        if (!res.ok || stop) return;
        const next = (await res.json()) as { status: string; processed: number; total: number | null; error: string | null };
        if (stop) return;
        setP(next);
        if (next.status !== "running") router.refresh();
      } catch {
        // transient network error: keep polling
      }
    };
    const timer = setInterval(tick, 1500);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [p.status, scanId, router]);

  // The total is an estimate (it can include mail we skip), so never show past 100%.
  const pct = p.total && p.total > 0 ? Math.min(100, Math.round((p.processed / p.total) * 100)) : null;

  return (
    <div className="mt-2 w-full" role="status" aria-live="polite">
      <div className="mb-1 flex justify-between text-xs text-zinc-400">
        <span>Scanning... {p.processed.toLocaleString("en-US")} messages{p.total ? ` of ~${p.total.toLocaleString("en-US")}` : ""}</span>
        {pct !== null && <span>{pct}%</span>}
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
        <div
          className={`h-full rounded-full bg-emerald-500 transition-all ${pct === null ? "w-1/3 animate-pulse" : ""}`}
          style={pct === null ? undefined : { width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
