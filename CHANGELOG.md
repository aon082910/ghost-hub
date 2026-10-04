# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com), and the project
uses [Semantic Versioning](https://semver.org) (0.x means the interface may still change).

## [0.1.0] - Unreleased

First pre-release. Built and tested against fake provider servers; not yet run against real accounts.

### Added

- **Mailboxes**: Gmail and Outlook / Microsoft 365 over OAuth (authorization code with PKCE, read-only scopes), and
  Yahoo, AOL, iCloud or any IMAP server with an app password. Any number of mailboxes, encrypted credentials, disconnect
  with optional data wipe, and a "reconnect" prompt when a provider rejects a saved login.
- **Several accounts per provider**: connect as many Gmail, Outlook or IMAP accounts as you like. Google's account chooser is
  always shown (it used to silently reuse the signed-in account, so a second Gmail account couldn't be added), the page says
  when a connect only refreshed an account that was already there, one address can't be connected through two providers at
  once, and "Scan all" starts the same scan on every mailbox.
- **Inbox scan**: header-only scan of Gmail, Microsoft Graph and IMAP, resumable and cancellable, with live progress.
  Finds services from sign-up, receipt, subscription and newsletter mail. A first scan of a very large mailbox can be
  limited to the last 5 years, 2 years, year or 90 days; the dashboard says when it's working from a partial scan.
  Spam, Trash, Sent and Drafts are skipped by default; an option includes them (useful for an old mailbox you plan to
  close, where sign-ups may have been deleted or filed as spam). Services and newsletter senders whose every message
  was in a Spam/Junk folder are marked "spam only" and set aside (a toggle shows them), and Ghost-Hub won't queue an
  unsubscribe for them, since that confirms your address is live. "Start over" recounts a mailbox from scratch and
  keeps your decisions. The dashboard can export a to-do checklist (Markdown or CSV) of the services still on your
  list, riskiest first, with each company's site, known breaches and how to delete it.
- **Settings page**: Gmail and Outlook credentials (client ID, secret, tenant) and the Have I Been Pwned switch and key are
  entered in the app, with the steps and the exact redirect address to register shown beside each field. Secrets are
  stored encrypted and never shown again; a saved value wins over `.env`, which still works as the fallback.
- A refused Gmail or Graph request now says why (for example, the Gmail API isn't switched on, with Google's link)
  instead of "HTTP 403", Gmail requests are paced to 40 a second to stay under Google's per-minute quota, and when Google
  still says "quota exceeded" Ghost-Hub waits up to a minute between retries instead of failing the scan.
- **Dashboard**: every service with a 0-100 risk score and a plain explanation, breach matching against Have I Been
  Pwned's public list (optional per-address check with your own key), filters, and a "forgotten account" signal.
  A company that emails from several domains (amazon.com, amazon.co.uk...) is one row, merged only where the
  deletion-guide dataset says the domains belong together.
- **Newsletters**: review-first bulk unsubscribe using RFC 8058 one-click, hardened against hostile links, with
  manual help for senders that need a web page or an email, and a "still sending" flag.
- **Deleting accounts**: step-by-step guides for about 2,600 services (from JustDeleteMe), your own record of what you
  deleted, and a "still emailing" flag after a later scan.
- **Profiles**: public profile lookup for your own usernames on about 30 sites, and Gravatar lookup (by hash) for your
  connected addresses.
- **Self-hosting**: Docker image (non-root, health check, version labels, telemetry off) and Compose file, an Unraid
  template and install guide, automatic database migrations, and an admin login with rate limiting.
  - Fails fast with a clear message and exit code 1 when configuration is invalid (including a placeholder admin
    password) or the database stays unreachable, instead of running and answering every request with an error.
  - A "Setup notes" card warns about plain-`http` setups, sign-in that can't work over `http`, and short passwords.
  - Security headers on every response, `noindex` pages, and a `robots.txt` that disallows everything.
- **Project**: CI (type check, lint, tests with PostgreSQL, build, dependency audit, Docker build), issue and pull
  request templates, `SECURITY.md`, `CONTRIBUTING.md` and third-party attribution.

### Known limitations

- Not yet exercised against real Google, Microsoft or IMAP accounts. IMAP scanning is covered by tests with a fake client.
- Related domains (for example `amazon.com` and `amazon.co.uk`) are listed separately.
- Account-deletion guides and profile sites are community data and can go stale.
- Single user only.
