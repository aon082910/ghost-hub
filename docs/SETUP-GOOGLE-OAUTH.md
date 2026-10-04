# Create your Google OAuth client (Gmail)

Ghost-Hub reads your Gmail using an OAuth client that **you** own. One-time setup, ~5 minutes.

> **Easiest:** do the steps below, then paste the values on the **Settings** page in Ghost-Hub. Nothing to edit, no restart. The
> `.env` lines in the steps are an alternative; a value saved in Settings wins over them.

1. Go to <https://console.cloud.google.com/> and create a project (e.g. "Ghost-Hub").
2. **APIs & Services → Library** → enable the **Gmail API**.
3. **APIs & Services → OAuth consent screen** (Google Auth Platform):
   - User type: **External**.
   - Add your own Gmail address as a **test user**.
   - Add the scope `https://www.googleapis.com/auth/gmail.readonly`.
4. **Credentials → Create credentials → OAuth client ID**:
   - Type: **Web application**.
   - Authorized redirect URI: `<APP_URL>/api/auth/google/callback`
     (see [Redirect URIs need HTTPS](#redirect-uris-need-https) below).
5. Copy the client ID and secret into the Settings page (Gmail section), or into `.env` as `GOOGLE_CLIENT_ID` and
   `GOOGLE_CLIENT_SECRET`.

## Redirect URIs need HTTPS

Google only accepts `http://` redirect URIs for `localhost`, and rejects bare IP addresses such as
`http://192.168.1.10:3000`. For a server on your network, either:

- put Ghost-Hub behind an HTTPS reverse proxy (Nginx Proxy Manager, Caddy, Traefik, Cloudflare Tunnel, Tailscale)
  on a real domain and set `APP_URL=https://hub.example.com`, or
- reach Ghost-Hub through `http://localhost:3000` (for example with an SSH port forward:
  `ssh -L 3000:localhost:3000 your-server`) and set `APP_URL=http://localhost:3000`.

`APP_URL` must be exactly the address you use in the browser, and the redirect URI you register must match it.

## More than one Gmail account

Click **Add another Gmail account** and choose a different account on Google's sign-in screen. While the consent screen is in
Testing status, add each extra Gmail address as a test user first. Choosing an account that is already connected just
refreshes its login.

## "HTTP 403" when scanning

Almost always the Gmail API isn't switched on for your project (step 2). Ghost-Hub shows Google's own reason and a link to switch
it on. The other cause is the Gmail permission being unticked on Google's consent screen: disconnect, connect again and tick it.

## Refresh tokens expiring after 7 days

While the consent screen is in **Testing** status, Google expires refresh tokens after 7 days. For a personal
app, go to **OAuth consent screen → Publish app** (status "In production"). It stays unverified — you'll see a
"Google hasn't verified this app" warning once during connect, which is expected for your own client.

## Connecting

If you used `.env`, restart Ghost-Hub first. Then click **Connect Gmail** on the Mailboxes page.
Ghost-Hub asks for one scope only, `gmail.readonly`, and uses it to read your mailbox address and (in the next
milestone) message headers. If Google's consent screen shows the Gmail permission as an unticked box, tick it —
Ghost-Hub can't work without it.

**Disconnect** removes the connection and revokes Ghost-Hub's access at Google. **Disconnect and delete data**
also deletes everything Ghost-Hub discovered from that mailbox. You can always revoke access yourself at
<https://myaccount.google.com/permissions>.

If the home page shows "Google rejected the token. Reconnect.", the refresh token expired (see above) or you
revoked access; click **Connect Gmail** again.
