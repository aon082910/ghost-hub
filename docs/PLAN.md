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
8. **Polish** — *deletion guides: done* (see "How deleting accounts works"); Unraid Community Apps template polish, release docs,
   and a decision on value recovery (milestone 7) remain.

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
- **Depth limit:** a scan can be limited to recent mail (5 years, 2 years, 1 year or 90 days). Each source filters on
  its own side (Gmail `after:<epoch seconds>`, Graph `$filter=receivedDateTime ge ...`, IMAP `SINCE`), the choice is
  stored on the scan row (`scans.since`), and only the mail actually read is marked seen, so a later wider or full scan
  fills in the rest without double counting. A limited scan makes a service's first-seen date later than reality, which
  can make a breach look like it predates the account and lower its score, so the dashboard shows a notice for any
  mailbox that has only limited or unfinished scans (`src/lib/scan/coverage.ts`). The progress total is "unknown" when
  the source can't count a window cheaply (Gmail).
- **Junk folders:** Spam/Junk/Bulk, Trash/Deleted, Sent and Drafts are skipped by default, because they hold spam
  senders rather than services you signed up for. The "Include spam, trash & sent" option (`scans.include_junk`) reads
  them too: IMAP lists every selectable folder, Gmail adds `includeSpamTrash=true` and drops `-in:sent -in:drafts`, Graph
  stops filtering by folder. Mail from your own address is never counted as a service, so Sent adds nothing by itself.
  Expect extra one-off senders from spam; they are mostly category "newsletter" with one message.
- **Spam-only:** each source marks mail that sat in the provider's spam folder (IMAP Junk/Spam/Bulk folders, Gmail's
  `SPAM` label, Graph's Junk Email folder; Trash is not spam). `accounts.spam_count` and `newsletters.spam_count` count
  those messages. A service or sender is *spam only* when every message was spam: one real message is enough to keep it
  visible, because a genuine company's mail sometimes lands in spam. Spam-only rows are hidden by default behind a toggle
  that shows how many are hidden, and `queueUnsubscribes` refuses them (unsubscribing from spam confirms the address).
- **Checklist export:** `GET /api/export/checklist?format=md|csv` (behind the login, never cached) lists services still
  active, not spam-only and not newsletters (`&newsletters=1` adds them), riskiest first. Names come from email headers,
  so Markdown output escapes every formatting, HTML and link character and CSV cells that start like a formula get a
  leading apostrophe (`src/lib/checklist.ts`). Nothing is fetched; links are the company's own domain and the bundled
  deletion guide.
- **Settings page:** provider credentials and the HIBP key live in a `settings` table (`src/lib/settings.ts`). Secrets are
  encrypted with the same AES-256-GCM key as mailbox tokens and the page never receives them: a secret box is always empty,
  and leaving it blank keeps what is saved. They are read into memory at start-up and after each save (on `globalThis`, so
  the rest of the code stays synchronous), and `src/lib/config.ts` picks a saved value over the environment, field by field.
  Unknown keys are ignored, every value is validated before any is written, and a secret saved under a different
  `ENCRYPTION_KEY` is reported as unreadable and treated as unset. `APP_URL`, `ADMIN_PASSWORD`, `ENCRYPTION_KEY` and
  `DATABASE_URL` stay in the environment because Ghost-Hub needs them to start.
- **Start over:** ticking "Start over" before a scan zeroes the mailbox's counts, forgets which messages were seen and
  clears its scan history, then rescans. Rows are kept, so decisions (deleted / kept / unsubscribed) survive, and a row
  with no messages is hidden until a scan finds it again. It's refused while a scan is running. Older data has no spam
  counts, and skipped-as-seen messages are never re-read, so this is how existing mailboxes pick them up.
- **Gmail quota:** Gmail allows about 15,000 quota units a minute per user and a message lookup costs 5, so `GmailSource` spaces
  requests to 40 a second (12,000 units a minute) across all concurrent workers. Gmail reports being throttled as a 403 (reason
  `rateLimitExceeded`, `userRateLimitExceeded` or `RATE_LIMIT_EXCEEDED`), not a 429, and a per-minute quota only clears when the
  minute rolls over, so a throttled request is retried up to six times with waits of 5, 10, 20, 40, 60 and 60 seconds (or
  `Retry-After` if longer, capped at 30). A scan of a big mailbox is therefore limited by Google, not by Ghost-Hub: about 2,400
  messages a minute.
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

## How deleting accounts works

- **Guides** come from the JustDeleteMe dataset (MIT, 2,664 services), slimmed to English text, the deletion page, a
  difficulty (easy / medium / hard / not offered / depends where you live), the domains it covers and, where the company
  takes requests by email, the address plus a request template. It's bundled in `src/lib/deletion/guides.json` and
  refreshed by `npm run guides:update` (fetches upstream, validates the shape, refuses to overwrite with a short list).
  Review the diff before committing: it's community data. Attribution lives in `docs/THIRD-PARTY.md`.
- **One row per company**: services whose domains appear in the same guide are merged on the dashboard
  (`src/lib/deletion/companies.ts`, `mergeCompanies` in `src/lib/dashboard.ts`), so `amazon.com` and `amazon.co.uk` are
  scored, shown and recorded once. The busiest domain leads, message counts add up, dates widen, the strongest category
  wins, and a breach naming any of the domains counts once. A merged row reads "deleted" or "kept" only when every
  domain agrees, and recording a decision applies to all its domains in one transaction (at most 50, all validated or
  none applied). Services with no guide are never merged, because joining by similar names would join unrelated sites.
- **Matching** is by registrable domain, indexed from every domain an entry lists. A guide that lists the exact domain
  comes first, and at most three are shown. Services with no guide get a generic hint and a search link.
- **Untrusted text**: dataset content is validated on load and only shown as plain text and links. A link is only offered
  if it's a plain `https` URL (17 entries are `http` and get no link, with an explanation); notes have HTML stripped and
  only `[text](https://...)` becomes a link; an email address must be a plain address, and the mail link is built with
  encoded subject and body for the user's own mail app. Ghost-Hub sends nothing.
- **Decisions**: `I've deleted it`, `Keep it` and `Put it back` set `accounts.status` for that domain in every mailbox and
  stamp `deleted_at`. Deleting and restoring each leave an audit row in `actions`; "keep" doesn't. A service shows as
  deleted or kept only when every mailbox agrees, so a mailbox added later that still has it brings it back. Scans never
  touch the status.
- **Verification**: a deleted service whose latest email is more than 3 days after `deleted_at` is flagged "Still
  emailing", the same signal as for newsletters. Ghost-Hub can't tell whether the account or only a mailing list remains.
- **Wipe**: wiping a mailbox removes audit rows for services no other mailbox still has.

## Gotchas

- A `<button formAction={fn}>` inside a form doesn't submit its own `name`/`value`. Row-level buttons bind their id
  instead (`fn.bind(null, id)`); a form-level `action` does include the clicked button's value.

## Operations

- **Start-up** (`src/instrumentation.ts` → `instrumentation-node.ts`): validate the environment, wait up to about a minute
  for the database, run migrations, then mark scans a restart interrupted as failed. Any failure logs `[ghost-hub] Cannot
  start: ...` and exits with code 1 in production (rethrows in development), so a misconfigured container is visibly
  broken rather than "running" and returning HTTP 500.
- **Health**: `GET /api/health` (public) checks the database; the image's `HEALTHCHECK` uses it.
- **Gate** (`src/proxy.ts`): everything needs a session except `/login`, `/api/health` and `/robots.txt` (crawlers must be
  able to read it while signed out), plus static files and images.
- **Headers** (`next.config.ts`): `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, a permissions policy,
  COOP, and a CSP limited to framing, forms, base URL and plugins (a script policy would need per-request nonces).
- **Setup notes** (`src/lib/setup-checks.ts`): warns about plain `http` off localhost, OAuth over `http`, and short passwords.
  The login also refuses placeholder passwords outright.
- **Image**: multi-stage, non-root, `NEXT_TELEMETRY_DISABLED=1`, OCI labels, about 310 MB (mostly the Node base image).

## Known gaps / backlog

- Scans run inside the web server process; they don't survive a restart (they resume on the next scan).
- IMAP has never been run against a real server, only a fake client.
- Services are listed per domain; related domains (amazon.com / amazon.co.uk) aren't merged.
- Breaches are matched by domain only, so a service that changed domains, or HIBP entries without a domain, are missed.
- The per-address HIBP check only covers connected mailboxes, not other addresses or phone numbers.
- Senders that offer only a web link or `mailto:` are never automated, by design.
- Deletion guides are only as current as the dataset; some links go stale. Nothing verifies that a guide still works.
- Ghost-Hub can't tell whether a deleted account is really gone, only whether the company keeps emailing.
- Profile checks cover ~30 sites. Big social networks (X, Instagram, Facebook, TikTok, LinkedIn, Reddit) aren't included
  because they block automated requests or show a page that doesn't reveal whether a profile exists.
- Usernames are stored lowercase, so sites that treat case as significant may give a different answer for the original.
- A "found" profile only means a page exists under that name; it may belong to someone else, and the page says so.
- Unsubscribing isn't verified beyond the HTTP status and whether mail keeps arriving; the sender's page isn't read.
- The real HTTPS transport has only been run against a local fake with a self-signed certificate, not a real sender.

## Open questions

- Job runner: in-process vs `pg-boss`.
- Deletion guides: bundle a curated dataset (e.g. JustDeleteMe) or write our own.
