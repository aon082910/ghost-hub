# Ghost-Hub

[![CI](https://github.com/aon082910/ghost-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/aon082910/ghost-hub/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

A self-hosted digital-footprint cleaner. Connect your mailboxes, find the accounts tied to them, see which have been
breached, and clean up, on your own hardware with your own credentials. Your email never goes to a third-party service.

> **Status: pre-release (0.1).** Everything is built and tested, but against fake Gmail, Microsoft and IMAP servers:
> it hasn't yet been run against real accounts, so expect rough edges and please [report them](../../issues).
> See [CHANGELOG.md](CHANGELOG.md) and [docs/PLAN.md](docs/PLAN.md).

## What it does

1. **Connect** — Gmail (Google OAuth), Outlook / Microsoft 365 (Microsoft OAuth) and Yahoo, AOL, iCloud or any
   IMAP mailbox (app password). All read-only, any number of mailboxes.
2. **Scan** — finds the services you've signed up for from sign-up, welcome, verification and receipt emails (message
   headers only). A first scan of a huge mailbox can be limited to recent mail and widened later. Spam, Trash, Sent and
   Drafts are skipped unless you tick **Include spam, trash & sent**, which suits an old mailbox you're closing. It can also look
   for public profiles under your own usernames, and the accounts linked to your own email addresses (see
   [Profiles](#profiles)).
3. **Dashboard** — every service in one list, scored 0-100 for risk with a plain explanation of why. Scores combine how
   you use the service, how long since it last emailed you, and known breaches of it (Have I Been Pwned's public list).
4. **Act** — review-first bulk newsletter unsubscribe, and step-by-step guides for deleting the accounts you don't
   need (a direct link, how hard it is, and a ready-made email request where the company takes them). Ghost-Hub never
   deletes an account for you: you do it, record it, and after your next scan it tells you if they keep emailing.
   Nothing happens without your approval.

## Install

### Docker Compose (any machine)

```bash
git clone https://github.com/aon082910/ghost-hub.git
cd ghost-hub
cp .env.example .env      # then fill in the values (see Configuration)
docker compose up -d --build
```

Open <http://localhost:3000>. The database is created and migrated automatically.

### Unraid

Ghost-Hub ships an Unraid template (one container plus a PostgreSQL container). See
[docs/UNRAID.md](docs/UNRAID.md) for the step-by-step guide, including HTTPS, backups and troubleshooting.

### Connecting mailboxes

Each provider is optional:

| Provider | Setup | Guide |
|----------|-------|-------|
| Gmail | Your own Google OAuth client (~5 min, once) | [docs/SETUP-GOOGLE-OAUTH.md](docs/SETUP-GOOGLE-OAUTH.md) |
| Outlook / Microsoft 365 | Your own Entra app registration (~5 min, once) | [docs/SETUP-MICROSOFT-OAUTH.md](docs/SETUP-MICROSOFT-OAUTH.md) |
| Yahoo, AOL, iCloud, other IMAP | An app password, entered in the UI | [docs/SETUP-YAHOO-IMAP.md](docs/SETUP-YAHOO-IMAP.md) |

Google and Microsoft only accept `http://` redirect addresses on `localhost`, so a server on your network needs an
HTTPS address (a reverse proxy) or access through `localhost`. The guides explain both, and Ghost-Hub's home page warns
you if your setup would break sign-in.

## Configuration

Set these in `.env` (Docker Compose) or in the Unraid template.

| Variable | Required | Purpose |
|----------|----------|---------|
| `APP_URL` | yes | The address you open Ghost-Hub at, e.g. `https://hub.example.com`. Used for sign-in redirects and the session cookie. |
| `ADMIN_PASSWORD` | yes | The web login password: 12+ characters. Common placeholder values are refused. |
| `ENCRYPTION_KEY` | yes | 32 random bytes, base64: `openssl rand -base64 32`. Encrypts stored tokens and passwords. **Back it up**: losing it means reconnecting every mailbox. |
| `DATABASE_URL` | yes | PostgreSQL connection string. Compose sets it for you. |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | Compose only | Credentials for the bundled database container. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | for Gmail | Your Google OAuth client. |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT` | for Outlook | Your Entra app. Tenant defaults to `common` (personal and work accounts). |
| `HIBP_ENABLED` | no (`true`) | Set `false` to make no calls to Have I Been Pwned at all. |
| `HIBP_API_KEY` | no | Your own HIBP key, to check whether your connected addresses are in breaches. |

## Privacy model

- Self-hosted: runs on your machine or Unraid server. No hosted backend and no telemetry (Next.js's is switched off in
  the image).
- Scans read message **headers only** (sender, subject, date and the list-unsubscribe headers), never message
  bodies or attachments. Subjects are used in memory to classify a message and are never stored. Only derived
  facts are kept: service domain, first/last seen, message count, category, unsubscribe link, and an opaque
  id per scanned message so a rescan can skip it.
- OAuth refresh tokens and IMAP app passwords are encrypted at rest (AES-256-GCM).
- You can disconnect and wipe all of a mailbox's data from the UI at any time.
- Pages carry `noindex` and a `robots.txt` that disallows everything, plus anti-framing and other security headers.

### What leaves your server

Ghost-Hub talks only to the services you connect, plus (optionally) Have I Been Pwned and a few public sites:

| To | When | What is sent |
|----|------|--------------|
| Google, Microsoft, or your IMAP server | Connecting and scanning | Your login and requests for message headers |
| Have I Been Pwned, public breach list | Press **Refresh breach list**, or after a scan if the list is over a week old | Nothing about you: it's a plain download |
| Have I Been Pwned, address lookup | Press **Check** on the dashboard, and only if you set `HIBP_API_KEY` | That one email address and your key |
| A newsletter sender's unsubscribe address | Only after you review and approve it | One HTTPS POST (`List-Unsubscribe=One-Click`), no cookies or login |
| ~30 public profile sites (GitHub, Codeberg, Bluesky...) | Press **Check now** on the Profiles page | One GET of the public profile page for each username you added; no login, nothing else about you |
| Gravatar | Press **Check now** on the Profiles page | A SHA-256 hash of each connected address, never the address |

Nothing else: the deletion guides are bundled, and the links in them open in your own browser only when you click.
Set `HIBP_ENABLED=false` to turn off every Have I Been Pwned call.

## Deleting accounts

Open a service on the Dashboard to see how to delete it. The guides come from the community-maintained
[JustDeleteMe](https://github.com/jdm-contrib/jdm) dataset (MIT licensed, see [docs/THIRD-PARTY.md](docs/THIRD-PARTY.md)),
which is bundled with Ghost-Hub, so looking one up makes no network request. After you've deleted an account, press
**I've deleted it**; Ghost-Hub keeps a record, and if a later scan sees more email from that company it flags
**Still emailing**. Refresh the guides with `npm run guides:update`.

## Profiles

The Profiles page answers "what's out there under my name?" without logging in anywhere.

- **Usernames you add** are looked up by opening each site's public profile page, the same request a browser makes.
  Each username needs a tick to confirm it's yours, you can add up to 10, and one checked in the last 10 minutes is skipped.
- **Your connected email addresses** are looked up on Gravatar by hash, which also lists accounts their owner linked.
- It deliberately does **not** probe sign-up or password-reset forms to see whether an address has an account (fragile,
  against many sites' terms, and it can trigger emails), look up phone numbers (there's no safe public way), or
  look up anyone else. Your inbox scan already finds the accounts you actually signed up for.
- The site list is plain data in `src/lib/profiles/sites.json`. Sites change, so `LIVE_SITES=1 npx vitest run
  src/lib/profiles/sites.live.test.ts` checks each entry against the real site. Fixes and new sites are welcome.

## Documentation

- [docs/UNRAID.md](docs/UNRAID.md): installing on Unraid
- [docs/SETUP-GOOGLE-OAUTH.md](docs/SETUP-GOOGLE-OAUTH.md), [docs/SETUP-MICROSOFT-OAUTH.md](docs/SETUP-MICROSOFT-OAUTH.md),
  [docs/SETUP-YAHOO-IMAP.md](docs/SETUP-YAHOO-IMAP.md): connecting mailboxes
- [docs/PLAN.md](docs/PLAN.md): design decisions, how scanning, risk scoring, unsubscribing and profile checks work
- [SECURITY.md](SECURITY.md): threat model and reporting a vulnerability
- [CONTRIBUTING.md](CONTRIBUTING.md): development setup and tests
- [CHANGELOG.md](CHANGELOG.md)

## Development

```bash
npm install
cp .env.example .env      # set ADMIN_PASSWORD (12+ chars) and ENCRYPTION_KEY
docker compose up -d db   # Postgres only
npm run dev
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the tests and conventions. Stack: Next.js (App Router), TypeScript,
Tailwind CSS, PostgreSQL (Drizzle ORM), Docker.

## Disclaimer

Ghost-Hub is for managing **your own** accounts and identifiers. Do not use the profile finder on other people.
It's provided as is, without warranty. Breach and risk information is a guide to what to look at first, not a
security guarantee.

## Acknowledgements

[JustDeleteMe](https://github.com/jdm-contrib/jdm) (account-deletion guides), [Have I Been Pwned](https://haveibeenpwned.com)
(breach data) and [Gravatar](https://gravatar.com) (public profile lookup).

## License

[MIT](LICENSE)
