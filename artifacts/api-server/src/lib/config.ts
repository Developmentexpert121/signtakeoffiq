/**
 * Centralized environment variable parsing for the API server.
 *
 * Parser functions and the startup validator live in `config-parsers.ts` (no
 * module-level side effects) so they can be imported safely before any other
 * module that consumes config values.  This file adds the module-level
 * evaluated constants that pipeline.ts and other runtime consumers depend on.
 * Those constants throw at import time when a value is invalid, which is the
 * fail-fast guard for pipeline consumers; the startup validator in index.ts
 * catches all bad values before the HTTP server binds.
 */

export {
  parseAiVisionCallsPerRun, parseAnthropicApiKey, parseClaudeBaseDelayMs,
  parseCleanupHistoryMaxAgeDays,
  parseCleanupHistoryMaxRows, parseMaxConcurrentPipelines, parsePdfSidecarUrl,
  parsePort, parseRasterizeDpi, parseRoomExtractionModel, parseScheduleModel, parseScheduleRetryDpi, parseSheetBatchSize,
  parseStep2FileConcurrency,
  parseStep4bExtConcurrency, parseVisionModel, validateStartupConfig, type Env
} from "./config-parsers";

import {
  parseAiVisionCallsPerRun,
  parseAnthropicApiKey,
  parseClaudeBaseDelayMs,
  parseCleanupHistoryMaxAgeDays,
  parseCleanupHistoryMaxRows,
  parseMaxConcurrentPipelines,
  parsePdfSidecarUrl,
  parseRasterizeDpi,
  parseRoomExtractionModel,
  parseScheduleModel,
  parseScheduleRetryDpi,
  parseSheetBatchSize,
  parseStep2FileConcurrency,
  parseStep4bExtConcurrency,
  parseVisionModel,
} from "./config-parsers";
import { logger } from "./logger";

/**
 * Anthropic API key required for all Claude vision calls.
 * Env: ANTHROPIC_API_KEY  (required — no default)
 *
 * Throws at import time when the key is absent so that any module importing
 * config.ts fails fast instead of producing a cryptic mid-scan error.
 */
export const anthropicApiKey = parseAnthropicApiKey(process.env as Record<string, string | undefined>);

/**
 * DPI used when rasterizing PDF pages to PNG for AI vision steps.
 * Env: RASTERIZE_DPI  (default: 150)
 */
export const rasterizeDpi = parseRasterizeDpi(process.env as Record<string, string | undefined>);

/**
 * Maximum number of new AI vision calls allowed per pipeline run.
 * Sheets whose results are reused from a prior run are not counted.
 * Env: AI_VISION_CALLS_PER_RUN  (default: 20)
 */
export const maxAiVisionCallsPerRun = parseAiVisionCallsPerRun(process.env as Record<string, string | undefined>) ?? 20;

/**
 * Maximum number of pipeline runs allowed to execute simultaneously (S3).
 * Env: MAX_CONCURRENT_PIPELINES  (default: 4)
 */
export const maxConcurrentPipelines = parseMaxConcurrentPipelines(process.env as Record<string, string | undefined>);

/**
 * Floor-plan sheets rasterized + vision-scanned in parallel per batch (S3).
 * Env: SHEET_BATCH_SIZE  (default: 4)
 */
export const sheetBatchSize = parseSheetBatchSize(process.env as Record<string, string | undefined>);

/**
 * PDFs whose drawing index is parsed in parallel in Step 2 (S2a).
 * Env: STEP2_FILE_CONCURRENCY  (default: 3)
 */
export const step2FileConcurrency = parseStep2FileConcurrency(process.env as Record<string, string | undefined>);

/**
 * Floor-plan sheets whose embedded schedule tables are extracted in parallel in
 * Step 4b-ext.  Env: STEP4B_EXT_CONCURRENCY  (default: 4)
 */
export const step4bExtConcurrency = parseStep4bExtConcurrency(process.env as Record<string, string | undefined>);

/**
 * DPI for the Step 3a high-DPI signage-schedule re-render fallback.
 * Env: SCHEDULE_RETRY_DPI  (default: 300)
 */
export const scheduleRetryDpi = parseScheduleRetryDpi(process.env as Record<string, string | undefined>);

/**
 * Model used for floor-plan room extraction (Step 3) — the biggest AI cost.
 * Env: ROOM_EXTRACTION_MODEL  (default: gemini-2.5-pro)
 */
export const roomExtractionModel = parseRoomExtractionModel(process.env as Record<string, string | undefined>);

/**
 * Model used for general vision calls (occupant loads, code/egress sheets).
 * Env: VISION_MODEL  (default: gemini-2.5-pro)
 */
export const visionModel = parseVisionModel(process.env as Record<string, string | undefined>);

/**
 * Model used for schedule / plaque / specialty table extraction.
 * Env: SCHEDULE_MODEL  (default: gemini-2.5-flash)
 */
export const scheduleModel = parseScheduleModel(process.env as Record<string, string | undefined>);

/**
 * Initial back-off delay for AI vision retries.
 * Env: CLAUDE_VISION_BASE_DELAY_MS  (default: 5000 ms)
 *
 * See parseClaudeBaseDelayMs in config-parsers.ts for full trade-off notes.
 */
export const claudeVisionBaseDelayMs = parseClaudeBaseDelayMs(process.env as Record<string, string | undefined>);

/**
 * Maximum age of guest_cleanup_runs history rows before they are pruned.
 * Env: CLEANUP_HISTORY_MAX_AGE_DAYS  (default: 90)
 * Invalid values emit a WARN and fall back to 90 instead of crashing.
 */
export const cleanupHistoryMaxAgeDays = parseCleanupHistoryMaxAgeDays(
  process.env as Record<string, string | undefined>,
  (bindings, msg) => logger.warn(bindings, msg),
);

/**
 * Maximum number of guest_cleanup_runs history rows to retain.
 * Env: CLEANUP_HISTORY_MAX_ROWS  (default: 1000)
 * Invalid values emit a WARN and fall back to 1000 instead of crashing.
 */
export const cleanupHistoryMaxRows = parseCleanupHistoryMaxRows(
  process.env as Record<string, string | undefined>,
  (bindings, msg) => logger.warn(bindings, msg),
);

/**
 * Base URL for the Python PDF sidecar service.
 * Env: PDF_SIDECAR_URL  (default: "http://127.0.0.1:8008")
 */
export const pdfSidecarUrl = parsePdfSidecarUrl(process.env as Record<string, string | undefined>);
