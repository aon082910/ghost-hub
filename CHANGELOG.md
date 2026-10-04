# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com), and the project
uses [Semantic Versioning](https://semver.org) (0.x means the interface may still change).

## [0.1.0] - Unreleased

First pre-release. Built and tested against fake provider servers; not yet run against real accounts.

### Added

- **Mailboxes**: Gmail and Outlook / Microsoft 365 over OAuth (authorization code with PKCE, read-only scopes), and
  Yahoo, AOL, iCloud or any IMAP server with an app password. Any number of mailboxes, encrypted credentials, disconnect
  with optional data wipe, and a "reconnect" prompt when a provider rejects a saved login.
- **Inbox scan**: header-only scan of Gmail, Microsoft Graph and IMAP, resumable and cancellable, with live progress.
  Finds services from sign-up, receipt, subscription and newsletter mail.
- **Dashboard**: every service with a 0-100 risk score and a plain explanation, breach matching against Have I Been
  Pwned's public list (optional per-address check with your own key), filters, and a "forgotten account" signal.
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
- No scan depth limit: a very large mailbox is scanned in full.
- Related domains (for example `amazon.com` and `amazon.co.uk`) are listed separately.
- Account-deletion guides and profile sites are community data and can go stale.
- Single user only.
