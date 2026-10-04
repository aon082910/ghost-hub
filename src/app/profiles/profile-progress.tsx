"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

type Job = { running: boolean; total: number; done: number; found: number; errors: number };

/** Shows how far the background check has got and refreshes the page when it stops. */
export function ProfileProgress({ initial }: { initial: Job }) {
  const router = useRouter();
  const [job, setJob] = useState(initial);

  useEffect(() => {
    if (!job.running) return;
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/profiles/progress", { cache: "no-store" });
        if (!res.ok || stop) return;
        const next = (await res.json()) as Job;
        if (stop) return;
        setJob(next);
        if (!next.running) router.refresh();
      } catch {
        // transient: keep polling
      }
    };
    const timer = setInterval(tick, 1200);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [job.running, router]);

  const pct = job.total > 0 ? Math.min(100, Math.round((job.done / job.total) * 100)) : 0;
  return (
    <div role="status" aria-live="polite" className="w-full">
      <div className="mb-1 flex justify-between text-xs text-zinc-400">
        <span>
          Checking... {job.done} of {job.total} lookups, {job.found} found so far
        </span>
        <span>{pct}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
        <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
