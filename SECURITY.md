# Security

## Reporting a vulnerability

Please report security problems privately, not in a public issue.

- Use GitHub's **Security → Report a vulnerability** on this repository.
- If that option isn't available, open an issue titled "Security contact request" **without any details**, and a private
  channel will be arranged.

Include what you found, how to reproduce it, and what you think the impact is. Ghost-Hub is maintained by one person in
their spare time, so expect an acknowledgement within a week or so rather than hours. Fixes for confirmed issues are
released as soon as they're ready, and reporters are credited unless they prefer not to be.

Only the latest release on `main` is supported.

## What Ghost-Hub protects, and what it assumes

Ghost-Hub holds the keys to your mailboxes, so it's built to hold as little as possible and to be hard to turn against you.

**Assumptions.** One person runs it for themselves, on a machine or network they control, and reaches it over HTTPS
(through a reverse proxy) or `localhost`. It isn't designed for multiple users or to face the open internet without a proxy.

**What it stores.** Encrypted OAuth refresh tokens and IMAP app passwords (AES-256-GCM, keys derived from
`ENCRYPTION_KEY`), plus derived facts: service domains, counts, dates, categories, unsubscribe links, and opaque message
ids. It never stores message bodies, attachments or subjects. Mailbox access is read-only.

**Controls.**

- Single admin login, with a signed session cookie (`HttpOnly`, `SameSite=Lax`, `Secure` when `APP_URL` is https), a
  per-client and a global login rate limit. A gate in front of the app requires a valid session for everything except
  the login page and the health check, and pages and server actions check it again.
- OAuth uses the authorization-code flow with PKCE and a `state` check, bound to the provider. Scopes are read-only.
- Anything that comes out of an email or a third-party dataset is treated as hostile: unsubscribe links are only
  requested over HTTPS to public hostnames, with the address checked when the connection is made (so DNS rebinding
  can't point it at your network), no redirects followed and no response body read; links shown on screen must be plain
  `https`; HTML is stripped from dataset text.
- Anything that sends a request on your behalf is review-first and claimed exactly once.
- Security headers on every response (`X-Frame-Options: DENY`, a restrictive `Content-Security-Policy` for framing,
  forms, base URL and plugins, `Referrer-Policy: no-referrer`, `nosniff`), and pages are marked `noindex`.
- The login refuses common placeholder passwords, and the home page warns about plain-`http` setups.
- Dependencies are kept minimal and `npm audit --omit=dev` is clean at release.

## Known limits

- The login rate limiter is in memory and keys on `X-Forwarded-For` (with a global cap as a backstop), so it resets on
  restart and trusts your proxy to set that header honestly. Don't expose Ghost-Hub directly to the internet.
- Security headers don't include a script-source policy (that would need per-request nonces), and HSTS is left to your
  reverse proxy, which terminates HTTPS.
- Anyone with your `ENCRYPTION_KEY` and a copy of the database can read the stored tokens and passwords. Protect both,
  and keep them apart in backups.
- A compromised mailbox provider account or app password is outside what Ghost-Hub can defend. Use app passwords you
  can revoke, and revoke them when you disconnect.
- It has been tested against fake provider servers, not yet against real accounts at scale. Treat 0.x as pre-release.
