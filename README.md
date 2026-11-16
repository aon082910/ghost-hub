# Ghost-Hub

A self-hosted digital-footprint cleaner. Connect your mailboxes and Ghost-Hub finds the accounts tied to them, shows which have been in breaches, and helps you clean up, all on your own hardware.

> **Pre-release (0.1).** It's built and tested against fake mail servers but not yet against real accounts, so expect rough edges and please report them.

What it does:

- **Finds your accounts.** Connects read-only to Gmail, Outlook and any IMAP mailbox (Yahoo, AOL, iCloud) and reads message headers only, never bodies.
- **Scores the risk.** Each service gets a 0-100 score with a plain explanation, using public breach data.
- **Helps you clean up.** Bulk newsletter unsubscribe and step-by-step account deletion guides. Nothing happens without your approval, and it never deletes an account for you.

Image: [allornothing/ghost-hub](https://hub.docker.com/r/allornothing/ghost-hub) · Source: [aon082910/ghost-hub](https://github.com/aon082910/ghost-hub)

## Install

**Docker Compose:**

```bash
git clone https://github.com/aon082910/ghost-hub.git
cd ghost-hub
cp .env.example .env    # fill in the four required values below
docker compose up -d --build
```

Open `http://localhost:3000`.

**Unraid:** use the template in [AoN-Unraid-Apps](https://github.com/aon082910/AoN-Unraid-Apps). It needs a separate PostgreSQL container. See `docs/UNRAID.md` for the walkthrough.

| Setting | What it's for |
|---|---|
| Port `3000` | Web UI |
| `APP_URL` | The address you open Ghost-Hub at |
| `ADMIN_PASSWORD` | Web login, 12+ characters |
| `ENCRYPTION_KEY` | From `openssl rand -base64 32`. **Back it up**, or you'll have to reconnect every mailbox |
| `DATABASE_URL` | PostgreSQL connection string (Compose sets this) |

Gmail and Outlook need your own OAuth app, about five minutes each. Guides are in `docs/`. Google and Microsoft only allow plain `http` on localhost, so a server on your network needs an HTTPS address. Yahoo and other IMAP mailboxes just need an app password.

## Help

[Open an issue](https://github.com/aon082910/ghost-hub/issues). Use it on your own accounts only. MIT licensed.
