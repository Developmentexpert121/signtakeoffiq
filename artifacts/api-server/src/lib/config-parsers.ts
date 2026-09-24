/**
 * Pure config parser functions for the API server.
 *
 * This module is intentionally free of any module-level side effects so it is
 * safe to import before the HTTP server is bound and before any other module
 * that may itself trigger config parsing (e.g. pipeline.ts).
 *
 * `config.ts` imports and re-exports everything here, adding the module-level
 * evaluated constants that pipeline.ts and other consumers use at runtime.
 */

export type Env = Record<string, string | undefined>;

/**
 * Parse the RASTERIZE_DPI environment variable from a given env object.
 * Returns 150 (the default) when the variable is absent or empty.
 * Throws a descriptive error for invalid values.
 */
export function parseRasterizeDpi(env: Env): number {
  const raw = env["RASTERIZE_DPI"];
  if (raw === undefined || raw === "") return 150;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid RASTERIZE_DPI value: "${raw}". Must be a positive number.`,
    );
  }
  return parsed;
}

/**
 * Parse the AI_VISION_CALLS_PER_RUN environment variable from a given env object.
 * Returns null when the variable is absent or empty (callers use their own default).
 * Throws a descriptive error for invalid values.
 */
export function parseAiVisionCallsPerRun(env: Env): number | null {
  const raw = env["AI_VISION_CALLS_PER_RUN"];
  if (raw === undefined || raw === "") return null;
  const parsed = parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== raw.trim()) {
    throw new Error(
      `Invalid AI_VISION_CALLS_PER_RUN value: "${raw}". Must be a positive integer (e.g. 10).`,
    );
  }
  return parsed;
}

/**
 * Shared parser for optional positive-integer tuning knobs.
 * Returns `fallback` when the variable is absent or empty; throws a descriptive
 * error for any non-positive-integer value.
 */
function parsePositiveInt(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== raw.trim()) {
    throw new Error(
      `Invalid ${name} value: "${raw}". Must be a positive integer (e.g. ${fallback}).`,
    );
  }
  return parsed;
}

/**
 * Maximum number of pipeline runs allowed to execute simultaneously (S3).
 * A 4th simultaneous upload beyond this is rejected so the sidecar/Gemini
 * aren't overwhelmed.  Raise once the sidecar is concurrent (S1).
 * Env: MAX_CONCURRENT_PIPELINES  (default: 4)
 */
export function parseMaxConcurrentPipelines(env: Env): number {
  return parsePositiveInt(env, "MAX_CONCURRENT_PIPELINES", 4);
}

/**
 * Number of floor-plan sheets rasterized + vision-scanned in parallel per batch
 * in Step 3/rooms (S3).  Bounded by Gemini rate limits and sidecar capacity.
 * Env: SHEET_BATCH_SIZE  (default: 4)
 */
export function parseSheetBatchSize(env: Env): number {
  return parsePositiveInt(env, "SHEET_BATCH_SIZE", 4);
}

/**
 * Number of uploaded PDFs whose drawing index is parsed in parallel in Step 2
 * (S2a).  Each one is an independent sidecar call.
 * Env: STEP2_FILE_CONCURRENCY  (default: 3)
 */
export function parseStep2FileConcurrency(env: Env): number {
  return parsePositiveInt(env, "STEP2_FILE_CONCURRENCY", 3);
}

/**
 * Number of floor-plan sheets whose embedded schedule tables are extracted in
 * parallel in Step 4b-ext.  Each one is an independent sidecar extract-table call.
 * Env: STEP4B_EXT_CONCURRENCY  (default: 4)
 */
export function parseStep4bExtConcurrency(env: Env): number {
  return parsePositiveInt(env, "STEP4B_EXT_CONCURRENCY", 4);
}

/**
 * DPI for the Step 3a high-DPI signage-schedule re-render fallback (the two-pass
 * 300-DPI retry).  A full-page 300-DPI render of a large sheet is the single most
 * expensive sidecar call; lowering this (e.g. 220) renders roughly 2x faster while
 * remaining far more legible than the 150-DPI standard pass.
 * Env: SCHEDULE_RETRY_DPI  (default: 300)
 */
export function parseScheduleRetryDpi(env: Env): number {
  return parsePositiveInt(env, "SCHEDULE_RETRY_DPI", 300);
}

/**
 * Parser for optional non-empty string knobs (model names, etc.).
 * Returns `fallback` when the variable is absent, empty, or whitespace-only.
 */
function parseString(env: Env, name: string, fallback: string): string {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw.trim();
}

/**
 * Model used for floor-plan room extraction (Step 3 tile + full-page scans) — the
 * single largest AI time/cost bucket.  Defaults to the proven gemini-2.5-pro.
 * Set to a Gemini 3 model id (verify the exact id against the live Gemini API,
 * e.g. a "gemini-3-*" flash-tier id) and validate with scripts/takeoff-eval before
 * rolling out — a faster Gemini 3 model here is the biggest available speed lever.
 * Env: ROOM_EXTRACTION_MODEL  (default: gemini-2.5-pro)
 */
export function parseRoomExtractionModel(env: Env): string {
  return parseString(env, "ROOM_EXTRACTION_MODEL", "gemini-2.5-pro");
}

/**
 * Model used for general vision calls outside room extraction (occupant loads,
 * code/egress sheets).  Env: VISION_MODEL  (default: gemini-2.5-pro)
 */
export function parseVisionModel(env: Env): string {
  return parseString(env, "VISION_MODEL", "gemini-2.5-pro");
}

/**
 * Model used for schedule / plaque / specialty table extraction (Step 3a vision
 * fallback, Step 4 plaque, Step 9.2 specialty + dictionary).  These read dense
 * tables and historically use the faster Flash tier.
 * Env: SCHEDULE_MODEL  (default: gemini-2.5-flash)
 */
export function parseScheduleModel(env: Env): string {
  return parseString(env, "SCHEDULE_MODEL", "gemini-2.5-flash");
}

/**
 * Parse the CLAUDE_VISION_BASE_DELAY_MS environment variable.
 *
 * This is the initial back-off delay (in milliseconds) before the first retry
 * of a failed AI vision call.  Subsequent retries double the delay up to
 * CLAUDE_VISION_MAX_DELAY_MS (64 s).
 *
 * Trade-offs:
 *  - Lower values (e.g. 500 ms) give faster retries but may hammer a rate-
 *    limited endpoint and trigger secondary throttling.
 *  - Higher values (e.g. 10 000 ms) are gentler on the API but add latency
 *    to every transient failure.
 *  - The default of 5 000 ms works well for most Anthropic tier plans.
 *
 * Returns 5000 when the variable is absent or empty.
 * Throws a descriptive error for invalid values.
 */
export function parseClaudeBaseDelayMs(env: Env): number {
  const raw = env["CLAUDE_VISION_BASE_DELAY_MS"];
  if (raw === undefined || raw === "") return 5_000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid CLAUDE_VISION_BASE_DELAY_MS value: "${raw}". Must be a positive number (milliseconds).`,
    );
  }
  return parsed;
}

/**
 * Parse the PORT environment variable from a given env object.
 * Throws a descriptive error when PORT is absent, non-numeric, zero, negative,
 * or a privileged system port (1–1023).
 * Exported for testability; index.ts calls this at startup.
 */
export function parsePort(env: Env): number {
  const raw = env["PORT"];
  if (raw === undefined || raw === "") {
    throw new Error("PORT environment variable is required but was not provided.");
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid PORT value: "${raw}". Must be a positive integer (e.g. 3000).`,
    );
  }
  if (parsed < 1024) {
    throw new Error(
      `PORT ${parsed} is a privileged port. Use a value >= 1024.`,
    );
  }
  return parsed;
}

export type CleanupConfigOnInvalid = (
  info: { envValue: string; defaultUsed: number },
  message: string,
) => void;

/**
 * Parse the CLEANUP_HISTORY_MAX_AGE_DAYS environment variable.
 * Returns 90 (the default) when the variable is absent, empty, or invalid.
 *
 * When a `warn` callback is supplied and the value is invalid, the callback is
 * invoked with diagnostic bindings before returning the default — this
 * supports lenient runtime behaviour (log + carry on) used by the live server.
 *
 * When no `warn` callback is supplied and the value is invalid, the default is
 * returned silently.
 */
export function parseCleanupHistoryMaxAgeDays(
  env: Env,
  warn?: (bindings: object, msg: string) => void,
): number {
  const DEFAULT = 90;
  const raw = env["CLEANUP_HISTORY_MAX_AGE_DAYS"];
  if (raw === undefined || raw === "") return DEFAULT;
  const parsed = parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== raw.trim()) {
    if (warn) {
      warn(
        { envVar: "CLEANUP_HISTORY_MAX_AGE_DAYS", envValue: raw, defaultUsed: DEFAULT },
        `Invalid CLEANUP_HISTORY_MAX_AGE_DAYS value: "${raw}". Must be a positive integer (e.g. 90). Using default.`,
      );
    }
    return DEFAULT;
  }
  return parsed;
}

/**
 * Parse the CLEANUP_HISTORY_MAX_ROWS environment variable.
 * Returns 1000 (the default) when the variable is absent, empty, or invalid.
 *
 * When a `warn` callback is supplied and the value is invalid, the callback is
 * invoked with diagnostic bindings before returning the default — this
 * supports lenient runtime behaviour (log + carry on) used by the live server.
 *
 * When no `warn` callback is supplied and the value is invalid, the default is
 * returned silently.
 */
export function parseCleanupHistoryMaxRows(
  env: Env,
  warn?: (bindings: object, msg: string) => void,
): number {
  const DEFAULT = 1000;
  const raw = env["CLEANUP_HISTORY_MAX_ROWS"];
  if (raw === undefined || raw === "") return DEFAULT;
  const parsed = parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== raw.trim()) {
    if (warn) {
      warn(
        { envVar: "CLEANUP_HISTORY_MAX_ROWS", envValue: raw, defaultUsed: DEFAULT },
        `Invalid CLEANUP_HISTORY_MAX_ROWS value: "${raw}". Must be a positive integer (e.g. 1000). Using default.`,
      );
    }
    return DEFAULT;
  }
  return parsed;
}

/**
 * Parse the PDF_SIDECAR_URL environment variable.
 * Returns "http://127.0.0.1:8008" (the default) when the variable is absent or empty.
 * Throws a descriptive error when the value is not a valid HTTP/HTTPS URL.
 */
export function parsePdfSidecarUrl(env: Env): string {
  const raw = env["PDF_SIDECAR_URL"];
  if (raw === undefined || raw === "") return "http://127.0.0.1:8008";
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Protocol must be http or https");
    }
  } catch {
    throw new Error(
      `Invalid PDF_SIDECAR_URL value: "${raw}". Must be a valid http or https URL (e.g. http://127.0.0.1:8008).`,
    );
  }
  return raw;
}

/**
 * Assert that a required secret environment variable is present and non-empty.
 * Throws a descriptive error when the variable is absent or blank.
 */
function requireSecret(env: Env, name: string, hint: string): void {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Required environment variable ${name} is missing or empty. ${hint}`);
  }
}

/**
 * Parse the Anthropic API key from a given env object.
 *
 * Accepts either ANTHROPIC_API_KEY (a direct key) or falls back to
 * AI_INTEGRATIONS_ANTHROPIC_API_KEY (the Replit AI Integration proxy key).
 * Throws a descriptive error only when both are absent or empty.
 */
export function parseAnthropicApiKey(env: Env): string {
  const direct = env["ANTHROPIC_API_KEY"];
  if (direct !== undefined && direct.trim() !== "") {
    return direct;
  }
  const integration = env["AI_INTEGRATIONS_ANTHROPIC_API_KEY"];
  if (integration !== undefined && integration.trim() !== "") {
    return integration;
  }
  throw new Error(
    "ANTHROPIC_API_KEY is required but was not provided. " +
    "Set ANTHROPIC_API_KEY or provision the Anthropic AI integration (AI_INTEGRATIONS_ANTHROPIC_API_KEY).",
  );
}

/**
 * Validate all operator-configurable environment variables in one pass.
 *
 * Tries every variable independently, collects all error messages, and returns
 * them as an array.  An empty array means all values are valid.  Callers
 * (i.e. the startup check in index.ts) decide what to do with the errors.
 *
 * Checks two categories:
 *  1. Required secrets — variables that must be present for the server to
 *     function at all (DATABASE_URL, AI integration keys, PRIVATE_OBJECT_DIR).
 *  2. Operator-tunable numerics — optional variables that accept defaults but
 *     must be valid numbers when explicitly provided (RASTERIZE_DPI, etc.).
 */
export function validateStartupConfig(env: Env = process.env as Env): string[] {
  const errors: string[] = [];

  // ── Required secrets ──────────────────────────────────────────────────────
  // These have no fallback — missing values cause the very first request that
  // needs them to fail with a cryptic error.  Catching them here gives the
  // operator a clear message at boot time.

  // The database connection string may be provided as either DATABASE_URL or
  // DO_DATABASE_URL (the latter takes precedence at runtime — see lib/db). On
  // DigitalOcean a managed binding can auto-inject a placeholder DATABASE_URL, so
  // DO_DATABASE_URL is the operator-controlled override. Accept either here.
  const hasDatabaseUrl = [env.DATABASE_URL, env.DO_DATABASE_URL].some(
    (value) => typeof value === "string" && value.trim() !== "",
  );
  if (!hasDatabaseUrl) {
    errors.push(
      "Required environment variable DATABASE_URL is missing or empty. " +
        "Ensure the PostgreSQL database is provisioned and the connection string is set " +
        "(DO_DATABASE_URL is also accepted).",
    );
  }

  try {
    requireSecret(
      env,
      "AI_INTEGRATIONS_ANTHROPIC_API_KEY",
      "Ensure the Anthropic AI integration is provisioned in Replit.",
    );
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  try {
    requireSecret(
      env,
      "AI_INTEGRATIONS_ANTHROPIC_BASE_URL",
      "Ensure the Anthropic AI integration is provisioned in Replit.",
    );
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  try {
    requireSecret(
      env,
      "PRIVATE_OBJECT_DIR",
      "Set PRIVATE_OBJECT_DIR to the object-storage bucket path for uploaded files.",
    );
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  // ── Production-only secrets ───────────────────────────────────────────────
  // These are enforced at module-load / first-use time in production
  // (guestAuth throws on import, sessionAuth throws when signing). Validating
  // them here surfaces a single clear error list at boot instead of a later
  // cryptic throw. Only required when NODE_ENV === "production".
  if (env.NODE_ENV === "production") {
    const guestSecret = env.GUEST_JWT_SECRET;
    if (guestSecret === undefined || guestSecret.trim() === "") {
      errors.push(
        "Required environment variable GUEST_JWT_SECRET is missing or empty in production. " +
          "Generate a long random string for guest-session token signing.",
      );
    }

    const sessionSecret = env.SESSION_SECRET;
    if (sessionSecret === undefined || sessionSecret.length < 16) {
      errors.push(
        "Required environment variable SESSION_SECRET is missing or too short in production. " +
          "Set a random string of at least 16 characters for session signing.",
      );
    }
  }

  // ── Operator-tunable numerics ─────────────────────────────────────────────

  try {
    parseAnthropicApiKey(env);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  try {
    parseRasterizeDpi(env);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  try {
    parseAiVisionCallsPerRun(env);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  try {
    parseMaxConcurrentPipelines(env);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  try {
    parseSheetBatchSize(env);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  try {
    parseStep2FileConcurrency(env);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  try {
    parseStep4bExtConcurrency(env);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  try {
    parseScheduleRetryDpi(env);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  try {
    parseClaudeBaseDelayMs(env);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  parseCleanupHistoryMaxAgeDays(env, (_bindings, msg) => errors.push(msg));

  parseCleanupHistoryMaxRows(env, (_bindings, msg) => errors.push(msg));

  try {
    parsePdfSidecarUrl(env);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  return errors;
}
