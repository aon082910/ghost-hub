"use client";

import { useActionState, useState } from "react";
import { connectImap, type ConnectImapState } from "./actions";

export type PresetOption = { id: string; label: string; appPasswordUrl: string | null; needsHost: boolean };

const field =
  "w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500";

export function ImapForm({ presets }: { presets: PresetOption[] }) {
  const [state, action, pending] = useActionState<ConnectImapState, FormData>(connectImap, {});
  const [presetId, setPresetId] = useState(presets[0].id);
  const preset = presets.find((p) => p.id === presetId)!;

  return (
    <form action={action} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs text-zinc-400">
          Provider
          <select name="preset" value={presetId} onChange={(e) => setPresetId(e.target.value)} className={field}>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-xs text-zinc-400">
          Email address
          <input name="email" type="email" required autoComplete="off" className={field} />
        </label>
      </div>

      {preset.needsHost && (
        <div className="grid gap-3 sm:grid-cols-[1fr_6rem]">
          <label className="space-y-1 text-xs text-zinc-400">
            IMAP server
            <input name="host" required placeholder="imap.example.com" className={field} />
          </label>
          <label className="space-y-1 text-xs text-zinc-400">
            Port
            <input name="port" type="number" defaultValue={993} className={field} />
          </label>
        </div>
      )}

      <label className="block space-y-1 text-xs text-zinc-400">
        App password
        <input name="password" type="password" required autoComplete="off" className={field} />
      </label>
      <p className="text-xs text-zinc-500">
        Use an app password, not your normal password.
        {preset.appPasswordUrl && (
          <>
            {" "}
            Create one in your{" "}
            <a href={preset.appPasswordUrl} target="_blank" rel="noreferrer" className="text-emerald-400 underline">
              {preset.label} security settings
            </a>
            .
          </>
        )}{" "}
        Connections use TLS on port 993.
      </p>

      {state.error && (
        <p role="alert" className="text-sm text-red-400">
          {state.error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 transition hover:bg-emerald-400 disabled:opacity-60"
      >
        {pending ? "Checking login..." : "Connect"}
      </button>
    </form>
  );
}
