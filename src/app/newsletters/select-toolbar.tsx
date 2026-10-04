"use client";

import { useEffect, useRef, useState } from "react";

/** Select / clear helpers and a live count for the sender checkboxes in the surrounding form. */
export function SelectToolbar({ label }: { label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(0);

  useEffect(() => {
    const form = ref.current?.closest("form");
    if (!form) return;
    const update = () => setCount(form.querySelectorAll("input[name=select]:checked").length);
    form.addEventListener("change", update);
    update();
    return () => form.removeEventListener("change", update);
  }, []);

  const setAll = (checked: boolean) => {
    const form = ref.current?.closest("form");
    form?.querySelectorAll<HTMLInputElement>("input[name=select]").forEach((cb) => {
      if (!cb.disabled) cb.checked = checked;
    });
    form?.dispatchEvent(new Event("change"));
  };

  const btn = "rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 transition hover:border-zinc-500";
  return (
    <div ref={ref} className="flex flex-wrap items-center gap-2">
      <button type="button" className={btn} onClick={() => setAll(true)}>
        {label}
      </button>
      <button type="button" className={btn} onClick={() => setAll(false)}>
        Clear
      </button>
      <span className="text-xs text-zinc-500" aria-live="polite">
        {count} selected
      </span>
    </div>
  );
}
