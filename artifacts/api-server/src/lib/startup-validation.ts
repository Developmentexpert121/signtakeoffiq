/**
 * Startup configuration guard for the API server.
 *
 * This module imports ONLY from `config-parsers` (no module-level evaluated
 * constants) and from `logger` so it is safe to import at the very top of
 * `index.ts`, before `app` or any other module that transitively imports
 * `config.ts` and its module-level constants.
 *
 * Exporting the guard as a plain function makes it straightforward to test
 * in isolation by supplying a custom env map and a mock exit function.
 */

import { validateStartupConfig, type Env } from "./config-parsers";
import { logger } from "./logger";

/**
 * Check all operator-configurable env vars before the HTTP server binds.
 *
 * If any value is invalid the function logs a structured summary of every bad
 * variable and invokes `exitFn(1)` (defaults to `process.exit`).  Accepting
 * `exitFn` as a parameter makes the function fully unit-testable without
 * spawning a subprocess.
 *
 * @param env     - Env map to validate (defaults to `process.env`).
 * @param exitFn  - Called with exit code 1 when validation fails (defaults to `process.exit`).
 */
export function checkStartupConfig(
  env: Env = process.env as Env,
  exitFn: (code: number) => never = process.exit,
): void {
  const errors = validateStartupConfig(env);
  if (errors.length === 0) return;

  logger.error(
    { configErrors: errors },
    `Server startup aborted: ${errors.length} invalid configuration value(s) detected`,
  );
  for (const msg of errors) {
    logger.error(msg);
  }
  exitFn(1);
}
