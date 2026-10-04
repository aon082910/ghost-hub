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
5. **Newsletters** *(done)* — `/newsletters` lists senders found by scans, a review page shows exactly where each
   request goes, and approving sends RFC 8058 one-click POSTs. Everything else is done by hand with a link or
   address. Verified end to end over real TLS against a fake sender. See "How unsubscribing works".
6. **Profiles** *(done)* — `/profiles`: public-profile lookups for the user's own usernames and Gravatar lookups for
   connected addresses. Scoped down on purpose, see "How profile checks work". Verified end to end over real TLS
   against a fake set of sites, and the bundled list against the real internet (30 of 31 candidate sites passed; the
   one that blocks automated requests was dropped).
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

## How unsubscribing works

Unsubscribe links come out of emails, and anyone can send you an email, so every request is treated as hostile input.

- **Only RFC 8058 one-click is automatic**: an `https` link in `List-Unsubscribe` plus `List-Unsubscribe-Post:
  List-Unsubscribe=One-Click`. A plain link may need a confirmation page and a GET must never change state, so
  those are shown for you to open. `mailto:` needs mail sent, which a read-only connection can't do, so your own mail
  app does it. Plain `http` links are never offered.
- **Review first**: select senders, then a review page lists each exact destination. Approving submits the ids you
  were shown (not "everything pending"), each action is claimed with one conditional UPDATE so a double click or two
  tabs can't send twice, and the request is rebuilt from the sender's stored header and re-validated at that moment.
- **What a request is**: one POST, fixed body, fixed headers (no cookies, no auth), a 15 s timeout, redirects not
  followed, response body never read. Only the status code matters: 2xx is success, 3xx and the rest are recorded as
  failures with a plain reason.
- **Network guard** (`src/lib/newsletters/ssrf.ts`): the URL must be `https` with no credentials, the default port, a
  real multi-label hostname (no IP literals in any spelling, no `.local`, `.internal`...). The name is resolved
  at connect time and refused if any address is private, loopback, link-local (including cloud metadata), multicast,
  IPv4-mapped IPv6, NAT64, 6to4 or otherwise reserved, so DNS rebinding can't swap in an internal address.
  Links that fail these checks are withheld in the list: not requested, not offered to open.
- **After**: the sender is marked unsubscribed with a timestamp. If mail keeps arriving more than 3 days later (seen
  on the next scan) it is flagged "still sending". Failures can be retried.
- **Development only**: `GHOSTHUB_ALLOW_PRIVATE_TARGETS=1` lets a local fake sender be used. It is ignored in
  production builds.

## How profile checks work

- **What it is**: for each username the user added, GET the public profile page on each site in `sites.json` and decide
  from the status code (and sometimes a marker in the body) whether the profile exists. For each connected address,
  ask Gravatar's public API by SHA-256 hash (no key, 100 requests an hour), which returns a profile and the accounts
  its owner linked. Results are stored in `shadow_profiles`; usernames in `profile_identifiers`.
- **What it deliberately isn't**: no probing of sign-up or reset forms (fragile, against many sites' terms, can send
  the user email), no phone lookups (no safe public source), no logins, and no looking up people who aren't the user.
- **Only the user's own identifiers**: addresses must belong to a connected mailbox (ownership proven by OAuth or IMAP
  login); usernames need an explicit confirmation, are capped at 10, and an identifier checked in the last 10 minutes
  is skipped. One job runs at a time, 4 requests at once, one request per site per username.
- **A site is only listed if it can be told apart honestly**: it must answer differently for a name that exists and one
  that doesn't, without a login, JavaScript or beating bot protection. Sites that block automated requests (Reddit,
  Medium, npm, Letterboxd, Last.fm...) or answer the same either way (Telegram, Ko-fi, PyPI) are left out. A 403, 429 or
  an unexpected body is "can't tell" and is shown with its reason, never guessed.
- **A flaky site can't erase a real answer**: a failed check never overwrites an earlier found or not-found result.
- **Network rules** (same guard as unsubscribe): https only, public hostnames, address checked at connect time, 10 s
  timeout, at most 64 KB of each page read, only same-host redirects followed (re-validated each hop), an honest
  User-Agent, no cookies. Links shown on screen must be plain https.
- **Keeping the list honest**: every site carries a well-known `known` account; `sites.live.test.ts` (opt in with
  `LIVE_SITES=1`) checks that it's found and an invented name isn't. A unit test makes sure each `known` name and the
  invented one satisfy that site's own username rules.
- **Development only**: `GHOSTHUB_PROFILE_SITES_FILE` (a different site list) and `GRAVATAR_API_URL` let a local fake be
  used. They're ignored in production builds, like `GHOSTHUB_ALLOW_PRIVATE_TARGETS`.

## Gotchas

- A `<button formAction={fn}>` inside a form doesn't submit its own `name`/`value`. Row-level buttons bind their id
  instead (`fn.bind(null, id)`); a form-level `action` does include the clicked button's value.

## Known gaps / backlog

- No scan depth limit (e.g. "last 3 years"); a very large mailbox is scanned in full.
- Scans run inside the web server process; they don't survive a restart (they resume on the next scan).
- IMAP has never been run against a real server, only a fake client.
- Services are listed per domain; related domains (amazon.com / amazon.co.uk) aren't merged.
- Breaches are matched by domain only, so a service that changed domains, or HIBP entries without a domain, are missed.
- The per-address HIBP check only covers connected mailboxes, not other addresses or phone numbers.
- Senders that offer only a web link or `mailto:` are never automated, by design.
- Profile checks cover ~30 sites. Big social networks (X, Instagram, Facebook, TikTok, LinkedIn, Reddit) aren't included
  because they block automated requests or show a page that doesn't reveal whether a profile exists.
- Usernames are stored lowercase, so sites that treat case as significant may give a different answer for the original.
- A "found" profile only means a page exists under that name; it may belong to someone else, and the page says so.
- Unsubscribing isn't verified beyond the HTTP status and whether mail keeps arriving; the sender's page isn't read.
- The real HTTPS transport has only been run against a local fake with a self-signed certificate, not a real sender.

## Open questions

- Job runner: in-process vs `pg-boss`.
- Deletion guides: bundle a curated dataset (e.g. JustDeleteMe) or write our own.
