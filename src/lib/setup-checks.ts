export type SetupNote = { level: "warn" | "info"; text: string };

type Config = {
  APP_URL: string;
  ADMIN_PASSWORD: string;
  GOOGLE_CLIENT_ID?: string;
  MICROSOFT_CLIENT_ID?: string;
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Mistakes that are easy to make when self-hosting and hard to notice: they don't stop Ghost-Hub starting, but they
 * weaken it or make sign-in fail in a confusing way. Pure, so it's easy to test.
 */
export function setupNotes(c: Config): SetupNote[] {
  const notes: SetupNote[] = [];

  let url: URL | null = null;
  try {
    url = new URL(c.APP_URL);
  } catch {
    // APP_URL is validated at startup; nothing useful to add here.
  }
  const plainHttpOffLocalhost = url?.protocol === "http:" && !LOCAL_HOSTS.has(url.hostname);
  const oauthConfigured = Boolean(c.GOOGLE_CLIENT_ID || c.MICROSOFT_CLIENT_ID);

  if (plainHttpOffLocalhost) {
    notes.push({
      level: "warn",
      text: "Ghost-Hub is on plain http, so your password and session travel across your network unencrypted and the session cookie isn't marked Secure. Put it behind an HTTPS reverse proxy and set APP_URL to the https address.",
    });
    if (oauthConfigured) {
      notes.push({
        level: "warn",
        text: "Google and Microsoft only accept http redirect addresses on localhost, so connecting Gmail or Outlook will fail until Ghost-Hub is reached over https (or through localhost).",
      });
    }
  }

  if (c.ADMIN_PASSWORD.length < 12) {
    notes.push({ level: "warn", text: "Your admin password is short. Use 12 or more characters; a passphrase works well." });
  }

  if (!oauthConfigured) {
    notes.push({
      level: "info",
      text: "Gmail and Outlook aren't set up yet (each needs an OAuth app you create once, see the docs folder). Yahoo, AOL, iCloud and other IMAP mailboxes work now with an app password.",
    });
  }

  return notes;
}
