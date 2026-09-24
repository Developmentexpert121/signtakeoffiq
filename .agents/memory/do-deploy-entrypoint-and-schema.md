---
name: DigitalOcean deploy entrypoint + prod schema sync
description: How this app boots on DigitalOcean App Platform and why prod DB schema must be synced by hand (additively).
---

# DO App Platform entrypoint

The DigitalOcean component's **run command is `./start-prod.sh`** (repo root) — NOT
the `Procfile`. If that script is missing the container exits 127, the TCP
readiness probe on `$PORT` fails, and App Platform auto-rolls-back the deploy.

`start-prod.sh` must:
- `export NODE_ENV=production` itself — DO does not set it, and without it the app
  picks the placeholder `DATABASE_URL` (host `base`) instead of `DO_DATABASE_URL`
  and prod-only security stays off. (See do-database-url-selection.md.)
- launch the Python pdf-sidecar fire-and-forget (NEVER wait on its health — a slow
  or failing sidecar must not delay Node or the TCP readiness probe on `$PORT`),
  then `exec node artifacts/api-server/dist/index.mjs` in the foreground.

**Deploy-time DB bootstrap.** `start-prod.sh` runs, on every boot (gated by
`SKIP_DB_BOOTSTRAP=1`, `|| WARN` non-fatal), ONLY the idempotent seeder
`node artifacts/api-server/dist/seed.mjs` — it does NOT push schema. The seeder is
the api-server esbuild entry (`src/seed.ts` → `dist/seed.mjs`): it calls
`runSeed()` from `@workspace/db` (default tenant + admin + building-type
profiles/lexicons + pricing + retention) then ensures a super-admin login.
**Why no push on boot:** `lib/db/drizzle.config.ts` reads raw `process.env.DATABASE_URL`
(NOT the NODE_ENV-aware resolver in index.ts), so on DO it connected to the
placeholder host `base` and `drizzle-kit push` failed every boot with
`getaddrinfo ENOTFOUND base`. "Fixing" the config to reach the real DB is worse,
not better: push would then DROP the prod DB's legacy columns (see next section) —
the prod DB is the long-lived `defaultdb`, never fresh. So push was removed from
the boot path entirely; schema is synced by hand (additive). Leaving drizzle.config
pointed at the broken `base` host is an accidental safety net against a careless
manual `drizzle-kit push` in a prod shell.

# Python pdf-sidecar deps on DO

DO builds the Python pdf-sidecar with the heroku/python buildpack, which runs
`uv sync --locked` against the **root `pyproject.toml` + `uv.lock`** — NOT
`artifacts/pdf-sidecar/requirements.txt` (uv never reads it). So the sidecar's
deps (pdfplumber, pdf2image, fastapi, uvicorn, pillow, httpx, python-multipart)
MUST be listed in the root `pyproject.toml [project.dependencies]` and locked via
`uv lock`, or the sidecar crash-loops with `ModuleNotFoundError`.
- `uv add` here fails at the install step (writes to the read-only Nix store) and
  then transactionally REVERTS pyproject/uv.lock. Instead edit `pyproject.toml`
  by hand and run `uv lock` (resolver-only; writes the lockfile, no site-packages
  install) — that's all DO needs.

`pdf2image` needs the **poppler** binary (`pdftoppm`) at runtime, which the
buildpack stack does NOT include. Provide it with a root **`Aptfile`** containing
`poppler-utils` — DO auto-detects the file and runs its apt buildpack, putting the
binaries on PATH. (Alternative, if Aptfile ever fails: swap pdf2image for the
pure-Python, permissively-licensed `pypdfium2` — no system dep. Avoid PyMuPDF: AGPL.)

The sidecar's `uvicorn.run(app, ...)` MUST pass `workers=1` explicitly. uvicorn
defaults `workers` to `$WEB_CONCURRENCY` (DO's buildpack sets this >1); with a
non-string `app` object and workers>1 it logs "You must pass the application as an
import string to enable 'reload' or 'workers'." and `sys.exit(1)` — so on DO the
sidecar crash-loops even after deps install. `workers=1` skips the WEB_CONCURRENCY
branch entirely. **Why single worker:** it's an internal same-container sidecar, no
need to scale processes.

# Production DB schema is synced by hand (additive only)

The prod database is a **DigitalOcean managed Postgres** (not Replit's managed PG,
so the Replit Publish migration flow does NOT apply). It drifts behind the code
whenever the dev schema changes, surfacing as `column/relation does not exist` once
the app finally connects.

**Rule:** sync prod additively — `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD
COLUMN IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`, wrapped in one transaction.

**Never** run `drizzle-kit push`/`push --force` against prod: prod carries legacy,
empty columns the current schema dropped (`users.external_id`/`company_id`,
`tenants.external_company_id`/`contact_email`/`contact_phone`) plus an extra legacy
table, and push would DROP them. Additive DDL leaves those untouched (Drizzle
ignores DB columns it doesn't define).

# Prod auth bootstrap gotchas (native session-cookie auth)

Legacy/seeded prod users exist in `users` but have NO row in `auth_credentials`,
so password sign-in returns 401 "no password set" (not 500). To let someone in,
upsert an `auth_credentials` row whose `password_hash` is an Argon2id hash from the
**same `argon2` npm package** the app uses (`argon2.verify` reads params from the
hash, so any standard argon2id PHC string verifies — exact opts don't matter for
verification). Connect with the DO DSN but strip `sslmode` from the URL and pass
`ssl:{rejectUnauthorized:false}` (pg v8.20 now treats `sslmode=require` as
`verify-full`, which rejects DO's self-signed chain).

Forgot-password can't rescue them: the SMTP transport requires `SMTP_HOST/PORT/USER/PASS`
and **`SMTP_USER` is not set**, so `getTransport()` throws and the email is silently
swallowed (route still returns ok to avoid enumeration). Fix `SMTP_USER` to enable
self-serve resets.

`SESSION_SECRET` (>=16 chars) is REQUIRED in prod — `signSession` throws without it,
but only when called (at sign-in's final step), so a missing value surfaces as a
login 500 *after* password verification, not at boot.

**How to diff code schema vs a remote DB:** bundle a small script with esbuild
(`--external:pg --external:drizzle-orm ...`) that imports `@workspace/db/schema`,
walks `getTableConfig()` for each table, and compares column names against the
target's `information_schema.columns`. Plain `node` can't run the schema directly —
its `.ts` files use extensionless relative imports the ESM resolver rejects.
