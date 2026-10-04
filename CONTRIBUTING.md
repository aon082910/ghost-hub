# Contributing

Thanks for helping. Ghost-Hub is a small, privacy-focused project, so a few ground rules keep it that way.

## Ground rules

- **Privacy first.** Scans read headers only. Don't add anything that reads message bodies, stores subjects, or keeps
  more than the derived facts described in the README, without opening an issue to discuss it first.
- **Every outbound request is documented.** If your change makes a new kind of network request, add it to the "What
  leaves your server" table in the README, say what is sent, and make it user-initiated unless there's a strong reason.
- **Untrusted input stays untrusted.** Text from emails, from the bundled datasets and from the network is validated
  before use, shown as plain text, and only linked when it's a plain `https` URL. Requests to addresses taken from
  those sources go through the guard in `src/lib/newsletters/ssrf.ts`.
- **Nothing happens on your behalf without review.** Anything that sends a request for the user needs a preview step and
  an exactly-once approval, like newsletter unsubscribe.
- **Tests with the change.** New behavior needs tests, and bug fixes need a test that failed before the fix.

## Setup

You need Node 22+ and Docker (for PostgreSQL).

```bash
npm install
cp .env.example .env            # set ADMIN_PASSWORD (12+ chars) and ENCRYPTION_KEY (openssl rand -base64 32)
docker compose up -d db
npm run dev                     # http://localhost:3000
```

Migrations run on startup. After editing `src/db/schema.ts`, run `npm run db:generate` and commit the new files in
`drizzle/`. Don't edit a migration that's already been released.

## Tests

```bash
npm test             # unit tests (database tests are skipped)
npm run typecheck
npm run lint
npm run build
```

The database integration tests need an empty PostgreSQL database that they're free to wipe:

```bash
docker compose exec -T db psql -U ghosthub -d postgres -c "create database ghosthub_test"
TEST_DATABASE_URL=postgres://ghosthub:YOUR_PASSWORD@localhost:5432/ghosthub_test npm test
```

Test files run one at a time because they share that database.

### Live checks (optional)

The profile-site list is checked against the real sites on request, since sites change:

```bash
LIVE_SITES=1 npx vitest run src/lib/profiles/sites.live.test.ts
```

It makes about two polite requests per site. Don't run it in CI.

## Where to fix things

| You want to... | Edit |
|----------------|------|
| Add or fix a profile site | `src/lib/profiles/sites.json` (give it a `known` public account, then run the live check) |
| Refresh account-deletion guides | `npm run guides:update`, review the diff, commit |
| Improve what counts as an account, receipt or newsletter | `src/lib/scan/classify.ts` and its tests |
| Tune risk scoring | `src/lib/breaches/risk.ts` and its tests (and the explanation in `docs/PLAN.md`) |
| Add a mail provider | Implement `MailSource` in `src/lib/scan/` and a connection type in `src/lib/mailboxes.ts` |

## Testing the UI against fakes

There's no need for real accounts to develop: the provider endpoints, Have I Been Pwned and the profile sites can be
pointed at a local fake server with the development-only environment variables (`GOOGLE_AUTH_URL`, `GOOGLE_TOKEN_URL`,
`GOOGLE_GMAIL_URL`, `MICROSOFT_*_URL`, `HIBP_BASE_URL`, `GRAVATAR_API_URL`, `GHOSTHUB_PROFILE_SITES_FILE`,
`GHOSTHUB_ALLOW_PRIVATE_TARGETS`). They're ignored in production builds, so a deployed instance can't be redirected.

## Pull requests

Keep them focused, describe what changed and why, and mention anything that affects privacy or what leaves the server.
CI runs the type check, lint, tests (including the database ones) and a build.
