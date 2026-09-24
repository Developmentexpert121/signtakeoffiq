---
name: DigitalOcean managed Postgres SSL connection
description: Why DATABASE_URL with sslmode=require fails on DO and how the db package handles it.
---

# DO managed Postgres TLS

`pg-connection-string@2.12+` treats a bare `sslmode=require` (also `prefer`/`allow`) as an
alias for `verify-full` — it sets `ssl = {}` (full CA + hostname verification). DigitalOcean
managed Postgres presents a chain whose CA is not in Node's default trust store, so the
connection fails at runtime with "unable to verify the first certificate" even though the
host/credentials are correct.

**Rule:** in `lib/db/src/index.ts`, `buildPoolConfig()` parses `DATABASE_URL`; for the relaxed
modes (`require`/`prefer`/`allow`) it deletes `sslmode` from the URL and passes
`ssl: { rejectUnauthorized: false }` explicitly. Strict modes (`verify-ca`/`verify-full`) and
`disable` are passed through untouched.

**Why the URL must be rewritten, not just augmented:** pg's `ConnectionParameters` does
`Object.assign({}, config, parse(connectionString))`, so the parsed `ssl` from the connection
string OVERWRITES any explicit `ssl` option. The explicit `ssl` is only honored once the URL no
longer carries an `sslmode`.

**Why rejectUnauthorized:false is acceptable:** it matches libpq's historical `require`
semantics (encrypt, don't verify CA). Operators who want strict verification set
`verify-ca`/`verify-full`, which are deliberately left intact.

**How to apply:** local dev DB uses `sslmode=disable` (host `helium`) → untouched path → no TLS,
so dev is unaffected. Verify changes by constructing `new pg.Client(buildPoolConfig(url))` and
inspecting `client.connectionParameters.ssl` (no network needed). `lib/db` has no vitest setup.
