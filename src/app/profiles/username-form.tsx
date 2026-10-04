"use client";

import { useState } from "react";
import { addProfileUsername } from "../actions";

/** Add a username you own. Suggestions come from your connected addresses; the confirmation is required. */
export function UsernameForm({ suggestions, atLimit }: { suggestions: string[]; atLimit: boolean }) {
  const [value, setValue] = useState("");
  const field = "w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500";

  return (
    <form action={addProfileUsername} className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <input
          name="username"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          required
          maxLength={41}
          autoComplete="off"
          spellCheck={false}
          placeholder="your-username"
          aria-label="Username"
          disabled={atLimit}
          className={`${field} max-w-xs flex-1`}
        />
        <button
          type="submit"
          disabled={atLimit}
          className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 transition hover:bg-emerald-400 disabled:opacity-50"
        >
          Add
        </button>
      </div>

      {suggestions.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
          From your addresses:
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setValue(s)}
              className="rounded-full border border-zinc-800 px-2.5 py-1 text-zinc-300 transition hover:border-zinc-600"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      <label className="flex items-start gap-2 text-xs text-zinc-400">
        <input type="checkbox" name="confirm" value="yes" required className="mt-0.5 h-4 w-4 accent-emerald-500" />
        <span>This is my own username. I won&apos;t use Ghost-Hub to look up other people.</span>
      </label>
    </form>
  );
}
