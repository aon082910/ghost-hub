# Ghost-Hub

A self-hosted digital-footprint cleaner.
Connect your inbox, discover every account you've ever signed up for, see what's breached, and clean up —
on your own hardware, with your own OAuth credentials. Your email never goes to a third-party service.

> **Status:** early development. See [docs/PLAN.md](docs/PLAN.md) for the roadmap.

## What it does

1. **Connect** — Gmail (Google OAuth), Outlook / Microsoft 365 (Microsoft OAuth) and Yahoo, AOL, iCloud or any
   IMAP mailbox (app password). All read-only, any number of mailboxes.
2. **Scan** — finds services from sign-up, welcome, verification and receipt emails; optionally searches the
   web for "shadow profiles" under your email, phone or username. Everything is checked against breach data.
3. **Dashboard** — accounts grouped by service, risk-scored, with breach flags and newsletter detection.
4. **Act** — deletion guides, review-first bulk newsletter unsubscribe. Nothing happens without your approval.

## Privacy model

- Self-hosted: runs on your machine or Unraid server. No hosted backend, no telemetry.
- Scans read message **headers only** (sender, subject, date and the list-unsubscribe headers), never message
  bodies or attachments. Subjects are used in memory to classify a message and are never stored. Only derived
  facts are kept: service domain, first/last seen, message count, category, unsubscribe link, and an opaque
  id per scanned message so a rescan can skip it.
- OAuth refresh tokens and IMAP app passwords are encrypted at rest (AES-256-GCM).
- You can disconnect and wipe all data from the UI at any time.

## Quick start (Docker)

```bash
cp .env.example .env      # then fill in the values
docker compose up -d
```

Open <http://localhost:3000>, then connect the mailboxes you use. Each provider is optional:

| Provider | Setup | Guide |
|----------|-------|-------|
| Gmail | Your own Google OAuth client (~5 min, once) | [docs/SETUP-GOOGLE-OAUTH.md](docs/SETUP-GOOGLE-OAUTH.md) |
| Outlook / Microsoft 365 | Your own Entra app registration (~5 min, once) | [docs/SETUP-MICROSOFT-OAUTH.md](docs/SETUP-MICROSOFT-OAUTH.md) |
| Yahoo, AOL, iCloud, other IMAP | An app password, entered in the UI | [docs/SETUP-YAHOO-IMAP.md](docs/SETUP-YAHOO-IMAP.md) |

Google and Microsoft only accept `http://` redirect URIs on `localhost`, so a server on your network needs an
HTTPS address (reverse proxy) or access through `localhost`. The guides explain both.

## Development

```bash
npm install
cp .env.example .env      # set ADMIN_PASSWORD (8+ chars) and ENCRYPTION_KEY
docker compose up -d db   # Postgres only
npm run dev
```

Database migrations run automatically on startup. After changing `src/db/schema.ts`, run
`npm run db:generate` and commit the new file in `drizzle/`. Other scripts: `npm test`,
`npm run typecheck`, `npm run lint`. To also run the database integration tests, create an empty Postgres
database and set `TEST_DATABASE_URL` to it before `npm test` (they're skipped otherwise).

## Stack

Next.js (App Router) · TypeScript · Tailwind CSS · PostgreSQL (Drizzle ORM) · Docker

## Disclaimer

Ghost-Hub is for managing **your own** accounts and identifiers. Do not use the shadow-profile scanner on
other people.

## License

MIT
