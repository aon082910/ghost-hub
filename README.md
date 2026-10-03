# Ghost-Hub

A self-hosted digital-footprint cleaner.
Connect your inbox, discover every account you've ever signed up for, see what's breached, and clean up —
on your own hardware, with your own OAuth credentials. Your email never goes to a third-party service.

> **Status:** early development. See [docs/PLAN.md](docs/PLAN.md) for the roadmap.

## What it does

1. **Connect** — Gmail via Google OAuth (read-only). Outlook is planned.
2. **Scan** — finds services from sign-up, welcome, verification and receipt emails; optionally searches the
   web for "shadow profiles" under your email, phone or username. Everything is checked against breach data.
3. **Dashboard** — accounts grouped by service, risk-scored, with breach flags and newsletter detection.
4. **Act** — deletion guides, review-first bulk newsletter unsubscribe. Nothing happens without your approval.

## Privacy model

- Self-hosted: runs on your machine or Unraid server. No hosted backend, no telemetry.
- Raw email content is processed in memory and never written to disk. Only derived facts are stored
  (service domain, first/last seen, message count, category, unsubscribe link).
- OAuth refresh tokens are encrypted at rest (AES-256-GCM).
- You can disconnect and wipe all data from the UI at any time.

## Quick start (Docker)

```bash
cp .env.example .env      # then fill in the values
docker compose up -d
```

Open <http://localhost:3000>. See [docs/SETUP-GOOGLE-OAUTH.md](docs/SETUP-GOOGLE-OAUTH.md) for creating your
Google OAuth client (required once; takes ~5 minutes).

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
