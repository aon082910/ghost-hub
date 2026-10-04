## What changed and why

## Checklist

- [ ] Tests added or updated, and `npm run typecheck`, `npm run lint` and `npm test` pass
- [ ] If it touches the database: a migration was generated with `npm run db:generate` (and no released migration was edited)
- [ ] If it adds a network request: the README's "What leaves your server" table is updated and the request is user-initiated
- [ ] If it handles text from emails, the network or a dataset: it's validated and only linked when it's a plain `https` URL
- [ ] It doesn't read message bodies or store subjects (or the change is discussed in an issue first)
