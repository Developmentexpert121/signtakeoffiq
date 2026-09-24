/**
 * API server entry point.
 *
 * Import order is deliberate:
 *   1. Only `logger` and the pure parser functions from `config-parsers.ts`
 *      are statically imported — none of these evaluate module-level config
 *      constants, so this file is safe to import in any env.
 *   2. `validateStartupConfig()` checks all operator env vars before anything
 *      else runs.  On failure it logs a full error list and calls
 *      `process.exit(1)`.
 *   3. `app` and `guestCleanup` are dynamically imported inside the `else`
 *      branch — they are never evaluated when config is invalid, even in tests
 *      where process.exit is mocked as a no-op.
 *   4. Runtime config values (rasterizeDpi, maxAiVisionCallsPerRun) are read
 *      directly from the pure parsers rather than from config.ts so that
 *      config.ts's module-level constants (which throw on bad values) are
 *      never imported here.
 */

import { logger } from "./lib/logger";
import {
  validateStartupConfig,
  parsePort,
  parseRasterizeDpi,
  parseAiVisionCallsPerRun,
  type Env,
} from "./lib/config-parsers";

const port = parsePort(process.env as Env);

// ---------------------------------------------------------------------------
// Startup configuration validation
// Collects every bad operator env var in one pass so operators see the full
// list in a single log message.  process.exit(1) terminates the process on
// any failure; all subsequent code is inside the `else` branch so it is
// never reached even when process.exit is mocked in tests.
// ---------------------------------------------------------------------------
const _configErrors = validateStartupConfig();

if (_configErrors.length > 0) {
  logger.error(
    { configErrors: _configErrors },
    `Server startup aborted: ${_configErrors.length} invalid configuration value(s) detected`,
  );
  for (const msg of _configErrors) {
    logger.error(msg);
  }
  process.exit(1);
} else {
  // -------------------------------------------------------------------------
  // Deferred imports — only evaluated after all config values are confirmed
  // valid.  Reads rasterizeDpi and maxAiVisionCallsPerRun from the pure
  // parsers (config-parsers.ts) rather than config.ts so that config.ts's
  // module-level throwing constants are never imported in this file.
  // -------------------------------------------------------------------------
  const { default: app } = await import("./app.js");
  const { startGuestCleanupJob } = await import("./lib/guestCleanup.js");

  const rasterizeDpi = parseRasterizeDpi(process.env as Env);
  const maxAiVisionCallsPerRun = parseAiVisionCallsPerRun(process.env as Env) ?? 10;

  app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    logger.info({ port }, "Server listening");
    logger.info({ rasterizeDpi }, "AI scan rasterization DPI");
    logger.info({ maxAiVisionCallsPerRun }, "AI vision call cap per run");

    startGuestCleanupJob();
  });
}
