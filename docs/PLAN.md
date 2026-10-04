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
3. **Inbox scan** *(done)* — a `MailSource` interface with three implementations (Gmail API, Microsoft Graph, IMAP):
   paged header-only fetch, domain→service grouping, resumable scan with progress, cancel and a results list.
   Verified end to end against fake Gmail and Graph mailboxes; the IMAP source is covered by unit tests with a
   fake client only. See "How scanning works" below.
4. **Dashboard + risk** *(done)* — `/dashboard` with summary tiles, breach data panel, filters (type, risk, known
   breach) and an expandable "why this score" per service. See "How risk scoring works" below. Verified end to
   end against a fake HIBP; nothing has run against the real HIBP API from the app.
5. **Newsletters** — `List-Unsubscribe` detection, review queue, bulk unsubscribe (one-click POST + mailto).
6. **Shadow scanner** — site list, username/email/phone checks, rate limiting, results view.
7. **Value recovery** — detect gift cards/coupons/rewards in receipts and promos.
8. **Polish** — deletion guides, Unraid Community Apps template, release docs.

## How scanning works

- **Sources** read headers only, newest first. Gmail: list ids, skip seen ones, fetch `format=metadata` with 8
  parallel requests, excluding sent mail, drafts and chats (spam and trash are excluded by the API). Graph:
  `$select` of headers with stable (`ImmutableId`) message ids, skipping Junk, Deleted, Sent and Drafts folders,
  and refusing any pagination link that leaves Graph's host. IMAP: every folder except Junk/Trash/Sent/Drafts
  (by special-use flag, falling back to folder name for servers like Yahoo whose spam folder is "Bulk"). All
  sources retry 429/5xx with Retry-After and time out after 30 s per request.
- **Classification** (`src/lib/scan/classify.ts`) works from the sender's registrable domain plus the subject and
  list headers: account (sign-up, verification, security, sign-in), subscription (billing, renewals, trials),
  receipt (orders, invoices, shipping) or newsletter (bulk mail). Mail from free providers, from the user, or
  from the user's own domain is ignored, as is mail with no signal. A service's category is the strongest
  evidence seen. It's a heuristic and will have false positives and negatives; tune the regexes and add test
  cases when you find them.
- **Exactness:** each page of results and its "seen" ids are saved in one transaction, so a crash, cancel or
  restart can never double count or lose a message, and scanning again continues where it stopped. Scans left
  "running" by a restart are marked failed on startup. One scan runs per mailbox at a time.
- **Newsletters:** `List-Unsubscribe` links and the one-click flag are recorded during the scan so the
  unsubscribe milestone needs no rescan. They're untrusted data from emails: validate before ever using them.

## How risk scoring works

`src/lib/breaches/risk.ts` is a pure function, so every number on the dashboard traces back to a list of factors.

- **Baseline** by relationship: account 15, subscription 10, receipt 5, newsletter 0.
- **Breaches** that name the service's registrable domain, from HIBP's public list (fabricated, spam-list, malware,
  stealer-log, retired and domain-less entries are dropped). Each breach is worth its **severity**, set by the worst
  data class leaked: credentials (passwords, hints, security questions, auth tokens) 50, financial 30, identity
  (government IDs, DOB, address, phone...) 18, basic (email, username, IP...) 8. That is multiplied by:
  - **exposure**: confirmed (the user's address is in it, via their HIBP key) 1.0; likely (the breach is within 30
    days before, or any time after, the service first emailed the user) 0.8; before (it predates the account) 0.3;
    date unknown 0.6;
  - 0.5 if HIBP hasn't verified the breach, 0.5 if it was of a subdomain (`forums.example.com`) rather than the
    site itself, and 0.5 for newsletters (usually no login).
  The three worst breaches count, capped at 60 points together.
- **Forgotten account**: +15 for an account or subscription with no email in over 2 years.
- **Levels**: high 60+, medium 35+, low 15+, minimal below that. It's a rule of thumb for deciding what to look at
  first, not a security verdict. Without an HIBP key, "likely" is an estimate from dates.

## Known gaps / backlog

- No scan depth limit (e.g. "last 3 years"); a very large mailbox is scanned in full.
- Scans run inside the web server process; they don't survive a restart (they resume on the next scan).
- IMAP has never been run against a real server, only a fake client.
- Services are listed per domain; related domains (amazon.com / amazon.co.uk) aren't merged.
- Breaches are matched by domain only, so a service that changed domains, or HIBP entries without a domain, are missed.
- The per-address HIBP check only covers connected mailboxes, not other addresses or phone numbers.

## Open questions

- Job runner: in-process vs `pg-boss`.
- Deletion guides: bundle a curated dataset (e.g. JustDeleteMe) or write our own.
