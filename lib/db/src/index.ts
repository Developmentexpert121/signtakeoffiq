import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

/**
 * Resolve the database connection string from `DATABASE_URL` / `DO_DATABASE_URL`.
 *
 * The preference order is environment-dependent and deliberately so:
 *
 *  - In production (`NODE_ENV === "production"`, e.g. DigitalOcean App Platform)
 *    `DO_DATABASE_URL` wins. DO can auto-inject a placeholder `DATABASE_URL` whose
 *    host is `base`, which does not resolve (`getaddrinfo ENOTFOUND base`). The
 *    operator-set `DO_DATABASE_URL` holds the real managed-DB connection string.
 *  - Everywhere else (local dev / tests) `DATABASE_URL` wins. This environment can
 *    have BOTH vars set — `DATABASE_URL` points at the local dev DB while
 *    `DO_DATABASE_URL` points at production — so preferring `DO_DATABASE_URL`
 *    unconditionally would make dev and the test suite run against production.
 *
 * Each branch falls back to the other var so a single-var setup still works.
 */
function resolveDatabaseUrl(): string | undefined {
  const isProduction = process.env.NODE_ENV === "production";
  const candidates = isProduction
    ? [process.env.DO_DATABASE_URL, process.env.DATABASE_URL]
    : [process.env.DATABASE_URL, process.env.DO_DATABASE_URL];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }
  return undefined;
}

const databaseUrl = resolveDatabaseUrl();

if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL (or DO_DATABASE_URL) must be set. Did you forget to provision a database?",
  );
}

/**
 * Build the pg Pool config from DATABASE_URL.
 *
 * Managed Postgres providers (e.g. DigitalOcean) require TLS but present a
 * certificate chain that is not in Node's default trust store. As of
 * pg-connection-string@2.12, a bare `sslmode=require` in the connection string
 * is treated as `verify-full`, which performs full CA verification and fails
 * against such providers with "unable to verify the first certificate".
 *
 * To honor libpq's `require` semantics (encrypt, but do not verify the CA), we
 * strip `sslmode` from the URL for the relaxed modes (`require`/`prefer`/`allow`)
 * and configure `ssl` explicitly. Note: pg parses the connection string AFTER and
 * Object.assigns it over the passed config, so an explicit `ssl` option is only
 * respected when the connection string itself no longer carries an `sslmode`.
 *
 * Strict modes (`verify-ca`/`verify-full`) and `disable` are left untouched, so an
 * operator who explicitly opts into CA/hostname verification keeps it, and the
 * local dev database (`sslmode=disable`) behaves exactly as before.
 */
const RELAXED_SSL_MODES = new Set(["require", "prefer", "allow"]);

function buildPoolConfig(urlString: string): pg.PoolConfig {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    // Not a parseable URL — hand it to pg as-is.
    return { connectionString: urlString };
  }

  const sslmode = url.searchParams.get("sslmode");

  if (sslmode == null || !RELAXED_SSL_MODES.has(sslmode)) {
    // disable / verify-ca / verify-full / unset → preserve pg's default handling.
    return { connectionString: urlString };
  }

  url.searchParams.delete("sslmode");
  return {
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: false },
  };
}

export const pool = new Pool(buildPoolConfig(databaseUrl));
export const db = drizzle(pool, { schema });

export * from "./schema";
export { runSeed } from "./seed";
