---
name: DATABASE_URL vs DO_DATABASE_URL selection
description: Why the db package picks the connection string by NODE_ENV, and the prod/dev footgun behind it.
---

# Choosing the DB connection string

This project's runtime environments can have BOTH `DATABASE_URL` and
`DO_DATABASE_URL` set at once:

- **Local Replit dev:** `DATABASE_URL` = the local dev DB (host `helium`), and
  `DO_DATABASE_URL` = the *production* DigitalOcean managed DB (kept as a secret for
  reference/migration).
- **DigitalOcean App Platform (prod):** `DO_DATABASE_URL` = the correct managed-DB
  string, while `DATABASE_URL` is an auto-injected placeholder whose host is `base`
  and fails with `getaddrinfo ENOTFOUND base`.

**Rule:** `resolveDatabaseUrl()` in `lib/db/src/index.ts` selects by `NODE_ENV`:
production prefers `DO_DATABASE_URL` (then `DATABASE_URL`); everything else prefers
`DATABASE_URL` (then `DO_DATABASE_URL`). Each branch falls back to the other so a
single-var setup still works.

**Why not just prefer DO_DATABASE_URL everywhere:** doing so points the local dev
server AND the vitest suite at PRODUCTION (the test suite then fails against a prod
DB missing newly-added columns, and dev would mutate prod). The two vars are not
"primary + fallback" — which one is correct depends on the environment.

**Why NODE_ENV must be forced in prod:** the root `Procfile` sets
`NODE_ENV=production` inline because DigitalOcean does not reliably set it; without
it the production branch (and prod-only secure cookies / `GUEST_JWT_SECRET` /
`SESSION_SECRET` enforcement) would not engage. vitest sets `NODE_ENV=test`, so the
production-only startup checks in `validateStartupConfig` stay dormant under test.

**How to apply:** if a deploy still hits host `base`, the real connection string
belongs in `DO_DATABASE_URL` and the launch path must set `NODE_ENV=production`
(verify the DO component actually runs the Procfile web command).
