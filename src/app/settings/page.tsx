import { requireSession } from "@/lib/auth";
import { googleConfig, hibpConfig, microsoftConfig, type Picked, type Source } from "@/lib/config";
import { getEnv } from "@/lib/env";
import { OAUTH_PROVIDERS } from "@/lib/oauth";
import { BAD_VALUE, ensureSettingsLoaded, isUnreadable, type SettingKey } from "@/lib/settings";
import { SiteHeader } from "../site-header";
import { removeGoogle, removeMicrosoft, resetBreach, saveBreach, saveGoogle, saveMicrosoft } from "./actions";

type Params = Record<string, string | string[] | undefined>;
const one = (sp: Params, k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);

const SECTION_NAME = { google: "Gmail", microsoft: "Outlook", breach: "Breach checks" } as const;
const MISSING: Record<string, string> = {
  missing_google_client_id: "Enter the client ID from Google.",
  missing_google_client_secret: "Enter the client secret from Google.",
  missing_microsoft_client_id: "Enter the application (client) ID from Microsoft.",
  missing_microsoft_client_secret: "Enter the client secret value from Microsoft.",
};

function banner(sp: Params) {
  const error = one(sp, "error");
  if (error) {
    const bad = error.startsWith("bad_") ? BAD_VALUE[error.slice(4) as SettingKey] : undefined;
    return { tone: "error" as const, text: bad ?? MISSING[error] ?? "Couldn't save that." };
  }
  const saved = one(sp, "saved") as keyof typeof SECTION_NAME | undefined;
  if (saved && saved in SECTION_NAME) return { tone: "ok" as const, text: `${SECTION_NAME[saved]} settings saved.` };
  const removed = one(sp, "removed") as keyof typeof SECTION_NAME | undefined;
  if (removed && removed in SECTION_NAME) return { tone: "ok" as const, text: `Saved ${SECTION_NAME[removed]} settings removed. Anything set in the environment applies again.` };
  return null;
}

const SOURCE_TEXT: Record<Source, string> = { ui: "Saved here", env: "From the environment (.env or container settings)", none: "Not set" };
const input = "w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600";
const btn = "rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition hover:border-zinc-500";
const primary = "rounded-md bg-emerald-500 px-3 py-1.5 text-xs font-medium text-zinc-950 transition hover:bg-emerald-400";
const link = "text-emerald-400 underline";

export default async function Settings(props: PageProps<"/settings">) {
  await requireSession();
  await ensureSettingsLoaded();
  const sp = await props.searchParams;
  const note = banner(sp);

  const google = googleConfig();
  const microsoft = microsoftConfig();
  const hibp = hibpConfig();
  const appUrl = getEnv().APP_URL;
  let plainHttpRemote = false;
  try {
    const u = new URL(appUrl);
    plainHttpRemote = u.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    // APP_URL is validated at start-up.
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-12">
      <SiteHeader current="/settings" />

      {note && (
        <p
          role={note.tone === "error" ? "alert" : "status"}
          className={`mb-6 rounded-lg border px-4 py-3 text-sm ${
            note.tone === "error" ? "border-red-900 bg-red-950/40 text-red-300" : "border-emerald-900 bg-emerald-950/40 text-emerald-300"
          }`}
        >
          {note.text}
        </p>
      )}

      <p className="mb-6 text-sm text-zinc-400">
        Everything for connecting Gmail and Outlook can be set here, so nothing needs editing in <code>.env</code>. Saved values take effect
        straight away, win over the environment, and secrets are stored encrypted and never shown again. Yahoo, AOL and iCloud need no setup
        here: connect them on the Mailboxes page with an app password.
      </p>

      {plainHttpRemote && (
        <p role="note" className="mb-6 rounded-lg border border-amber-900 bg-amber-950/30 px-4 py-3 text-xs text-amber-200">
          Ghost-Hub is at <code>{appUrl}</code>. Google and Microsoft only accept <code>http</code> redirect addresses on <code>localhost</code>, so
          connecting Gmail or Outlook won&apos;t work from here until you reach Ghost-Hub over https or through localhost.
        </p>
      )}

      <Card id="google" title="Gmail" status={google.clientId.value && google.clientSecret.value ? "ready" : "off"}>
        <Steps
          items={[
            <>
              Open the{" "}
              <a className={link} href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener noreferrer">
                Google Cloud console
              </a>{" "}
              and create a project called Ghost-Hub.
            </>,
            <>
              Turn on the{" "}
              <a className={link} href="https://console.cloud.google.com/apis/library/gmail.googleapis.com" target="_blank" rel="noopener noreferrer">
                Gmail API
              </a>{" "}
              (click Enable). Skipping this is what causes a &quot;403&quot; error when scanning.
            </>,
            <>
              Set up the{" "}
              <a className={link} href="https://console.cloud.google.com/auth/overview" target="_blank" rel="noopener noreferrer">
                consent screen
              </a>
              : user type External, add your own Gmail address as a test user, add the scope <code>gmail.readonly</code>, then click Publish app so
              the connection doesn&apos;t expire after 7 days.
            </>,
            <>
              Under{" "}
              <a className={link} href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer">
                Credentials
              </a>{" "}
              create an OAuth client ID of type Web application, and add the redirect address below.
            </>,
          ]}
        />
        <RedirectUri value={OAUTH_PROVIDERS.google.redirectUri()} />
        <form action={saveGoogle} className="mt-4 space-y-3">
          <Field label="Client ID" source={google.clientId.source}>
            <input name="clientId" defaultValue={google.clientId.value ?? ""} autoComplete="off" spellCheck={false} placeholder="123456789-abc.apps.googleusercontent.com" className={input} />
          </Field>
          <SecretField label="Client secret" picked={google.clientSecret} unreadable={isUnreadable("google_client_secret")} />
          <Buttons canRemove={google.clientId.source === "ui" || google.clientSecret.source === "ui"} remove={removeGoogle} />
        </form>
      </Card>

      <Card id="microsoft" title="Outlook, Hotmail and Microsoft 365" status={microsoft.clientId.value && microsoft.clientSecret.value ? "ready" : "off"}>
        <Steps
          items={[
            <>
              In the{" "}
              <a className={link} href="https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/CreateApplicationBlade" target="_blank" rel="noopener noreferrer">
                Microsoft Entra admin center
              </a>{" "}
              register a new app called Ghost-Hub. For account types choose &quot;any organizational directory and personal Microsoft accounts&quot;.
            </>,
            <>Under Redirect URI choose Web and enter the redirect address below.</>,
            <>Under Certificates &amp; secrets create a client secret and copy its Value (not the ID) straight away, because it is only shown once.</>,
            <>
              Under API permissions add Microsoft Graph delegated permissions <code>Mail.Read</code> and <code>User.Read</code>.
            </>,
          ]}
        />
        <RedirectUri value={OAUTH_PROVIDERS.microsoft.redirectUri()} />
        <form action={saveMicrosoft} className="mt-4 space-y-3">
          <Field label="Application (client) ID" source={microsoft.clientId.source}>
            <input name="clientId" defaultValue={microsoft.clientId.value ?? ""} autoComplete="off" spellCheck={false} placeholder="00000000-0000-0000-0000-000000000000" className={input} />
          </Field>
          <SecretField label="Client secret value" picked={microsoft.clientSecret} unreadable={isUnreadable("microsoft_client_secret")} />
          <Field label="Account types (tenant)" source={microsoft.tenant.source} hint="common allows personal and work or school accounts. Use consumers for personal only, or a tenant ID for one organization. It must match what you chose when registering the app.">
            <input name="tenant" list="tenants" defaultValue={microsoft.tenant.value ?? "common"} autoComplete="off" spellCheck={false} className={input} />
            <datalist id="tenants">
              <option value="common" />
              <option value="consumers" />
              <option value="organizations" />
            </datalist>
          </Field>
          <Buttons canRemove={[microsoft.clientId, microsoft.clientSecret, microsoft.tenant].some((p) => p.source === "ui")} remove={removeMicrosoft} />
        </form>
      </Card>

      <Card id="breach" title="Breach checks (Have I Been Pwned)" status={hibp.enabled.value ? "ready" : "off"} statusText={hibp.enabled.value ? "On" : "Off"}>
        <p className="text-xs text-zinc-400">
          Ghost-Hub always downloads Have I Been Pwned&apos;s public list of breached sites to score your services (nothing about you is sent). An API key
          from{" "}
          <a className={link} href="https://haveibeenpwned.com/API/Key" target="_blank" rel="noopener noreferrer">
            haveibeenpwned.com/API/Key
          </a>{" "}
          is optional and paid: with it, the dashboard can check whether your own addresses were in a breach, which sends that address to them.
        </p>
        <form action={saveBreach} className="mt-4 space-y-3">
          <label className="flex items-center gap-2 text-sm text-zinc-200">
            <input type="checkbox" name="enabled" defaultChecked={hibp.enabled.value} className="accent-emerald-500" />
            Use Have I Been Pwned at all
            <span className="text-xs text-zinc-500">({SOURCE_TEXT[hibp.enabled.source]})</span>
          </label>
          <SecretField label="API key (optional)" name="apiKey" picked={hibp.apiKey} unreadable={isUnreadable("hibp_api_key")} />
          <Buttons canRemove={hibp.enabled.source === "ui" || hibp.apiKey.source === "ui"} remove={resetBreach} removeLabel="Remove saved settings" />
        </form>
      </Card>

      <p className="text-xs text-zinc-500">
        Still set in the environment: <code>APP_URL</code> (the address you open Ghost-Hub at), <code>ADMIN_PASSWORD</code>, <code>ENCRYPTION_KEY</code> and{" "}
        <code>DATABASE_URL</code>. They are needed before Ghost-Hub can start, so they can&apos;t live in the database. If you change{" "}
        <code>ENCRYPTION_KEY</code>, saved secrets become unreadable and must be entered again.
      </p>
    </main>
  );
}

function Card({ id, title, status, statusText, children }: { id: string; title: string; status: "ready" | "off"; statusText?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="mb-6 scroll-mt-6 rounded-xl border border-zinc-800 bg-zinc-950 p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="font-medium text-zinc-100">{title}</h2>
        <span
          className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
            status === "ready" ? "border-emerald-900 bg-emerald-950/40 text-emerald-300" : "border-zinc-800 bg-zinc-900 text-zinc-400"
          }`}
        >
          {statusText ?? (status === "ready" ? "Ready to connect" : "Not set up")}
        </span>
      </div>
      {children}
    </section>
  );
}

function Steps({ items }: { items: React.ReactNode[] }) {
  return (
    <details className="text-xs text-zinc-400">
      <summary className="cursor-pointer text-zinc-300">How to get these (about 5 minutes)</summary>
      <ol className="mt-2 list-decimal space-y-1.5 pl-5">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ol>
    </details>
  );
}

function RedirectUri({ value }: { value: string }) {
  return (
    <div className="mt-3 text-xs text-zinc-400">
      Redirect address to register (it must match exactly; click to select it):
      <code className="mt-1 block select-all break-all rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-zinc-200">{value}</code>
    </div>
  );
}

function Field({ label, source, hint, children }: { label: string; source: Source; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 flex items-baseline justify-between gap-3 text-xs text-zinc-300">
        {label}
        <span className="text-[11px] text-zinc-500">{SOURCE_TEXT[source]}</span>
      </span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-zinc-500">{hint}</span>}
    </label>
  );
}

/** A secret is never sent back to the browser: the box stays empty, and leaving it empty keeps what is saved. */
function SecretField({ label, name = "clientSecret", picked, unreadable }: { label: string; name?: string; picked: Picked; unreadable: boolean }) {
  return (
    <Field label={label} source={picked.source} hint={unreadable ? "The saved value can't be read with the current ENCRYPTION_KEY. Enter it again." : undefined}>
      <input
        type="password"
        name={name}
        autoComplete="new-password"
        spellCheck={false}
        placeholder={picked.value ? "Saved. Leave blank to keep it, or paste a new one." : "Paste it here"}
        className={input}
      />
    </Field>
  );
}

function Buttons({ canRemove, remove, removeLabel = "Remove saved values" }: { canRemove: boolean; remove: () => Promise<void>; removeLabel?: string }) {
  return (
    <div className="flex flex-wrap gap-2 pt-1">
      <button className={primary}>Save</button>
      {canRemove && (
        <button formAction={remove} className={btn} formNoValidate>
          {removeLabel}
        </button>
      )}
    </div>
  );
}
