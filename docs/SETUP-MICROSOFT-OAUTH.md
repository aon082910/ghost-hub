# Create your Microsoft (Outlook / Microsoft 365) app

Ghost-Hub reads Outlook.com, Hotmail, Live and Microsoft 365 mail through an app registration that **you**
own. It's free and takes about 5 minutes. Ghost-Hub asks for read-only permissions: `Mail.Read`, `User.Read`
(to look up your address) and `offline_access` (to stay connected).

> **Easiest:** do the steps below, then paste the values on the **Settings** page in Ghost-Hub. Nothing to edit, no restart. The
> `.env` lines in the steps are an alternative; a value saved in Settings wins over them.

1. Sign in to the [Microsoft Entra admin center](https://entra.microsoft.com/) and go to
   **Identity → Applications → App registrations → New registration**.
   (Personal Microsoft accounts without a tenant can use the
   [Azure portal](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade) the same way.)
2. Name it "Ghost-Hub". Under **Supported account types** choose **Accounts in any organizational directory
   and personal Microsoft accounts**.
3. Under **Redirect URI** choose platform **Web** and enter `<APP_URL>/api/auth/microsoft/callback`
   (see [Redirect URIs need HTTPS](#redirect-uris-need-https) below). Click **Register**.
4. Copy the **Application (client) ID** into the Settings page (Outlook section), or into `.env` as `MICROSOFT_CLIENT_ID`.
5. **Certificates & secrets → New client secret.** Copy the secret **Value** (not the ID) into Settings, or into `.env` as
   `MICROSOFT_CLIENT_SECRET`. Secrets expire (24 months at most); set a reminder to create a new one.
6. **API permissions → Add a permission → Microsoft Graph → Delegated permissions** and add `Mail.Read` and
   `User.Read`. (`offline_access` is requested during sign-in.) Admin consent isn't needed for personal accounts.
   For a work or school account your organization may require an admin to approve `Mail.Read`.
7. If you used `.env`, restart Ghost-Hub. Then click **Connect Outlook** on the Mailboxes page.

## Account types

The tenant (the Settings field, or `MICROSOFT_TENANT`) defaults to `common` (personal and work/school accounts). Set it to `consumers` to allow only
personal accounts, or to your tenant ID to allow only your organization. It must match the **Supported account
types** you chose in step 2.

## Redirect URIs need HTTPS

Microsoft only accepts `http://` redirect URIs for `localhost`. For a server on your network, either:

- put Ghost-Hub behind an HTTPS reverse proxy (Nginx Proxy Manager, Caddy, Traefik, Cloudflare Tunnel, Tailscale)
  and set `APP_URL=https://hub.example.com`, or
- reach Ghost-Hub through `http://localhost:3000` (for example with an SSH port forward:
  `ssh -L 3000:localhost:3000 your-server`) and set `APP_URL=http://localhost:3000`.

`APP_URL` must be exactly the address you use in the browser, and the redirect URI registered in step 3 must
match it.

## Disconnecting

Microsoft has no way for an app to revoke its own access, so **Disconnect** removes Ghost-Hub's stored token
but can't invalidate it at Microsoft. To remove access completely, delete the app at
<https://account.live.com/consent/Manage> (personal accounts) or <https://myapps.microsoft.com> (work or school),
and delete the app registration if you no longer use Ghost-Hub.
