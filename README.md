# Ghost-Hub

A self-hosted digital-footprint cleaner.
Connect your inbox, discover every account you've ever signed up for, see what's breached, and clean up —
on your own hardware, with your own OAuth credentials. Your email never goes to a third-party service.

> **Status:** early development. See [docs/PLAN.md](docs/PLAN.md) for the roadmap.

## What it does

1. **Connect** — Gmail (Google OAuth), Outlook / Microsoft 365 (Microsoft OAuth) and Yahoo, AOL, iCloud or any
   IMAP mailbox (app password). All read-only, any number of mailboxes.
2. **Scan** — finds the services you've signed up for from sign-up, welcome, verification and receipt emails (message
   headers only). It can also look for public profiles under your own usernames, and the accounts linked to your own
   email addresses (see "Profiles" below).
3. **Dashboard** — every service in one list, scored 0-100 for risk with a plain explanation of why. Scores combine how
   you use the service, how long since it last emailed you, and known breaches of it (Have I Been Pwned's public list).
4. **Act** — review-first bulk newsletter unsubscribe (deletion guides are planned). Nothing happens without your
   approval.

## Privacy model

- Self-hosted: runs on your machine or Unraid server. No hosted backend, no telemetry.
- Scans read message **headers only** (sender, subject, date and the list-unsubscribe headers), never message
  bodies or attachments. Subjects are used in memory to classify a message and are never stored. Only derived
  facts are kept: service domain, first/last seen, message count, category, unsubscribe link, and an opaque
  id per scanned message so a rescan can skip it.
- OAuth refresh tokens and IMAP app passwords are encrypted at rest (AES-256-GCM).
- You can disconnect and wipe all data from the UI at any time.

## What leaves your server

Ghost-Hub talks only to the services you connect, plus (optionally) Have I Been Pwned:

| To | When | What is sent |
|----|------|--------------|
| Google, Microsoft, or your IMAP server | Connecting and scanning | Your login and requests for message headers |
| Have I Been Pwned, public breach list | Press **Refresh breach list**, or after a scan if the list is over a week old | Nothing about you: it's a plain download |
| Have I Been Pwned, address lookup | Press **Check** on the dashboard, and only if you set `HIBP_API_KEY` | That one email address and your key |
| A newsletter sender's unsubscribe address | Only after you review and approve it | One HTTPS POST (`List-Unsubscribe=One-Click`), no cookies or login |
| ~30 public profile sites (GitHub, Codeberg, Bluesky...) | Press **Check now** on the Profiles page | One GET of the public profile page for each username you added; no login, nothing else about you |
| Gravatar | Press **Check now** on the Profiles page | A SHA-256 hash of each connected address, never the address |

Set `HIBP_ENABLED=false` to turn off every Have I Been Pwned call. Breach checks then don't run and scores use
only how you use each service.

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

## Disclaimer

Ghost-Hub is for managing **your own** accounts and identifiers. Do not use the shadow-profile scanner on
other people.

## License

MIT
