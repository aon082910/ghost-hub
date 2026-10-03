# Ghost-Hub — Plan

Self-hosted, open-source digital-footprint cleaner. Single-user per deployment, run via Docker (target: Unraid),
published on GitHub so others can host their own.

## How it works

| Step | What Ghost-Hub does |
|------|---------------------|
| 1. Connect | Gmail and Outlook / Microsoft 365 via the user's own OAuth apps; Yahoo, AOL, iCloud and other IMAP mailboxes via app password |
| 2. Scan | Gmail scanner that finds the services you've signed up for, a username/email/phone profile checker, and breach matching |
| 3. Dashboard | Accounts, linked profiles, breach risk, gift cards, subscriptions and newsletters, risk-scored |
| 4. Act | Deletion guides, bulk unsubscribe, value recovery. Every action needs explicit approval |

## Key decisions

- **Stack:** Next.js (App Router) + TypeScript + Tailwind + PostgreSQL. ORM: Drizzle (decided).
- **Yahoo:** Yahoo's mail OAuth requires a signed commercial agreement, so Yahoo (and AOL, iCloud, any IMAP host) connect over IMAP with an app password on implicit TLS (993) only. Providers that have disabled password IMAP (Gmail, Outlook.com) use their OAuth connectors.
- **Microsoft:** Graph with `Mail.Read` + `User.Read` + `offline_access`, tenant `common` by default. Refresh tokens rotate on every use and are stored again. Redirect URIs must be HTTPS except localhost (same for Google), so LAN installs need a reverse proxy or a localhost tunnel.
- **Self-host OAuth:** each user creates their own Google OAuth client, so there is no shared secret and no
  Google verification process. Scope: `gmail.readonly` only. Caveat: apps left in "Testing" status get refresh
  tokens that expire after 7 days — document switching the consent screen to "In production" (unverified is fine
  for a personal app) in `docs/SETUP-GOOGLE-OAUTH.md`.
- **Privacy:** raw email is processed in memory only. Persist derived facts, never bodies. Tokens encrypted with
  AES-256-GCM (`ENCRYPTION_KEY`).
- **Auth:** single admin password from env, stateless HMAC-signed session cookie (7 days), login limited to 5 tries / 15 min per IP, enforced in `src/proxy.ts` and re-checked in pages via `requireSession()`. Intended for LAN / reverse proxy use.
- **Breach data:** HIBP free public breach list (matched by service domain) by default; optional `HIBP_API_KEY`
  for per-email lookups.
- **Shadow scanner:** data-driven site list (JSON: URL template + detection rule). Only for the user's own
  identifiers. Possible later integration with Maigret/Sherlock as a sidecar container.

## Data model (draft)

- `accounts` — service domain, display name, first_seen, last_seen, message_count, category, breach flags, risk score
- `messages_seen` — Gmail message id only (dedupe/resumable scans), no content
- `newsletters` — sender, List-Unsubscribe URL/mailto, unsubscribe status
- `shadow_profiles` — site, identifier type, URL, found_at, status
- `breaches` — cached HIBP breach list
- `actions` — queued/approved/executed user actions (audit log)
- `mailbox_connections` — provider (google/microsoft/imap), mailbox, auth type, encrypted credential (refresh token or app password), IMAP host/port, needs_reauth

## Milestones

1. **Foundation** *(done)* — scaffold, Docker/Unraid files, docs, Drizzle + Postgres with auto-migrate on startup, zod env validation, admin login (signed session cookie, login rate limit), `/api/health`, Docker healthcheck.
2. **Mailbox connect** *(done)* — Gmail and Microsoft over a generic OAuth core (code flow + PKCE + state, encrypted refresh tokens, rotated-token storage, `needsReauth` on `invalid_grant`), plus IMAP + app password for Yahoo/AOL/iCloud/custom (login verified before saving). Disconnect revokes at Google; Microsoft and IMAP can't be revoked remotely so the UI says what to remove by hand. Optional data wipe. Tested end to end against fake Google/Microsoft servers; the IMAP success path is only covered by unit tests with a mocked client.
3. **Inbox scan** — a `MailSource` interface with three implementations (Gmail API, Microsoft Graph, IMAP): paged
   header-only fetch, sign-up/welcome/receipt heuristics, domain→service grouping, resumable scan with progress UI.
4. **Dashboard + risk** — accounts list, breach matching, risk score, filters.
5. **Newsletters** — `List-Unsubscribe` detection, review queue, bulk unsubscribe (one-click POST + mailto).
6. **Shadow scanner** — site list, username/email/phone checks, rate limiting, results view.
7. **Value recovery** — detect gift cards/coupons/rewards in receipts and promos.
8. **Polish** — deletion guides, Unraid Community Apps template, release docs.

## Open questions

- Job runner: in-process vs `pg-boss`.
- Deletion guides: bundle a curated dataset (e.g. JustDeleteMe) or write our own.
