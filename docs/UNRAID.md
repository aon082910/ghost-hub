# Installing on Unraid

Ghost-Hub needs two containers: **Ghost-Hub** itself and **PostgreSQL**. Plan on about 15 minutes, plus a few more
if you also want Gmail or Outlook (they need an HTTPS address, see step 4).

> The Unraid template points at the image `allornothing/ghost-hub`. If that image isn't on Docker Hub yet, build it
> yourself on any machine with Docker and push it to your own registry, or run the Compose setup from the README
> instead. See [Building the image yourself](#building-the-image-yourself).

## 1. Install PostgreSQL

1. In **Apps**, search for a PostgreSQL container (any current version, 15 or newer) and install it.
2. Set `POSTGRES_USER` to `ghosthub`, `POSTGRES_DB` to `ghosthub`, and choose a long `POSTGRES_PASSWORD`.
3. Keep its data path on a share you back up, e.g. `/mnt/user/appdata/ghost-hub-db`.
4. Start it. Ghost-Hub creates its own tables on first start.

## 2. Generate your encryption key

Open the Unraid terminal and run:

```bash
openssl rand -base64 32
```

Copy the output somewhere safe (a password manager). It encrypts the tokens and passwords Ghost-Hub stores.
**If you lose it you must reconnect every mailbox**, and there's no way to recover the old values.

## 3. Install Ghost-Hub

1. In **Apps**, search for **Ghost-Hub** and install it. If it isn't listed yet, add the template by hand:

   ```bash
   wget -O /boot/config/plugins/dockerMan/templates-user/my-ghost-hub.xml \
     https://raw.githubusercontent.com/aon082910/AoN-Unraid-Apps/main/Ghost-Hub/ghost-hub.xml
   ```

   Then **Docker → Add Container** and pick it from the template list.
2. Fill in the variables:

   | Variable | Value |
   |----------|-------|
   | **App URL** | The address you'll open Ghost-Hub at, e.g. `https://hub.example.com`. Use `http://localhost:3000` only if you'll reach it through a tunnel. |
   | **Admin Password** | A passphrase of 12 or more characters. Common placeholders are refused. |
   | **Encryption Key** | The key from step 2. |
   | **Database URL** | `postgres://ghosthub:YOUR_DB_PASSWORD@UNRAID_IP:5432/ghosthub` |

3. Apply. The first start waits for the database, creates the tables, and then serves on port 3000.
   Open the **WebUI**, sign in with your admin password, and check the **Setup notes** card on the home page: it
   warns about the most common mistakes.

## 4. HTTPS (needed for Gmail and Outlook)

Google and Microsoft only accept `http://` sign-in redirects for `localhost`, and a login over plain `http` crosses your
network unencrypted. Put Ghost-Hub behind HTTPS, for example with Nginx Proxy Manager, SWAG, Traefik, a Cloudflare
Tunnel, or Tailscale, then:

- set **App URL** to the `https://` address you proxy to, and
- register `APP_URL/api/auth/google/callback` (and `/microsoft/callback`) as the redirect address in your OAuth apps.

Yahoo, AOL, iCloud and other IMAP mailboxes don't need this, but HTTPS is still the right way to reach the login page.
Make sure your proxy forwards the client address in `X-Forwarded-For`: the login rate limiter uses it.

Then follow [SETUP-GOOGLE-OAUTH.md](SETUP-GOOGLE-OAUTH.md), [SETUP-MICROSOFT-OAUTH.md](SETUP-MICROSOFT-OAUTH.md) or
[SETUP-YAHOO-IMAP.md](SETUP-YAHOO-IMAP.md) and add the client IDs in the template.

## Backups

Everything lives in the PostgreSQL data folder, plus your **Encryption Key**. Back up both. Without the key, restored
mailbox connections can't be decrypted (the data Ghost-Hub found is still there, but you'll reconnect the mailboxes).

## Updating

Update the Ghost-Hub container from the Docker tab. Database changes are applied automatically on start, and
upgrades are designed to keep your data. Back up the database first if you want a safety net.

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| Container restarts, log says `Invalid environment configuration` | A required variable is missing or invalid. The log lists each one. |
| Log keeps saying `waiting for database` | The Database URL is wrong, or PostgreSQL isn't running or reachable from the container. |
| "Too many attempts" at login | Five wrong passwords in 15 minutes. Wait, or restart the container to clear it. |
| Gmail or Outlook sign-in fails with a redirect error | The redirect address doesn't match `APP_URL` exactly, or `APP_URL` isn't `https` (see step 4). |
| A scan fails with "can't read this mailbox's saved login", or mailboxes ask to reconnect after a restore | The Encryption Key changed. Reconnect the mailboxes. |
| A scan says it was interrupted by a restart | Scan again: it continues where it stopped. |

## Building the image yourself

```bash
git clone https://github.com/aon082910/ghost-hub.git
cd ghost-hub
docker build --build-arg VERSION=0.1.0 -t allornothing/ghost-hub:latest .
```

The build needs internet access (it downloads fonts and npm packages). Push it to a registry you control and change
the template's **Repository** field to match.
