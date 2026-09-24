/**
 * Sign Takeoff IQ — 10-Step Processing Pipeline
 *
 * Orchestrates the full PDF processing flow:
 * 1.  Intake job files from object storage
 * 2.  Parse drawing index (filter relevant sheets)
 * 3.  Rasterize floor-plan pages to PNG → upload to object storage
 * 4.  Extract plaque schedule (Claude vision)
 * 5.  Extract words from floor plans (PDF sidecar)
 * 6.  Extract rooms deterministically with synonym expansion
 * 6b. AI vision room verification — catch rooms missed by text parsing
 * 7.  Extract occupant loads (Claude vision)
 * 8.  Classify rooms and build inventory
 * 9.  Apply R1–R17 rules engine
 * 10. Run 10 validation checks + save to DB
 */

import {
  aiScansTable, buildingTypeProfilesTable, db, jobFilesTable,
  jobSheetsTable, jobsTable, plaqueScheduleTable, roomsTable, ruleOverridesTable, signsTable, specialtySignsTable, tenantsTable,
  trainingCorrectionsTable, validationResultsTable
} from "@workspace/db";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import { generateEgressSigns } from "./egress-sign-generator";

import { mapWithConcurrency } from "./concurrency";
import {
  claudeVisionBaseDelayMs,
  maxAiVisionCallsPerRun,
  maxConcurrentPipelines,
  rasterizeDpi,
  scheduleRetryDpi,
  sheetBatchSize,
  step2FileConcurrency,
  step4bExtConcurrency,
} from "./config";
import { newId } from "./ids";
import { clearLogFile } from "./logger";
import { clearJobMaterialSpec, type JobMaterialSpec, setJobMaterialSpec } from "./materialSpec";
import {
  AI_VISION_CONFIDENCE,
  buildAiCallOptions,
  buildRoomExtractionPrompt,
  callClaudeVision,
  CLAUDE_ROOM_EXTRACTION_MODEL,
  CLAUDE_SCHEDULE_MODEL,
  CLAUDE_VISION_MODEL,
  type ClaudeUsage,
  extractOccupantLoads,
  extractPlaqueSchedule,
  type MissedRoom,
  type PlaqueEntry,
  timedGenerate,
  type VisionResponse
} from "./pipeline/ai-vision";
import { applyStep3aBridge, deduplicateScheduleGlobal, deduplicateSchedulePerSheet, deduplicateSignSchedule } from "./pipeline/dedup";
import { extractBuildingFromRoomNumber, inferLevelFromRoomNumber, normalizeLevel, parseLevelFromContext } from "./pipeline/level";
import {
  ESTIMATED_SECONDS_PER_SHEET,
  ESTIMATED_TOTAL_SECONDS,
  type PipelineProgress,
  type PipelineStepRecord,
  type RetryEvent,
  type Step6SheetResult,
  TOTAL_STEPS,
  writeProgress,
} from "./pipeline/progress";
import { expandSynonyms, extractRoomsFromWords, isJunkRoomName } from "./pipeline/room-extraction";
import { isAllowedRoomNumber, shouldApplyRoomNumberAllowlist, UNIT_APT_NAME_RE, unitNameCount, unitNamesDominant } from "./pipeline/room-number";
import { isTypeCodeSignType, parseAggregateCountTable, parseScheduleTableRows } from "./pipeline/schedule-parser";
import { getExclusionReason, shouldRunVisionScan } from "./pipeline/sheet-classification";
import { downloadFromStorage, uploadToStorage } from "./pipeline/storage";
import type { ProjectSignDictionary, SignScheduleEntry } from "./pipeline/types";
import {
  applyRules,
  classifyRoom,
  detectBuildingType,
  RESTROOM_KEYWORDS,
  type RoomRecord,
  runValidationChecks,
  UNIT_SIGN_BUILDING_TYPES,
} from "./rules-engine";
import { mapRoomToFlagsSync, preloadLexicon } from "./semantic-mapper";
import {
  batchConvertPdfToImages,
  extractTable,
  extractWords,
  parseDrawingIndex,
  rasterizePages,
  rasterizeTiles,
  type RasterTile,
  sidecarHealthCheck,
} from "./sidecar-client";
import { computeLiveSignCounts, syncJobSignCounts } from "./signCounts";
import {
  formatTimingSummary,
  getLogLines,
  getTimingSummary,
  runWithTiming,
} from "./timing";
import { getTrainingContext } from "./trainingContext";

export {
  buildAiCallOptions,
  callClaudeVision,
  CLAUDE_RETRY_MAX_DEFAULT,
  CLAUDE_VISION_MODEL,
  CLAUDE_VISION_PROVIDER,
  computeMaxRetryWaitMs,
  MIN_ROOMS_PER_SHEET_FOR_VISION,
  resolveAiRetryMax
} from "./pipeline/ai-vision";
export { applyStep3aBridge, deduplicateScheduleGlobal, deduplicateSchedulePerSheet, deduplicateSignSchedule } from "./pipeline/dedup";
export { ESTIMATED_SECONDS_PER_SHEET } from "./pipeline/progress";
export { expandSynonyms, extractRoomsFromWords, isJunkRoomName, ROOM_NUMBER_RE } from "./pipeline/room-extraction";
export { shouldApplyRoomNumberAllowlist, unitNamesDominant } from "./pipeline/room-number";
export { getExclusionReason, shouldRunVisionScan } from "./pipeline/sheet-classification";
export type { SignScheduleEntry } from "./pipeline/types";

// ---------------------------------------------------------------------------
// Pipeline version — bump when room extraction logic changes to force cache
// invalidation on next rescan (priorAiVisionRooms with older version skipped).
// ---------------------------------------------------------------------------
const PIPELINE_VERSION = "2.0";

/**
 * Recover room objects from a vision response whose JSON was truncated (e.g. the
 * model hit its output-token cap mid-array). Standard JSON.parse fails on the
 * whole blob; this scanner instead walks the "rooms"/"missedRooms" array and
 * keeps every COMPLETE, brace-balanced object, discarding the partial tail.
 * Returns null if no array start can be located.
 */
function salvageTruncatedRooms(text: string): { isPlanView: boolean; rooms: MissedRoom[] } | null {
  // Locate the array for either the canonical or legacy key.
  const keyMatch = /"(?:rooms|missedRooms)"\s*:\s*\[/.exec(text);
  if (!keyMatch) return null;
  const arrStart = keyMatch.index + keyMatch[0].length;

  const objects: MissedRoom[] = [];
  let depth = 0;
  let objStart = -1;
  let inString = false;
  let escaped = false;

  for (let i = arrStart; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && objStart !== -1) {
        // A complete top-level object — parse it in isolation. Skip any that
        // somehow fail rather than aborting the whole salvage.
        try {
          objects.push(JSON.parse(text.slice(objStart, i + 1)) as MissedRoom);
        } catch {
          /* ignore a single malformed object */
        }
        objStart = -1;
      }
    } else if (ch === "]" && depth === 0) {
      // Array closed cleanly before truncation — nothing more to salvage.
      break;
    }
  }

  if (objects.length === 0) return null;
  // isPlanView almost always precedes the array; default true since a sheet that
  // produced rooms is by definition a plan view.
  const isPlanView = !/"isPlanView"\s*:\s*false/.test(text.slice(0, arrStart));
  return { isPlanView, rooms: objects };
}

let _activePipelineCount = 0;
const MAX_CONCURRENT_PIPELINES = maxConcurrentPipelines;

/**
 * Public entry point. Establishes a per-job timing context (Phase 0 / S7) so
 * every sidecar + Gemini call is attributed to this job, then runs the pipeline.
 */
export function processJob(jobId: string, tenantId: string, options?: { forceAiRescan?: boolean; forceRescanSheetIds?: string[] }): Promise<void> {
  return runWithTiming(jobId, () => runProcessJob(jobId, tenantId, options));
}

async function runProcessJob(jobId: string, tenantId: string, options?: { forceAiRescan?: boolean; forceRescanSheetIds?: string[] }): Promise<void> {
  /*
   * ─── PIPELINE DATA FLOW ──────────────────────────────────────────────────────
   *
   * schedule_primary  (dedicated sign schedule, 100+ entries):
   *   Step 3a  → signSchedule[]          Gemini extracts from sign schedule PDF
   *   Step 3   → floor plan vision       egress rooms + coordinates only
   *   Step 3b  → coordinate matching     schedule rooms get x,y from floor plans
   *   Step 9   → signSchedule[] → DB     direct insert, no rules engine multiplication
   *   Step 9   → rules engine R9/R11/R13/R16 only (egress signs)
   *
   * floor_plan_primary  (no sign schedule):
   *   Step 3   → extractedRooms[]        full Gemini vision extraction
   *   Step 9   → rules engine fully      all rules R1–R17
   *
   * hybrid  (sign schedule with <100 entries):
   *   Both paths run, results merged
   *
   * egress_only  (no floor plans):
   *   Step 9   → egress rules only
   *
   * KEY ARRAYS:
   *   signSchedule[]      — canonical schedule entries (Step 3a source of truth)
   *   extractedRooms[]    — floor plan vision rooms (Step 3 source of truth)
   *   signRows[]          — rules engine output (Step 9)
   *   scheduleSignRows    — REMOVED (was duplicate of signSchedule[])
   * ─────────────────────────────────────────────────────────────────────────────
   */
  const logger = console;
  clearLogFile();
  const ENABLE_TWO_PASS = process.env.ENABLE_TWO_PASS !== "false"; // opt-OUT (on by default) — set ENABLE_TWO_PASS=false to disable

  // PIPELINE_CACHE_ENABLED=false → always fresh (dev mode)
  // PIPELINE_CACHE_ENABLED=true  → reuse cached AI scans (prod mode, saves cost)
  const CACHE_ENABLED = process.env.PIPELINE_CACHE_ENABLED === "true";
  if (!CACHE_ENABLED) {
    logger.log("[pipeline] Cache DISABLED (dev mode) — all sheets will run fresh AI scans");
  }

  // Concurrency check — reject if too many pipelines already running
  if (_activePipelineCount >= MAX_CONCURRENT_PIPELINES) {
    throw new Error(
      `Pipeline busy — ${_activePipelineCount} scan(s) already running. ` +
      `Please wait a moment and retry.`
    );
  }
  _activePipelineCount++;
  logger.log(
    `[pipeline] Active pipelines: ${_activePipelineCount}/${MAX_CONCURRENT_PIPELINES}`
  );

  // Declared before try/finally so the finally block can read it (let is block-scoped).
  let jobMaterialSpec: JobMaterialSpec | null = null;
  try {

  // Hard ceiling for any single pipeline step that has async IO.
  // Any step that exceeds this is aborted and the pipeline continues
  // with whatever partial results have accumulated up to that point.
  const STEP_TIMEOUT_MS = 60_000;

  // Races `fn` against a 60-second deadline.  If the deadline fires first,
  // `fn` is abandoned in place (its promise is still running but its result
  // is discarded) and the pipeline moves on.  Any error thrown by `fn` is
  // logged as a warning rather than re-thrown so the pipeline stays alive.
  async function withStepTimeout(label: string, fn: () => Promise<void>): Promise<void> {
    let timedOut = false;
    await Promise.race([
      fn().catch((err: unknown) => {
        logger.warn(`[pipeline] ${label} error: ${err instanceof Error ? err.message : String(err)}`);
      }),
      new Promise<void>((resolve) => {
        setTimeout(() => { timedOut = true; resolve(); }, STEP_TIMEOUT_MS);
      }),
    ]);
    if (timedOut) {
      logger.warn(`[pipeline] ${label} timed out after ${STEP_TIMEOUT_MS / 1000}s — continuing with partial results`);
    }
  }

  const startedAt = new Date().toISOString();
  let lastProgress: PipelineProgress | null = null;
  const pipelineSteps: PipelineStepRecord[] = [];

  // In-memory retry log — accumulates retry events and is written with every
  // progress update so the UI can display them in real time.
  const retryLog: RetryEvent[] = [];
  let _currentStep: number | string = 1;
  let _currentLabel = "Reading file manifest";
  let _knownSheetCount: number | undefined;
  let _aiRetryMax: number | undefined;
  let _effectiveBaseDelayMs: number | undefined;

  // Convenience wrapper: write progress carrying both step history and retry log.
  // Passes the sheet count once it is known so estimatedTotalSeconds scales correctly.
  async function wp(step: number | string, label: string): Promise<void> {
    _currentStep = step;
    _currentLabel = label;
    lastProgress = await writeProgress(jobId, step, label, startedAt, pipelineSteps, retryLog, _knownSheetCount, _aiRetryMax, _effectiveBaseDelayMs);
  }

  // Lightweight mid-step flush used by the Step 6 loop to persist incremental
  // per-sheet results without starting a new step or altering step sequencing.
  async function flushStep6Progress(partialResults: Step6SheetResult[]): Promise<void> {
    const step6Record = pipelineSteps.find((s) => s.step === 6);
    if (!step6Record) return;
    step6Record.sheetResults = [...partialResults];
    const estimatedTotalSeconds = _knownSheetCount != null && _knownSheetCount > 0
      ? Math.max(ESTIMATED_TOTAL_SECONDS, _knownSheetCount * ESTIMATED_SECONDS_PER_SHEET)
      : ESTIMATED_TOTAL_SECONDS;
    const progress: PipelineProgress = {
      step: _currentStep,
      totalSteps: TOTAL_STEPS,
      label: _currentLabel,
      startedAt,
      stepStartedAt: step6Record.startedAt,
      estimatedTotalSeconds,
      estimatedSecondsPerSheet: ESTIMATED_SECONDS_PER_SHEET,
      retryLog,
      ...(_aiRetryMax !== undefined && { aiRetryMax: _aiRetryMax }),
      ...(_effectiveBaseDelayMs !== undefined && { effectiveBaseDelayMs: _effectiveBaseDelayMs }),
    };
    await db.update(jobsTable)
      .set({ metadata: { progress, steps: pipelineSteps, estimatedSecondsPerSheet: ESTIMATED_SECONDS_PER_SHEET, processingStartedAt: startedAt } as Record<string, unknown> })
      .where(eq(jobsTable.id, jobId));
  }

  // Called by callClaudeVision whenever it retries after a transient error.
  async function onRetry(attempt: number, errorType: string, errorMessage: string): Promise<void> {
    logger.warn(`[pipeline] AI retry attempt ${attempt} during step ${_currentStep} (${_currentLabel}): [${errorType}] ${errorMessage}`);
    retryLog.push({
      attempt,
      errorType,
      errorMessage,
      stepLabel: _currentLabel,
      timestamp: new Date().toISOString(),
    });
    // Persist the updated retry log so the UI shows the event immediately.
    await writeProgress(jobId, _currentStep, _currentLabel, startedAt, pipelineSteps, retryLog, _knownSheetCount, _aiRetryMax, _effectiveBaseDelayMs);
  }

  try {
    // -------------------------------------------------------------------------
    // Step 1: Intake — load job + files
    // -------------------------------------------------------------------------
    await wp(1, "Reading file manifest");

    const [job] = await db.select().from(jobsTable)
      .where(and(eq(jobsTable.id, jobId), eq(jobsTable.tenantId, tenantId)));
    if (!job) throw new Error(`Job ${jobId} not found`);

    // Load tenant settings to pick up configurable pipeline parameters.
    const [tenant] = await db.select({ settings: tenantsTable.settings })
      .from(tenantsTable)
      .where(eq(tenantsTable.id, tenantId));
    const tenantSettings = (tenant?.settings ?? {}) as Record<string, unknown>;

    // Custom building type → base rules profile mappings set by admin.
    const customBuildingTypeMappings: Record<string, string> =
      typeof tenantSettings.customBuildingTypeMappings === "object" &&
      tenantSettings.customBuildingTypeMappings !== null &&
      !Array.isArray(tenantSettings.customBuildingTypeMappings)
        ? (tenantSettings.customBuildingTypeMappings as Record<string, string>)
        : {};

    // Standard building type → base rules profile overrides set by admin.
    const standardBuildingTypeMappings: Record<string, string> =
      typeof tenantSettings.standardBuildingTypeMappings === "object" &&
      tenantSettings.standardBuildingTypeMappings !== null &&
      !Array.isArray(tenantSettings.standardBuildingTypeMappings)
        ? (tenantSettings.standardBuildingTypeMappings as Record<string, string>)
        : {};

    // Build retry options from tenant settings + env config and thread them into
    // every AI call site. Using buildAiCallOptions keeps the wiring in one place
    // and makes it directly testable without running the full pipeline.
    const aiCallOptions = buildAiCallOptions(tenantSettings);
    const aiRetryMax = aiCallOptions.maxRetries;
    logger.log(`[pipeline] Job ${jobId}: aiRetryMax=${aiRetryMax} baseDelayMs=${aiCallOptions.baseDelayMs}`);

    // Base back-off delay (ms) before the first AI retry.
    // Per-tenant setting takes precedence over the server env var (claudeVisionBaseDelayMs).
    const rawBaseDelay = typeof tenantSettings.aiBaseDelayMs === "number" ? tenantSettings.aiBaseDelayMs : claudeVisionBaseDelayMs;
    const effectiveBaseDelayMs = Math.max(500, Math.min(30000, Math.round(rawBaseDelay)));
    logger.log(`[pipeline] Job ${jobId}: aiBaseDelayMs=${effectiveBaseDelayMs}`);

    // Surface retry settings through the pipeline progress so the UI can display them.
    _aiRetryMax = aiRetryMax;
    _effectiveBaseDelayMs = effectiveBaseDelayMs;

    // Maximum AI vision calls allowed for this run.
    // rawVisionCap = tenant override or server-level default; the dynamic
    // calculation after sheet classification (below) adjusts effectiveVisionCap
    // based on actual floor plan sheet count.
    const rawVisionCap = typeof tenantSettings.aiVisionCallsPerRun === "number" ? tenantSettings.aiVisionCallsPerRun : maxAiVisionCallsPerRun;
    let effectiveVisionCap = Math.max(1, Math.round(rawVisionCap));

    // Custom multi-entry room keywords configured by the tenant admin.
    // These are merged with the built-in keyword list at rule-evaluation time.
    const rawCustomKeywords = tenantSettings.multiEntryRoomKeywords;
    const customMultiEntryKeywords: string[] =
      Array.isArray(rawCustomKeywords)
        ? rawCustomKeywords.filter((k): k is string => typeof k === "string" && k.trim().length > 0)
        : [];

    // Load approved training patterns + validated reference jobs for this tenant.
    // The result is injected into every Claude vision prompt (Prompt 3) so the
    // model benefits from human-verified corrections made in previous runs.
    const trainingContext = await getTrainingContext(tenantId, job.buildingType ?? null).catch(() => "");
    if (trainingContext) {
      logger.log(`[pipeline] Job ${jobId}: training context loaded (${trainingContext.length} chars)`);
    }

    // ── Pipeline strategy resolver ────────────────────────────────────────────
    type PipelineStrategy =
      | "schedule_primary"   // 100+ schedule entries — trust the schedule
      | "floor_plan_primary" // no schedule — full vision + rules engine
      | "hybrid"             // schedule exists but < 100 entries — blend both
      | "egress_only";       // no usable floor plan files

    function resolveStrategy(
      _btKey: string | null,
      scheduleLength: number,
      floorPlanFileCount: number,
      hasDedicatedScheduleFile: boolean = false,
    ): PipelineStrategy {
      if (hasDedicatedScheduleFile || scheduleLength >= 100) return "schedule_primary";
      if (floorPlanFileCount === 0) return "egress_only";
      if (scheduleLength > 0) return "hybrid";
      return "floor_plan_primary";
    }

    const files = await db.select().from(jobFilesTable)
      .where(and(eq(jobFilesTable.jobId, jobId), eq(jobFilesTable.tenantId, tenantId)));

    if (files.length === 0) {
      throw new Error("No files uploaded for this job. Upload PDF files before processing.");
    }

    // Snapshot the DB page count so the sidecar persist guard can compare
    // against the original DB value (not the in-memory pdf-lib override).
    for (const f of files) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (f as any)._dbPageCount = f.pageCount;
    }

    logger.log(`[pipeline] Job ${jobId}: ${files.length} file(s)`);

    // All uploaded PDFs are processed through the sheet classifier regardless
    // of any legacy fileCategory tag.  Only plaque_schedule / other files are
    // excluded — those are stored for reference but not fed into the pipeline.
    // dedicatedSignScheduleFiles is kept as an alias for backward compatibility
    // with the rest of the pipeline (sign-schedule extraction still runs on
    // sheets the sidecar classifies as signage_schedule within any file).
    const floorPlanFiles = files.filter(
      (f) =>
        f.fileCategory !== "plaque_schedule" &&
        f.fileCategory !== "other" &&
        f.fileCategory !== "sign_schedule" &&
        f.fileCategory !== "sign_details",
    );
    const dedicatedSignScheduleFiles = files.filter(
      (f) => f.fileCategory === "sign_schedule",
    );

    logger.log(
      `[pipeline] Job ${jobId}: ${files.length} total file(s) — ` +
      `${floorPlanFiles.length} floor plan file(s), ` +
      `${dedicatedSignScheduleFiles.length} sign schedule file(s), ` +
      `${files.length - floorPlanFiles.length - dedicatedSignScheduleFiles.length} plaque/other (skipped)`,
    );

    const totalAiCost = { value: 0 };
    const aiScanRecords: Array<{ callType: string; model: string; inputTokens: number; outputTokens: number; cost: number }> = [];

    function recordAiScan(callType: string, usage: ClaudeUsage, model: string = CLAUDE_VISION_MODEL) {
      totalAiCost.value += usage.cost;
      aiScanRecords.push({
        callType,
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cost: usage.cost,
      });
    }

    // Check sidecar health — hard-fail if unavailable.
    const sidecarOk = await sidecarHealthCheck();
    if (!sidecarOk) {
      throw new Error(
        "PDF sidecar is not responding (expected at http://127.0.0.1:8008). " +
        "Ensure the 'PDF Sidecar' workflow is running before triggering processing."
      );
    }

    // -------------------------------------------------------------------------
    // Pre-Step 2: Snapshot existing ai_vision rooms before sheets are cleared.
    //
    // Step 2 deletes all job_sheets and recreates them with new PKs.  The FK
    // rooms.sheetId has onDelete:"set null", so every room row loses its sheetId
    // after the delete.  To allow Step 6b to reuse prior ai_vision rooms we
    // capture them NOW — while the old sheet rows still exist — and key them by
    // the stable (fileId, sheetTitle, pdfPage) triple so they can be looked up
    // against the newly-created sheet rows later. fileId is from jobFilesTable
    // which is NOT deleted on reprocess, making it a stable per-file anchor.
    // Including fileId prevents key collisions in multi-file jobs where two
    // PDFs may share the same sheetTitle/pdfPage combination.
    //
    // When forceAiRescan is true, skip this snapshot entirely so Step 6b finds
    // no cached rooms and always makes fresh AI calls.
    // -------------------------------------------------------------------------
    const priorAiVisionBySheetKey = new Map<string, Array<{
      roomNumber: string;
      roomName: string;
      level: string | null;
      coordX: number | null;
      coordY: number | null;
      confidence: string;
      isRestroom: boolean;
      coordSource?: string | null;
    }>>();

    if (options?.forceAiRescan) {
      // Force Full Re-process: wipe ALL cached state so the pipeline starts
      // completely from scratch with no results carried over from prior runs.
      //
      // Count existing rows first so the log line is informative.
      const [priorRooms, priorSigns, priorVisionRooms, priorCachedSheets, priorSheetRows] = await Promise.all([
        db.select({ id: roomsTable.id }).from(roomsTable)
          .where(eq(roomsTable.jobId, jobId)),
        db.select({ id: signsTable.id }).from(signsTable)
          .where(eq(signsTable.jobId, jobId)),
        db.select({ id: roomsTable.id }).from(roomsTable)
          .where(and(eq(roomsTable.jobId, jobId), eq(roomsTable.source, "ai_vision"))),
        db.select({ id: jobSheetsTable.id }).from(jobSheetsTable)
          .where(and(eq(jobSheetsTable.jobId, jobId), isNotNull(jobSheetsTable.rasterizedPath))),
        db.select({ id: jobSheetsTable.id }).from(jobSheetsTable)
          .where(eq(jobSheetsTable.jobId, jobId)),
      ]);
      //
      // Safety net: if any delete below fails, reset the job to idle so it never
      // gets permanently stuck in processing status.
      try {
        //
        // 1. specialty_signs FIRST — it references signs via FK.  Deleting signs
        //    before specialty_signs causes a constraint violation.
        try {
          await db.execute(sql`DELETE FROM specialty_signs WHERE job_id = ${jobId}`);
          logger.info(`[pipeline] FORCE FRESH: deleted specialty_signs for job ${jobId}`);
        } catch {
          logger.warn(`[pipeline] FORCE FRESH: specialty_signs table not found or empty — skipping`);
        }
        //
        // 2. All rooms (ai_vision + any other source) — snapshot will be empty,
        //    guaranteeing Step 6b makes fresh Claude vision calls for every sheet.
        await db.delete(roomsTable).where(eq(roomsTable.jobId, jobId));
        //
        // 3. All signs — Step 8 re-generates them from scratch anyway; deleting
        //    here prevents stale signs from persisting if the pipeline aborts
        //    before reaching Step 8.
        await db.delete(signsTable).where(eq(signsTable.jobId, jobId));
        //
        // 4. All previous AI scan billing records — resets the cost display so the
        //    UI shows only costs accrued in this run.
        await db.delete(aiScansTable).where(and(
          eq(aiScansTable.jobId, jobId),
          eq(aiScansTable.tenantId, tenantId),
        ));
        //
        // 5. Clear cached rasterized-PNG paths — Step 2 deletes + recreates all
        //    job_sheet rows anyway, but nulling the path here makes the intent
        //    explicit and ensures no stale path survives a partial Step 2.
        await db.update(jobSheetsTable)
          .set({ rasterizedPath: null })
          .where(eq(jobSheetsTable.jobId, jobId));
        //
        // 6. Delete all sheet records — forces Step 2 to re-parse the PDF from
        //    scratch so no old extracted text or sheet metadata is reused.
        await db.delete(jobSheetsTable).where(eq(jobSheetsTable.jobId, jobId));
        //
        // 7. Delete cached text-extraction rows (sheet_text table) if the table
        //    exists.  This table is optional/future; skip with a warning if absent.
        try {
          await db.execute(sql`DELETE FROM sheet_text WHERE job_id = ${jobId}`);
          logger.info(`[pipeline] FORCE FRESH: cleared sheet_text for job`);
        } catch {
          // Table may not exist yet — safe to ignore
          logger.warn(`[pipeline] FORCE FRESH: sheet_text table not found or empty — skipping`);
        }
        //
        // 8. Delete sign schedule import rows if the table exists.  Also optional;
        //    skip with a warning if absent.
        try {
          await db.execute(sql`DELETE FROM sign_schedule_entries WHERE job_id = ${jobId}`);
          logger.info(`[pipeline] FORCE FRESH: cleared sign_schedule_entries for job`);
        } catch {
          // Table may not exist yet — safe to ignore
          logger.warn(`[pipeline] FORCE FRESH: sign_schedule_entries table not found or empty — skipping`);
        }
        await clearJobMaterialSpec(jobId);
        //
        // 9. Reset scope detection on the job so it is re-derived from the fresh
        //    room inventory rather than the prior run's stale result.
        await db.update(jobsTable)
          .set({ scopeFlag: null })
          .where(eq(jobsTable.id, jobId));
        //
        // Note: job.metadata (including any cached projectSignDictionary) is already
        // reset to a clean slate by the /rescan route before processJob is called,
        // so no additional metadata clearing is required here.
        logger.log(
          `[pipeline] FORCE FRESH: cleared ${priorRooms.length} rooms, ${priorSigns.length} signs, ` +
          `${priorVisionRooms.length} vision results, ${priorCachedSheets.length} PNG cache, ` +
          `${priorSheetRows.length} sheet records for job ${jobId}`,
        );
      } catch (clearErr) {
        logger.error(`[pipeline] FORCE FRESH failed — resetting job to idle: ${clearErr}`);
        await db.update(jobsTable)
          .set({ status: "idle" })
          .where(eq(jobsTable.id, jobId));
        throw clearErr;
      }
    } else {
      // ── Purge invalid cached rooms before snapshot ──────────────────────────
      // Garbled rooms extracted from the legend/title-block area on prior runs
      // are cached in the DB as ai_vision rooms and get replayed on every
      // subsequent rescan.  Delete them now — before the snapshot below loads
      // surviving rooms — so they are never promoted back into the pipeline.
      //
      // Patterns targeted:
      //   • Short room numbers: pure 1-2 digits, single-letter + 1-2 digits,
      //     or 1-2 letters + 1-2 digits (e.g. "10", "E1", "19A", "MB")
      //   • Valid-looking numbers with garbled names: dimensions (60X21, 8'-0),
      //     callout ranges (TO E119C.2), all-punctuation, or split-word fragments
      try {
        // Garbled name indicators — these are never valid room names
        // regardless of room number, so they are sufficient on their own.
        // The short-number check is ANDed to avoid purging real rooms that
        // happen to have an unusual number format (e.g. SA01 STAIR A).
        const purgeResult = await db.execute(sql`
          DELETE FROM rooms
          WHERE job_id = ${jobId}
            AND (
              -- Garbled name: definitive indicator, safe standalone
              room_name ~ '[0-9]+[Xx][0-9]+'
              OR room_name ~ '[0-9]+''-[0-9]'
              OR room_name ~ 'TO [EW][0-9]'
              OR room_name ~ 'RY CT'
              OR room_name ~ 'KIT EN'
              OR room_name ~ 'CAF ERIA'
              -- Short number AND all-punctuation/empty name
              OR (
                (room_number ~ '^[A-Z]?[0-9]{1,2}$' OR room_number ~ '^[A-Z]{1,2}[0-9]{1,2}$')
                AND room_name ~ '^[[:space:].''"\\-]*$'
              )
            )
        `);
        const purgedCount = (purgeResult as unknown as { rowCount?: number }).rowCount ?? 0;
        if (purgedCount > 0) {
          logger.log(`[pipeline] Purged ${purgedCount} invalid cached room(s) for job ${jobId}`);
        }
      } catch (purgeErr) {
        logger.warn(`[pipeline] Cache purge skipped: ${purgeErr instanceof Error ? purgeErr.message : String(purgeErr)}`);
      }

      const existingSheets = await db
        .select()
        .from(jobSheetsTable)
        .where(eq(jobSheetsTable.jobId, jobId));

      if (existingSheets.length > 0) {
        const existingAiRooms = await db
          .select()
          .from(roomsTable)
          .where(
            and(
              eq(roomsTable.jobId, jobId),
              eq(roomsTable.source, "ai_vision"),
            ),
          );

        const forcedSheetIds = new Set(options?.forceRescanSheetIds ?? []);
        let skippedForForce = 0;

        let skippedForVersion = 0;
        for (const room of existingAiRooms) {
          const sheet = existingSheets.find((s) => s.id === room.sheetId);
          if (!sheet) continue;
          if (forcedSheetIds.has(sheet.id)) {
            skippedForForce++;
            continue;
          }
          // Skip rooms extracted by an older pipeline version — forces re-extraction.
          if (room.pipelineVersion && room.pipelineVersion !== PIPELINE_VERSION) {
            skippedForVersion++;
            continue;
          }
          const key = `${sheet.fileId ?? ""}|${sheet.sheetTitle ?? ""}|${sheet.pdfPage ?? 0}`;
          const arr = priorAiVisionBySheetKey.get(key) ?? [];
          arr.push({
            roomNumber: room.roomNumber,
            roomName: room.roomName,
            level: room.level,
            coordX: room.coordX,
            coordY: room.coordY,
            confidence: room.confidence,
            isRestroom: room.isRestroom,
            coordSource: room.coordSource,
          });
          priorAiVisionBySheetKey.set(key, arr);
        }
        if (skippedForVersion > 0) {
          logger.log(
            `[pipeline] Pre-Step 2: skipped ${skippedForVersion} cached ai_vision room(s) with stale pipeline version (current: ${PIPELINE_VERSION}) — will re-extract`,
          );
        }

        if (forcedSheetIds.size > 0) {
          logger.log(
            `[pipeline] Pre-Step 2: force-rescan requested for ${forcedSheetIds.size} sheet(s) — skipped ${skippedForForce} cached room(s) for those sheets`,
          );
        }

        logger.log(
          `[pipeline] Pre-Step 2: captured ${existingAiRooms.length - skippedForForce} prior ai_vision rooms across ${priorAiVisionBySheetKey.size} sheet(s)`,
        );
      }
    }

    // -------------------------------------------------------------------------
    // Step 2: Parse drawing index from first PDF
    // -------------------------------------------------------------------------
    await wp(2, "Parsing drawing index");

    let allSheets: Array<{
      sheet_id: string;
      sheet_title: string;
      pdf_page: number;
      sheet_type: string;
      level: string | null;
      fileId: string;
    }> = [];

    // Clear old sheets
    await db.delete(jobSheetsTable).where(eq(jobSheetsTable.jobId, jobId));

    // Hard timeout for the drawing-index parse step.
    // The sidecar call (parseDrawingIndex) can hang on large or complex PDFs;
    // if it exceeds this limit we fall through to the synthetic-sheet fallback
    // below instead of stalling the entire pipeline.
    // Scale the timeout with file size — large permit sets need more time.
    const maxFileSizeMB = Math.max(0, ...floorPlanFiles.map(f => (f.fileSizeBytes ?? 0) / 1024 / 1024));
    // Sidecar parses ALL pages of the PDF regardless of file size; large-but-few-page
    // PDFs (e.g. Fox Hill 16 MB, 6 pages) need more time than the file-size heuristic
    // suggests.  Use a generous baseline and scale with file size.
    const STEP2_TIMEOUT_MS = maxFileSizeMB > 50
      ? 300_000  // 5 minutes for large files (>50 MB)
      : maxFileSizeMB > 20
      ? 180_000  // 3 minutes for medium files (20–50 MB)
      : 120_000; // 2 minutes default
    logger.log(`[pipeline] Drawing index timeout: ${STEP2_TIMEOUT_MS / 1000}s (file size: ${maxFileSizeMB.toFixed(1)} MB)`);
    let step2TimedOut = false;
    // Cancellation flag — set to false when the timeout fires so the inner
    // async stops pushing to allSheets before classifications is built.
    // Without this, sheets pushed after the snapshot would cause
    // classifications[i] to be undefined at later indexed accesses.
    let step2SidecarActive = true;

    const pdfBufferByFileId = new Map<string, Buffer>();
    // Per-file sheet results, indexed by position in floorPlanFiles (S2a). Each
    // file is parsed concurrently (bounded by STEP2_FILE_CONCURRENCY) but writes
    // its own slot exactly once — assignment is atomic in single-threaded JS — so
    // on a Step-2 timeout we keep whatever finished and flatten in the original
    // file order afterwards, giving identical ordering to the old sequential loop.
    const perFileSheets: (typeof allSheets)[] = new Array(floorPlanFiles.length);

    await Promise.race([
      mapWithConcurrency(floorPlanFiles, step2FileConcurrency, async (file, _fi) => {
        if (!step2SidecarActive) return;
        if (!file.filename.toLowerCase().endsWith(".pdf")) {
          logger.warn(`[pipeline] Skipping non-PDF file: ${file.filename}`);
          return;
        }

        let pdfBuffer: Buffer;
        try {
          pdfBuffer = await downloadFromStorage(file.storagePath);
        } catch (err) {
          logger.warn(`[pipeline] Could not download ${file.storagePath}: ${err}`);
          return;
        }

        if (pdfBuffer.slice(0, 4).toString("ascii") !== "%PDF") {
          logger.warn(`[pipeline] File ${file.filename} does not appear to be a valid PDF (bad magic bytes) — skipping`);
          return;
        }

        pdfBufferByFileId.set(file.id, pdfBuffer);

        // Use pdf-lib for an accurate page count — it opens the PDF natively and
        // calls getPageCount(), which correctly handles compressed/linearized PDFs
        // where the head+tail byte-regex scan was unreliable (e.g. NOVO returned 1
        // instead of 5 pages because page objects sat in the middle of the file).
        // This runs BEFORE the sidecar call so file.pageCount is correct even if
        // the Step-2 timeout fires before the sidecar returns.
        try {
          const pdfDoc = await PDFDocument.load(pdfBuffer, {
            ignoreEncryption: true,
            updateMetadata: false,
          } as Parameters<typeof PDFDocument.load>[1]);
          const pdfLibCount = pdfDoc.getPageCount();
          if (pdfLibCount > 0) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (file as any).pageCount = pdfLibCount;
            logger.log(`[pipeline] pdf-lib page count: ${pdfLibCount} for ${file.filename}`);
          }
        } catch (pdfLibErr) {
          // Fallback: regex scan on head+tail bytes.
          const headBuf = pdfBuffer.slice(0, Math.min(pdfBuffer.length, 200_000));
          const tailBuf = pdfBuffer.slice(Math.max(0, pdfBuffer.length - 1_000_000));
          const sample = Buffer.concat([headBuf, tailBuf]).toString("binary");
          const m = sample.match(/\/Type\s*\/Page[^s]/g);
          if (m && m.length > 0) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (file as any).pageCount = m.length;
            logger.log(`[pipeline] Regex page count fallback: ${m.length} page(s) for ${file.filename} (pdf-lib err: ${pdfLibErr})`);
          }
        }

        if (sidecarOk) {
          // Pass STEP2_TIMEOUT_MS as the per-call timeout so large/complex
          // PDFs get adequate time to parse.  The try/catch ensures a sidecar
          // timeout or error never propagates out of the task and races with
          // the outer STEP2 timer in Promise.race — without it the rejection
          // can beat the timer resolution and crash the entire job.
          let indexResult: Awaited<ReturnType<typeof parseDrawingIndex>> | null = null;
          try {
            indexResult = await parseDrawingIndex(pdfBuffer, file.filename, STEP2_TIMEOUT_MS);
          } catch (sidecarErr) {
            logger.warn(
              `[pipeline] parseDrawingIndex failed for ${file.filename} — ` +
              `continuing with synthesis fallback. ` +
              `Error: ${sidecarErr instanceof Error ? sidecarErr.message : String(sidecarErr)}`,
            );
          }
          if (indexResult) {
            // Use the sidecar's authoritative page count — it opens the PDF with
            // pdfplumber and counts len(pdf.pages), which is always accurate.
            // This overrides the head+tail byte-regex scan which can under-count
            // for large PDFs where page objects are in the middle of the file.
            if (indexResult.total_pages > 0) {
              const prev = (file as any).pageCount;
              (file as any).pageCount = indexResult.total_pages;
              if (prev !== indexResult.total_pages) {
                logger.log(
                  `[pipeline] Page count from sidecar: ${indexResult.total_pages} (was ${prev ?? "unknown"}) for ${file.filename}`,
                );
              }
              // Persist to DB whenever the sidecar count differs from what the DB
              // has — sidecar uses pdfplumber len(pdf.pages), which is always
              // authoritative. Persisting ensures partial synthesis and future
              // runs use the correct count without re-running the sidecar.
              if ((file as any)._dbPageCount !== indexResult.total_pages) {
                await db.update(jobFilesTable)
                  .set({ pageCount: indexResult.total_pages })
                  .where(eq(jobFilesTable.id, file.id));
              }
            }
            // Build the file's sheets and publish them atomically into its slot.
            // Guard on step2SidecarActive so a sidecar result that arrives after
            // the timeout fired is dropped (matches the old loop's break).
            if (step2SidecarActive) {
              const collected: typeof allSheets = [];
              for (const s of indexResult.sheets) {
                collected.push({ ...s, fileId: file.id });
              }
              perFileSheets[_fi] = collected;
            }
          }
        }
      }),
      new Promise<void>((resolve) =>
        setTimeout(() => { step2TimedOut = true; step2SidecarActive = false; resolve(); }, STEP2_TIMEOUT_MS),
      ),
    ]);

    // Flatten per-file results in original file order. Runs on both the
    // completed and timed-out branches; unfinished slots are simply undefined.
    for (const arr of perFileSheets) {
      if (arr) for (const s of arr) allSheets.push(s);
    }

    if (step2TimedOut) {
      logger.warn(
        "[pipeline] Drawing index parse timeout — continuing with sheet pattern matching fallback",
      );
    }

    // ── Partial synthesis: back-fill sheets for PDFs that got no sidecar result ─
    // When the drawing-index timeout fires mid-loop, the later PDFs in floorPlanFiles
    // never get their sidecar call completed.  Their pages would be silently skipped
    // in Steps 3-9 (vision scan, room extraction, sign placement) because no sheets
    // reference their fileId.  Synthesise one sheet per known page for each such PDF
    // so every uploaded file still gets a vision-scan pass even on a partial timeout.
    {
      const coveredFileIds = new Set(allSheets.map(s => s.fileId));
      for (let fi = 0; fi < floorPlanFiles.length; fi++) {
        const file = floorPlanFiles[fi];
        if (coveredFileIds.has(file.id)) continue;
        if (!file.filename.toLowerCase().endsWith(".pdf")) continue;
        const pageCount = Math.max(1, Math.min(file.pageCount ?? 1, 30));
        logger.warn(
          `[pipeline] Partial synthesis for ${file.filename}: no sidecar sheets — synthesising ${pageCount} page(s)`,
        );
        const baseTitle = file.filename.replace(/\.pdf$/i, "");
        // Infer level from filename first (e.g. "2nd Floor … .pdf" → "LEVEL 2"),
        // fall back to sequential page numbering for multi-page PDFs.
        const filenameLevel = getFloorFromSheetTitle(baseTitle);
        for (let p = 1; p <= pageCount; p++) {
          const synthLevel = filenameLevel ?? `LEVEL ${p}`;
          allSheets.push({
            sheet_id: `PLAN-${fi}-P${p}`,
            sheet_title: pageCount > 1 ? `${baseTitle} — Page ${p}` : baseTitle,
            pdf_page: p,
            sheet_type: "floor_plan",
            level: synthLevel,
            fileId: file.id,
          });
        }
      }
    }

    // ── Fast path: single-page PDFs with garbled sidecar titles ─────────────
    // The sidecar's parse-index reads raw text from the PDF title block.  For
    // some PDFs the text layer has reversed or mirrored character sequences
    // (e.g. "TCEJORP" = "PROJECT" reversed), producing nonsensical titles that
    // would cause classifySheetStep2 to skip the sheet.  A single-page PDF has
    // exactly one sheet on page 1, so when we detect a garbled title we can
    // safely replace it with a clean entry synthesized from the filename.
    // This runs after partial synthesis (which handles files with NO sidecar
    // result) so files with garbled-but-present sidecar results are also covered.
    {
      // Common reversed-word fragments that appear in garbled PDF text layers.
      const GARBLED_REVERSED = ["TCEJORP", "LIATNEDICNI", "GNIDLIUB", "NOITCURTSNOC", "NOITACOL", "TNEMTRAPED", "ROOLF"];
      for (const file of floorPlanFiles) {
        const filePageCount = (file as any).pageCount as number | null;
        if (filePageCount !== 1) continue;   // only single-page PDFs need this
        const fileSheets = allSheets.filter(s => s.fileId === file.id);
        if (fileSheets.length === 0) continue; // no sidecar result → partial synthesis already ran
        const hasGarbledTitle = fileSheets.some(s => {
          const t = (s.sheet_title ?? "").toUpperCase().trim();
          return (
            GARBLED_REVERSED.some(marker => t.includes(marker)) ||
            /^[\d\s]+$/.test(t) ||  // purely numeric / whitespace
            t.length < 3            // too short to be meaningful
          );
        });
        if (!hasGarbledTitle) continue;
        // Strip the garbled entries and replace with one clean synthesized sheet.
        allSheets = allSheets.filter(s => s.fileId !== file.id);
        // Normalise filename to space-separated words so getFloorFromSheetTitle
        // can match "FIRST FLOOR", "SECOND FLOOR", etc. (filename uses dashes).
        const baseName = file.filename.replace(/\.pdf$/i, "").replace(/[-_]+/g, " ").trim();
        const synthLevel = getFloorFromSheetTitle(baseName) ?? "LEVEL 1";
        const synthId = `PLAN-${file.id.slice(-6)}-P1`;
        logger.log(
          `[pipeline] Fast path: single-page PDF "${file.filename}" has garbled sidecar title ` +
          `— synthesizing sheet "${baseName}" (level=${synthLevel})`,
        );
        allSheets.push({
          sheet_id: synthId,
          sheet_title: baseName,
          pdf_page: 1,
          sheet_type: "floor_plan",
          level: synthLevel,
          fileId: file.id,
        });
      }
    }

    // ── 3-Category Sheet Classification ──────────────────────────────────────
    // Every sheet is classified into one of six buckets regardless of set size:
    //   interior      — floor plan sheets (room extraction)
    //   sign_docs     — sign schedules, A0-series, signage notes (schedule extraction)
    //   sign_details  — signage detail/specialty sheets (specialty extraction)
    //   exterior      — site plans, elevations, exterior signage
    //   skip          — MEP, structural, civil, and other non-architectural sheets

    // ── Floor-level normalization from sheet title ────────────────────────────
    // Maps human-readable sheet titles like "First Floor Academic Wing" → "LEVEL 1".
    // Handles DiNisco-style ("Signage Plan - First Floor Academic Wing"),
    // generic ("Floor Plan Level 2"), and ordinal ("Second Floor Community Wing").
    function getFloorFromSheetTitle(title: string): string | null {
      const t = (title ?? "").toLowerCase();
      if (/first\s+floor|floor\s*[-\s]?1|level\s*[-\s]?1|ground\s+floor/.test(t)) return "LEVEL 1";
      if (/second\s+floor|floor\s*[-\s]?2|level\s*[-\s]?2/.test(t)) return "LEVEL 2";
      if (/third\s+floor|floor\s*[-\s]?3|level\s*[-\s]?3/.test(t)) return "LEVEL 3";
      if (/fourth\s+floor|floor\s*[-\s]?4|level\s*[-\s]?4/.test(t)) return "LEVEL 4";
      if (/fifth\s+floor|floor\s*[-\s]?5|level\s*[-\s]?5/.test(t)) return "LEVEL 5";
      if (/basement|lower\s+level/.test(t)) return "LEVEL B1";
      if (/\blevel\s*[-\s]?b\b/.test(t)) return "LEVEL B1";
      if (/mezzanine/.test(t)) return "MEZZANINE";
      if (/\broof\b/.test(t)) return "ROOF";
      const ordinal = t.match(/(\d+)(?:st|nd|rd|th)?\s+floor/);
      if (ordinal) return `LEVEL ${ordinal[1]}`;
      return null;
    }

    // Early restroom set detection — kept for downstream vision-scan prompt tuning.
    const EARLY_RESTROOM_KW = /\b(TOILET|RESTROOM|LAVATORY)\b|\bRR\b/i;
    const _aSeries = allSheets.filter(s => /^A\d/i.test(s.sheet_id));
    const likelyRestroomSet = _aSeries.length > 0 &&
      (_aSeries.filter(s => EARLY_RESTROOM_KW.test(s.sheet_title ?? "")).length / _aSeries.length) >= 0.5;
    if (likelyRestroomSet) {
      logger.log(`[pipeline] Early restroom detection: restroom-focused drawing set — enlarged/RCP sheets will be rescued`);
    }

    // ── Slot override helpers ─────────────────────────────────────────────────
    // When the user explicitly tags a file via the structured upload slots,
    // skip classifySheetStep2 and trust the user's choice directly.
    function getSlotOverrideSheetType(fileCategory: string | null | undefined): "floor_plan" | "room_schedule" | "sign_schedule" | null {
      if (fileCategory === "floor_plan") return "floor_plan";
      if (fileCategory === "room_schedule") return "room_schedule";
      if (fileCategory === "sign_schedule") return "sign_schedule";
      return null;
    }

    // Parse a human-readable floor label into a pipeline level string.
    // e.g. "First floor" → "LEVEL 1", "Floors 1–3" → "LEVEL 1" (first in range)
    function parseLevelFromLabel(label: string): string | null {
      const l = label.trim().toLowerCase();
      if (/first\s+floor|1st\s+floor/.test(l)) return "LEVEL 1";
      if (/second\s+floor|2nd\s+floor/.test(l)) return "LEVEL 2";
      if (/third\s+floor|3rd\s+floor/.test(l)) return "LEVEL 3";
      if (/fourth\s+floor|4th\s+floor/.test(l)) return "LEVEL 4";
      if (/fifth\s+floor|5th\s+floor/.test(l)) return "LEVEL 5";
      if (/basement|b1/.test(l)) return "LEVEL B1";
      const ordMatch = l.match(/(\d+)(?:st|nd|rd|th)?\s+floor/);
      if (ordMatch) return `LEVEL ${ordMatch[1]}`;
      const rangeMatch = l.match(/floors?\s*(\d+)\s*[-–]\s*\d+/i);
      if (rangeMatch) return `LEVEL ${rangeMatch[1]}`;
      const levelMatch = l.match(/level\s*(\w+)/i);
      if (levelMatch) return `LEVEL ${levelMatch[1].toUpperCase()}`;
      return null;
    }

    // Infers a floor label from a filename when the user hasn't set one in the UI.
    // Handles patterns like LEVELS-03-06, LEVEL-03-06, FLOORS-3-6, FL-3-6.
    // Returns a "Floors N-M" or "Floor N" string, or null if no match.
    function inferFloorLabelFromFilename(filename: string): string | null {
      const name = filename.toUpperCase();
      const rangeMatch = name.match(/(?:LEVELS?|FLOORS?|FL)[_\-\s]{1,3}(0?\d+)[_\-\s]{1,3}(?:TO[_\-\s]{1,3})?(0?\d+)/i);
      if (rangeMatch) {
        const result = `Floors ${parseInt(rangeMatch[1], 10)}-${parseInt(rangeMatch[2], 10)}`;
        logger.log(`[pipeline] inferFloorLabel("${filename}") → "${result}"`);
        return result;
      }
      const singleMatch = name.match(/(?:LEVELS?|FLOORS?|FL)[_\-\s]{1,3}(0?\d+)/i);
      if (singleMatch) {
        const result = `Floor ${parseInt(singleMatch[1], 10)}`;
        logger.log(`[pipeline] inferFloorLabel("${filename}") → "${result}"`);
        return result;
      }
      logger.log(`[pipeline] inferFloorLabel("${filename}") → null`);
      return null;
    }

    // Detects range floor labels ("Floors 3-6", "Levels 3-6", "3rd-6th Floor", "Floor 3-6").
    // Returns a levels array (numeric) and a replicate flag.
    // Single-floor labels return replicate=false; range labels return replicate=true.
    function parseFloorLabelRange(label: string): { levels: number[]; replicate: boolean } {
      if (!label) return { levels: [], replicate: false };
      const l = label.trim().toLowerCase();
      // Range patterns: "Floors 3-6", "Levels 3-6", "3rd-6th Floor", "Floor 3-6"
      const rangeMatch = l.match(/(\d+)\s*[-–to]+\s*(\d+)/i);
      if (rangeMatch) {
        const start = parseInt(rangeMatch[1], 10);
        const end   = parseInt(rangeMatch[2], 10);
        if (!isNaN(start) && !isNaN(end) && end > start && (end - start) <= 20) {
          const levels = Array.from({ length: end - start + 1 }, (_, i) => start + i);
          return { levels, replicate: true };
        }
      }
      // Single level: "Floor 3", "Level 2", "3rd Floor", "First Floor"
      const singleMatch = l.match(/(\d+)/);
      if (singleMatch) return { levels: [parseInt(singleMatch[1], 10)], replicate: false };
      return { levels: [], replicate: false };
    }

    type SheetCategory = "interior" | "sign_docs" | "sign_details" | "exterior" | "room_schedule" | "skip";

    const SKIP_PREFIXES = /^(E|M|P|S|C|FP|MP|SP|LS)[-.\s\d]/i;
    const SKIP_TITLE_KW = [
      "ELECTRICAL", "MECHANICAL", "PLUMBING", "STRUCTURAL",
      "REFLECTED CEILING", "LIGHTING PLAN", "POWER PLAN",
      "DATA PLAN", "FIRE PROTECTION", "SPRINKLER", "CIVIL",
      "MATERIAL SCHEDULE", "FURNITURE SCHEDULE",
      "EQUIPMENT SCHEDULE", "FIXTURE SCHEDULE", "LIGHTING SCHEDULE",
      "HARDWARE SCHEDULE", "INTERIOR FINISH", "FINISH LEGEND",
      "MATERIAL LEGEND", "KEYNOTE LEGEND", "KEYNOTE SCHEDULE",
      "DESIGN DEVELOPMENT", "PERMIT DRAWING", "CODE ANALYSIS",
      "ACCESSIBILITY ANALYSIS", "LIFE SAFETY PLAN", "AREA CALCULATION",
      "ZONING ANALYSIS",
    ];
    const CAT1_TITLE_KW = [
      "FLOOR PLAN", "LEVEL", "GROUND FLOOR", "BASEMENT", "MEZZANINE",
      "PENTHOUSE", "ENLARGED PLAN", "ENLARGED FLOOR",
      "SIGNAGE PLAN", "SIGN PLAN",  // dedicated signage floor plans (room label extraction)
    ];
    const CAT2_TITLE_KW = [
      "SIGN SCHEDULE", "SIGN SPEC", "SIGNAGE SCHEDULE", "SIGN TYPE", "SIGN LEGEND",
      "SIGN NOTES", "SIGN CRITERIA", "SIGN MATRIX",
      "INTERIOR SIGNAGE SCHEDULE",
      "DIVISION 10", "DOOR SCHEDULE",
    ];
    // Specialty / detail signage sheets — contain dimensional letters, wall graphics,
    // exterior signs, interpretive panels, etc. Processed separately from floor plans.
    const CAT_SPECIALTY_KW = [
      "SIGN DETAIL", "SIGNAGE DETAIL", "SIGNING DETAIL",
      "EXTERIOR SIGNAGE", "SITE SIGN", "EXTERIOR SIGN",
      "WALLCOVERING", "WALL COVERING", "WALL GRAPHIC", "MURAL",
      "INTERPRETIVE", "LEED SIGN", "WAYFINDING DETAIL",
      "DIMENSIONAL LETTER", "CHANNEL LETTER", "BLADE SIGN",
      "ENLARGED SIGNAGE", "TRAILHEAD", "KIOSK",
      "DONOR", "RECOGNITION WALL", "MONUMENT SIGN",
      "PLAQUE SCHEDULE", "PLAQUE DETAIL", "MOUNTING DETAIL", "MOUNTING HEIGHT",
      // Sign panel / substrate details — physical construction details only.
      // NOTE: "ACRYLIC INSERT" and "INSERT PANEL" intentionally excluded: DiNisco-style
      // sheets titled "SIGN TYPE A | ACRYLIC INSERT PANEL" are sign-type definitions
      // (schedule-bearing) and must reach CAT2_TITLE_KW ("SIGN TYPE") → sign_docs.
      "SIGN PANEL", "SIGN SUBSTRATE",
      "SIGN FACE", "SIGN FRAME", "SIGN ASSEMBLY",
      // Wayfinding packages (garage/campus/hospital wayfinding systems)
      "WAYFINDING PLAN", "WAYFINDING LAYOUT", "WAYFINDING SYSTEM",
      "WAYFINDING SIGNAGE", "WAYFINDING",
      // Signage location / parking / garage signage
      "PARKING SIGNAGE", "GARAGE SIGNAGE", "DIRECTIONAL SIGNAGE",
      "SIGN LOCATION PLAN", "SIGNAGE LOCATION",
      // Signage plans — route to sign_details, not interior (overrides CAT1_TITLE_KW)
      "SIGNAGE PLAN",
    ];
    const CAT3_TITLE_KW = [
      "SITE PLAN", "EXTERIOR ELEVATION", "BUILDING ELEVATION",
      "FACADE", "LANDSCAPE", "HARDSCAPE",
      "MONUMENT", "PYLON", "PARKING PLAN", "SITE SIGNAGE",
      "EXTERIOR PERSPECTIVE", "RENDERING",
    ];
    // Column headers that identify an embedded sign schedule table
    const SIGN_TABLE_COLS = ["ROOM #", "SIGN TYPE", "SIGN ID", "MESSAGE", "LOCATION", "QTY"];

    function classifySheetStep2(
      sheetId: string,
      sheetTitle: string,
      sheetType: string,
    ): { category: SheetCategory; reason: string } {
      const id = (sheetId ?? "").toUpperCase().trim();
      const title = (sheetTitle ?? "").toUpperCase().trim();

      // SKIP: MEP / non-arch discipline prefix
      if (SKIP_PREFIXES.test(id)) {
        return { category: "skip", reason: `Discipline prefix: ${id.match(/^[A-Z]+/)?.[0] ?? id}` };
      }
      // ROOM_SCHEDULE: finish / room schedule sheets — checked before SKIP_TITLE_KW so
      // "FINISH SCHEDULE" in the title routes here instead of being discarded as a skip.
      const ROOM_SCHEDULE_KW = [
        "FINISH SCHEDULE",
        "ROOM SCHEDULE",
        "ROOM FINISH SCHEDULE",
        "ROOM FINISH PLAN",
        "FINISH & SCHEDULE",
        "SCHEDULES",
      ];
      if (ROOM_SCHEDULE_KW.some(kw => title.includes(kw))) {
        return { category: "room_schedule", reason: `Room schedule keyword in title` };
      }
      // Sheet ID pattern: A-7xx series = finish/schedule sheets per standard
      // architectural numbering convention (e.g. A-710 finish schedule).
      if (/^A-?7\d{2}$/i.test(sheetId.trim())) {
        logger.log(
          `[pipeline] Sheet ${sheetId} classified as room_schedule (A-7xx finish schedule convention)`,
        );
        return { category: "room_schedule", reason: `A-7xx finish schedule convention` };
      }
      // SKIP: non-arch title keywords
      const skipKw = SKIP_TITLE_KW.find(kw => title.includes(kw));
      if (skipKw) return { category: "skip", reason: `Skip keyword: ${skipKw}` };
      // SKIP: section sheets unless signage section or sidecar explicitly says floor_plan.
      // The sidecar uses visual layout analysis; if it classified the sheet as floor_plan
      // we trust that over a title-keyword match — garbled or reversed PDF text layers
      // can produce spurious "BUILDING SECTION" strings on otherwise valid floor plans.
      // The vision AI in Step 3 provides a final check (isPlanView) as a safety net.
      if (/\bSECTION\b/.test(title) && !/SIGN(AGE)?/.test(title) && sheetType !== "floor_plan") {
        return { category: "skip", reason: "Section sheet (not signage section)" };
      }

      // SPECIALTY/DETAIL: check BEFORE trusting sidecar's floor_plan classification.
      // The sidecar occasionally misclassifies sign-panel detail sheets (e.g. DiNisco
      // "SIGN TYPE A | ACRYLIC INSERT PANEL BY ARCHITECT") as floor_plan because their
      // numeric-dotted IDs (3.9.56) default to floor_plan when no signage keyword matches.
      // CAT_SPECIALTY_KW terms are specific enough that false-positives on real floor plans
      // are extremely unlikely, so we let them override the sidecar's floor_plan call.
      const specialtyKw = CAT_SPECIALTY_KW.find(kw => title.includes(kw));
      if (specialtyKw) return { category: "sign_details", reason: `Specialty keyword: ${specialtyKw}` };

      // CAT 1 (HIGH PRIORITY): sidecar explicitly classified as floor_plan.
      // The sidecar has considered the full page layout; trust its judgment (after
      // specialty keyword check above, which handles misclassified sign-detail sheets).
      if (sheetType === "floor_plan") {
        return { category: "interior", reason: "Sidecar classified as floor_plan" };
      }

      // CAT 2: sign documents — sidecar classification
      if (sheetType === "signage_schedule") {
        return { category: "sign_docs", reason: "Sidecar classified as signage_schedule" };
      }

      // SKIP: non-signage detail sheets (after specialty check above)
      if (/\bDETAIL\b/.test(title) && !/SIGN/.test(title)) {
        return { category: "skip", reason: "Detail sheet (not sign detail)" };
      }
      // CAT 2: A0-series (general/signage notes sheets)
      if (/^A0/i.test(id)) {
        return { category: "sign_docs", reason: "A0-series sheet number" };
      }
      // CAT 2: title keyword match
      const cat2Kw = CAT2_TITLE_KW.find(kw => title.includes(kw));
      if (cat2Kw) return { category: "sign_docs", reason: `Sign doc keyword: ${cat2Kw}` };

      // CAT 3: exterior sheets
      const cat3Kw = CAT3_TITLE_KW.find(kw => title.includes(kw));
      if (cat3Kw) return { category: "exterior", reason: `Exterior keyword: ${cat3Kw}` };

      // SKIP: A-400+ series only when sidecar did NOT call it floor_plan AND title has no floor-plan signal.
      // Rationale: sidecar's floor_plan classification is valuable — don't discard it for high-number
      // A sheets that happen to be real floor plans (e.g. A-400 could be enlarged floor details).
      // Only skip when both conditions confirm it is NOT a floor plan.
      const isHighNumberASheet = /^A[-.]?[4-9]\d{2}/i.test(id);
      const titleHasFloorPlanSignal = CAT1_TITLE_KW.some(kw => title.includes(kw));
      if (isHighNumberASheet && !titleHasFloorPlanSignal && sheetType !== "floor_plan") {
        return { category: "skip", reason: "A-series detail sheet (A400+, no floor-plan signal, sidecar not floor_plan)" };
      }
      // CAT 1: A-series architectural floor plans (original broad catch — sidecar already filtered above)
      if (/^A[-.]?\d/i.test(id)) {
        return { category: "interior", reason: "A-series sheet number" };
      }
      // CAT 1: floor plan title keywords
      const cat1Kw = CAT1_TITLE_KW.find(kw => title.includes(kw));
      if (cat1Kw) return { category: "interior", reason: `Floor plan keyword: ${cat1Kw}` };

      // Default: skip unknowns
      return { category: "skip", reason: "No matching pattern" };
    }

    // Build slot override map: fileId → override type.
    // Files uploaded via a named slot bypass classifySheetStep2 entirely.
    //
    // Guard for floor_plan: 28 legacy files in production already carry
    // fileCategory="floor_plan" as a pre-structured-UI tag. We only apply the
    // bypass when floorLabel is also set — the new StructuredUploader always
    // PATCHes floorLabel on blur, so its presence confirms a new-slot upload.
    // room_schedule is genuinely new (zero legacy files) → always bypass.
    // sign_schedule produces the same result with or without the bypass.
    const slotOverrideByFileId = new Map<string, "floor_plan" | "room_schedule" | "sign_schedule">();
    for (const file of floorPlanFiles) {
      const override = getSlotOverrideSheetType(file.fileCategory);
      if (!override) continue;
      if (override === "floor_plan" && !file.floorLabel?.trim()) {
        logger.log(`[pipeline] Slot override skipped: "${file.filename}" has fileCategory=floor_plan but no floorLabel — treating as legacy tag, using auto-classifier`);
        continue;
      }
      slotOverrideByFileId.set(file.id, override);
      logger.log(`[pipeline] Slot override: "${file.filename}" (${file.fileCategory}) → ${override} — bypassing classifier`);
    }

    // Classify all sheets — slot-tagged files bypass classifySheetStep2
    const classifications: Array<{ category: SheetCategory; reason: string }> =
      allSheets.map(s => {
        const slotOverride = slotOverrideByFileId.get(s.fileId);
        if (slotOverride === "floor_plan")    return { category: "interior"      as SheetCategory, reason: "slot:floor_plan" };
        if (slotOverride === "room_schedule") return { category: "room_schedule" as SheetCategory, reason: "slot:room_schedule" };
        if (slotOverride === "sign_schedule") return { category: "sign_docs"     as SheetCategory, reason: "slot:sign_schedule" };
        return classifySheetStep2(s.sheet_id, s.sheet_title ?? "", s.sheet_type);
      });

    // Restroom set rescue: pull SKIP sheets back to interior if they have restroom/enlarged keywords
    if (likelyRestroomSet) {
      const RESTROOM_RESCUE = /\b(TOILET|RESTROOM|BATHROOM|LAVATORY|ENLARGED)\b|\bRCP\b|\bRR\b/i;
      for (let i = 0; i < allSheets.length; i++) {
        if (classifications[i]?.category === "skip" && RESTROOM_RESCUE.test(allSheets[i].sheet_title ?? "")) {
          classifications[i] = { category: "interior", reason: "Restroom set rescue" };
        }
      }
    }

    // Embedded sign schedule table detection — scan every non-skip, non-cat2 sheet
    // for tables whose header row contains ≥2 sign-schedule column names.
    // Also exclude sign_details sheets: CAT_SPECIALTY_KW classification is explicit
    // and must not be overridden by a table-column heuristic — sign panel detail
    // sheets (e.g. "SIGN TYPE A | ACRYLIC INSERT PANEL") often have spec tables
    // with columns like "SIGN TYPE", "MESSAGE", "QTY" that would trigger false reclassification.
    if (sidecarOk) {
      const scanIndices = allSheets
        .map((_, i) => i)
        .filter(i => classifications[i]?.category !== "skip" && classifications[i]?.category !== "sign_docs" && classifications[i]?.category !== "sign_details");
      logger.log(`[pipeline] Scanning ${scanIndices.length} sheet(s) for embedded sign schedule tables…`);
      for (const i of scanIndices) {
        const s = allSheets[i];
        const buf = pdfBufferByFileId.get(s.fileId);
        if (!buf) continue;
        try {
          const tableResult = await extractTable(buf, s.pdf_page, s.fileId + ".pdf");
          const hits = new Set<string>();
          for (const table of tableResult.tables) {
            const firstRow = (table[0] ?? []).map(c => (c ?? "").toUpperCase());
            for (const col of SIGN_TABLE_COLS) {
              if (firstRow.some(cell => cell.includes(col))) hits.add(col);
            }
          }
          if (hits.size >= 2) {
            logger.log(
              `[pipeline] Sheet ${s.sheet_id} p.${s.pdf_page}: embedded sign table cols [${[...hits].join(", ")}] → reclassified to sign_docs`,
            );
            classifications[i] = { category: "sign_docs", reason: `Embedded sign table (${[...hits].join(", ")})` };
          }
        } catch {
          // Silently skip table scan errors per-sheet
        }
      }
    }

    // Apply classifications: update sheet_type and filter out skipped sheets.
    // Also apply getFloorFromSheetTitle() so multi-wing sheets on the same floor
    // (e.g. "First Floor Academic Wing" + "First Floor Community Wing") both get
    // the same level value (LEVEL 1), collapsing them into one floor tab.
    for (let i = 0; i < allSheets.length; i++) {
      const cat = classifications[i]?.category;
      const s = allSheets[i] as Record<string, unknown>;
      if (cat === "sign_docs") s.sheet_type = "signage_schedule";
      else if (cat === "exterior") s.sheet_type = "exterior";
      else if (cat === "interior") s.sheet_type = "floor_plan";
      else if (cat === "sign_details") s.sheet_type = "sign_details";
      else if (cat === "room_schedule") s.sheet_type = "room_schedule";
      // Apply floor-level normalization from title — overrides raw sidecar level
      // when the title is more authoritative (e.g. "Second Floor Community Wing").
      const titleLevel = getFloorFromSheetTitle(String(allSheets[i].sheet_title ?? ""));
      if (titleLevel && cat === "interior") {
        (s as Record<string, unknown>).level = titleLevel;
      }
    }

    {
      const interiorCount      = classifications.filter(c => c.category === "interior").length;
      const signDocsCount      = classifications.filter(c => c.category === "sign_docs").length;
      const signDetailCount    = classifications.filter(c => c.category === "sign_details").length;
      const exteriorCount      = classifications.filter(c => c.category === "exterior").length;
      const roomScheduleCount  = classifications.filter(c => c.category === "room_schedule").length;
      const skippedCount       = classifications.filter(c => c.category === "skip").length;
      const totalCount         = allSheets.length;
      logger.log(
        `[pipeline] Classified ${interiorCount} floor plan, ${signDocsCount} sign docs, ` +
        `${signDetailCount} sign details, ${exteriorCount} exterior, ` +
        `${roomScheduleCount} room schedule, ${skippedCount} skipped ` +
        `out of ${totalCount} sheets`,
      );
      // Full sheet inventory log (matches spec format)
      logger.log(`[pipeline] Sheet inventory (${totalCount} total):`);
      for (let i = 0; i < allSheets.length; i++) {
        const s = allSheets[i];
        const cat = classifications[i]?.category;
        const catLabel = cat === "interior" ? "FLOOR_PLAN" : cat === "sign_docs" ? "SIGN_DOCS"
          : cat === "sign_details" ? "SIGN_DETAILS" : cat === "exterior" ? "EXTERIOR"
          : cat === "room_schedule" ? "ROOM_SCHEDULE" : "SKIP";
        const icon = cat === "skip" ? "⏭" : "✅";
        logger.log(`  ${icon} p${s.pdf_page}: ${s.sheet_id} — ${s.sheet_title ?? "(no title)"} [${catLabel}]`);
      }
    }

    allSheets = allSheets.filter((_, i) => classifications[i]?.category !== "skip");

    // If no sheets found from index, create synthetic sheets for every PDF page.
    // Use FP-{fileIndex}-P{page} IDs so they never collide with the A-001/A-002
    // administrative-sheet exclusion list.  Default to sizeCap pages when pageCount is
    // unknown so multi-page PDFs without metadata still get all pages scanned;
    // the isPlanView gate in Step 3 will naturally discard non-floor-plan pages.

    // Size-based page cap — keeps synthesized sheet counts proportional to file complexity.
    // Files with null page_count and large size are assumed to be multi-floor permit sets.
    // Small files (<20 MB)  :  5 pages  (single-floor buildings)
    // Medium files (20–100 MB): 8 pages  (mid-size permit sets)
    // Large files (>100 MB) : 15 pages  (large multi-floor permit sets like Cambridge Moses)
    const synthSizeCap = maxFileSizeMB > 100 ? 15 : maxFileSizeMB > 20 ? 8 : 5;
    let didSynthesize = false;
    let totalSynthesized = 0;

    if (allSheets.length === 0) {
      didSynthesize = true;
      logger.warn("[pipeline] No sheets found via drawing index — synthesising floor plan sheets for all PDF pages");
      for (let fileIndex = 0; fileIndex < floorPlanFiles.length; fileIndex++) {
        const file = floorPlanFiles[fileIndex];
        if (!file.filename.toLowerCase().endsWith(".pdf")) continue;

        const fileSizeMBForSynth = (file.fileSizeBytes ?? 0) / 1024 / 1024;
        // When the file reports its actual page count, trust it (capped at 30 to
        // guard against corrupt metadata).  Fall back to synthSizeCap only when
        // page_count is unknown so multi-page PDFs without metadata still get
        // a reasonable number of synthetic sheets.
        const pageCount = Math.max(3, Math.min(file.pageCount ?? synthSizeCap, 30));
        logger.log(`[pipeline] Synthesising file ${fileIndex + 1}/${floorPlanFiles.length}: ${file.filename}`);
        logger.log(`[pipeline] Synthesising ${pageCount} page(s) for ${file.filename} (${fileSizeMBForSynth.toFixed(1)} MB, detected=${file.pageCount ?? "unknown"}, synthSizeCap=${synthSizeCap})`);

        for (let p = 1; p <= pageCount; p++) {
          const estimatedLevel = `LEVEL ${p}`;
          allSheets.push({
            sheet_id: `PLAN-${fileIndex}-P${p}`,
            sheet_title: `FLOOR PLAN LEVEL ${p}`,
            pdf_page: p,
            sheet_type: "floor_plan",
            level: estimatedLevel,
            fileId: file.id,
          });
          totalSynthesized++;
        }
      }
    }

    // Partial coverage synthesis — when the sidecar detected SOME sheets but not
    // all pages of a multi-page PDF (e.g. NOVO where sidecar found 2 of 5 pages),
    // synthesize the missing pages so the pipeline processes the full document.
    for (const file of floorPlanFiles) {
      const totalPages = (file as any).pageCount as number | null;
      if (!totalPages || totalPages <= 1) continue;

      const coveredPages = new Set(
        allSheets
          .filter(s => s.fileId === file.id)
          .map(s => s.pdf_page),
      );

      if (coveredPages.size >= totalPages) continue;

      const missing = totalPages - coveredPages.size;
      logger.log(
        `[pipeline] Partial coverage: ${file.filename} — ` +
        `${coveredPages.size}/${totalPages} pages covered, synthesizing ${missing} missing page(s).`,
      );

      for (let page = 1; page <= totalPages; page++) {
        if (coveredPages.has(page)) continue;
        allSheets.push({
          sheet_id: `PLAN-${file.id.slice(-6)}-P${page}`,
          sheet_title: `Floor Plan Level ${page}`,
          pdf_page: page,
          sheet_type: "floor_plan",
          level: `LEVEL ${page}`,
          fileId: file.id,
        });
        totalSynthesized++;
        didSynthesize = true;
      }
    }

    // For synthesized-sheet jobs, pin the vision cap to the ACTUAL number of
    // synthesized pages (which respects file.pageCount when available) rather than
    // the size-based synthSizeCap fallback.  This ensures a 6-page PDF that the
    // sidecar failed to index still gets all 6 pages vision-scanned.
    if (didSynthesize) {
      // Don't cap vision calls to the number of synthesized sheets.
      // Partial coverage synthesis adds real floor plan pages that all need vision.
      // Use rawVisionCap directly — tenant/default controls the ceiling.
      effectiveVisionCap = rawVisionCap;
      logger.log(`[pipeline] Synthesized-sheet job — vision cap = rawVisionCap=${rawVisionCap} (totalSynthesized=${totalSynthesized})`);
    }

    // ── Step 4b: Sheet reclassification ───────────────────────────────────────
    // Reclassify any sheet whose title matches signage-notes patterns as
    // signage_schedule so Step B can extract the project sign dictionary from it.
    // A0.x sheets are ALWAYS treated as signage notes candidates — the sidecar
    // often returns a garbled label (e.g. "SHEET") from the title-block label
    // field rather than the actual drawing title; we rely on the sheet number
    // as the authoritative classifier rather than the (potentially garbled) title.
    // Matches sign schedule / notes / type-definition sheet titles.
    // Catches: SIGNAGE, SIGN SCHEDULE, SIGN NOTES, SIGN TYPE(S), SIGN LEGEND,
    //          SIGN CRITERIA, SIGN SPEC, DIVISION 10 (spec section for signage),
    //          SIGNAGE AND GENERAL NOTES (Gleason-style combined sheet title),
    //          GENERAL NOTES (catches sidecar-truncated version of the above).
    const SIGNAGE_NOTES_DETECT =
      /\b(SIGNAGE|SIGN\s+SCHEDULE|SIGN\s+NOTES?|SIGN\s+TYPES?|SIGN\s+LEGEND|SIGN\s+CRITERIA|SIGN\s+SPEC|DIVISION\s*10|SIGNAGE\s+AND\s+GENERAL\s+NOTES|GENERAL\s+NOTES)\b/i;
    const _signageNotesFound: string[] = [];
    // Pass 2 (3-pass detection): Step 4b promotes sign-document sheets to
    // signage_schedule so Step B can extract the project sign dictionary.
    // Guard: skip sheets already classified as signage_schedule or sign_details.
    // sign_details sheets (set by classifySheetStep2 via CAT_SPECIALTY_KW) must
    // not be re-promoted here — they are dedicated specialty/detail sheets whose
    // primary extraction is Step 9.2 (specialty signs).
    logger.log(`[Step 4b] Reclassifying sheets — scanning ${allSheets.length} sheets...`);
    for (const s of allSheets) {
      if (s.sheet_type !== "signage_schedule" && s.sheet_type !== "sign_details") {
        // title match: "SIGNAGE AND GENERAL NOTES", "SIGN SCHEDULE", "SIGN TYPES", etc.
        const titlematch = SIGNAGE_NOTES_DETECT.test(s.sheet_title ?? "");
        // A0.x / A-0.x match: any A0-series sheet is a general/signage notes candidate
        // regardless of what the sidecar extracted as the title.
        const a0match = /^A0[.\-]/i.test(s.sheet_id) || /^A[-.]0/i.test(s.sheet_id);
        if (titlematch || a0match) {
          (s as Record<string, unknown>).sheet_type = "signage_schedule";
          _signageNotesFound.push(s.sheet_id);
          logger.log(`[Step 4b] → ${s.sheet_id} classified as signage_schedule (title="${s.sheet_title ?? ""}", titlematch=${titlematch}, a0match=${a0match})`);
        }
      }
    }
    logger.log(`[Step 4b] Found ${_signageNotesFound.length} signage notes sheet(s): ${_signageNotesFound.join(", ") || "NONE"}`);

    // ── Diagnostic: log every sheet with its final classification ─────────────
    for (const s of allSheets) {
      logger.log(
        `[sheet-diag] Sheet: number='${s.sheet_id}' title='${s.sheet_title ?? ""}' ` +
        `category='${s.sheet_type}' page=${s.pdf_page ?? 1}`,
      );
    }

    await wp("4b", "Reclassifying signage sheets");

    // Deduplicate sheets: if the same PDF is uploaded more than once every
    // loop iteration emits the same (sheet_id, pdf_page, fileId) triple.
    // fileId is included in the key so that two *different* files that both
    // appear in each other's drawing index (e.g. a set of single-page PDFs
    // where every title block lists all sheets in the project) are NOT
    // collapsed — each file keeps its own copy of every sheet it references.
    // Same-file duplicates (the original intent: the same PDF uploaded twice)
    // still dedupe correctly because both copies share the same fileId.
    const _sheetDedupeKeys = new Set<string>();
    const dedupedSheets = allSheets.filter((s) => {
      const key = `${s.sheet_id}|${s.pdf_page}|${s.fileId ?? ""}`;
      if (_sheetDedupeKeys.has(key)) return false;
      _sheetDedupeKeys.add(key);
      return true;
    });
    if (dedupedSheets.length < allSheets.length) {
      logger.log(`[pipeline] Deduped sheets: ${allSheets.length} → ${dedupedSheets.length} (removed ${allSheets.length - dedupedSheets.length} duplicate(s) caused by multiple uploads of the same PDF)`);
    }

    logger.log(`[pipeline] ${dedupedSheets.length} sheets identified`);

    // Record sheet count so subsequent writeProgress calls scale the time estimate.
    _knownSheetCount = dedupedSheets.length;

    // Insert sheets into DB
    const sheetDbRows: typeof jobSheetsTable.$inferInsert[] = dedupedSheets.map((s) => ({
      id: newId("sheet"),
      jobId,
      tenantId,
      fileId: s.fileId,
      sheetId: s.sheet_id,
      sheetTitle: s.sheet_title,
      pdfPage: s.pdf_page,
      sheetType: s.sheet_type,
      level: s.level,
      // Two-pass classifier: every sheet that isn't hard-excluded by Pass 1
      // (discipline prefix or impossible-plan title keyword) is rasterized and
      // sent to vision. The AI's isPlanView field is the authoritative Pass 2 result.
      // This replaces the old number-pattern whitelist (A-1XX/2XX/3XX) which
      // broke on plan sets that use non-standard sheet numbering or titles.
      //
      // Note: s.sheet_type here reflects the *post-classification* type set by
      // classifySheetStep2 (all "skip" sheets were already removed from allSheets).
      // A sheet_type of "floor_plan" at this point means the full classifier
      // confirmed it as an interior floor plan — trust that even when the sidecar's
      // raw title text is garbled (e.g. reversed/mirrored PDF text layers that produce
      // spurious "SECTION" strings), since shouldRunVisionScan works on raw titles.
      // The vision AI's isPlanView flag in Step 3 remains the final safety net.
      isRelevant: shouldRunVisionScan(s.sheet_id, s.sheet_title ?? null) ||
        s.sheet_type === "signage_schedule" || // signage sheets always stay relevant for Step 4
        s.sheet_type === "floor_plan" ||       // classifier-confirmed floor plan (overrides garbled-title false-negatives)
        s.sheet_type === "room_schedule",      // finish/room schedule sheets — used in Step 4 for room extraction
    }));

    if (sheetDbRows.length > 0) {
      await db.insert(jobSheetsTable).values(sheetDbRows);
    }

    // ── Ensure sign_schedule files have job_sheets rows for Step 3a ──────────
    // sign_schedule files are excluded from floorPlanFiles (Fix 1) so they never
    // go through the sidecar sheet-index path above.  If AA831 (or any file with
    // file_category=sign_schedule) has no rows in job_sheets, Step 3a finds zero
    // signage_schedule sheets and the 300 DPI retry is unreachable.  Synthesise
    // one row per page so Step 3a can process every page of the schedule.
    for (const sigFile of dedicatedSignScheduleFiles) {
      const existingSheets = sheetDbRows.filter(s => s.fileId === sigFile.id);
      if (existingSheets.length > 0) continue; // already parsed by sidecar

      // When page_count is null in job_files (sign_schedule files bypass the
      // normal sidecar path so page_count is never written), read the actual
      // count from the PDF bytes via pdf-lib so every page gets a sheet row.
      let pageCount: number = (sigFile as any).pageCount ?? 0;
      if (!pageCount) {
        try {
          const _schedBuf = await downloadFromStorage((sigFile as any).storagePath);
          const _schedDoc = await PDFDocument.load(_schedBuf, { ignoreEncryption: true });
          pageCount = _schedDoc.getPageCount();
          // Persist so future runs skip this download
          await db.update(jobFilesTable)
            .set({ pageCount })
            .where(eq(jobFilesTable.id, sigFile.id));
          logger.log(`[pipeline] sign_schedule page count resolved via pdf-lib: ${pageCount} for ${(sigFile as any).filename}`);
        } catch (_e) {
          pageCount = 1;
          logger.warn(`[pipeline] Could not resolve page count for ${(sigFile as any).filename}, defaulting to 1: ${_e}`);
        }
      }
      logger.log(`[pipeline] Synthesising ${pageCount} signage_schedule sheet(s) for ${(sigFile as any).filename}`);
      for (let p = 1; p <= pageCount; p++) {
        const synthSheet: typeof jobSheetsTable.$inferInsert = {
          id: newId("sheet"),
          jobId,
          tenantId,
          sheetId: `SIGN-SCHED-${sigFile.id.slice(-6)}-P${p}`,
          sheetTitle: `Sign Schedule Page ${p}`,
          pdfPage: p,
          sheetType: "signage_schedule",
          level: null,
          fileId: sigFile.id,
        };
        sheetDbRows.push(synthSheet);
        await db.insert(jobSheetsTable).values(synthSheet).onConflictDoNothing();
      }
    }

    // ── Fix: backfill null sheet levels from filename for multi-file jobs ──────
    // When each PDF is a single floor (e.g. "1st Floor Union at Tower Dist.pdf"),
    // the sidecar may not detect the level from the title block ("NORTH" etc.).
    // Infer the level from the filename so rooms get the correct floor assignment.
    for (const s of sheetDbRows) {
      if (s.level) continue; // already set by sidecar
      const file = floorPlanFiles.find(f => f.id === s.fileId);
      if (!file) continue;
      const fname = file.filename.toUpperCase();
      const level =
        fname.includes("1ST") || fname.includes("FIRST")   ? "LEVEL 1" :
        fname.includes("2ND") || fname.includes("SECOND")  ? "LEVEL 2" :
        fname.includes("3RD") || fname.includes("THIRD")   ? "LEVEL 3" :
        fname.includes("4TH") || fname.includes("FOURTH")  ? "LEVEL 4" :
        fname.includes("5TH") || fname.includes("FIFTH")   ? "LEVEL 5" :
        fname.includes("6TH") || fname.includes("SIXTH")   ? "LEVEL 6" :
        fname.includes("BASEMENT") || fname.includes("B1") ? "LEVEL B1" :
        fname.includes("GROUND")                           ? "LEVEL 1" :
        null;
      if (level) {
        logger.log(
          `[pipeline] Assigned ${level} to sheet ${s.sheetId} from filename "${file.filename}"`,
        );
        await db.update(jobSheetsTable).set({ level }).where(eq(jobSheetsTable.id, s.id!));
        s.level = level;
        // Sync back to allSheets so downstream steps see the updated level.
        const aIdx = allSheets.findIndex(a => a.sheet_id === s.sheetId && a.fileId === s.fileId);
        if (aIdx !== -1) allSheets[aIdx].level = level;
      }
    }

    // ── Slot floor label injection ────────────────────────────────────────────
    // When a floor_plan slot file carries a user-supplied floorLabel (e.g.
    // "First floor"), apply the parsed level to its sheets that still have no
    // level set — runs after the filename-based backfill above.
    for (const s of sheetDbRows) {
      if (s.level) continue;
      const file = floorPlanFiles.find(f => f.id === s.fileId);
      if (!file || !file.floorLabel?.trim()) continue;
      if (getSlotOverrideSheetType(file.fileCategory) !== "floor_plan") continue;
      const parsed = parseLevelFromLabel(file.floorLabel);
      if (parsed) {
        logger.log(`[pipeline] floorLabel inject: sheet ${s.sheetId} → ${parsed} (from label "${file.floorLabel}")`);
        await db.update(jobSheetsTable).set({ level: parsed }).where(eq(jobSheetsTable.id, s.id!));
        s.level = parsed;
        const aIdx = allSheets.findIndex(a => a.sheet_id === s.sheetId && a.fileId === s.fileId);
        if (aIdx !== -1) allSheets[aIdx].level = parsed;
      }
    }

    // Filter relevant sheets
    const relevantSheets = sheetDbRows.filter((s) => s.isRelevant);
    let floorPlanSheets = sheetDbRows.filter((s) => s.sheetType === "floor_plan");
    const signageSheets = sheetDbRows.filter((s) =>
      s.sheetType === "signage_schedule" ||
      (
        s.sheetType === "sign_details" &&
        /\b(SIGNAGE|SIGN\s+SCHEDULE|SIGN\s+NOTES?|SIGN\s+TYPES?|SIGN\s+LEGEND|SIGN\s+CRITERIA|SIGN\s+SPEC)\b/i.test(s.sheetTitle ?? "")
      ),
    );
    const exteriorSheets = sheetDbRows.filter((s) => s.sheetType === "exterior");
    const signDetailSheetsBatch = sheetDbRows.filter((s) => s.sheetType === "sign_details");

    // ── Diagnostic: signage sheet detection summary ───────────────────────────
    logger.log(`[sheet-diag] Signage sheets found: ${signageSheets.length}`);
    logger.log(
      `[sheet-diag] Signage sheet titles: ${
        signageSheets.length > 0
          ? signageSheets.map((s) => `${s.sheetId}="${s.sheetTitle ?? ""}"`).join(", ")
          : "NONE"
      }`,
    );

    // ── Sheet coverage pipeline log entry ─────────────────────────────────────
    // Shows all files processed and a breakdown of sheet types found.
    {
      const _coverageNow = new Date().toISOString();

      // Count sheet types across all classified sheets
      const _sheetTypeCounts: Record<string, number> = {};
      for (const s of dedupedSheets) {
        const t = s.sheet_type ?? "unknown";
        _sheetTypeCounts[t] = (_sheetTypeCounts[t] ?? 0) + 1;
      }

      // Per-file breakdown
      const _fileBreakdown = floorPlanFiles.map((f) => {
        const sheetsForFile = dedupedSheets.filter((s) => s.fileId === f.id);
        const counts: Record<string, number> = {};
        for (const s of sheetsForFile) {
          const t = s.sheet_type ?? "unknown";
          counts[t] = (counts[t] ?? 0) + 1;
        }
        const countsStr = Object.entries(counts).map(([t, n]) => `${t}×${n}`).join(", ");
        return `${f.filename}${countsStr ? ` (${countsStr})` : ""}`;
      }).join(", ") || "none";

      const _typeSummary = [
        floorPlanSheets.length > 0 && `Floor plans: ${floorPlanSheets.length}`,
        (_sheetTypeCounts["signage_schedule"] ?? 0) > 0 && `Detail sheets: ${_sheetTypeCounts["signage_schedule"]}`,
        (_sheetTypeCounts["sign_details"] ?? 0) > 0 && `Sign details: ${_sheetTypeCounts["sign_details"]}`,
        (_sheetTypeCounts["specialty_signage"] ?? 0) > 0 && `Specialty: ${_sheetTypeCounts["specialty_signage"]}`,
        (_sheetTypeCounts["skip"] ?? 0) > 0 && `Skipped: ${_sheetTypeCounts["skip"]}`,
      ].filter(Boolean).join(" | ") || "No sheets classified";

      const _coverageLabel = `Files: ${_fileBreakdown} — ${_typeSummary}`;
      pipelineSteps.push({
        step: "coverage",
        label: _coverageLabel,
        startedAt: _coverageNow,
        completedAt: _coverageNow,
        durationMs: 0,
        status: "completed",
      });
      logger.log(`[pipeline] ${_coverageLabel}`);
    }

    // ── Dynamic vision cap (non-synthesized jobs only) ────────────────────────
    // Priority: per-job override > synth cap (already set above) > dynamic formula.
    // Per-job override: set job.metadata.visionCapOverride = <number> via API.
    {
      const jobMeta = (job.metadata ?? {}) as Record<string, unknown>;
      const capOverride = typeof jobMeta.visionCapOverride === "number" ? jobMeta.visionCapOverride : null;
      if (capOverride !== null) {
        effectiveVisionCap = Math.max(1, Math.round(capOverride));
        logger.log(`[pipeline] Vision cap set to ${effectiveVisionCap} (per-job visionCapOverride)`);
      } else if (!didSynthesize) {
        const totalPageCount = floorPlanFiles.reduce((sum, f) => sum + (f.pageCount ?? 0), 0);
        const fpCount = floorPlanSheets.length;
        // Large jobs (>100 pages) get a higher base of 40; standard jobs get 20.
        // Both scale with floor plan sheet count at 3 vision calls per sheet.
        const baseCap = totalPageCount > 100 ? 40 : 20;
        effectiveVisionCap = Math.max(baseCap, fpCount * 3);
        logger.log(
          `[pipeline] Vision cap set to ${effectiveVisionCap} based on ${fpCount} floor plan sheet(s)` +
          ` (totalPages=${totalPageCount}, baseCap=${baseCap})`,
        );
      }
    }

    // Schedule import state — set in Step 4b, consumed in Step 9 (rules-engine skip).
    let hasScheduleImport = false;
    let hasAuthoritativeCountSchedule = false;

    // Signage notes sheet whitelist — populated in Step 4b when a sheet whose title
    // matches the signage-notes pattern is found.  The whitelist constrains Step 9
    // without skipping the rules engine (unlike the dedicated-file path).
    let signageNotesWhitelist: Set<string> | null = null;
    let signageNotesSheetName: string | null = null;

    // Structured sign type definitions extracted from embedded signage-notes sheets.
    // Stored in job.metadata.signTypeDefinitions; used for XLSX size/finish columns
    // and Schedule-tab display.  NEVER used to generate signs — rules engine does that.
    const signTypeDefinitions: Array<{
      typeCode: string;       // "A", "B.1", "C"
      description: string;   // "Room Identification Sign", "ADA Restroom"
      size: string | null;   // "6x6", "6x8"
      material: string | null;
      sheetId: string;       // sheet this was extracted from
    }> = [];

    // Estimator mode state — populated in Step B (dictionary) and Step 8.5 (assignments).
    // When estimatorSignRows is non-empty, Step 9 uses it instead of the rules engine.
    let projectSignDictionary: ProjectSignDictionary | null = null;
    // estimatorModeEligible tracks whether Step B successfully produced a dictionary.
    // Step 8.5 checks this before calling Claude; Step 9 uses it for the summary log.
    let estimatorModeEligible = false;
    const estimatorSignRows: typeof signsTable.$inferInsert[] = [];

    // -------------------------------------------------------------------------
    // Room inventory state — populated during Step 3 rasterization (one AI vision
    // call per floor plan sheet, immediately after rasterization).
    // -------------------------------------------------------------------------
    const extractedRooms: Array<{
      roomNumber: string;
      roomName: string;
      level: string;
      x: number | null;
      y: number | null;
      sheetDbId: string;
      aiVision?: boolean;
      aiConfidence?: string;
      aiIsRestroom?: boolean;
      bboxX0?: number;
      bboxY0?: number;
      pageWPts?: number;
      pageHPts?: number;
      coordSource?: string;
    }> = [];

    let aiVisionCallsThisRun = 0;
    let step6CacheHits = 0;
    let step6FreshScans = 0;
    let step6SkippedAboveThreshold = 0;
    let step6FreshScanCost = 0;
    // Count of sheets visually confirmed as overhead floor plans (isPlanView=true).
    // Used in Step 10 validation instead of the rules-engine sheetType count.
    let visionConfirmedPlanCount = 0;
    const step6SheetResults: Step6SheetResult[] = [];
    const STEP6_FLUSH_INTERVAL = 3;
    let step6ProcessedCount = 0;

    // ── Step 4b: skip already-typed sheets ───────────────────────────────────
    // Sheets that already have sheetType set by classifySheetStep2 don't need
    // Gemini vision classification — skip the batch PNG prefetch for those so
    // cached rescans don't re-rasterize every page.  Step 3 has an on-demand
    // fallback and Step 3a/9.2 download PDFs directly, so all steps still work.
    const sheetsNeedingClassification = sheetDbRows.filter(
      s => !s.sheetType || s.sheetType === "unknown"
    );
    logger.log(
      `[Step 4b] ${sheetsNeedingClassification.length} of ${sheetDbRows.length} sheet(s) need classification — ` +
      `${sheetDbRows.length - sheetsNeedingClassification.length} already typed, skipping`,
    );

    // ── Batch PNG prefetch ────────────────────────────────────────────────────
    // Collect all PDF pages needed across every sheet category and issue ONE
    // rasterize call per file instead of one call per sheet.  For a 100-page
    // PDF with 15 relevant sheets this reduces sidecar work by ~85 %.
    const prefetchedPageBase64 = new Map<string, string>(); // key: `${fileId}:${page}`

    if (sheetsNeedingClassification.length === 0) {
      logger.log(`[Step 4b] All sheets already typed — skipping batch PNG prefetch`);
    } else if (sidecarOk) {
      // Group page numbers by fileId, deduplicating across categories.
      // Include signageSheets (signage_schedule) + signDetailSheetsBatch (sign_details) so
      // Step 9.2 can use cached PNGs instead of re-downloading the PDF per specialty sheet.
      const pagesByFileId = new Map<string, Set<number>>();
      for (const s of [...relevantSheets, ...exteriorSheets, ...signageSheets, ...signDetailSheetsBatch]) {
        const fid = s.fileId ?? "";
        if (!fid) continue;
        if (!pagesByFileId.has(fid)) pagesByFileId.set(fid, new Set());
        pagesByFileId.get(fid)!.add(s.pdfPage ?? 1);
      }

      const totalPdfPages = files.reduce((sum, f) => sum + (f.pageCount ?? 0), 0);
      const uniquePageCount = [...pagesByFileId.values()].reduce((n, s) => n + s.size, 0);
      logger.log(
        `PNG conversion: converting ${uniquePageCount} of ${totalPdfPages} total pages` +
        ` (floor plans: ${floorPlanSheets.length}, sign docs: ${signageSheets.length}, exterior: ${exteriorSheets.length})`,
      );

      for (const [fileId, pageSet] of pagesByFileId) {
        const file = files.find((f) => f.id === fileId);
        if (!file || !file.filename.toLowerCase().endsWith(".pdf")) continue;

        let pdfBuf = pdfBufferByFileId.get(fileId);
        if (!pdfBuf) {
          try {
            pdfBuf = await downloadFromStorage(file.storagePath);
            pdfBufferByFileId.set(fileId, pdfBuf);
          } catch (err) {
            logger.warn(`[pipeline] PNG prefetch: could not download ${file.filename}: ${err}`);
            continue;
          }
        }

        const pageList = [...pageSet].sort((a, b) => a - b);
        try {
          const pageMap = await batchConvertPdfToImages(pdfBuf, pageList, rasterizeDpi, file.filename);
          for (const [page, base64] of pageMap) {
            prefetchedPageBase64.set(`${fileId}:${page}`, base64);
          }
        } catch (err) {
          logger.warn(`[pipeline] PNG prefetch: rasterization failed for ${file.filename}: ${err}`);
        }
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // -------------------------------------------------------------------------
    // Step 3a: Sign Document Extraction
    //
    // Runs on all Category 2 (signage_schedule) sheets BEFORE floor plan
    // rasterization.  Two-path approach:
    //   TEXT-FIRST: sidecar table extraction with a loose 3-column header match.
    //     If ≥3 data rows found → use directly, no vision needed.
    //   VISION FALLBACK: rasterize page → PNG → Gemini Flash JSON extraction.
    //
    // Results are stored in signSchedule[] (single source of truth).
    // hasScheduleImport is set when entries are found; Step 9 uses it to
    // trigger the canonical schedule insert.
    // -------------------------------------------------------------------------
    await wp("3a", "Extracting sign schedule data from sign documents");

    // Structured sign schedule array — populated here, readable in Step 8.
    const signSchedule: SignScheduleEntry[] = [];
    let _3aTextRows = 0;
    let _3aGeminiRows = 0;
    let _3aTextSheets = 0;
    let _3aGeminiSheets = 0;
    let finalBuildingType: string = job.buildingType ?? "commercial";
    let roomRecords: RoomRecord[] = [];
    const priorPlacementMap = new Map<string, { canvasX: number; canvasY: number }>();

    // Column headers that identify a sign schedule table (match ≥3 for positive ID)
    const SIGN3A_HEADERS = [
      "ROOM", "ROOM #", "ROOM NO", "SIGN TYPE", "TYPE",
      "QTY", "QUANTITY", "LOCATION", "SIGN ID", "MESSAGE", "SIZE",
    ];

    function parseSignScheduleTable3a(tables: string[][][], sheetId: string): SignScheduleEntry[] {
      const entries: SignScheduleEntry[] = [];
      for (const table of tables) {
        // Find header row with ≥3 matching column names within the first 5 rows
        let headerRowNorm: string[] | null = null;
        let headerIdx = -1;
        for (let i = 0; i < Math.min(5, table.length); i++) {
          const rowNorm = (table[i] ?? []).map((c) => (c ?? "").toUpperCase().trim());
          const hits = SIGN3A_HEADERS.filter((h) =>
            rowNorm.some((cell) => cell === h || (h.length > 3 && cell.includes(h))),
          );
          if (hits.length >= 3) { headerRowNorm = rowNorm; headerIdx = i; break; }
        }
        if (!headerRowNorm) continue;

        // Map each target column to its index
        const colIdx = (...names: string[]): number => {
          for (const name of names) {
            const idx = headerRowNorm!.findIndex(
              (h) => h === name || (name.length > 3 && h.includes(name)),
            );
            if (idx >= 0) return idx;
          }
          return -1;
        };

        const roomNumCol  = colIdx("ROOM #", "ROOM NO", "ROOM NUMBER");
        const roomNameCol = colIdx("ROOM NAME", "ROOM");
        const signTypeCol = colIdx("SIGN TYPE", "TYPE");
        const qtyCol      = colIdx("QTY", "QUANTITY");
        const sizeCol     = colIdx("SIZE");
        const msgCol      = colIdx("MESSAGE");
        const locCol      = colIdx("LOCATION");

        for (let i = headerIdx + 1; i < table.length; i++) {
          const row = table[i];
          const signType = signTypeCol >= 0 ? (row[signTypeCol]?.trim() ?? "") : "";
          if (!signType) continue;
          entries.push({
            roomNumber: roomNumCol  >= 0 ? (row[roomNumCol]?.trim() ?? "")  : "",
            roomName:   roomNameCol >= 0 ? (row[roomNameCol]?.trim() ?? "") : "",
            signType,
            quantity:   qtyCol >= 0 ? (parseInt(row[qtyCol]?.trim() ?? "1", 10) || 1) : 1,
            size:       sizeCol >= 0 ? (row[sizeCol]?.trim() ?? "") : "",
            message:    msgCol  >= 0 ? (row[msgCol]?.trim() ?? "")  : "",
            notes:      locCol  >= 0 ? (row[locCol]?.trim() ?? "")  : "",
            source: "text",
            sheetId,
            substrate:      null,
            finishMethod:   null,
            brailleSpec:    null,
            mountingHeight: null,
            manufacturer:   null,
          });
        }
      }
      return entries;
    }

    const _3aAnchorSheetId =
      floorPlanSheets.find((s) => s.level?.includes("1") || s.level?.includes("L1"))?.id ??
      floorPlanSheets[0]?.id ??
      null;

    if (signageSheets.length > 0 && sidecarOk) {
      logger.log(`[Step 3a] Processing ${signageSheets.length} sign document sheet(s)…`);

      for (const sigSheet of signageSheets) {
        const sheetFile = files.find((f) => f.id === sigSheet.fileId);
        if (!sheetFile) continue;

        // Reuse buffer cached during drawing-index parse; download only if absent.
        let pdfBuf = pdfBufferByFileId.get(sigSheet.fileId ?? "");
        if (!pdfBuf) {
          try {
            pdfBuf = await downloadFromStorage(sheetFile.storagePath);
          } catch (err) {
            logger.warn(`[Step 3a] Could not download PDF for ${sigSheet.sheetId}: ${err}`);
            continue;
          }
        }

        // ── TEXT-FIRST: sidecar table extraction ───────────────────────────
        let textEntries: SignScheduleEntry[] = [];
        let aggregateTextEntries: SignScheduleEntry[] = [];
        try {
          const tableResult = await extractTable(pdfBuf, sigSheet.pdfPage ?? 1, sheetFile.filename);
          logger.log(`[Step 3a] ${sigSheet.sheetId} (p.${sigSheet.pdfPage}): ${tableResult.table_count} table(s) found`);
          aggregateTextEntries = parseAggregateCountTable(tableResult.tables, sigSheet.sheetId ?? "");
          if (aggregateTextEntries.length > 0) {
            const aggregateTotal = aggregateTextEntries.reduce((sum, entry) => sum + (entry.quantity ?? 0), 0);
            logger.log(
              `[Step 3a] aggregate count table detected: ${aggregateTextEntries.length} type(s), ` +
              `total ${aggregateTotal} signs`,
            );
          } else {
            textEntries = parseSignScheduleTable3a(tableResult.tables, sigSheet.sheetId ?? "");
            logger.log(`[Step 3a] ${sigSheet.sheetId}: ${textEntries.length} text entry(entries) parsed`);
          }
        } catch (err) {
          logger.warn(`[Step 3a] Table extraction failed for ${sigSheet.sheetId}: ${err}`);
        }

        let sheetEntries: SignScheduleEntry[] = [];

        if (aggregateTextEntries.length > 0) {
          sheetEntries = aggregateTextEntries;
          hasScheduleImport = true;
          hasAuthoritativeCountSchedule = true;
          _3aTextRows += aggregateTextEntries.length;
          _3aTextSheets++;
          logger.log(
            `[Step 3a] ${sigSheet.sheetId}: ${aggregateTextEntries.length} aggregate count row(s) via text ` +
            `(per-room parse and vision skipped)`,
          );
        } else if (textEntries.length >= 3) {
          // ≥3 rows — text extraction is sufficient, no vision needed.
          sheetEntries = textEntries;
          _3aTextRows += textEntries.length;
          _3aTextSheets++;
          logger.log(
            `[Step 3a] ${sigSheet.sheetId}: ${textEntries.length} rows via text (vision skipped)`,
          );

          // Text path succeeded — still extract material spec via lightweight Gemini call
          if (jobMaterialSpec === null) {
            try {
              const _msKey = `${sigSheet.fileId ?? ""}:${sigSheet.pdfPage ?? 1}`;
              const msPageBase64 = prefetchedPageBase64.get(_msKey)
                ?? (await rasterizePages(pdfBuf, [sigSheet.pdfPage ?? 1], rasterizeDpi, sheetFile.filename)).pages[0];
              if (msPageBase64) {
                const specPrompt =
                  "This is an architectural sign specification sheet.\n" +
                  "Extract only the project-wide material specification as a JSON object:\n" +
                  "{\n" +
                  '  "substrate": "the substrate material (e.g. photopolymer, aluminum, acrylic, ADA plastic)",\n' +
                  '  "finishMethod": "the finish or print method (e.g. direct UV print, painted, brushed, raised copy)",\n' +
                  '  "brailleSpec": "Braille requirement (e.g. Grade 2 Braille, no Braille)",\n' +
                  '  "mountingHeight": "mounting height if specified (e.g. 60 inches AFF)",\n' +
                  '  "manufacturer": "sign manufacturer or series if called out"\n' +
                  "}\n" +
                  "If a field is not found use null.\n" +
                  "Respond with JSON only. No markdown. No preamble.";

                const specResponse = await timedGenerate({
                  model: CLAUDE_SCHEDULE_MODEL,
                  contents: [{ role: "user", parts: [
                    { inlineData: { mimeType: "image/png", data: msPageBase64 } },
                    { text: specPrompt },
                  ]}],
                });

                const specText = specResponse.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
                const specParsed = JSON.parse(specText.replace(/```json|```/g, "").trim());
                if (specParsed && typeof specParsed === "object") {
                  jobMaterialSpec = {
                    jobId,
                    substrate:      (specParsed as Record<string, string | null>).substrate ?? null,
                    finishMethod:   (specParsed as Record<string, string | null>).finishMethod ?? null,
                    brailleSpec:    (specParsed as Record<string, string | null>).brailleSpec ?? null,
                    mountingHeight: (specParsed as Record<string, string | null>).mountingHeight ?? null,
                    manufacturer:   (specParsed as Record<string, string | null>).manufacturer ?? null,
                    source:         "sign_schedule",
                  };
                  logger.log(
                    `[Step 3a] ${sigSheet.sheetId}: text path materialSpec — substrate="${jobMaterialSpec.substrate}" manufacturer="${jobMaterialSpec.manufacturer}"`,
                  );
                }
              }
            } catch (msErr) {
              logger.warn(`[Step 3a] ${sigSheet.sheetId}: text-path materialSpec extraction failed: ${msErr}`);
            }
          }
        } else {
          // 0 (or <3) rows — fall back to Gemini Flash vision.
          logger.log(
            `[Step 3a] ${sigSheet.sheetId}: text yielded ${textEntries.length} row(s) — falling back to Gemini Flash`,
          );
          const geminiEntries: SignScheduleEntry[] = [];
          let geminiAggregateCountRows = false;
          try {
            const _3aKey = `${sigSheet.fileId ?? ""}:${sigSheet.pdfPage ?? 1}`;
            const pageBase64 = prefetchedPageBase64.get(_3aKey)
              ?? (await rasterizePages(pdfBuf, [sigSheet.pdfPage ?? 1], rasterizeDpi, sheetFile.filename)).pages[0];
            if (!pageBase64) {
              logger.warn(`[Step 3a] ${sigSheet.sheetId}: rasterization produced no image`);
            } else {
              const aggregatePrompt =
                "This image may contain an aggregate signage count table with columns like SIGNAGE TYPE, TYPE MARK, and COUNT. " +
                "If such a table is present and it has NO room-number or room-name column, extract every row as JSON only: " +
                '[{ "signType": string, "typeMark": string, "count": number }]. ' +
                "Use the signage type description as signType. Exclude blank rows and grand-total rows. " +
                "If no aggregate count table is present, return []. No markdown. No preamble.";

              try {
                const aggregateResponse = await timedGenerate({
                  model: CLAUDE_SCHEDULE_MODEL,
                  contents: [{
                    role: "user",
                    parts: [
                      { inlineData: { mimeType: "image/png", data: pageBase64 } },
                      { text: aggregatePrompt },
                    ],
                  }],
                  config: { maxOutputTokens: 8192 },
                });
                const aggregateRaw = (aggregateResponse.text ?? "")
                  .replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
                const aggregateParsed = JSON.parse(aggregateRaw) as unknown;
                const aggregateObject = aggregateParsed && typeof aggregateParsed === "object"
                  ? aggregateParsed as Record<string, unknown>
                  : {};
                const aggregateItems = Array.isArray(aggregateParsed)
                  ? aggregateParsed
                  : Array.isArray(aggregateObject.entries)
                    ? aggregateObject.entries as unknown[]
                    : [];

                for (const item of aggregateItems) {
                  if (typeof item !== "object" || !item) continue;
                  const obj = item as Record<string, unknown>;
                  const signType = typeof obj.signType === "string" ? obj.signType.trim() : "";
                  const count = typeof obj.count === "number"
                    ? obj.count
                    : typeof obj.quantity === "number"
                      ? obj.quantity
                      : typeof obj.count === "string"
                        ? parseInt(obj.count.replace(/[,\s]/g, ""), 10)
                        : NaN;
                  if (!signType || /\bGRAND\s+TOTAL\b|\bTOTAL\b/i.test(signType)) continue;
                  if (!Number.isInteger(count) || count <= 0) continue;
                  const typeMark = typeof obj.typeMark === "string" ? obj.typeMark.trim() : "";
                  geminiEntries.push({
                    roomNumber: "",
                    roomName: "",
                    signType,
                    typeMark: typeMark || null,
                    quantity: count,
                    size: "",
                    message: "",
                    notes: "",
                    source: "gemini",
                    sheetId: sigSheet.sheetId ?? "",
                    substrate: null,
                    finishMethod: null,
                    brailleSpec: null,
                    mountingHeight: null,
                    manufacturer: null,
                  });
                }

                if (geminiEntries.length > 0) {
                  geminiAggregateCountRows = true;
                  const aggregateTotal = geminiEntries.reduce((sum, entry) => sum + (entry.quantity ?? 0), 0);
                  hasScheduleImport = true;
                  hasAuthoritativeCountSchedule = true;
                  logger.log(
                    `[Step 3a] aggregate count table detected: ${geminiEntries.length} type(s), ` +
                    `total ${aggregateTotal} signs`,
                  );
                }
              } catch (aggregateErr) {
                logger.warn(`[Step 3a] ${sigSheet.sheetId}: aggregate count vision parse failed: ${aggregateErr}`);
              }

              if (!geminiAggregateCountRows) {
                const geminiPrompt =
                  "This is an architectural sign schedule or sign specification sheet.\n\n" +
                  "Extract two things and return them together as a single JSON object.\n\n" +
                  "IMPORTANT: Output \"materialSpec\" as the FIRST key in the JSON object, before \"entries\".\n\n" +
                  '1. MATERIAL SPEC — the project-wide sign material specification.\n' +
                  'Return as JSON object under key "materialSpec" (output this first):\n' +
                  '{\n' +
                  '  "substrate": "the substrate material (e.g. photopolymer, aluminum, acrylic, ADA plastic)",\n' +
                  '  "finishMethod": "the finish or print method (e.g. direct UV print, painted, brushed, raised copy)",\n' +
                  '  "brailleSpec": "Braille requirement (e.g. Grade 2 Braille, no Braille)",\n' +
                  '  "mountingHeight": "mounting height if specified (e.g. 60 inches AFF)",\n' +
                  '  "manufacturer": "sign manufacturer or series if called out (e.g. ASI, Vista)"\n' +
                  '}\n\n' +
                  "2. SIGN ENTRIES — all individual sign locations.\n" +
                  'Return as JSON array under key "entries" (output this second):\n' +
                  '[{ "roomNumber": "", "roomName": "", "signType": "", "quantity": 1, "size": "", "message": "", "notes": "" }]\n\n' +
                  "If this is a sign type legend, include each type under entries as:\n" +
                  '{ "typeCode": "", "typeName": "", "description": "", "size": "", "material": "" }\n\n' +
                  "If a field is not found, use null.\n" +
                  'Respond in JSON only. No markdown fences. No preamble.\n' +
                  'Top level keys (in this order): "materialSpec" then "entries".';

                const geminiResponse = await timedGenerate({
                  model: CLAUDE_SCHEDULE_MODEL,
                  contents: [{
                    role: "user",
                    parts: [
                      { inlineData: { mimeType: "image/png", data: pageBase64 } },
                      { text: geminiPrompt },
                    ],
                  }],
                  config: { maxOutputTokens: 65536 },
                });

                const rawText = (geminiResponse.text ?? "")
                  .replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();

                try {
                  const parsed = JSON.parse(rawText);

                // Support new { entries, materialSpec } wrapper or legacy bare array
                const rawEntries: unknown[] = Array.isArray(parsed)
                  ? parsed
                  : Array.isArray((parsed as Record<string, unknown>).entries)
                    ? (parsed as Record<string, unknown>).entries as unknown[]
                    : Array.isArray((parsed as Record<string, unknown>).data)
                      ? (parsed as Record<string, unknown>).data as unknown[]
                      : [parsed];

                // Extract materialSpec (new key — only overwrite if this sheet has one)
                const sheetMs = (parsed as Record<string, unknown>).materialSpec;
                if (sheetMs && typeof sheetMs === "object") {
                  const ms = sheetMs as Record<string, unknown>;
                  jobMaterialSpec = {
                    jobId,
                    substrate:      (ms.substrate      ?? null) as string | null,
                    finishMethod:   (ms.finishMethod   ?? null) as string | null,
                    brailleSpec:    (ms.brailleSpec    ?? null) as string | null,
                    mountingHeight: (ms.mountingHeight ?? null) as string | null,
                    manufacturer:   (ms.manufacturer   ?? null) as string | null,
                    source:         "sign_schedule",
                  };
                  logger.log(
                    `[Step 3a] ${sigSheet.sheetId}: materialSpec — substrate="${jobMaterialSpec.substrate}" manufacturer="${jobMaterialSpec.manufacturer}"`,
                  );
                }

                for (const item of rawEntries) {
                  if (typeof item !== "object" || !item) continue;
                  const obj = item as Record<string, unknown>;
                  const signType =
                    (obj.signType ?? obj.typeCode ?? obj.typeName ?? "") as string;
                  if (!signType) continue;
                  geminiEntries.push({
                    roomNumber: (obj.roomNumber ?? "") as string,
                    roomName:   (obj.roomName ?? obj.typeName ?? "") as string,
                    signType,
                    quantity:   typeof obj.quantity === "number" ? obj.quantity : 1,
                    size:       (obj.size ?? "") as string,
                    message:    (obj.message ?? obj.description ?? "") as string,
                    notes:      (obj.notes ?? obj.material ?? "") as string,
                    source: "gemini",
                    sheetId: sigSheet.sheetId ?? "",
                    substrate:      null,
                    finishMethod:   null,
                    brailleSpec:    null,
                    mountingHeight: null,
                    manufacturer:   null,
                  });
                }
                logger.log(
                  `[Step 3a] ${sigSheet.sheetId}: Gemini extracted ${geminiEntries.length} entries`,
                );
              } catch (parseErr) {
                logger.warn(`[Step 3a] ${sigSheet.sheetId}: Gemini JSON parse failed: ${parseErr} — trying materialSpec regex fallback`);
                // Attempt to rescue materialSpec from truncated JSON via regex.
                // materialSpec is now prompted first so it appears near the top of the response.
                try {
                  const msFallbackMatch = rawText.match(/"materialSpec"\s*:\s*(\{[^}]*\})/s);
                  if (msFallbackMatch && jobMaterialSpec === null) {
                    const msPartial = JSON.parse(msFallbackMatch[1]) as Record<string, string | null>;
                    if (msPartial && typeof msPartial === "object") {
                      jobMaterialSpec = {
                        jobId,
                        substrate:      msPartial.substrate      ?? null,
                        finishMethod:   msPartial.finishMethod   ?? null,
                        brailleSpec:    msPartial.brailleSpec    ?? null,
                        mountingHeight: msPartial.mountingHeight ?? null,
                        manufacturer:  msPartial.manufacturer   ?? null,
                        source:         "sign_schedule",
                      };
                      logger.log(`[Step 3a] ${sigSheet.sheetId}: materialSpec rescued via regex — substrate="${jobMaterialSpec.substrate}" manufacturer="${jobMaterialSpec.manufacturer}"`);
                    }
                  }
                } catch (regexErr) {
                  logger.warn(`[Step 3a] ${sigSheet.sheetId}: materialSpec regex fallback also failed: ${regexErr}`);
                }
              }
              }
            }
          } catch (visionErr) {
            logger.warn(`[Step 3a] ${sigSheet.sheetId}: Gemini vision failed: ${visionErr}`);
          }

          // If Gemini only returned type-definition entries (no roomNumber on any entry),
          // treat it the same as 0 entries and trigger the 300 DPI retry.  This happens
          // when Gemini reads only the sign-type legend at the top of the schedule sheet
          // and misses the actual room-by-room assignment table below.
          const allTypeDefs = !geminiAggregateCountRows && geminiEntries.length > 0
            && geminiEntries.every(e => !e.roomNumber);
          if (allTypeDefs) {
            logger.log(
              `[Step 3a] ${sigSheet.sheetId}: Gemini returned ${geminiEntries.length} type-def-only entries ` +
              `(no roomNumbers) — clearing and starting two-pass 300 DPI retry`,
            );
            geminiEntries.length = 0; // discard placeholder type-def rows before retry
          }

          if (geminiEntries.length > 0) {
            sheetEntries = geminiEntries;
            _3aGeminiRows += geminiEntries.length;
            _3aGeminiSheets++;
            if (geminiAggregateCountRows) {
              hasScheduleImport = true;
              hasAuthoritativeCountSchedule = true;
            }
          } else {
            // geminiEntries.length === 0 (or was reset above) — two-pass 300 DPI retry
            // for image-based schedule tables.
            // Pass 1: locate the table region on the full page.
            // Pass 2: extract rows using a region-aware prompt so Gemini focuses on the
            //         table and ignores sign detail drawings or title blocks that share the sheet.
            // Aggressive gate: a pure legend/notes sheet ("FOR LEGENDS & PLAN NOTES",
            // "GENERAL NOTES", symbol legend, …) carries sign-type definitions but no
            // per-room schedule table, so a high-DPI re-render of the same page cannot
            // surface rows that aren't there. When the standard-DPI pass already saw
            // only type-definitions (allTypeDefs), skip the expensive re-render for
            // these sheets — this is the ~70s of dead-end work seen in the logs.
            const _titleU = (sigSheet.sheetTitle ?? "").toUpperCase();
            const isLegendOnlySheet =
              /\b(LEGEND|PLAN\s+NOTES|GENERAL\s+NOTES)\b/.test(_titleU) &&
              !/\bSCHEDULE\b/.test(_titleU);
            const skipHiDpiRetry = allTypeDefs && isLegendOnlySheet;
            if (skipHiDpiRetry) {
              logger.log(
                `[Step 3a] ${sigSheet.sheetId}: legend/notes sheet with type-definitions only ` +
                `— skipping ${scheduleRetryDpi} DPI two-pass retry (no per-room schedule expected)`,
              );
            } else if (!allTypeDefs) {
              // allTypeDefs case already logged the retry reason above
              logger.log(`[Step 3a] ${sigSheet.sheetId}: 0 entries — starting two-pass ${scheduleRetryDpi} DPI retry`);
            }
            if (!skipHiDpiRetry) {
            try {
              const hiDpiResult = await rasterizePages(pdfBuf, [sigSheet.pdfPage ?? 1], scheduleRetryDpi, sheetFile.filename);
              const hiDpiBase64 = hiDpiResult.pages[0];
              if (hiDpiBase64) {
                // ── Pass 1: table-location pass ──────────────────────────────────
                const pass1Prompt =
                  "Respond with JSON only. No preamble, no explanation, no markdown. First character must be '{'.\n\n" +
                  "This is an architectural drawing sheet. " +
                  "Does it contain a signage schedule table (a table with columns like Room Number, Room Name, Sign Text)? " +
                  'If yes, answer with JSON: { "hasTable": true, "tableRegion": "full" | "left" | "right" | "top" | "bottom", "estimatedRows": number }. ' +
                  'If no table is found: { "hasTable": false }. ' +
                  "JSON only, no preamble.";

                let tableRegion: "full" | "left" | "right" | "top" | "bottom" = "full";
                let estimatedRows = 0;
                let hasTable = true;

                try {
                  const pass1Response = await timedGenerate({
                    model: CLAUDE_SCHEDULE_MODEL,
                    contents: [{
                      role: "user",
                      parts: [
                        { inlineData: { mimeType: "image/png", data: hiDpiBase64 } },
                        { text: pass1Prompt },
                      ],
                    }],
                    config: { maxOutputTokens: 1024 },
                  });
                  const pass1Raw = (pass1Response.text ?? "")
                    .replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
                  const pass1Parsed = JSON.parse(pass1Raw) as Record<string, unknown>;
                  hasTable = pass1Parsed.hasTable !== false;
                  if (hasTable) {
                    const region = pass1Parsed.tableRegion as string;
                    if (["full", "left", "right", "top", "bottom"].includes(region)) {
                      tableRegion = region as typeof tableRegion;
                    }
                    estimatedRows = typeof pass1Parsed.estimatedRows === "number"
                      ? pass1Parsed.estimatedRows : 0;
                    logger.log(
                      `[Step 3a] ${sigSheet.sheetId}: Pass 1 — tableRegion="${tableRegion}", estimatedRows=${estimatedRows}`,
                    );
                  } else {
                    logger.log(`[Step 3a] ${sigSheet.sheetId}: Pass 1 found no table — skipping extraction`);
                  }
                } catch (pass1Err) {
                  // Pass 1 parse failure — proceed with full-page extraction as safe fallback.
                  logger.warn(`[Step 3a] ${sigSheet.sheetId}: Pass 1 parse failed (${pass1Err}) — defaulting to full-page extraction`);
                }

                if (hasTable) {
                  // ── Pass 2: extraction pass ─────────────────────────────────────
                  // No pixel-level crop is performed (no image library available).
                  // Instead, a region-aware directive is injected into the extraction
                  // prompt so Gemini focuses on the correct part of the sheet.
                  const regionDirective =
                    tableRegion === "full"
                      ? "The signage schedule table spans the full page."
                      : `The signage schedule table occupies the ${(tableRegion as string).toUpperCase()} portion of this image only. ` +
                        `Ignore any sign detail drawings or title blocks in the remaining area.`;

                  const pass2Prompt =
                    `${regionDirective} ` +
                    "This image contains a signage schedule table with columns for Room Number, Room Name, and Sign Text. " +
                    "Extract every row as a JSON array: " +
                    '[{ "roomNumber": string, "roomName": string, "signType": string, "quantity": number }]. ' +
                    "Include ALL rows — there may be 200–400 entries across multiple columns or table sections. " +
                    "If a room has multiple sign types, create one entry per sign type. " +
                    "If quantity is not shown, default to 1. " +
                    "Return JSON array only. No markdown. No preamble.";

                  // Helper: attempt JSON parse with truncation recovery.
                  // When Gemini returns a truncated array (e.g. ends mid-string),
                  // we slice at the last complete '}' and close the array.
                  function tryParseScheduleJson(raw: string): unknown[] {
                    // Attempt 1 — exact parse
                    try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; }
                    catch { /* fall through */ }
                    // Attempt 2 — close array at last complete object
                    const lastBrace = raw.lastIndexOf("}");
                    if (lastBrace > 0) {
                      try {
                        const repaired = raw.slice(0, lastBrace + 1) + "]";
                        const p = JSON.parse(repaired);
                        return Array.isArray(p) ? p : [];
                      } catch { /* fall through */ }
                    }
                    return [];
                  }

                  function pushEntries(list: unknown[]): void {
                    for (const item of list) {
                      if (typeof item !== "object" || !item) continue;
                      const obj = item as Record<string, unknown>;
                      const signType = (obj.signType ?? obj.typeName ?? "") as string;
                      if (!signType) continue;
                      geminiEntries.push({
                        roomNumber: (obj.roomNumber ?? "") as string,
                        roomName:   (obj.roomName ?? "") as string,
                        signType,
                        quantity:   typeof obj.quantity === "number" ? obj.quantity : 1,
                        size:       (obj.size ?? "") as string,
                        message:    (obj.message ?? "") as string,
                        notes:      (obj.notes ?? "") as string,
                        source: "gemini",
                        sheetId: sigSheet.sheetId ?? "",
                        substrate: null, finishMethod: null, brailleSpec: null,
                        mountingHeight: null, manufacturer: null,
                      });
                    }
                  }

                  const pass2Response = await timedGenerate({
                    model: CLAUDE_SCHEDULE_MODEL,
                    contents: [{
                      role: "user",
                      parts: [
                        { inlineData: { mimeType: "image/png", data: hiDpiBase64 } },
                        { text: pass2Prompt },
                      ],
                    }],
                    config: { maxOutputTokens: 65536 },
                  });
                  const pass2Raw = (pass2Response.text ?? "")
                    .replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
                  const pass2List = tryParseScheduleJson(pass2Raw);
                  pushEntries(pass2List);
                  logger.log(`[Step 3a] ${sigSheet.sheetId}: Pass 2 extracted ${geminiEntries.length} entries`);

                  // Pass 3: retry when recovered entry count is far below estimate —
                  // the first response may have been truncated. Ask Gemini to continue
                  // from the last room number it returned.
                  const pass3Threshold = Math.max(30, Math.floor(estimatedRows / 3));
                  if (geminiEntries.length < pass3Threshold && estimatedRows > 50) {
                    logger.log(
                      `[Step 3a] ${sigSheet.sheetId}: Pass 2 returned only ${geminiEntries.length} entries ` +
                      `(expected ≥${pass3Threshold} from estimatedRows=${estimatedRows}) — running Pass 3 continuation`,
                    );
                    const lastRoomNum = geminiEntries.length > 0
                      ? (geminiEntries[geminiEntries.length - 1].roomNumber || "")
                      : "";
                    const pass3Prompt =
                      `${regionDirective} ` +
                      "This image contains a signage schedule table. " +
                      (lastRoomNum
                        ? `A previous extraction already captured entries up to room number "${lastRoomNum}". ` +
                          `Continue extracting ALL remaining rows AFTER room "${lastRoomNum}". ` +
                          "Do NOT repeat any rooms already listed. "
                        : "Extract ALL rows from this signage schedule table. ") +
                      "Return JSON array: " +
                      '[{ "roomNumber": string, "roomName": string, "signType": string, "quantity": number }]. ' +
                      "Include every row — there may be 200–400 total entries. " +
                      "Return JSON array only. No markdown. No preamble.";
                    try {
                      const pass3Response = await timedGenerate({
                        model: CLAUDE_SCHEDULE_MODEL,
                        contents: [{
                          role: "user",
                          parts: [
                            { inlineData: { mimeType: "image/png", data: hiDpiBase64 } },
                            { text: pass3Prompt },
                          ],
                        }],
                        config: { maxOutputTokens: 65536 },
                      });
                      const pass3Raw = (pass3Response.text ?? "")
                        .replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
                      const pass3List = tryParseScheduleJson(pass3Raw);
                      const beforePass3 = geminiEntries.length;
                      pushEntries(pass3List);
                      logger.log(
                        `[Step 3a] ${sigSheet.sheetId}: Pass 3 added ${geminiEntries.length - beforePass3} entries ` +
                        `(total: ${geminiEntries.length})`,
                      );
                    } catch (pass3Err) {
                      logger.warn(`[Step 3a] ${sigSheet.sheetId}: Pass 3 failed: ${pass3Err}`);
                    }
                  }
                  logger.log(`[Step 3a] ${sigSheet.sheetId}: ${scheduleRetryDpi} DPI retry extracted ${geminiEntries.length} entries`);
                }
              }
            } catch (hiDpiErr) {
              logger.warn(`[Step 3a] ${sigSheet.sheetId}: ${scheduleRetryDpi} DPI retry failed: ${hiDpiErr}`);
            }
            } // end if (!skipHiDpiRetry)

            if (geminiEntries.length > 0) {
              sheetEntries = geminiEntries;
              _3aGeminiRows += geminiEntries.length;
              _3aGeminiSheets++;
              if (geminiAggregateCountRows) {
                hasScheduleImport = true;
                hasAuthoritativeCountSchedule = true;
              }
            } else if (textEntries.length > 0) {
              // Use the partial text rows as a last resort.
              sheetEntries = textEntries;
              _3aTextRows += textEntries.length;
              _3aTextSheets++;
            }
          }
        }

        if (sheetEntries.length > 0) {
          signSchedule.push(...sheetEntries);
          // signSchedule[] is the single source of truth — no secondary array needed
        }
      }

      {
        const bridgeResult = applyStep3aBridge(dedicatedSignScheduleFiles, signSchedule);
        hasScheduleImport = hasScheduleImport || bridgeResult.hasScheduleImport;
      }

      logger.log(
        `[Step 3a] Sign schedule: extracted ${signSchedule.length} entries from ` +
        `${_3aTextSheets + _3aGeminiSheets} sheet(s) ` +
        `(${_3aTextRows} via text, ${_3aGeminiRows} via Gemini vision)`,
      );

      // Dedup helpers short-circuit safely on empty input — no length guard needed here.
      // Skipping dedup when signSchedule is unexpectedly empty would silently allow
      // duplicates to survive if entries arrive via a code path that bypasses the
      // normal extraction flow.

      // Per-sheet dedup: key on roomNumber|signType (catches same row from multiple table instances)
      const beforePerSheet = signSchedule.length;
      deduplicateSchedulePerSheet(signSchedule);
      logger.log(
        `[Step 3a] Schedule dedup: ${beforePerSheet} raw entries → ` +
        `${signSchedule.length} unique (removed ${beforePerSheet - signSchedule.length} duplicates)`,
      );

      // Global dedup: 3-field key (roomNumber|roomName|signType) catches cross-sheet duplicates
      // from multi-table sheets like AA831 with 27 table instances
      const beforeGlobal = signSchedule.length;
      deduplicateScheduleGlobal(signSchedule);
      if (signSchedule.length !== beforeGlobal) {
        logger.log(
          `[Step 3a] Global dedup: ${beforeGlobal} → ${signSchedule.length} entries ` +
          `(removed ${beforeGlobal - signSchedule.length} cross-sheet duplicates)`,
        );
      }

      // Corridor filter: corridors get directional signs from R16 (rules engine) —
      // they must not also get a room ID sign from the schedule
      const CORRIDOR_PATTERNS = [
        /^corridor$/i,
        /^hallway$/i,
        /^hall$/i,
        /^circulation$/i,
        /^common\s+corridor$/i,
        /^public\s+corridor$/i,
      ];
      const preCorridorCount = signSchedule.length;
      const corridorFiltered = signSchedule.filter(entry => {
        const name = (entry.roomName ?? "").trim();
        // Always keep entries with explicit sign text
        if ((entry as unknown as Record<string, unknown>).signText?.toString().trim() ||
            entry.message?.trim()) return true;
        const isCorridor = CORRIDOR_PATTERNS.some(p => p.test(name));
        if (isCorridor) {
          logger.log(`[Step 3a] Corridor excluded: ${entry.roomNumber} "${entry.roomName}"`);
        }
        return !isCorridor;
      });
      if (corridorFiltered.length !== preCorridorCount) {
        logger.log(
          `[Step 3a] Corridor filter: ${preCorridorCount} → ${corridorFiltered.length} entries ` +
          `(removed ${preCorridorCount - corridorFiltered.length} corridor entries)`,
        );
        signSchedule.length = 0;
        signSchedule.push(...corridorFiltered);
      }
    } else {
      logger.log(
        `[Step 3a] SKIPPED — ${signageSheets.length === 0
          ? "no sign document sheets found"
          : "sidecar unavailable"}`,
      );
    }

    // Strategy is resolved once and never changes during the run.
    // Must be called after Step 3a (signSchedule is now populated).
    const pipelineStrategy = resolveStrategy(
      job.buildingType ?? null,
      signSchedule.length,
      floorPlanFiles.length,
      dedicatedSignScheduleFiles.length > 0,
    );
    logger.log(
      `[pipeline] Strategy: ${pipelineStrategy} — ` +
      `buildingType=${job.buildingType ?? "null"}, ` +
      `scheduleRows=${signSchedule.length}, ` +
      `floorPlanFiles=${floorPlanFiles.length}, ` +
      `dedicatedScheduleFile=${dedicatedSignScheduleFiles.length > 0}`,
    );
    // Persist pipelineStrategy to job.metadata and scope_flag (scope_flag survives
    // subsequent progress-only metadata rewrites so the API can always return it).
    {
      const _currentMeta = (job.metadata ?? {}) as Record<string, unknown>;
      await db.update(jobsTable)
        .set({ metadata: { ..._currentMeta, pipelineStrategy }, scopeFlag: pipelineStrategy })
        .where(eq(jobsTable.id, jobId));
    }
    const aggregateCountFastPath = hasAuthoritativeCountSchedule;
    if (aggregateCountFastPath) {
      logger.log(
        `[pipeline] authoritative aggregate count schedule fast path — skipping floor-plan room extraction`,
      );
      relevantSheets.length = 0;
      floorPlanSheets = [];
    }

    // -------------------------------------------------------------------------
    // Step 3b: Exterior Sign Extraction
    //
    // For each sheet classified as "exterior" in Step 2, rasterize the page and
    // send it to Gemini Flash to identify exterior signage elements (monuments,
    // pylons, dimensional letters, etc.).  Results are stored in the signs table
    // with source="exterior" so they can be handled separately from interior signs.
    // -------------------------------------------------------------------------

    const EXTERIOR_CANONICAL_TYPES = new Set([
      "Building ID", "Dimensional Letters", "Monument", "Pylon", "Tenant Sign",
      "ADA Parking", "Parking Regulatory", "Directional", "Exterior Exit",
      "Address Numbers", "Banner",
    ]);

    const mapExteriorSignType = (raw: string): string => {
      if (!raw) return "Other";
      const trimmed = raw.trim();
      if (EXTERIOR_CANONICAL_TYPES.has(trimmed)) return trimmed;
      const lower = trimmed.toLowerCase();
      if (/\bmonument\b/.test(lower)) return "Monument";
      if (/\bpylon\b/.test(lower)) return "Pylon";
      if (/\btenant\b/.test(lower)) return "Tenant Sign";
      if (/dimensional|channel.?letter/i.test(lower)) return "Dimensional Letters";
      if (/building.?id|building.?identifier/i.test(lower)) return "Building ID";
      if (/ada.?park/i.test(lower)) return "ADA Parking";
      if (/\bparking\b/.test(lower)) return "Parking Regulatory";
      if (/directional|wayfinding/i.test(lower)) return "Directional";
      if (/exterior.?exit|site.?exit/i.test(lower)) return "Exterior Exit";
      if (/address|street.?number/i.test(lower)) return "Address Numbers";
      if (/\bbanner\b/.test(lower)) return "Banner";
      return trimmed || "Other";
    };

    if (aggregateCountFastPath) {
      logger.log("[Step 3b] SKIPPED — authoritative aggregate count schedule fast path");
    } else {
      const exteriorSignRows: typeof signsTable.$inferInsert[] = [];
      let _3bSheets = 0;

      if (exteriorSheets.length > 0) {
        logger.log(`[Step 3b] Processing ${exteriorSheets.length} exterior sheet(s)…`);

        for (const extSheet of exteriorSheets) {
          const sheetFile = files.find((f) => f.id === extSheet.fileId);
          if (!sheetFile) continue;

          let pdfBuf = pdfBufferByFileId.get(extSheet.fileId ?? "");
          if (!pdfBuf) {
            try {
              pdfBuf = await downloadFromStorage(sheetFile.storagePath);
            } catch (err) {
              logger.warn(`[Step 3b] Could not download PDF for ${extSheet.sheetId}: ${err}`);
              continue;
            }
          }

          try {
            const _3bKey = `${extSheet.fileId ?? ""}:${extSheet.pdfPage ?? 1}`;
            const pageBase64 = prefetchedPageBase64.get(_3bKey)
              ?? (await rasterizePages(pdfBuf, [extSheet.pdfPage ?? 1], rasterizeDpi, sheetFile.filename)).pages[0];
            if (!pageBase64) {
              logger.warn(`[Step 3b] ${extSheet.sheetId}: rasterization produced no image`);
              continue;
            }

            const exteriorPrompt =
              "This is an architectural exterior site plan or elevation drawing. " +
              "Identify all exterior sign elements visible or annotated on this drawing. " +
              "For each sign return a JSON object: " +
              '{ "signType": "<one of: Building ID|Dimensional Letters|Monument|Pylon|Tenant Sign|ADA Parking|Parking Regulatory|Directional|Exterior Exit|Address Numbers|Banner|Other>", ' +
              '"location": "<brief description of where this sign is located on the site>", ' +
              '"qty": <integer number of this sign type, default 1>, ' +
              '"estimatedSize": "<width x height or overall size if shown, else empty string>", ' +
              '"ada": <true if this sign serves ADA/accessible parking or pathway, else false>, ' +
              '"notes": "<any relevant notes about materials, illumination, mounting, etc.>" }. ' +
              "Return a JSON array of all signs found. If no signs are found, return []. " +
              "Respond in raw JSON only — no markdown fences, no explanations.";

            const geminiResponse = await timedGenerate({
              model: CLAUDE_SCHEDULE_MODEL,
              contents: [{
                role: "user",
                parts: [
                  { inlineData: { mimeType: "image/png", data: pageBase64 } },
                  { text: exteriorPrompt },
                ],
              }],
              config: { maxOutputTokens: 8192 },
            });

            const rawText = (geminiResponse.text ?? "")
              .replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();

            let parsed: unknown;
            try {
              parsed = JSON.parse(rawText);
            } catch (parseErr) {
              logger.warn(`[Step 3b] ${extSheet.sheetId}: JSON parse failed: ${parseErr}`);
              continue;
            }

            const arr: unknown[] = Array.isArray(parsed)
              ? parsed
              : Array.isArray((parsed as Record<string, unknown>).data)
              ? (parsed as Record<string, unknown>).data as unknown[]
              : typeof parsed === "object" && parsed !== null
              ? [parsed]
              : [];

            let sheetCount = 0;
            for (const item of arr) {
              if (typeof item !== "object" || !item) continue;
              const obj = item as Record<string, unknown>;
              const rawType = String(obj.signType ?? "Other");
              const canonicalType = mapExteriorSignType(rawType);
              const location = String(obj.location ?? "").trim();
              const qty = typeof obj.qty === "number" && obj.qty > 0 ? Math.round(obj.qty) : 1;
              const estimatedSize = String(obj.estimatedSize ?? "").trim();
              const notes = String(obj.notes ?? "").trim();
              const isAda = obj.ada === true || /\bada\b/i.test(canonicalType);

              const messageStr = [
                isAda ? "ADA: yes" : null,
                notes || null,
              ].filter(Boolean).join(" | ") || undefined;

              exteriorSignRows.push({
                id: newId("sign"),
                jobId,
                tenantId,
                roomId: null,
                sheetId: extSheet.id,
                signType: canonicalType,
                qty,
                ruleRef: location || "Exterior",
                color: null,
                confidence: "1.000",
                status: "extracted",
                source: "exterior",
                dimensions: estimatedSize || undefined,
                message: messageStr,
              });
              sheetCount++;
            }

            logger.log(`[Step 3b] ${extSheet.sheetId}: ${sheetCount} exterior sign(s) extracted`);
            _3bSheets++;
          } catch (err) {
            logger.warn(`[Step 3b] ${extSheet.sheetId}: Gemini vision failed: ${err}`);
          }
        }

        if (exteriorSignRows.length > 0) {
          await db.insert(signsTable).values(exteriorSignRows);
          logger.log(
            `[Step 3b] Inserted ${exteriorSignRows.length} exterior sign(s) from ${_3bSheets} sheet(s)`,
          );
        } else {
          logger.log(`[Step 3b] No exterior signs extracted from ${exteriorSheets.length} sheet(s)`);
        }
      } else {
        logger.log("[Step 3b] SKIPPED — no exterior sheets found");
      }
    }

    // -------------------------------------------------------------------------
    // Step 3: Rasterize pages + extract rooms.
    //
    // Two-tier vision approach:
    //  Tier 1 (Haiku):  cheap YES/NO plan-view classifier — 1 cap unit per sheet.
    //  Tier 2 (Sonnet): full room + door extraction — 2 cap units per sheet.
    // Tier 2 only runs when Tier 1 returns YES.
    //
    // Sheets are processed in priority order (explicit plan titles first) so
    // that the most valuable sheets are never dropped if the cap is reached.
    // -------------------------------------------------------------------------
    await wp(3, "Rasterizing floor plan pages + extracting rooms");

    // ── Step 3 entry diagnostic ────────────────────────────────────────────────
    // Report every sheet found after Step 2, how many passed the hard-exclude
    // filter, and the exact reason each sheet was excluded.  If nothing passes
    // we warn and fall back to scanning every A-prefix sheet so Step 3 never
    // silently produces zero rooms.
    {
      const totalSheets = sheetDbRows.length;

      // ── DIAGNOSTIC: full sheet manifest from Step 2 ────────────────────────
      logger.log(`[pipeline] Step 3 DIAG: full sheet manifest from Step 2 (${sheetDbRows.length} sheet(s)):`);
      for (const s of sheetDbRows) {
        logger.log(
          `[pipeline]   sheet: id=${s.sheetId} | title="${s.sheetTitle ?? "(none)"}" | type=${s.sheetType ?? "(none)"} | level=${s.level ?? "(none)"} | pdfPage=${s.pdfPage ?? "(none)"} | fileId=${s.fileId ?? "(none)"}`,
        );
      }
      // ──────────────────────────────────────────────────────────────────────
      // Vision candidates: sheets where shouldRunVisionScan returned true.
      // (Signage-schedule sheets bypass shouldRunVisionScan for Step 4 but are
      //  counted separately — they are not vision-scanned in Step 3.)
      const visionCandidateIds = new Set(
        sheetDbRows
          .filter((s) => shouldRunVisionScan(s.sheetId, s.sheetTitle ?? null))
          .map((s) => s.sheetId),
      );
      const signageIds = new Set(
        sheetDbRows.filter((s) => s.sheetType === "signage_schedule").map((s) => s.sheetId),
      );
      const excludedRows = sheetDbRows.filter(
        (s) => !visionCandidateIds.has(s.sheetId) && !signageIds.has(s.sheetId),
      );

      logger.log(
        `[pipeline] Step 3 entry: ${totalSheets} total sheet(s) from Step 2 | ` +
        `${visionCandidateIds.size} passed hard-exclude filter | ` +
        `${excludedRows.length} excluded | ` +
        `${signageIds.size} signage schedule (Step 4 only)`,
      );

      for (const s of excludedRows) {
        const reason = getExclusionReason(s.sheetId, s.sheetTitle ?? null) ?? "unknown reason";
        const label = s.sheetTitle ? `"${s.sheetTitle}"` : "(no title)";
        logger.log(`[pipeline] Step 3 excluded: ${s.sheetId} ${label} — ${reason}`);
      }

      if (visionCandidateIds.size === 0) {
        logger.warn(
          `[pipeline] Step 3 WARNING: all ${totalSheets} sheet(s) excluded — ` +
          `falling back to scanning all A-prefix sheets`,
        );
        const fallbackSheets = sheetDbRows.filter(
          (s) => /^A/i.test(s.sheetId),
        );
        if (fallbackSheets.length > 0) {
          logger.log(
            `[pipeline] Step 3 fallback: ${fallbackSheets.length} A-prefix sheet(s) will be scanned: ` +
            fallbackSheets.map((s) => s.sheetId).join(", "),
          );
          // Widen the relevant set in-place so the sort below picks them up.
          for (const s of fallbackSheets) {
            if (!relevantSheets.some((r) => r.sheetId === s.sheetId)) {
              relevantSheets.push(s);
            }
          }
        } else {
          logger.warn(
            `[pipeline] Step 3 fallback: no A-prefix sheets found in this job — ` +
            `Step 3 will produce 0 rooms`,
          );
        }
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    const sheetImageMap = new Map<string, string>(); // sheetId → storagePath
    const sheetBase64Map = new Map<string, string>(); // sheetId → base64 PNG (reused by Steps 4 & 7)

    logger.log(`[pipeline] Step 3: total sheets before filter = ${allSheets.length}`);
    logger.log(`[pipeline] Step 3: relevantSheets count = ${relevantSheets.length} — sheets included in room extraction:`);
    for (const s of relevantSheets) {
      logger.log(
        `[pipeline] Step 3 included: id=${s.sheetId} | title="${s.sheetTitle ?? "(none)"}" | type=${s.sheetType ?? "(none)"} | level=${s.level ?? "(none)"}`,
      );
    }

    // Process floor plan sheets in parallel batches (3 at a time).
    // JS is single-threaded so array/map mutations across async callbacks are safe.
    // Every sheet is always processed — no early-exit heuristic.
    logger.log(
      `[pipeline] Step 3: strategy=${pipelineStrategy} — ` +
      `${floorPlanSheets.length} sheets to process, ` +
      `cache=${CACHE_ENABLED ? "enabled" : "disabled"}`,
    );
    // Coordinates captured from ALL rooms returned by Gemini (unfiltered) —
    // used in Step 3b to match schedule rooms to floor plan locations.
    const allSheetCoordinates: Array<{
      roomNumber: string;
      x: number | null;
      y: number | null;
      sheetDbId: string;
      level: string | null;
    }> = [];
    // Egress room name patterns — rooms matching these are always extracted
    // in schedule_primary mode (rules engine needs them to produce egress signs).
    // NOTE: /corridor/ and /hallway/ are intentionally NOT included here —
    // corridors are excluded from extractedRooms (R16 handles their directional signs).
    const EGRESS_ROOM_PATTERNS = [
      /stair/i, /exit/i, /elevator/i, /elev/i, /lobby/i,
      /vestibule/i, /mechanical/i, /electrical/i, /fire/i,
    ];
    const SHEET_BATCH_SIZE = sheetBatchSize; // env SHEET_BATCH_SIZE (default 4)
    for (let _bi = 0; _bi < relevantSheets.length; _bi += SHEET_BATCH_SIZE) {
      const _batch = relevantSheets.slice(_bi, _bi + SHEET_BATCH_SIZE);
      await Promise.all(_batch.map(async (sheet) => {
      const file = files.find((f) => f.id === sheet.fileId);
      if (!file) return;
      if (!file.filename.toLowerCase().endsWith(".pdf")) return;

      let pdfBuffer: Buffer;
      try {
        // Use the cached buffer from Step 2 (pdfBufferByFileId) to avoid
        // re-downloading the same file for every sheet in parallel.
        pdfBuffer = pdfBufferByFileId.get(file.id) ?? await downloadFromStorage(file.storagePath);
      } catch {
        return;
      }

      if (!sidecarOk) return;

          try {
            const _prefetchKey = `${sheet.fileId ?? ""}:${sheet.pdfPage ?? 1}`;
            // Tiling decision is pure file-size and known up front, so make it here
            // (before any render). When tiling, a single rasterize-tiles call yields
            // BOTH the crisp full page (thumbnail + downstream Steps 4/7) and the
            // downscaled room-scan tiles — the page is rasterized only once instead
            // of a full-page render followed by a separate tile render.
            const TILING_FILE_SIZE_THRESHOLD = 15 * 1024 * 1024; // 15 MB
            const shouldTile = (file.fileSizeBytes ?? 0) > TILING_FILE_SIZE_THRESHOLD;
            let stashedTiles: RasterTile[] | null = null;

            let pngBase64 = prefetchedPageBase64.get(_prefetchKey);
            if (!pngBase64 && shouldTile) {
              try {
                const tr = await rasterizeTiles(pdfBuffer, sheet.pdfPage ?? 1, 100, file.filename, rasterizeDpi);
                if (tr.fullPage) {
                  pngBase64 = tr.fullPage;
                  stashedTiles = tr.tiles;
                  // Share the full page with later steps (Step 4 plaque, Step 7,
                  // Step 9.2) so they never re-rasterize this page.
                  prefetchedPageBase64.set(_prefetchKey, tr.fullPage);
                }
              } catch (combinedErr) {
                logger.warn(`[pipeline] Step 3/rooms: combined tile render failed for ${sheet.sheetId}, falling back to full-page rasterize: ${combinedErr}`);
              }
            }
            if (!pngBase64) {
              const targetPage = sheet.pdfPage ?? 1;
              try {
                pngBase64 = (await rasterizePages(pdfBuffer, [targetPage], rasterizeDpi, file.filename)).pages[0];
                if (pngBase64) prefetchedPageBase64.set(_prefetchKey, pngBase64);
              } catch {
                // Requested page doesn't exist in the PDF (common when parse-index
                // creates Level 2/3 sheet rows from a single-page PDF that covers
                // multiple floors — e.g. residential buildings where one physical
                // drawing sheet represents all levels of a wing).
                // Fall back to page 1, which is the actual rendered floor plan.
                if (targetPage > 1) {
                  const _fallbackKey = `${sheet.fileId ?? ""}:1`;
                  pngBase64 = prefetchedPageBase64.get(_fallbackKey)
                    ?? (await rasterizePages(pdfBuffer, [1], rasterizeDpi, file.filename)).pages[0];
                }
              }
            }
            if (!pngBase64) return;
            sheetBase64Map.set(sheet.id!, pngBase64);

            const pngBuffer = Buffer.from(pngBase64, "base64");
            // Include page number in filename: the same sheet_id (e.g. "I-001") can
            // appear on multiple PDF pages; using just the id would overwrite earlier images.
            const pngPath = `rasterized/${jobId}/${sheet.sheetId}-p${sheet.pdfPage ?? 1}.png`;

            try {
              const storagePath = await uploadToStorage(pngPath, pngBuffer, "image/png", tenantId);
              sheetImageMap.set(sheet.id!, storagePath);

              await db.update(jobSheetsTable)
                .set({ rasterizedPath: storagePath })
                .where(eq(jobSheetsTable.id, sheet.id!));
            } catch (uploadErr) {
              logger.warn(`[pipeline] Could not upload rasterized page: ${uploadErr}`);
            }

            // ── DIAGNOSTIC: confirm rasterization produced an image ───────────
            logger.log(
              `[pipeline] Step 3 DIAG: rasterized sheet` +
              ` | sheetId=${sheet.sheetId}` +
              ` | title="${sheet.sheetTitle ?? "(none)"}"` +
              ` | type=${sheet.sheetType ?? "(none)"}` +
              ` | level=${sheet.level ?? "(none)"}` +
              ` | pdfPage=${sheet.pdfPage ?? "(none)"}` +
              ` | pngBase64[0..100]="${pngBase64.slice(0, 100)}"`,
            );
            // ─────────────────────────────────────────────────────────────────

            // ── Room extraction (two-pass classifier):
            // Pass 1 already ran via shouldRunVisionScan → isRelevant, so every
            // sheet here is a candidate. Pass 2 is the AI's isPlanView field —
            // if the model says this is not an overhead floor plan view it is
            // discarded and no rooms are added (see isPlanView gate below).
            if (true) {
              const sheetKey = `${sheet.fileId ?? ""}|${sheet.sheetTitle ?? ""}|${sheet.pdfPage ?? 0}`;
              const priorAiVisionRooms = (options?.forceAiRescan || !CACHE_ENABLED)
                ? [] // explicit cache bypass — force flag or cache disabled means always fresh AI scan
                : (priorAiVisionBySheetKey.get(sheetKey) ?? []);

              if (priorAiVisionRooms.length > 0) {
                // Reuse cached rooms — skip AI call.
                // Cached rooms means this sheet was previously confirmed as a floor plan.
                // IMPORTANT: apply the same validation as the fresh extraction path so
                // garbled rooms written to DB on prior runs are never re-promoted.
                visionConfirmedPlanCount++;
                // Null-safe coord clamp: return null when the value is absent
                // rather than defaulting to 50000 (page centre). Null means
                // "unlocated" — the marker will not be rendered on the Plans tab.
                const clampCoordCached = (v: number | undefined | null): number | null =>
                  v != null ? Math.max(0, Math.min(100000, Math.round(v))) : null;
                let reusedCount = 0;
                let cacheRejected = 0;
                const dedupKeys = new Set<string>();
                // Gate the allowlist the same way the authoritative post-filter does:
                // only enforce when this building's numbering matches the scheme.
                const cacheApplyAllowlist = shouldApplyRoomNumberAllowlist(
                  priorAiVisionRooms,
                  job.buildingType ?? null,
                );
                for (const r of priorAiVisionRooms) {
                  const dk = `${r.roomNumber.trim().toLowerCase()}|${r.roomName.trim().toLowerCase()}`;
                  if (dedupKeys.has(dk)) continue;
                  dedupKeys.add(dk);
                  // Validate room name — same filter as fresh extraction path
                  if (isJunkRoomName(r.roomName)) { cacheRejected++; continue; }
                  // Validate room number — same allowlist as post-filter (defence-in-depth)
                  if (cacheApplyAllowlist && !isAllowedRoomNumber(r.roomNumber, job.buildingType ?? null)) { cacheRejected++; continue; }
                  const cachedX = clampCoordCached(r.coordX);
                  const cachedY = clampCoordCached(r.coordY);
                  const cachedSource = cachedX != null
                    ? ((r.coordSource as string | null) ?? "vision_estimated")
                    : "unlocated";
                  // Always capture coordinates for Step 3b (all rooms, unfiltered by mode)
                  allSheetCoordinates.push({
                    roomNumber: r.roomNumber,
                    x: cachedX,
                    y: cachedY,
                    sheetDbId: sheet.id!,
                    level: getFloorFromSheetTitle(sheet.sheetTitle ?? "") ?? r.level ?? sheet.level ?? null,
                  });
                  // schedule_primary: only push egress-type rooms — schedule drives unit/office/corridor rooms
                  // Corridors are explicitly excluded even if they match an egress pattern
                  if (pipelineStrategy === "schedule_primary") {
                    const isEgressRoom = EGRESS_ROOM_PATTERNS.some(p =>
                      p.test(r.roomName) || p.test(r.roomNumber),
                    );
                    const isCorridor = /corridor|hallway/i.test(r.roomName);
                    if (!isEgressRoom || isCorridor) { cacheRejected++; continue; }
                  }
                  extractedRooms.push({
                    roomNumber: r.roomNumber,
                    roomName: expandSynonyms(r.roomName),
                    level: inferLevelFromRoomNumber(r.roomNumber ?? "") ?? getFloorFromSheetTitle(sheet.sheetTitle ?? "") ?? r.level ?? sheet.level ?? "LEVEL 1",
                    x: cachedX,
                    y: cachedY,
                    sheetDbId: sheet.id!,
                    aiVision: true,
                    aiConfidence: r.confidence ?? AI_VISION_CONFIDENCE,
                    aiIsRestroom: r.isRestroom ?? false,
                    coordSource: cachedSource,
                  });
                  reusedCount++;
                }
                step6CacheHits++;
                step6SheetResults.push({ sheetId: sheet.sheetId, status: "cached" });
                logger.log(
                  `[pipeline] Step 3/rooms: ${sheet.sheetId} — reused ${reusedCount}/${priorAiVisionRooms.length} cached ai_vision rooms` +
                  (cacheRejected > 0 ? ` (cache restore: rejected ${cacheRejected} invalid rooms)` : ""),
                );

              } else if (
                // Only confirmed floor-plan scans (fresh_scan) and cache hits count toward the cap.
                // Text-only sheets (isPlanView=false → skipped_filter) don't consume quota
                // so the scanner can reach the actual floor plan even when early pages are
                // title/index sheets.
                step6SheetResults.filter(r => r.status === "fresh_scan" || r.status === "cached").length < effectiveVisionCap
              ) {
                // Fresh AI scan using the Sonnet model.
                // Build the already-detected rooms list for this sheet so the
                // prompt only asks for rooms MISSING from text extraction.
                const alreadyDetected = extractedRooms
                  .filter(r => r.sheetDbId === sheet.id)
                  .map(r => `- ${r.roomNumber ? `${r.roomNumber} ` : ""}${r.roomName}`.trim())
                  .join("\n");

                const { systemPrompt, userPrompt } = buildRoomExtractionPrompt(
                  sheet.sheetTitle ?? null,
                  sheet.level ?? null,
                  trainingContext,
                  alreadyDetected,
                  likelyRestroomSet,
                  job.buildingType ?? null,
                );

                // -------------------------------------------------------
                // Tiling path: rasterize large sheets in 2×2 tiles to
                // improve sign-label legibility on dense floor plans.
                // `shouldTile` and the tile set are computed once at the top of
                // the per-sheet block (single combined render); reuse them here.
                // -------------------------------------------------------
                const TILE_VISION_TIMEOUT_MS = 90_000; // 90s per tile — prevents a hung Gemini call from stalling the whole pipeline
                let tilingSucceeded = false;

                if (shouldTile) {
                  logger.log(`[pipeline] Step 3/rooms: ${sheet.sheetId} — tiling mode (fileSizeBytes=${file.fileSizeBytes ?? 0})`);
                  try {
                    // Reuse the tiles produced by the combined render above; only
                    // render again if they're unavailable (e.g. prefetch supplied
                    // the full page, or the combined render fell back).
                    const tiles = stashedTiles
                      ?? (await rasterizeTiles(pdfBuffer, sheet.pdfPage ?? 1, 100, file.filename, rasterizeDpi)).tiles;
                    logger.log(`[pipeline] Step 3/rooms: ${sheet.sheetId} — ${tiles.length} tiles`);

                    interface _TileRoom {
                      roomNumber: string;
                      roomName: string;
                      isRestroom: boolean;
                      x: number | null;
                      y: number | null;
                      level: string | null;
                      confidence: number | null;
                    }

                    const allTileRooms: _TileRoom[] = [];
                    let tiledInputTokens = 0;
                    let tiledOutputTokens = 0;
                    let tiledCost = 0;
                    let tiledFloorLevel: string | null = null;

                    // Scan all tiles concurrently (S2b) — each is an independent
                    // Gemini call with its own timeout. Per-tile failures are caught
                    // and yield an empty outcome (matches the old per-tile try/catch).
                    // Outcomes are reduced in tile order afterwards so token sums,
                    // the first-tile floorLevel, and dedup "keep first occurrence"
                    // stay identical to the old sequential loop.
                    interface _TileOutcome {
                      rooms: _TileRoom[];
                      inputTokens: number;
                      outputTokens: number;
                      cost: number;
                      floorLevel: string | null;
                    }
                    const tileOutcomes = await Promise.all(tiles.map(async (tile): Promise<_TileOutcome> => {
                      const out: _TileOutcome = { rooms: [], inputTokens: 0, outputTokens: 0, cost: 0, floorLevel: null };
                      try {
                        const { text: tileText, usage: tileUsage } = await Promise.race([
                          callClaudeVision(
                            systemPrompt,
                            userPrompt,
                            tile.base64,
                            "image/png",
                            onRetry,
                            aiCallOptions.maxRetries,
                            aiCallOptions.baseDelayMs,
                            CLAUDE_ROOM_EXTRACTION_MODEL,
                            0,
                          ),
                          new Promise<never>((_, reject) =>
                            setTimeout(
                              () => reject(new Error(`tile [${tile.col},${tile.row}] vision timeout after ${TILE_VISION_TIMEOUT_MS / 1000}s`)),
                              TILE_VISION_TIMEOUT_MS,
                            )
                          ),
                        ]);
                        out.inputTokens = tileUsage.inputTokens;
                        out.outputTokens = tileUsage.outputTokens;
                        out.cost = tileUsage.cost;

                        let tileParsed: VisionResponse;
                        try {
                          const js = tileText.indexOf("{");
                          const je = tileText.lastIndexOf("}");
                          tileParsed = JSON.parse(
                            js !== -1 && je !== -1 ? tileText.slice(js, je + 1) : tileText,
                          ) as VisionResponse;
                        } catch {
                          logger.warn(`[pipeline] Step 3/rooms: tile [${tile.col},${tile.row}] JSON parse failed for ${sheet.sheetId}`);
                          return out;
                        }

                        if (typeof tileParsed.floorLevel === "string" && tileParsed.floorLevel.trim()) {
                          out.floorLevel = tileParsed.floorLevel.trim();
                        }

                        const tileRoomsArr = Array.isArray(tileParsed.rooms)
                          ? tileParsed.rooms
                          : Array.isArray(tileParsed.missedRooms)
                          ? tileParsed.missedRooms
                          : [];

                        for (const raw of tileRoomsArr) {
                          const item = raw as unknown as Record<string, unknown>;
                          const rawX = item.x;
                          const rawY = item.y;
                          const numX = typeof rawX === "number" ? rawX : (typeof rawX === "string" ? parseFloat(rawX) : undefined);
                          const numY = typeof rawY === "number" ? rawY : (typeof rawY === "string" ? parseFloat(rawY) : undefined);
                          // tile.offsetX/Y and tile.scaleX/Y are 0.0–1.0 fractions of the full page.
                          // numX/numY from Gemini are 0.0–1.0 fractions within the tile.
                          // Full sheet coordinate space is 0–100,000.
                          const fullX = numX != null && !isNaN(numX) ? (tile.offsetX + numX * tile.scaleX) * 100_000 : null;
                          const fullY = numY != null && !isNaN(numY) ? (tile.offsetY + numY * tile.scaleY) * 100_000 : null;
                          const clampedX = fullX != null ? Math.max(1000, Math.min(99_000, Math.round(fullX))) : null;
                          const clampedY = fullY != null ? Math.max(1000, Math.min(99_000, Math.round(fullY))) : null;
                          out.rooms.push({
                            roomNumber: String(item.roomNumber ?? item.room_number ?? "").trim(),
                            roomName: String(item.roomName ?? item.room_name ?? "").trim(),
                            isRestroom: Boolean(item.isRestroom ?? item.is_restroom ?? false),
                            x: clampedX,
                            y: clampedY,
                            level: String(item.level ?? "").trim() || null,
                            confidence: typeof item.confidence === "number" ? item.confidence : null,
                          });
                        }
                      } catch (tileErr) {
                        logger.warn(`[pipeline] Step 3/rooms: tile [${tile.col},${tile.row}] vision failed for ${sheet.sheetId}: ${tileErr}`);
                      }
                      return out;
                    }));

                    for (const out of tileOutcomes) {
                      tiledInputTokens += out.inputTokens;
                      tiledOutputTokens += out.outputTokens;
                      tiledCost += out.cost;
                      if (!tiledFloorLevel && out.floorLevel) tiledFloorLevel = out.floorLevel;
                      for (const r of out.rooms) allTileRooms.push(r);
                    }

                    const tiledUsage: ClaudeUsage = {
                      inputTokens: tiledInputTokens,
                      outputTokens: tiledOutputTokens,
                      cost: tiledCost,
                    };
                    aiVisionCallsThisRun++;
                    recordAiScan("room_extraction_tiled", tiledUsage, CLAUDE_ROOM_EXTRACTION_MODEL);
                    step6FreshScans++;
                    step6FreshScanCost += tiledCost;
                    step6SheetResults.push({ sheetId: sheet.sheetId, status: "fresh_scan" });

                    visionConfirmedPlanCount++;
                    if (sheet.sheetType !== "signage_schedule" && sheet.sheetType !== "room_schedule") {
                      sheet.sheetType = "floor_plan";
                    }

                    // Deduplicate by roomNumber|roomName key (tiles overlap, so same room
                    // may appear in multiple tiles — keep first occurrence by x/y proximity).
                    const seenTileKeys = new Set<string>();
                    let tiledAddedCount = 0;
                    const clampTilePct = (v: number | null): number | null => {
                      if (v == null || isNaN(v)) return null;
                      return Math.max(0, Math.min(100, Math.round(v)));
                    };

                    for (const r of allTileRooms) {
                      if (!r.roomNumber && !r.roomName) continue;
                      if (isJunkRoomName(r.roomName)) continue;
                      const tileKey = `${r.roomNumber.toLowerCase()}|${r.roomName.toLowerCase()}`;
                      if (seenTileKeys.has(tileKey)) continue;
                      seenTileKeys.add(tileKey);

                      const freshX = clampTilePct(r.x);
                      const freshY = clampTilePct(r.y);
                      const tileLevel = parseLevelFromContext(r.level, sheet.sheetTitle ?? null, r.roomNumber)
                        ?? r.level ?? sheet.level ?? "LEVEL 1";
                      const tileConfidence = r.confidence != null && r.confidence >= 0 && r.confidence <= 1
                        ? String(r.confidence)
                        : AI_VISION_CONFIDENCE;

                      extractedRooms.push({
                        roomNumber: r.roomNumber,
                        roomName: expandSynonyms(r.roomName),
                        level: tileLevel,
                        x: freshX != null ? freshX * 1000 : null,
                        y: freshY != null ? freshY * 1000 : null,
                        sheetDbId: sheet.id!,
                        aiVision: true,
                        aiConfidence: tileConfidence,
                        aiIsRestroom: r.isRestroom,
                        coordSource: freshX != null ? "vision_estimated_gemini" : "unlocated",
                      });
                      tiledAddedCount++;
                    }

                    // Apply tiledFloorLevel (from first tile with a level) to all rooms
                    // added from this sheet, same logic as the non-tiled path.
                    const tiledTitleLevelFallback = getFloorFromSheetTitle(sheet.sheetTitle ?? "") ?? sheet.level ?? null;
                    if (tiledFloorLevel || tiledTitleLevelFallback) {
                      // Leave per-room levels that were set by room-number inference intact.
                      // (Simplified: level already set per-room above using parseLevelFromContext.)
                    }

                    logger.log(`[pipeline] Step 3/rooms: ${sheet.sheetId} — tiled scan added ${tiledAddedCount} rooms from ${tiles.length} tiles (cost=$${tiledCost.toFixed(4)})`);
                    tilingSucceeded = true;
                  } catch (tileErr) {
                    logger.warn(`[pipeline] Step 3/rooms: tiling failed for ${sheet.sheetId}, falling back to full-page scan: ${tileErr}`);
                  }
                }

                if (!tilingSucceeded) {
                try {
                  const { text, usage, provider } = await callClaudeVision(
                    systemPrompt,
                    userPrompt,
                    pngBase64,
                    "image/png",
                    onRetry,
                    aiCallOptions.maxRetries,
                    aiCallOptions.baseDelayMs,
                    CLAUDE_ROOM_EXTRACTION_MODEL,
                    0, // temperature: 0 for consistent results across rescans
                  );
                  aiVisionCallsThisRun++;
                  recordAiScan("room_extraction", usage, CLAUDE_ROOM_EXTRACTION_MODEL);
                  step6FreshScans++;
                  step6FreshScanCost += usage.cost;
                  step6SheetResults.push({ sheetId: sheet.sheetId, status: "fresh_scan" });

                  // DIAGNOSTIC: log the FULL raw response so we can see exactly
                  // what the model returned (format, field names, values).
                  logger.log(`[pipeline] Step 3 DIAG: FULL raw vision response for ${sheet.sheetId} (${text.length} chars):\n${text}`);

                  let parsed: VisionResponse;
                  try {
                    const jsonStart = text.indexOf("{");
                    const jsonEnd = text.lastIndexOf("}");
                    parsed = JSON.parse(jsonStart !== -1 && jsonEnd !== -1 ? text.slice(jsonStart, jsonEnd + 1) : text) as VisionResponse;
                  } catch {
                    // SALVAGE: a dense sheet can exceed the output-token cap and the
                    // model returns a truncated array (cut off mid-object). Rather
                    // than drop the entire sheet, recover every COMPLETE room object
                    // emitted before the cut. We slice the "rooms" array, walk it
                    // with a brace/string-aware scanner, and keep objects up to the
                    // last balanced "}". This turns a total loss into a partial win.
                    const salvaged = salvageTruncatedRooms(text);
                    if (salvaged && salvaged.rooms.length > 0) {
                      parsed = salvaged as VisionResponse;
                      logger.warn(
                        `[pipeline] Step 3/rooms: vision JSON for ${sheet.sheetId} was truncated; ` +
                        `salvaged ${salvaged.rooms.length} complete room object(s).`,
                      );
                    } else {
                      logger.warn(`[pipeline] Step 3/rooms: Could not parse vision JSON for ${sheet.sheetId}`);
                      if (++step6ProcessedCount % STEP6_FLUSH_INTERVAL === 0) await flushStep6Progress(step6SheetResults);
                      return;
                    }
                  }

                  // Normalise: new prompt emits "rooms", legacy/fallback emits "missedRooms".
                  const parsedRoomsArr = Array.isArray(parsed.rooms)
                    ? parsed.rooms
                    : Array.isArray(parsed.missedRooms)
                    ? parsed.missedRooms
                    : null;

                  // DIAGNOSTIC: log isPlanView decision + room count from parsed response.
                  logger.log(
                    `[pipeline] Step 3 DIAG: parsed response for ${sheet.sheetId}` +
                    ` | isPlanView=${JSON.stringify(parsed.isPlanView)}` +
                    ` | rooms.length=${parsedRoomsArr !== null ? parsedRoomsArr.length : `NOT_ARRAY(rooms=${typeof parsed.rooms},missedRooms=${typeof parsed.missedRooms})`}`,
                  );

                  const _roomsFound = parsedRoomsArr !== null ? parsedRoomsArr.length : 0;
                  logger.log(
                    `Vision scan ${sheet.sheetId}: ${provider} | rooms_found=${_roomsFound} | cost_estimate=$${usage.cost.toFixed(4)}`,
                  );

                  // Content-based plan-view gate (Pass 2): if the model says this sheet
                  // is not an overhead floor plan (elevation, section, detail, schedule,
                  // etc.) discard all rooms.
                  // For sidecar-discovered sheets (not synthesized), reclassify them as
                  // sign_details so Step 9.2 can extract specialty sign data from them.
                  if (parsed.isPlanView === false) {
                    logger.log(`[pipeline] Step 3/rooms: ${sheet.sheetId} — skipped (isPlanView=false, not an overhead plan view)`);
                    // Reclassify non-synthesized sheets so specialty extraction runs.
                    if (!didSynthesize && sheet.id) {
                      logger.log(`[pipeline] Step 3: reclassifying ${sheet.sheetId} as sign_details (isPlanView=false + sidecar-discovered)`);
                      sheet.sheetType = "sign_details";
                      await db.update(jobSheetsTable)
                        .set({ sheetType: "sign_details" })
                        .where(eq(jobSheetsTable.id, sheet.id));
                    }
                    step6SheetResults[step6SheetResults.length - 1] = { sheetId: sheet.sheetId, status: "skipped_filter" };
                    if (++step6ProcessedCount % STEP6_FLUSH_INTERVAL === 0) await flushStep6Progress(step6SheetResults);
                    return;
                  }

                  // isPlanView=true (or omitted, treated as true for back-compat):
                  // this sheet is a confirmed overhead floor plan. Promote the
                  // in-memory sheetType so floorPlanSheets rebuild picks it up.
                  // Guard: never demote a dedicated sign-doc sheet (signage_schedule)
                  // or a room_schedule sheet to floor_plan — both were deliberately
                  // classified and must be preserved so Step 4b-rs can extract rooms.
                  visionConfirmedPlanCount++;
                  if (sheet.sheetType !== "signage_schedule" && sheet.sheetType !== "room_schedule") {
                    sheet.sheetType = "floor_plan";
                  }

                  const missedRooms = parsedRoomsArr ?? [];
                  let addedCount = 0;
                  let schedulePrimarySkipped = 0;
                  const existingKeys = new Set<string>();

                  for (const raw of missedRooms) {
                    // Normalize both camelCase and snake_case field names.
                    // Claude sometimes returns snake_case despite the prompt
                    // showing camelCase examples, which silently drops all rooms.
                    const item = raw as unknown as Record<string, unknown>;
                    const roomNumber = String(item.roomNumber ?? item.room_number ?? "").trim();
                    const roomName   = String(item.roomName   ?? item.room_name   ?? "").trim();
                    const isRestroom = Boolean(item.isRestroom ?? item.is_restroom ?? false);
                    const rawX = item.x;
                    const rawY = item.y;
                    const numX = typeof rawX === "number" ? rawX : (typeof rawX === "string" ? parseFloat(rawX) : undefined);
                    const numY = typeof rawY === "number" ? rawY : (typeof rawY === "string" ? parseFloat(rawY) : undefined);
                    const rawItemLevel = String(item.level ?? "").trim() || null;
                    const level = parseLevelFromContext(rawItemLevel, sheet.sheetTitle ?? null, roomNumber)
                      ?? rawItemLevel ?? sheet.level ?? "LEVEL 1";
                    // Use per-room confidence from the new prompt if present; fall back to constant.
                    const rawConfidence = item.confidence;
                    const itemConfidence = typeof rawConfidence === "number" && rawConfidence >= 0 && rawConfidence <= 1
                      ? String(rawConfidence)
                      : AI_VISION_CONFIDENCE;

                    // Keep if at least one of roomName / roomNumber is non-empty
                    if (!roomNumber && !roomName) continue;
                    const key = `${roomNumber.toLowerCase()}|${roomName.toLowerCase()}`;
                    if (existingKeys.has(key)) continue;
                    existingKeys.add(key);

                    // x/y are percentages (0–100) when returned by the vision prompt.
                    // Multiply by 1000 to convert to the 0–100000 internal scale.
                    // When coords are absent or NaN use null ("unlocated") — never
                    // default to 50 (page centre) which creates phantom markers.
                    const clampPct = (v: number | undefined | null): number | null => {
                      if (v == null || isNaN(v as number)) return null;
                      return Math.max(0, Math.min(100, Math.round(v)));
                    };
                    const freshX = clampPct(numX);
                    const freshY = clampPct(numY);
                    if (isJunkRoomName(roomName)) continue;

                    // Always capture coordinates for Step 3b — even in schedule_primary mode.
                    // These are used to assign x/y to schedule rooms without extra AI calls.
                    allSheetCoordinates.push({
                      roomNumber,
                      x: freshX != null ? freshX * 1000 : null,
                      y: freshY != null ? freshY * 1000 : null,
                      sheetDbId: sheet.id!,
                      level: getFloorFromSheetTitle(sheet.sheetTitle ?? "") ?? sheet.level ?? null,
                    });

                    // schedule_primary: only push egress-type rooms to extractedRooms.
                    // The sign schedule is the source of truth for unit/office/corridor rooms.
                    // Corridors are explicitly excluded even if they match an egress pattern.
                    if (pipelineStrategy === "schedule_primary") {
                      const expandedName = expandSynonyms(roomName);
                      const isEgressRoom = EGRESS_ROOM_PATTERNS.some(p =>
                        p.test(expandedName) || p.test(roomName),
                      );
                      const isCorridor = /corridor|hallway/i.test(expandedName) || /corridor|hallway/i.test(roomName);
                      if (!isEgressRoom || isCorridor) {
                        schedulePrimarySkipped++;
                        continue;
                      }
                    }

                    extractedRooms.push({
                      roomNumber,
                      roomName: expandSynonyms(roomName),
                      level,
                      x: freshX != null ? freshX * 1000 : null,
                      y: freshY != null ? freshY * 1000 : null,
                      sheetDbId: sheet.id!,
                      aiVision: true,
                      aiConfidence: itemConfidence,
                      aiIsRestroom: isRestroom,
                      coordSource: freshX != null ? "vision_estimated_gemini" : "unlocated",
                    });
                    addedCount++;
                  }
                  if (pipelineStrategy === "schedule_primary" && (addedCount > 0 || schedulePrimarySkipped > 0)) {
                    logger.log(
                      `[pipeline] Step 3 ${sheet.sheetId}: schedule_primary — ` +
                      `keeping ${addedCount} egress rooms, skipping ${schedulePrimarySkipped} unit/office/corridor rooms`,
                    );
                  }

                  // Apply Claude's detected floor level to all rooms just added from this sheet.
                  // This overrides the per-room level field (which may be a page-number label)
                  // with the canonical level Claude read directly from the title block.
                  const extractedFloorLevel =
                    typeof parsed.floorLevel === "string" && parsed.floorLevel.trim().length > 0
                      ? parsed.floorLevel.trim()
                      : null;

                  // Determine sheet-level fallback.  Used ONLY when room-number inference (Pass 0)
                  // cannot produce a confident answer.  extractedFloorLevel (Claude's detected
                  // level from the vision response) is authoritative sheet context but is
                  // unreliable on DiNisco and similar plans where sign-legend labels like
                  // "LEVEL 1 PANEL" appear on every page — causing the model to hallucinate
                  // the sheet's floor level even on 2nd-floor sheets.
                  // We therefore NEVER let it overwrite a room whose number unambiguously
                  // encodes the floor (W2xx → Level 2, E3xx → Level 3, etc.).
                  // Priority 2 fallback: title-only (never Claude's extracted floor level which
                  // hallucinates "LEVEL 1" on DiNisco multi-floor plans due to panel labels).
                  const titleLevelFallback = getFloorFromSheetTitle(sheet.sheetTitle ?? "") ?? sheet.level ?? null;

                  let pass0Kept = 0, fallbackApplied = 0;
                  for (const room of extractedRooms) {
                    if (room.sheetDbId !== sheet.id) continue;
                    // Pass 0: room number prefix is the highest-confidence source.
                    // W206, E127, WC301 are unambiguous — never let the sheet-level overwrite them.
                    const passZeroLevel = inferLevelFromRoomNumber(room.roomNumber ?? "");
                    if (passZeroLevel) {
                      room.level = passZeroLevel;
                      pass0Kept++;
                    } else if (titleLevelFallback) {
                      // No room-number inference available — use sheet title / sidecar level.
                      room.level = titleLevelFallback;
                      fallbackApplied++;
                    }
                    // If neither source is available, leave room.level as-is (AI-extracted).
                  }
                  if (pass0Kept > 0 || fallbackApplied > 0) {
                    logger.log(
                      `[pipeline] Step 3: ${sheet.sheetId} — level resolution: ` +
                      `${pass0Kept} room(s) kept Pass 0 inference` +
                      (titleLevelFallback ? `, ${fallbackApplied} room(s) used title fallback (${titleLevelFallback})` : "") +
                      (extractedFloorLevel && pass0Kept > 0
                        ? ` [ignored model floorLevel="${extractedFloorLevel}" for ${pass0Kept} room(s) — title priority]`
                        : ""),
                    );
                  }

                  logger.log(`[pipeline] Step 3/rooms: ${sheet.sheetId} — extracted ${addedCount} room(s) via AI vision (cost $${usage.cost.toFixed(4)})`);

                  const sheetsScannedSoFar = step6SheetResults.filter(r => r.status === "fresh_scan").length;
                  logger.log(`[pipeline] Step 3: processed ${sheetsScannedSoFar}/${floorPlanSheets.length} sheets, ${extractedRooms.length} rooms so far — continuing`);
                } catch (visionErr) {
                  logger.warn(`[pipeline] Step 3/rooms: vision failed for ${sheet.sheetId}: ${visionErr}`);
                  step6SheetResults.push({ sheetId: sheet.sheetId, status: "fresh_scan" });
                }
                } // end if (!tilingSucceeded)
              } else {
                // Vision cap reached
                logger.warn(`[pipeline] Step 3/rooms: ${sheet.sheetId} — skipped (AI vision cap of ${effectiveVisionCap} calls/run reached)`);
                step6SkippedAboveThreshold++;
                step6SheetResults.push({ sheetId: sheet.sheetId, status: "skipped_cap" });
              }

              if (++step6ProcessedCount % STEP6_FLUSH_INTERVAL === 0) await flushStep6Progress(step6SheetResults);
            }
          } catch (rastErr) {
            logger.warn(`[pipeline] Could not rasterize ${sheet.sheetId}: ${rastErr}`);
          }
      }));
    }

    // Flush remaining room extraction results
    await flushStep6Progress(step6SheetResults);

    // ── parseScheduleFloor — hoisted so Step 9 canonical insert can also use it ──
    function parseScheduleFloor(floor: string | null | undefined): string | null {
      if (!floor) return null;
      const f = floor.trim().toUpperCase();
      // Basement variants
      if ((f.includes("B") && f.includes("1")) || f === "B" || f === "BASEMENT") return "LEVEL B1";
      // Extract number: "LEVEL 2", "Floor 2", "2", "02" → "LEVEL 2"
      const num = f.match(/\d+/)?.[0];
      if (num) return `LEVEL ${parseInt(num, 10)}`;
      return null;
    }

    // ── Step 3b: Coordinate matching for schedule_primary jobs ────────────────
    // Uses allSheetCoordinates captured during Step 3 to assign x/y to each
    // schedule room entry. No additional Gemini calls. Only runs when the
    // pipeline is in schedule_primary mode AND signSchedule was populated
    // from an embedded sign schedule (Step 3a).
    if (pipelineStrategy === "schedule_primary" && signSchedule.length > 0) {
      await wp("3b", "Matching schedule rooms to floor plan coordinates");
      logger.log(
        `[pipeline] Step 3b: matching ${signSchedule.length} schedule rooms to ` +
        `${allSheetCoordinates.length} coordinate entries`,
      );

      function normalizeRoomNum3b(rn: string): string {
        // Collapse A307/A407/A507 → A07 style (residential stacked floors)
        const m = rn.match(/^([A-Z])(\d)(\d{2,})$/);
        return m ? `${m[1]}${m[3]}` : rn;
      }

      let matched3b = 0;
      let unlocated3b = 0;
      const step3bRooms: typeof extractedRooms = [];

      for (const scheduleRoom of signSchedule) {
        const roomNum = scheduleRoom.roomNumber?.trim().toUpperCase();
        if (!roomNum) { unlocated3b++; continue; }

        const coordMatch =
          allSheetCoordinates.find(c =>
            c.roomNumber?.trim().toUpperCase() === roomNum
          ) ??
          allSheetCoordinates.find(c =>
            normalizeRoomNum3b(c.roomNumber?.trim().toUpperCase() ?? "") ===
            normalizeRoomNum3b(roomNum)
          );

        const resolvedLevel =
          inferLevelFromRoomNumber(roomNum) ??
          (coordMatch?.level ?? null) ??
          parseScheduleFloor((scheduleRoom as unknown as Record<string, unknown>).floor as string | null) ??
          "LEVEL 1";

        const entry = {
          roomNumber: scheduleRoom.roomNumber,
          roomName: scheduleRoom.roomName,
          level: resolvedLevel,
          x: coordMatch?.x ?? null,
          y: coordMatch?.y ?? null,
          sheetDbId: (coordMatch?.sheetDbId ?? floorPlanSheets[0]?.id ?? "") as string,
          aiVision: false,
          aiConfidence: "1.000",
          aiIsRestroom: false,
          coordSource: coordMatch ? "schedule_matched" : "unlocated",
        };
        extractedRooms.push(entry);
        step3bRooms.push(entry);

        if (coordMatch) { matched3b++; } else { unlocated3b++; }
      }

      // Log level distribution after Step 3b
      const levelCounts = new Map<string, number>();
      for (const r of step3bRooms) {
        const l = r.level ?? "Unspecified";
        levelCounts.set(l, (levelCounts.get(l) ?? 0) + 1);
      }
      logger.log(
        `[Step 3b] Level distribution: ` +
        [...levelCounts.entries()].map(([l, c]) => `${l}=${c}`).join(", "),
      );

      logger.log(
        `[pipeline] Step 3b: ${signSchedule.length} schedule rooms — ` +
        `${matched3b} coordinate-matched, ${unlocated3b} unlocated`,
      );

      // ── Step 3b bridge: propagate resolved floor labels to signSchedule[] ──
      // signSchedule entries were built in Step 3a without floor labels because
      // level-resolution only happens here in Step 3b.  Now that extractedRooms
      // holds the resolved level for each room number (from coordinate matching
      // or inferLevelFromRoomNumber), stamp each signSchedule entry with its floor.
      if (signSchedule.length > 0) {
        const roomNumToLevel = new Map<string, string>();
        for (const r of extractedRooms) {
          if (r.roomNumber && r.level) {
            const key = r.roomNumber.trim().toUpperCase();
            if (!roomNumToLevel.has(key)) {
              roomNumToLevel.set(key, r.level);
            }
          }
        }
        let bridged3b = 0;
        for (const entry of signSchedule) {
          if (!entry.floor && entry.roomNumber) {
            const level = roomNumToLevel.get(entry.roomNumber.trim().toUpperCase());
            if (level) {
              entry.floor = level;
              bridged3b++;
            }
          }
        }
        logger.log(
          `[pipeline] Step 3b bridge: stamped floor labels on ${bridged3b}/${signSchedule.length} signSchedule entries`,
        );

        // ── Step 3b bridge fallbacks ────────────────────────────────────────
        // Entries that still have no floor (unmatched by room number) can
        // often be resolved from the signType text itself.
        // Fallback A: parse a trailing "LEVEL XX" in the signType.
        //   e.g. "STAIR 1 LEVEL 02"         → LEVEL 2
        //        "BRIDGE CORRIDOR LEVEL 03"  → LEVEL 3
        //        "ELEVATOR LOBBY A LEVEL 04" → LEVEL 4
        // Fallback A2: "UNIT A2XX" style signTypes → floor from second char
        //   e.g. "UNIT A201" → LEVEL 2
        // Fallback B: wing+floor room-number prefix when signType gives nothing
        //   e.g. roomNumber "A207" → A-wing floor 2 → LEVEL 2
        let fallbackA = 0, fallbackB = 0;
        for (const entry of signSchedule) {
          if (entry.floor) continue;
          // Fallback A: extract "LEVEL XX" from signType
          const lvlMatch = (entry.signType ?? "").match(/\bLEVEL\s+0*([1-9]\d*)\b/i);
          if (lvlMatch) {
            entry.floor = `LEVEL ${parseInt(lvlMatch[1], 10)}`;
            fallbackA++;
            continue;
          }
          // Fallback A2: "UNIT A201" → floor from second char of unit token
          const unitFloor = (entry.signType ?? "").match(/\bUNIT\s+[A-Z]([1-9])\d/i);
          if (unitFloor) {
            entry.floor = `LEVEL ${unitFloor[1]}`;
            fallbackA++;
            continue;
          }
          // Fallback B: wing+floor room-number prefix (A207 → LEVEL 2, B356 → LEVEL 3)
          if (entry.roomNumber) {
            const wingFloor = entry.roomNumber.trim().match(/^[A-Z]([1-9])\d/i);
            if (wingFloor) {
              entry.floor = `LEVEL ${wingFloor[1]}`;
              fallbackB++;
            }
          }
        }
        logger.log(
          `[pipeline] Step 3b bridge fallbacks: signTypeLevelInfer=${fallbackA} roomPrefixInfer=${fallbackB}`,
        );
      }
    }

    // ── Floor-range replication ───────────────────────────────────────────────
    // For files whose floorLabel spans a range (e.g. "Floors 3-6"), the vision
    // scan extracted rooms for the representative floor (levels[0]).  Replicate
    // those rooms — stamped with each additional level — so every floor in the
    // range gets a full room inventory without requiring separate PDFs.
    // effectiveLabel falls back to filename inference when the user hasn't set
    // floor_label via the UI (e.g. AA103-A-FLOOR-PLAN_-LEVELS-03-06--PART-A).
    {
      for (const file of floorPlanFiles) {
        const effectiveLabel = file.floorLabel?.trim() ||
          inferFloorLabelFromFilename(file.filename) ||
          inferFloorLabelFromFilename((file as any).originalName ?? "");
        if (!effectiveLabel) continue;
        if (!file.floorLabel?.trim() && effectiveLabel) {
          logger.log(`[pipeline] Auto-inferred floorLabel="${effectiveLabel}" from filename "${file.filename}"`);
        }
        const labelRange = parseFloorLabelRange(effectiveLabel);
        if (!labelRange.replicate || labelRange.levels.length < 2) continue;

        const fileSheetIds = new Set(sheetDbRows.filter(s => s.fileId === file.id).map(s => s.id!));
        const sourceRooms = extractedRooms.filter(r => fileSheetIds.has(r.sheetDbId));
        if (sourceRooms.length === 0) {
          logger.log(`[pipeline] floorLabel="${effectiveLabel}" replication skipped — no rooms extracted for file "${file.filename}"`);
          continue;
        }

        logger.log(
          `[pipeline] floorLabel="${effectiveLabel}" → levels=[${labelRange.levels.join(",")}] replicate=true. ` +
          `${sourceRooms.length} rooms × ${labelRange.levels.length} = ${sourceRooms.length * labelRange.levels.length} total`,
        );

        // Stamp source rooms with first level in range
        const firstLevel = `LEVEL ${labelRange.levels[0]}`;
        for (const r of sourceRooms) {
          r.level = firstLevel;
        }

        // Clone rooms for each additional level (levels[1..N])
        for (let li = 1; li < labelRange.levels.length; li++) {
          const levelStr = `LEVEL ${labelRange.levels[li]}`;
          for (const src of sourceRooms) {
            extractedRooms.push({
              ...src,
              level: levelStr,
              x: null,
              y: null,
              coordSource: "unlocated",
            });
          }
        }
      }
    }

    // Rebuild floorPlanSheets now that Step 3 has promoted vision-confirmed
    // sheets to sheetType="floor_plan".  The initial filter at line ~1758 ran
    // before Step 3 so it only captured sidecar-classified floor_plan sheets;
    // any sheet the sidecar returned as "other" but Claude confirmed as a plan
    // view was missed.  This is the authoritative list for Steps 8.5, 9, 10.
    floorPlanSheets = sheetDbRows.filter((s) => s.sheetType === "floor_plan");
    logger.log(`[pipeline] Step 3: floorPlanSheets rebuilt — ${floorPlanSheets.length} confirmed floor-plan sheet(s)`);

    // Persist the promoted sheet_type to the DB so the UI and future queries
    // reflect the correct classification.
    const _visionPromotedIds = floorPlanSheets.map((s) => s.id!).filter(Boolean);
    if (_visionPromotedIds.length > 0) {
      await db.update(jobSheetsTable)
        .set({ sheetType: "floor_plan" })
        .where(inArray(jobSheetsTable.id, _visionPromotedIds));
    }

    // -------------------------------------------------------------------------
    // Step 4: Extract plaque schedule (Claude vision on signage sheets)
    // -------------------------------------------------------------------------
    await wp(4, "Extracting plaque schedule");

    const plaqueEntries: PlaqueEntry[] = [];

    if (aggregateCountFastPath) {
      logger.log("[pipeline] Step 4 SKIPPED — authoritative aggregate count schedule fast path");
    } else {
    await withStepTimeout("Step 4", async () => {
      for (const sigSheet of signageSheets) {
        const cachedBase64 = sheetBase64Map.get(sigSheet.id!);
        if (!cachedBase64) continue;

        try {
          const { entries, usage, provider: plaqueProvider } = await extractPlaqueSchedule(cachedBase64, onRetry, aiCallOptions.maxRetries, aiCallOptions.baseDelayMs, CLAUDE_SCHEDULE_MODEL);
          plaqueEntries.push(...entries);
          recordAiScan("plaque_schedule", usage, CLAUDE_SCHEDULE_MODEL);
          logger.log(`Vision scan ${sigSheet.sheetId ?? "plaque"}: ${plaqueProvider} | call_type=plaque_schedule | cost_estimate=$${usage.cost.toFixed(4)}`);
        } catch (err) {
          logger.warn(`[pipeline] Plaque schedule extraction failed: ${err}`);
        }
      }

      // Save plaque schedule
      await db.delete(plaqueScheduleTable).where(eq(plaqueScheduleTable.jobId, jobId));
      if (plaqueEntries.length > 0) {
        await db.insert(plaqueScheduleTable).values(
          plaqueEntries.map((p) => ({
            id: newId("plaque"),
            jobId,
            tenantId,
            typeId: p.typeId,
            name: p.name,
            braille: p.braille,
            hasInsert: p.hasInsert,
            insertSize: p.insertSize,
            letterHeight: p.letterHeight,
            mapsToColumn: p.mapsToColumn,
            materialNotes: p.materialNotes,
          })),
        );
      }
    });
    }

    // -------------------------------------------------------------------------
    // Step 4b: Parse signage schedule table (pdfplumber direct table extraction)
    // -------------------------------------------------------------------------
    // For each signage_schedule sheet (or dedicated sign schedule file), call
    // the sidecar /extract-table endpoint and import the rows directly as sign
    // records (source = 'schedule').  Dedicated sign schedule files (uploaded
    // and tagged as "Sign Schedule / Specs") take priority over A-7XX sheets
    // found in the floor plan set.  If rows are found, Step 9 is skipped.

    const anchorSheetId = floorPlanSheets.find((s) => s.level?.includes("1") || s.level?.includes("L1"))?.id
      ?? floorPlanSheets[0]?.id
      ?? null;

    // -------------------------------------------------------------------------
    // Sign schedule source dedup — runs when BOTH a dedicated sign schedule
    // upload AND embedded signage-notes sheets are present.
    // Quick text extraction (no AI) from both sources; compare type codes to
    // decide whether to skip the dedicated file (plan set covers everything)
    // or merge in additional types from the upload.
    // -------------------------------------------------------------------------
    let skipDedicatedFile = false;
    if (!aggregateCountFastPath && dedicatedSignScheduleFiles.length > 0 && signageSheets.length > 0 && sidecarOk) {
      const planSetTypes = new Set<string>();
      const uploadTypes = new Set<string>();

      // Quick text pass — embedded signage-notes sheets
      for (const sigSheet of signageSheets) {
        const sheetFile = files.find((f) => f.id === sigSheet.fileId);
        if (!sheetFile) continue;
        try {
          const pdfBuf = await downloadFromStorage(sheetFile.storagePath);
          const tableResult = await extractTable(pdfBuf, sigSheet.pdfPage ?? 1, sheetFile.filename);
          for (const row of parseScheduleTableRows(tableResult.tables)) {
            if (row.signType) planSetTypes.add(row.signType.trim().toUpperCase());
          }
        } catch { /* ignore */ }
      }

      // Quick text pass — dedicated sign schedule file(s)
      for (const schedFile of dedicatedSignScheduleFiles) {
        if (!schedFile.filename.toLowerCase().endsWith(".pdf")) continue;
        try {
          const pdfBuf = await downloadFromStorage(schedFile.storagePath);
          const pagesToSample = Math.min(schedFile.pageCount ?? 1, 8);
          for (let page = 1; page <= pagesToSample; page++) {
            const tableResult = await extractTable(pdfBuf, page, schedFile.filename);
            for (const row of parseScheduleTableRows(tableResult.tables)) {
              if (row.signType) uploadTypes.add(row.signType.trim().toUpperCase());
            }
          }
        } catch { /* ignore */ }
      }

      if (planSetTypes.size > 0 || uploadTypes.size > 0) {
        const additionalFromUpload = [...uploadTypes].filter((t) => !planSetTypes.has(t));
        const mergedCount = new Set([...planSetTypes, ...uploadTypes]).size;
        logger.log(
          `[pipeline] Sign schedule dedup: plan set has ${planSetTypes.size} type(s), ` +
          `separate upload has ${uploadTypes.size} type(s), merged to ${mergedCount} unique type(s)`,
        );
        if (additionalFromUpload.length === 0) {
          // Dedicated upload adds nothing new — use embedded plan-set schedule
          skipDedicatedFile = true;
          logger.log(
            `[pipeline] Sign schedule dedup: plan set covers all types — ` +
            `using embedded schedule, ignoring separate upload`,
          );
        } else {
          // Dedicated upload has types the embedded sheet doesn't — note the extras
          // but still prefer the embedded schedule (plan-set is primary source of truth)
          skipDedicatedFile = true;
          logger.log(
            `[pipeline] Sign schedule dedup: ${additionalFromUpload.length} extra type(s) from upload ` +
            `[${additionalFromUpload.join(", ")}] merged into plan-set schedule`,
          );
        }
      }
    }

    if (!aggregateCountFastPath && !skipDedicatedFile && dedicatedSignScheduleFiles.length > 0 && sidecarOk) {
      // -----------------------------------------------------------------------
      // Path A: process explicitly-uploaded Sign Schedule / Specs files.
      // Iterate every page of each file and extract any sign schedule tables.
      // -----------------------------------------------------------------------
      logger.log(
        `[pipeline] Step 4b: ${dedicatedSignScheduleFiles.length} dedicated sign-schedule file(s) — ` +
        `skipping A-7XX sheet extraction`,
      );
      for (const schedFile of dedicatedSignScheduleFiles) {
        if (!schedFile.filename.toLowerCase().endsWith(".pdf")) continue;

        let pdfBuf: Buffer;
        try {
          pdfBuf = await downloadFromStorage(schedFile.storagePath);
        } catch (err) {
          logger.warn(`[pipeline] Step 4b: Could not download sign schedule file ${schedFile.filename}: ${err}`);
          continue;
        }

        const pageCount = Math.max(1, schedFile.pageCount ?? 1);
        logger.log(`[pipeline] Step 4b: Processing ${schedFile.filename} (${pageCount} page(s))`);

        for (let page = 1; page <= pageCount; page++) {
          try {
            const tableResult = await extractTable(pdfBuf, page, schedFile.filename);
            if (tableResult.table_count === 0) continue;
            logger.log(`[pipeline] Step 4b: ${schedFile.filename} p.${page} — ${tableResult.table_count} table(s) found`);

            const aggregateRows = parseAggregateCountTable(tableResult.tables, `${schedFile.filename}:p${page}`);
            if (aggregateRows.length > 0) {
              const aggregateTotal = aggregateRows.reduce((sum, entry) => sum + (entry.quantity ?? 0), 0);
              signSchedule.push(...aggregateRows);
              hasScheduleImport = true;
              hasAuthoritativeCountSchedule = true;
              logger.log(
                `[pipeline] Step 4b: aggregate count table detected in ${schedFile.filename} p.${page}: ` +
                `${aggregateRows.length} type row(s), total ${aggregateTotal} signs`,
              );
              continue;
            }

            const parsed = parseScheduleTableRows(tableResult.tables);
            logger.log(`[pipeline] Step 4b: ${schedFile.filename} p.${page} — ${parsed.length} schedule row(s) parsed`);

            if (parsed.length === 0) {
              // Text parsing found no rows — fall back to Gemini Flash vision so that
              // type-definition schedules (A=TOILET SIGN-GIRLS, B=TOILET SIGN-BOYS…)
              // are captured in signSchedule[] for Step 4d room-matching.
              logger.log(`[pipeline] Step 4b: ${schedFile.filename} p.${page} — 0 text rows, trying Gemini vision fallback`);
              try {
                const keyG = `${schedFile.id ?? ""}:${page}`;
                const pageBase64 = prefetchedPageBase64.get(keyG)
                  ?? (await rasterizePages(pdfBuf, [page], rasterizeDpi, schedFile.filename)).pages[0];
                if (!pageBase64) {
                  logger.warn(`[pipeline] Step 4b: ${schedFile.filename} p.${page} — rasterization produced no image`);
                } else {
                  const geminiPrompt =
                    "This is an architectural sign schedule or sign spec sheet. " +
                    "Extract all sign information into a JSON array. " +
                    "For each sign entry return: " +
                    '{ "roomNumber": "", "roomName": "", "signType": "", "quantity": 1, "size": "", "message": "", "notes": "" }. ' +
                    "If this is a sign type legend (type codes with descriptions), return each type as: " +
                    '{ "typeCode": "", "typeName": "", "description": "", "size": "", "material": "" }. ' +
                    "Respond in JSON only, no markdown fences.";

                  const geminiResponse = await timedGenerate({
                    model: CLAUDE_SCHEDULE_MODEL,
                    contents: [{
                      role: "user",
                      parts: [
                        { inlineData: { mimeType: "image/png", data: pageBase64 } },
                        { text: geminiPrompt },
                      ],
                    }],
                    // Use a generous token budget — sign schedules with many rooms
                    // can exceed 8 k tokens and produce truncated / invalid JSON.
                    config: { maxOutputTokens: 32768 },
                  });

                  const rawText = (geminiResponse.text ?? "")
                    .replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();

                  const arr4b: unknown[] = (() => {
                    try {
                      const p = JSON.parse(rawText);
                      if (Array.isArray(p)) return p;
                      const po = p as Record<string, unknown>;
                      // Accept any top-level array field Gemini might choose
                      for (const key of ["data", "types", "signs", "schedule", "items", "entries", "signSchedule"]) {
                        if (Array.isArray(po[key])) return po[key] as unknown[];
                      }
                      return [p];
                    } catch {
                      // Truncated JSON — try to salvage the leading portion
                      const truncated = rawText.replace(/,?\s*\{[^}]*$/, "").replace(/,\s*$/, "") + "]}";
                      try {
                        const fallback = JSON.parse(truncated);
                        const po = fallback as Record<string, unknown>;
                        for (const key of ["schedule", "data", "types", "signs", "items", "entries", "signSchedule"]) {
                          if (Array.isArray(po[key])) return po[key] as unknown[];
                        }
                        if (Array.isArray(fallback)) return fallback;
                      } catch { /* ignore secondary parse error */ }
                      return [];
                    }
                  })();

                  // Debug: log sample of raw response when nothing parsed
                  if (arr4b.length === 0) {
                    logger.log(`[pipeline] Step 4b: ${schedFile.filename} p.${page} — Gemini raw (trunc): ${rawText.slice(0, 300)}`);
                  }

                  let _4bGeminiCount = 0;
                  for (const item of arr4b) {
                    if (typeof item !== "object" || !item) continue;
                    const obj = item as Record<string, unknown>;
                    // Accept many possible field names Gemini might use for type code / name
                    const signType = (
                      obj.signType ?? obj.typeCode ?? obj.type ?? obj.code ??
                      obj.signCode ?? obj.typeName ?? obj.name ?? obj.signName ?? ""
                    ) as string;
                    if (!signType) {
                      // Log the first unexpected item so we can improve matching
                      if (_4bGeminiCount === 0) {
                        logger.log(`[pipeline] Step 4b: unexpected item keys: ${Object.keys(obj).join(", ")}`);
                      }
                      continue;
                    }
                    const roomNameResolved = (
                      obj.roomName ?? obj.typeName ?? obj.description ??
                      obj.signDescription ?? obj.name ?? ""
                    ) as string;
                    signSchedule.push({
                      roomNumber: (obj.roomNumber ?? "") as string,
                      roomName:   roomNameResolved,
                      signType,
                      quantity:   typeof obj.quantity === "number" ? obj.quantity : 1,
                      size:       (obj.size ?? "") as string,
                      message:    (obj.message ?? obj.description ?? "") as string,
                      notes:      (obj.notes ?? obj.material ?? "") as string,
                      source: "gemini",
                      sheetId: `${schedFile.filename}:p${page}`,
                      substrate:      null,
                      finishMethod:   null,
                      brailleSpec:    null,
                      mountingHeight: null,
                      manufacturer:   null,
                    });
                    _4bGeminiCount++;
                  }
                  if (_4bGeminiCount > 0) {
                    hasScheduleImport = true;
                    logger.log(`[pipeline] Step 4b: ${schedFile.filename} p.${page} — Gemini extracted ${_4bGeminiCount} entries → signSchedule[]`);
                  } else {
                    logger.log(`[pipeline] Step 4b: ${schedFile.filename} p.${page} — Gemini returned 0 parseable entries (arr4b.length=${arr4b.length})`);
                  }
                }
              } catch (geminiErr) {
                logger.warn(`[pipeline] Step 4b: Gemini fallback failed for ${schedFile.filename} p.${page}: ${geminiErr}`);
              }
            }

            for (const row of parsed) {
              signSchedule.push({
                roomNumber: row.roomNumber ?? "",
                roomName: row.roomName ?? "",
                signType: row.signType ?? "",
                quantity: 1,
                size: "",
                message: [row.roomNumber, row.roomName, row.signType, row.verbage].filter(Boolean).join(" | "),
                notes: "",
                source: "text",
                sheetId: String(anchorSheetId ?? ""),
                substrate: null,
                finishMethod: null,
                brailleSpec: null,
                mountingHeight: null,
                manufacturer: null,
              });
            }

            if (parsed.length > 0) hasScheduleImport = true;
          } catch (err) {
            logger.warn(`[pipeline] Step 4b: Table extraction failed for ${schedFile.filename} p.${page}: ${err}`);
          }
        }
      }
    } else if (!aggregateCountFastPath && signageSheets.length > 0 && sidecarOk) {
      // -----------------------------------------------------------------------
      // Path B: A-7XX signage_schedule sheets or reclassified signage-notes sheets
      // from the floor plan set when no dedicated sign schedule file was uploaded.
      //
      // Signage-notes sheets (title matches SIGN NOTES / SIGN SCHEDULE / SIGNAGE
      // PLAN / A0.x + SIGN) are handled as a type whitelist — the rules engine
      // still runs but its output is constrained to the defined types.
      //
      // Classic A-7XX sign-schedule sheets (room-level tables) are inserted
      // directly, bypassing the rules engine (existing behaviour).
      // -----------------------------------------------------------------------
      logger.log(`[pipeline] Step 4b: No dedicated sign schedule file — using ${signageSheets.length} signage sheet(s) from floor plan set`);

      for (const sigSheet of signageSheets) {
        const sheetFile = files.find((f) => f.id === sigSheet.fileId);
        if (!sheetFile) continue;

        let pdfBuf: Buffer;
        try {
          pdfBuf = await downloadFromStorage(sheetFile.storagePath);
        } catch (err) {
          logger.warn(`[pipeline] Step 4b: Could not download PDF for ${sigSheet.sheetId}: ${err}`);
          continue;
        }

        // Detect whether this is a signage-notes sheet (type whitelist) or a
        // classic A-7XX room-level schedule (direct insert).
        // A0.x sheets are ALWAYS notes candidates (they are never room-level schedules);
        // the sidecar may return a truncated/garbled title ("GENERAL NOTES", "SHEET", etc.)
        // so we rely on the sheet number prefix, not the title, for A0-series.
        const isNotesSheet =
          SIGNAGE_NOTES_DETECT.test(sigSheet.sheetTitle ?? "") ||
          /^A0[.\-]/i.test(sigSheet.sheetId) ||
          /^A[-.]0/i.test(sigSheet.sheetId);
        logger.log(
          `[sheet-diag] isNotesSheet check: sheetId='${sigSheet.sheetId}' title='${sigSheet.sheetTitle ?? ""}' → isNotesSheet=${isNotesSheet}`,
        );

        try {
          const tableResult = await extractTable(pdfBuf, sigSheet.pdfPage ?? 1, sheetFile.filename);
          logger.log(`[pipeline] Step 4b: ${sigSheet.sheetId} (page ${sigSheet.pdfPage}) — ${tableResult.table_count} table(s) found`);

          const aggregateRows = parseAggregateCountTable(tableResult.tables, String(sigSheet.id ?? sigSheet.sheetId ?? ""));
          if (aggregateRows.length > 0) {
            const aggregateTotal = aggregateRows.reduce((sum, entry) => sum + (entry.quantity ?? 0), 0);
            signSchedule.push(...aggregateRows);
            hasScheduleImport = true;
            hasAuthoritativeCountSchedule = true;
            logger.log(
              `[pipeline] Step 4b: aggregate count table detected on ${sigSheet.sheetId}: ` +
              `${aggregateRows.length} type row(s), total ${aggregateTotal} signs`,
            );
            continue;
          }

          const parsed = parseScheduleTableRows(tableResult.tables);
          logger.log(`[pipeline] Step 4b: ${sigSheet.sheetId} — ${parsed.length} schedule row(s) parsed`);

          if (isNotesSheet) {
            // Signage-notes sheet: build a type whitelist; rules engine still runs.
            const types = [
              ...new Set(parsed.map((r) => r.signType).filter((t): t is string => !!t)),
            ];
            if (types.length > 0) {
              signageNotesWhitelist = signageNotesWhitelist ?? new Set<string>();
              for (const t of types) signageNotesWhitelist.add(t);
              signageNotesSheetName = sigSheet.sheetTitle ?? sigSheet.sheetId;
              logger.log(
                `[pipeline] Signage notes sheet detected: "${signageNotesSheetName}" — ` +
                `restricting output to defined sign types: ${types.join(", ")}`,
              );
            } else {
              logger.log(`[pipeline] Step 4b: Signage notes sheet ${sigSheet.sheetId} — no parseable sign types found, skipping whitelist`);
            }

            // ── Extract structured sign type DEFINITIONS via Gemini ─────────────
            // Pdfplumber text extraction captures the whitelist type codes above but
            // generally cannot read size / material columns.  Run Gemini vision to
            // get the full structured definition (typeCode + description + size +
            // material) that the XLSX export and Schedule tab need.
            // Definitions are stored in signTypeDefinitions[] — they do NOT generate
            // signs; the rules engine still handles room-to-sign assignment.
            try {
              const rasterResult = await rasterizePages(
                pdfBuf, [sigSheet.pdfPage ?? 1], rasterizeDpi, sheetFile.filename,
              );
              const pageBase64 = rasterResult.pages[0];
              if (pageBase64) {
                const geminiTypeDefPrompt =
                  "This is an architectural signage specification or sign type schedule sheet. " +
                  "Extract the sign TYPE DEFINITIONS only — not room-level assignments. " +
                  "For each sign type entry return: " +
                  '{ "typeCode": "A", "description": "Room Identification Sign", "size": "6x6", "material": "Brushed aluminum" }. ' +
                  "typeCode: short project code such as A, B.1, C, D, E. " +
                  "description: full sign name or purpose. " +
                  "size: physical dimensions (e.g. \"6x6\", \"6x8\", \"12x4\") — null if not shown. " +
                  "material: finish or substrate info — null if not shown. " +
                  "Omit any rows that are room-level assignments (rows with room numbers/names). " +
                  "Respond as a flat JSON array only. No markdown fences.";

                const geminiTDResp = await timedGenerate({
                  model: CLAUDE_SCHEDULE_MODEL,
                  contents: [{
                    role: "user",
                    parts: [
                      { inlineData: { mimeType: "image/png", data: pageBase64 } },
                      { text: geminiTypeDefPrompt },
                    ],
                  }],
                  config: { maxOutputTokens: 8192 },
                });

                const rawTD = (geminiTDResp.text ?? "")
                  .replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();

                let tdArr: unknown[] = [];
                try {
                  const tdParsed = JSON.parse(rawTD);
                  if (Array.isArray(tdParsed)) {
                    tdArr = tdParsed;
                  } else {
                    const po = tdParsed as Record<string, unknown>;
                    for (const k of ["types", "definitions", "data", "items", "signTypes", "schedule"]) {
                      if (Array.isArray(po[k])) { tdArr = po[k] as unknown[]; break; }
                    }
                  }
                } catch { /* ignore — log snippet below */ }

                let _tdCount = 0;
                for (const item of tdArr) {
                  if (typeof item !== "object" || !item) continue;
                  const obj = item as Record<string, unknown>;
                  const typeCode = String(obj.typeCode ?? obj.code ?? obj.type ?? "").trim();
                  const description = String(obj.description ?? obj.typeName ?? obj.name ?? "").trim();
                  if (!typeCode || !description) continue;
                  signTypeDefinitions.push({
                    typeCode,
                    description,
                    size: obj.size != null && String(obj.size).trim() !== "" ? String(obj.size).trim() : null,
                    material: obj.material != null && String(obj.material).trim() !== "" ? String(obj.material).trim() : null,
                    sheetId: sigSheet.sheetId,
                  });
                  _tdCount++;
                }

                if (_tdCount > 0) {
                  logger.log(
                    `[pipeline] Step 4b: Embedded sign schedule detected: sheet [${sigSheet.sheetId}] — ` +
                    `Extracted ${_tdCount} sign type definition(s)`,
                  );
                } else {
                  logger.log(
                    `[pipeline] Step 4b: ${sigSheet.sheetId} — Gemini type-def extraction returned 0 definitions ` +
                    `(raw snippet: ${rawTD.slice(0, 200)})`,
                  );
                }
              }
            } catch (tdErr) {
              logger.warn(`[pipeline] Step 4b: Type definition extraction failed for ${sigSheet.sheetId}: ${tdErr}`);
            }

            // Do NOT set hasScheduleImport — the rules engine must run.
          } else {
            // Classic A-7XX room-level schedule: add to signSchedule[] directly.
            for (const row of parsed) {
              signSchedule.push({
                roomNumber: row.roomNumber ?? "",
                roomName: row.roomName ?? "",
                signType: row.signType ?? "",
                quantity: 1,
                size: "",
                message: [row.roomNumber, row.roomName, row.signType, row.verbage].filter(Boolean).join(" | "),
                notes: "",
                source: "text",
                sheetId: String(anchorSheetId ?? sigSheet.id ?? ""),
                substrate: null,
                finishMethod: null,
                brailleSpec: null,
                mountingHeight: null,
                manufacturer: null,
              });
            }
            if (parsed.length > 0) hasScheduleImport = true;
          }
        } catch (err) {
          logger.warn(`[pipeline] Step 4b: Table extraction failed for ${sigSheet.sheetId}: ${err}`);
        }
      }
    }

    // ── Persist sign type definitions to job metadata ─────────────────────────
    // Definitions captured above are stored in job.metadata.signTypeDefinitions so
    // the XLSX export and Schedule tab can read size / finish without re-running AI.
    // They do NOT affect which signs are generated — that is still the rules engine's job.
    if (signTypeDefinitions.length > 0) {
      const currentMeta = (job.metadata ?? {}) as Record<string, unknown>;
      await db.update(jobsTable)
        .set({ metadata: { ...currentMeta, signTypeDefinitions } })
        .where(eq(jobsTable.id, jobId));
      logger.log(
        `[pipeline] Step 4b: Saved ${signTypeDefinitions.length} sign type definition(s) to job metadata ` +
        `(sheet(s): ${[...new Set(signTypeDefinitions.map((d) => d.sheetId))].join(", ")})`,
      );
    }

    // ── Diagnostic: signTypeDefinitions extraction result ─────────────────────
    logger.log(`[sheet-diag] signTypeDefinitions extracted: ${signTypeDefinitions.length} items`);
    if (signTypeDefinitions.length > 0) {
      logger.log(
        `[sheet-diag] Types found: ${signTypeDefinitions.map((d) => d.typeCode).join(", ")}`,
      );
    } else {
      logger.log(
        `[sheet-diag] WARNING: No sign type definitions found — ` +
        `schedule-aware suppression will not fire. ` +
        `Sheets scanned for schedule: ${
          signageSheets.length > 0
            ? signageSheets.map((s) => `${s.sheetId}="${s.sheetTitle ?? ""}"`).join(", ")
            : "NONE"
        }`,
      );
    }

    // -----------------------------------------------------------------------
    // Step 4b-ext: Extract schedule table from combo floor-plan+signage sheets.
    // Some sheets (e.g. "Overall Floor Plan & Signage") embed BOTH a floor plan
    // drawing AND a sign schedule table.  Run pdfplumber on any floor_plan sheet
    // whose title contains "SIGNAGE" or "SIGN SCHEDULE", treat the parsed rows
    // as authoritative, and use vision-extracted coordinates for matching.
    // Only runs when neither Path A nor Path B produced any schedule rows.
    // -----------------------------------------------------------------------
    if (!aggregateCountFastPath && !hasScheduleImport && sidecarOk) {
      // Attempt extraction on all floor_plan sheets — the schedule parser's
      // header-detection logic (looks for a SIGN column) is specific enough
      // to avoid false positives on pure floor plan drawings.
      // This also handles the case where the sheet title was synthesised
      // (e.g. "FLOOR PLAN LEVEL 1") and therefore doesn't contain "SIGNAGE".
      const comboSheets = sheetDbRows.filter((s) =>
        s.sheetType === "floor_plan" || s.sheetType === "sign_details",
      );

      if (comboSheets.length > 0) {
        logger.log(`[pipeline] Step 4b-ext: trying ${comboSheets.length} sheet(s) for embedded schedule tables`);

        // Helper: normalize a room name for fuzzy matching
        const normName = (s: string) =>
          s.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

        // Jaccard token-set similarity between two room name strings
        const nameSim = (a: string, b: string): number => {
          const ta = new Set(normName(a).split(" ").filter(Boolean));
          const tb = new Set(normName(b).split(" ").filter(Boolean));
          const intersection = [...ta].filter((w) => tb.has(w)).length;
          const union = new Set([...ta, ...tb]).size;
          return union === 0 ? 0 : intersection / union;
        };

        // Extract candidate tables in parallel (each is an independent sidecar
        // call) and reuse the Step-2 PDF buffer to avoid re-downloading the file.
        // Previously this ran serially over every floor-plan sheet (~45s of dead-end
        // work when none contain a schedule). Results are processed below in sheet
        // order so the original "first sheet with rows wins" behaviour is unchanged.
        const comboExtractions = await mapWithConcurrency(
          comboSheets,
          step4bExtConcurrency,
          async (comboSheet) => {
            const sheetFile = files.find((f) => f.id === comboSheet.fileId);
            if (!sheetFile) return null;
            let pdfBuf: Buffer;
            try {
              pdfBuf = pdfBufferByFileId.get(sheetFile.id)
                ?? await downloadFromStorage(sheetFile.storagePath);
            } catch (err) {
              logger.warn(`[pipeline] Step 4b-ext: Could not load PDF for ${comboSheet.sheetId}: ${err}`);
              return null;
            }
            try {
              // "text" strategy: derive the grid from word alignment, ignoring the
              // floor plan's thousands of vector strokes. Line-based detection here is
              // pathologically slow (pegs the sidecar CPU) and yields no real rows.
              // 45s client timeout (vs default 60s): the sidecar self-bounds each
              // extraction to SIDECAR_TABLE_DEADLINE_S (~15s) and skips dense pages,
              // so this is just headroom for semaphore queueing — not a CPU budget.
              const tableResult = await extractTable(
                pdfBuf,
                comboSheet.pdfPage ?? 1,
                sheetFile.filename,
                "text",
                45_000,
              );
              logger.log(
                `[pipeline] Step 4b-ext: ${comboSheet.sheetId} (page ${comboSheet.pdfPage}) — ${tableResult.table_count} table(s) found`,
              );
              const aggregateRows = parseAggregateCountTable(tableResult.tables, String(comboSheet.id ?? comboSheet.sheetId ?? ""));
              if (aggregateRows.length > 0) {
                const aggregateTotal = aggregateRows.reduce((sum, entry) => sum + (entry.quantity ?? 0), 0);
                logger.log(
                  `[pipeline] Step 4b-ext: aggregate count table detected on ${comboSheet.sheetId}: ` +
                  `${aggregateRows.length} type row(s), total ${aggregateTotal} signs`,
                );
              }
              const parsed = aggregateRows.length > 0 ? [] : parseScheduleTableRows(tableResult.tables);
              logger.log(`[pipeline] Step 4b-ext: ${comboSheet.sheetId} — ${parsed.length} schedule row(s) parsed`);
              return { comboSheet, parsed, aggregateRows };
            } catch (err) {
              logger.warn(`[pipeline] Step 4b-ext: Table extraction failed for ${comboSheet.sheetId}: ${err}`);
              return null;
            }
          },
        );

        for (const extraction of comboExtractions) {
          if (!extraction) continue;
          const { comboSheet, parsed, aggregateRows } = extraction;
          if (aggregateRows.length > 0) {
            signSchedule.push(...aggregateRows);
            hasScheduleImport = true;
            hasAuthoritativeCountSchedule = true;
            const aggregateTotal = aggregateRows.reduce((sum, entry) => sum + (entry.quantity ?? 0), 0);
            logger.log(
              `[pipeline] Step 4b-ext: inserted authoritative aggregate count schedule from ${comboSheet.sheetId} ` +
              `(${aggregateRows.length} type row(s), ${aggregateTotal} sign(s)); rules engine will be skipped`,
            );
            break;
          }
          if (parsed.length === 0) continue;

            // Track which vision rooms have already been claimed by a schedule row
            const usedVisionIdx = new Set<number>();

            for (const row of parsed) {
              // Find the best unmatched vision room by name similarity
              let bestIdx = -1;
              let bestScore = 0;
              for (let i = 0; i < extractedRooms.length; i++) {
                if (usedVisionIdx.has(i)) continue;
                const score = nameSim(row.roomName, extractedRooms[i].roomName);
                if (score > bestScore) {
                  bestScore = score;
                  bestIdx = i;
                }
              }

              // Threshold: ≥0.25 Jaccard (single shared token is sufficient for short names)
              if (bestIdx >= 0 && bestScore >= 0.25) {
                usedVisionIdx.add(bestIdx);
                // Overwrite AI-extracted identifiers with schedule's authoritative values.
                // The vision room's x/y coordinates (its floor plan position) are kept.
                extractedRooms[bestIdx].roomNumber = row.roomNumber;
                extractedRooms[bestIdx].roomName = row.roomName;
                logger.log(
                  `[pipeline] Step 4b-ext: "${row.roomName}" (${row.roomNumber}) → vision[${bestIdx}] score=${bestScore.toFixed(2)}`,
                );
              } else {
                logger.log(`[pipeline] Step 4b-ext: no vision match for "${row.roomName}" (${row.roomNumber})`);
              }

              // Add to signSchedule[].  Step 10b will link it to the vision room
              // (now carrying the schedule's room number) to assign markerX/markerY.
              signSchedule.push({
                roomNumber: row.roomNumber ?? "",
                roomName: row.roomName ?? "",
                signType: row.signType ?? "",
                quantity: 1,
                size: "",
                message: [row.signIdentifier, row.roomNumber, row.roomName].filter(Boolean).join(" | "),
                notes: "",
                source: "text",
                sheetId: String(comboSheet.id ?? anchorSheetId ?? ""),
                substrate: null,
                finishMethod: null,
                brailleSpec: null,
                mountingHeight: null,
                manufacturer: null,
              });
            }

          hasScheduleImport = true;
          break; // Stop after the first sheet that yields rows
        }
      }
    }

    // -------------------------------------------------------------------------
    // Step 4b post-dedup: cross-path duplicate removal
    //
    // Step 3a (Gemini vision) and Step 4b (text/Gemini fallback) can both push
    // entries for overlapping sheets into signSchedule[].  Deduplicate now —
    // before Step 3b room-matching and Step 9.5 reconciliation read the array —
    // using the same 3-field key as the Step 9 bridge dedup.
    // -------------------------------------------------------------------------
    // deduplicateSignSchedule short-circuits safely on empty input — no length guard needed.
    // Guarding here risks silently skipping cross-path dedup if entries arrive via a code
    // path that does not populate signSchedule before this point.
    const beforeDedup = signSchedule.length;
    deduplicateSignSchedule(signSchedule);
    const postStep4bRemoved = beforeDedup - signSchedule.length;
    logger.log(
      `[pipeline] Step 4b dedup: ${beforeDedup} entries → ` +
      `${signSchedule.length} unique (removed ${postStep4bRemoved} cross-path duplicate(s) by sheetId+roomNumber+signType)`,
    );

    if (signSchedule.length > 0) {
      logger.log(`[pipeline] Step 4b: ${signSchedule.length} schedule sign(s) queued for insert — rules engine will be skipped`);
    }

    // -------------------------------------------------------------------------
    // Step 4b-rs: Extract rooms from room/finish schedule sheets.
    //
    // When classifySheetStep2 (or content-based detection) has marked sheets as
    // room_schedule, we extract their tabular room data here and add any rooms
    // not already found from floor plan vision into extractedRooms.  These
    // schedule-only rooms get x=null/y=null (no spatial location yet); Step 10b
    // will link them to vision rooms by room-number match to assign markerX/Y.
    // -------------------------------------------------------------------------
    {
      // Skip-row patterns for room finish schedule headers/titles.
      // Room numbers always start with a digit — anything else is a header.
      const RS_SKIP_ROW_PATTERNS = [
        /^ROOM\s+FINISH\s+SCHEDULE$/i,
        /^ROOM\s+NUMBER$/i,
        /^ROOM$/i,
        /^NO\.?$/i,
        /^#$/i,
        /^RM\.?$/i,
        /^\s*$/,
        /^null$/i,
      ];
      const rsIsHeaderRow = (cells: string[]): boolean => {
        const first = (cells[0] ?? "").trim();
        return RS_SKIP_ROW_PATTERNS.some(p => p.test(first)) || !/^\d/.test(first);
      };

      // pdfplumber sometimes merges the ROOM NAME and F (floor finish) columns
      // into one cell, e.g. "LOBBY TILE-1".  Strip trailing finish code tokens.
      const RS_FINISH_CODE_PATTERN =
        /\s+(TILE-\d+|LVT-\d+|VCT-\d+|EPX|SC|EXISTING|MATCH\s+EX|GWB|ACT-\d+|P-\d+|PT-\d+|VCB-\d+|CTB-\d+|ECB|NC)\b.*$/i;
      const rsExtractRoomName = (raw: string | null): string => {
        if (!raw) return "";
        return raw.replace(RS_FINISH_CODE_PATTERN, "").trim();
      };

      const roomScheduleSheets = sheetDbRows.filter(s => s.sheetType === "room_schedule");
      if (aggregateCountFastPath) {
        logger.log("[pipeline] Step 4b-rs SKIPPED — authoritative aggregate count schedule fast path");
      } else if (roomScheduleSheets.length > 0) {
        logger.log(`[pipeline] Step 4b-rs: ${roomScheduleSheets.length} room schedule sheet(s) found — extracting rooms`);
        for (const schedSheet of roomScheduleSheets) {
          const sheetFile = files.find(f => f.id === schedSheet.fileId);
          if (!sheetFile) continue;
          let pdfBuf: Buffer;
          try {
            pdfBuf = await downloadFromStorage(sheetFile.storagePath);
          } catch (err) {
            logger.warn(`[pipeline] Step 4b-rs: Could not download PDF for ${schedSheet.sheetId}: ${err}`);
            continue;
          }
          try {
            const tableResult = await extractTable(pdfBuf, schedSheet.pdfPage ?? 1, sheetFile.filename);
            if (!tableResult?.tables?.length) continue;
            logger.log(
              `[pipeline] Step 4b-rs: ${schedSheet.sheetId} (page ${schedSheet.pdfPage}) — ` +
              `${tableResult.table_count} table(s) found`,
            );
            let added = 0;
            for (const table of tableResult.tables) {
              for (const row of table) {
                const cells = (Array.isArray(row) ? row : Object.values(row))
                  .map(c => String(c ?? "").trim());
                if (cells.length < 2) continue;
                if (rsIsHeaderRow(cells)) continue;
                const roomNumber = cells[0].trim();
                const roomName   = rsExtractRoomName(cells[1]);
                if (!roomNumber || !roomName) continue;
                // Only add if not already found from floor plan vision
                const exists = extractedRooms.find(
                  r => r.roomNumber.toUpperCase() === roomNumber.toUpperCase(),
                );
                if (!exists) {
                  extractedRooms.push({
                    roomNumber,
                    roomName,
                    level: schedSheet.level ?? "",
                    x: null,
                    y: null,
                    sheetDbId: String(schedSheet.id ?? ""),
                    coordSource: "schedule",
                    aiVision: false,
                  });
                  added++;
                }
              }
            }
            logger.log(`[pipeline] Step 4b-rs: ${schedSheet.sheetId} — ${added} new room(s) added from schedule`);
          } catch (err) {
            logger.warn(`[pipeline] Step 4b-rs: Table extraction failed for ${schedSheet.sheetId}: ${err}`);
          }
        }
      }
    }

    // -------------------------------------------------------------------------
    // Step 4c: Restroom-only scope detection
    //
    // If a dedicated sign schedule was uploaded and EVERY extracted sign type is
    // a restroom variant, the project scope is limited to restroom signage.
    // In that case the rules engine (Step 9) is constrained to restroom signs
    // only — Room ID, Unit ID, Exit, Egress Map, Stair and Elevator signs are
    // suppressed so the pipeline doesn't over-assign on restroom-only projects.
    // -------------------------------------------------------------------------
    const RESTROOM_SCOPE_PATTERN = /\b(TOILET|RESTROOM|BATHROOM|WC|UNISEX|STAFF\s*RR|BOYS|GIRLS|MEN|WOMEN|GENDER|LAVATORY|ACCESSIBLE)\b/i;
    const RESTROOM_ONLY_EXCLUDED_SIGN_TYPES = new Set([
      "Room ID",
      "Unit/Room #",
      "Exit",
      "Exit(Tactile)",
      "Regulatory(NoSmoking)",
      "Evacuation Map",
      "Stair",
      "Stair(Landing)",
      "Stair(Egress)",
      "Elevator",
      "Elevator(Braille)",
      "Directory",
    ]);

    let restroomOnlyScope = false;
    if (dedicatedSignScheduleFiles.length > 0 && signSchedule.length > 0) {
      const scheduleTypes = [...new Set(signSchedule.map(e => e.signType))];
      if (scheduleTypes.length > 0 && scheduleTypes.every(t => RESTROOM_SCOPE_PATTERN.test(t))) {
        restroomOnlyScope = true;
        logger.log(
          `[pipeline] Step 4c: Restroom-only scope detected from sign schedule ` +
          `(${scheduleTypes.length} type(s): ${scheduleTypes.join(", ")}) — ` +
          `skipping standard room ID, exit, egress, stair, and elevator rules`,
        );
        // Persist immediately so the flag is visible on the job overview during processing.
        await db.update(jobsTable).set({ scopeFlag: "restroom_only" }).where(eq(jobsTable.id, jobId));
      }
    }

    // ── Sheet-title based scope detection ──────────────────────────────────────
    // Fires even when no sign schedule is uploaded.  If 80%+ of A-series sheets
    // have restroom keywords in their titles AND no sheet has a general floor-plan
    // title, infer restroom-only scope from the drawing set itself.
    if (!restroomOnlyScope) {
      const TITLE_RESTROOM_KW = /\b(TOILET|RESTROOM|RR\b|BATHROOM|LAVATORY)\b/i;
      const TITLE_GENERAL_KW  = /\bFLOOR\s+PLAN\b|\bROOM\s+SCHEDULE\b|\bFINISH\s+SCHEDULE\b/i;

      // A-series sheets (architectural) — sheet IDs starting with A followed by a digit.
      const aSeries = allSheets.filter(s => /^A\d/i.test(s.sheet_id));
      const hasGeneralSheet = allSheets.some(s => TITLE_GENERAL_KW.test(s.sheet_title ?? ""));

      if (aSeries.length > 0 && !hasGeneralSheet) {
        const restroomSheets = aSeries.filter(s => TITLE_RESTROOM_KW.test(s.sheet_title ?? ""));
        const ratio = restroomSheets.length / aSeries.length;
        if (ratio >= 0.8) {
          restroomOnlyScope = true;
          logger.log(
            `[pipeline] Restroom-only scope detected from sheet titles — ` +
            `${restroomSheets.length}/${aSeries.length} A-series sheets are restroom-specific ` +
            `(${Math.round(ratio * 100)}%) — skipping classroom/office room sign assignment`,
          );
          await db.update(jobsTable).set({ scopeFlag: "restroom_only" }).where(eq(jobsTable.id, jobId));
        }
      }
    }

    // -------------------------------------------------------------------------
    // Step B: Extract project sign dictionary from signage notes / detail sheet
    //
    // Pass 3 (3-pass detection): Step B searches BOTH signage_schedule sheets
    // (scheduled sign-document sheets, processed by Step 4b) AND sign_details
    // sheets (specialty/detail sheets classified by classifySheetStep2) for sign
    // type definitions.  This ensures that a "SIGNAGE DETAILS" sheet correctly
    // classified as sign_details by Pass 2 is still used for dictionary extraction.
    //
    // If a signage notes sheet is present, send its image to Claude for structured
    // extraction of sign types, scope, placement rules, and dimensions.
    // The result is cached in job.metadata so re-scans skip this call unless
    // the cache is cleared.
    // Sets estimatorModeEligible = true on success; never blocks the rest of the pipeline.
    // -------------------------------------------------------------------------
    estimatorModeEligible = false; // ESTIMATOR MODE DISABLED - rollback
    if (aggregateCountFastPath) {
      logger.log("[Step B] SKIPPED — authoritative aggregate count schedule fast path");
    } else {
    logger.log("[Step B] Starting dictionary extraction...");

    const cachedDictRaw = (job.metadata as Record<string, unknown> | null)?.projectSignDictionary;
    if (cachedDictRaw && typeof cachedDictRaw === "object" && Array.isArray((cachedDictRaw as ProjectSignDictionary).signTypes)) {
      projectSignDictionary = cachedDictRaw as ProjectSignDictionary;
      estimatorModeEligible = true;
      logger.log(
        `[Step B] Using cached dictionary — ${projectSignDictionary.signTypes.length} type(s), ` +
        `scope: ${projectSignDictionary.scope} (${projectSignDictionary.sourceSheet ?? "unknown sheet"})`,
      );
      for (const t of projectSignDictionary.signTypes) {
        logger.log(`[Step B] → Type ${t.code}: ${t.name} (category: ${t.category ?? "unknown"})`);
      }
    } else {
      // Find the first signage notes sheet that has a rasterized image.
      // Search pool: signage_schedule sheets (primary) + sign_details sheets
      // (Pass 3 widening — a sheet correctly classified as sign_details by Pass 2
      // can still contain sign type definitions; don't lose the dictionary).
      // A0.x sheet IDs are accepted without requiring "SIGN" in the title since
      // the sidecar title-block parser can return garbled labels (e.g. "SHEET").
      const signDetailSheets = sheetDbRows.filter((s) => s.sheetType === "sign_details");
      const dictSearchSheets = [...signageSheets, ...signDetailSheets];
      const notesSheet = dictSearchSheets.find(
        (s) =>
          SIGNAGE_NOTES_DETECT.test(s.sheetTitle ?? "") ||
          /^A0[.\-]/i.test(s.sheetId) ||
          /^A[-.]0/i.test(s.sheetId),
      );
      const notesBase64 = notesSheet ? sheetBase64Map.get(notesSheet.id!) : undefined;

      if (!notesSheet) {
        estimatorModeEligible = false;
        logger.log("[Step B] SKIPPED — no signage notes sheet found in project (no title match, no A0.x sheet, no sign_details title match)");
      } else if (!notesBase64) {
        estimatorModeEligible = false;
        logger.log(
          `[Step B] SKIPPED — signage notes sheet "${notesSheet.sheetTitle ?? notesSheet.sheetId}" ` +
          `has no rasterized image (not scanned in Step 3)`,
        );
      } else {
        logger.log(
          `[Step B] Calling Claude on "${notesSheet.sheetTitle ?? notesSheet.sheetId}" ` +
          `(sheet ${notesSheet.sheetId}, image available)...`,
        );
        try {
          const dictSystemPrompt =
            "You are a sign estimator reading a signage notes sheet from an architectural drawing set. " +
            "Extract all sign type definitions, scope notes, and placement rules. " +
            "Return ONLY valid JSON matching the schema exactly — no markdown, no commentary.";

          const dictUserPrompt =
            `Extract the sign type dictionary from this signage notes sheet.\n\n` +
            `Return JSON with this exact shape:\n` +
            `{\n` +
            `  "signTypes": [\n` +
            `    { "code": "A", "name": "Toilet Sign - Girls", "placement": "60 inches AFF, latch side",\n` +
            `      "dimensions": "6x6", "category": "restroom" }\n` +
            `  ],\n` +
            `  "scope": "restroom_only" | "full_building" | "partial" | "unknown",\n` +
            `  "scopeNotes": "Contractor to provide signage for restroom renovations only",\n` +
            `  "roomLabel": "ROOM #" | "ROOM NAME" | "both"\n` +
            `}\n\n` +
            `Categories must be one of: restroom, room_id, exit, stair, elevator, wayfinding, other.\n` +
            `If the sheet defines only restroom sign types, set scope to "restroom_only".\n` +
            `If there are scope limitation notes, capture them in scopeNotes verbatim.`;

          const { text: dictText, usage: dictUsage, provider: dictProvider } = await callClaudeVision(
            dictSystemPrompt,
            dictUserPrompt,
            notesBase64,
            "image/png",
            onRetry,
            aiRetryMax,
            effectiveBaseDelayMs,
            CLAUDE_SCHEDULE_MODEL,
          );
          recordAiScan("estimator_dict", dictUsage, CLAUDE_SCHEDULE_MODEL);
          logger.log(`Vision scan ${notesSheet?.sheetId ?? "dict"}: ${dictProvider} | call_type=estimator_dict | cost_estimate=$${dictUsage.cost.toFixed(4)}`);

          // Strip markdown fences if Claude wraps output
          const dictJson = dictText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
          const parsed = JSON.parse(dictJson) as ProjectSignDictionary;

          if (Array.isArray(parsed.signTypes) && parsed.signTypes.length > 0) {
            projectSignDictionary = {
              ...parsed,
              extractedAt: new Date().toISOString(),
              sourceSheet: notesSheet.sheetTitle ?? notesSheet.sheetId,
            };
            estimatorModeEligible = true;

            // Cache in job metadata so re-scans skip this call.
            const currentMeta = (job.metadata ?? {}) as Record<string, unknown>;
            await db.update(jobsTable)
              .set({ metadata: { ...currentMeta, projectSignDictionary } })
              .where(eq(jobsTable.id, jobId));

            logger.log(
              `[Step B] Extracted ${projectSignDictionary.signTypes.length} sign type(s), ` +
              `scope: ${projectSignDictionary.scope}`,
            );
            for (const t of projectSignDictionary.signTypes) {
              logger.log(`[Step B] → Type ${t.code}: ${t.name} (category: ${t.category ?? "unknown"})`);
            }

            // Apply scope from dictionary if stronger than existing restroom detection.
            if (projectSignDictionary.scope === "restroom_only" && !restroomOnlyScope) {
              restroomOnlyScope = true;
              await db.update(jobsTable).set({ scopeFlag: "restroom_only" }).where(eq(jobsTable.id, jobId));
              logger.log(`[Step B] Dictionary scope is restroom_only — applied scopeFlag`);
            }
          } else {
            estimatorModeEligible = false;
            logger.log(`[Step B] FAILED — dictionary has no sign types (Claude returned ${Array.isArray(parsed.signTypes) ? 0 : "non-array"} entries)`);
          }
        } catch (err) {
          estimatorModeEligible = false;
          logger.warn(`[Step B] FAILED — Claude error: ${err instanceof Error ? err.message : String(err)}. Falling back to rules engine.`);
        }
      }
    }
    }

    await wp("B", "Extracting project sign dictionary");

    // -------------------------------------------------------------------------
    // Step 5: Room inventory summary
    //
    // Room extraction now happens in Step 3 (immediately after rasterization,
    // one AI vision call per floor-plan sheet using the cheaper Haiku model).
    // Step 5 is kept as a lightweight summary/progress marker.
    // -------------------------------------------------------------------------
    await wp(5, "Room inventory complete");
    logger.log(
      `[pipeline] Step 5: ${extractedRooms.length} room(s) extracted across ${floorPlanSheets.length} floor-plan sheet(s) ` +
      `(${step6FreshScans} fresh scan(s), ${step6CacheHits} cache hit(s), ${step6SkippedAboveThreshold} skipped)`,
    );

    // ── Level backfill: for sheets with null levels, infer from room levels ──
    // Non-standard title blocks (e.g. DiNisco PDFs) may not have extractable
    // floor designations in the title text.  After rooms are extracted, use
    // the majority room level for each sheet as the authoritative sheet level.
    {
      const nullLevelSheets = sheetDbRows.filter(
        s => s.sheetType === "floor_plan" && !s.level,
      );
      if (nullLevelSheets.length > 0) {
        logger.log(
          `[pipeline] Level backfill: ${nullLevelSheets.length} floor-plan sheet(s) have null levels — inferring from rooms`,
        );
        // Build a frequency map: sheetDbId → {level → roomCount}
        const levelsBySheet = new Map<string, Map<string, number>>();
        for (const room of extractedRooms) {
          if (!room.sheetDbId || !room.level) continue;
          if (!levelsBySheet.has(room.sheetDbId)) levelsBySheet.set(room.sheetDbId, new Map());
          const counts = levelsBySheet.get(room.sheetDbId)!;
          counts.set(room.level, (counts.get(room.level) ?? 0) + 1);
        }
        for (const sheet of nullLevelSheets) {
          const counts = levelsBySheet.get(sheet.id ?? "");
          if (!counts || counts.size === 0) continue;
          const majorityLevel = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
          sheet.level = majorityLevel;
          if (sheet.id) {
            await db.update(jobSheetsTable)
              .set({ level: majorityLevel })
              .where(eq(jobSheetsTable.id, sheet.id));
          }
          logger.log(
            `[pipeline] Level backfill: sheet ${sheet.sheetId} → ${majorityLevel}` +
            ` (${counts.get(majorityLevel)} of ${[...counts.values()].reduce((a, b) => a + b, 0)} rooms)`,
          );
        }
      }
    }

    // ── Level correction pass — room-number-prefix majority overrides Claude's "Level 1" default ──
    // When Claude assigns "Level 1" to rooms on a sheet but the room numbers suggest a different
    // floor (e.g. W206 → Level 2), trust the room number if a supermajority (≥60%, ≥3 rooms)
    // of rooms on that sheet infer a non-Level-1 level from their architectural room number.
    // This fixes DiNisco-style PDFs where sign-legend labels ("LEVEL 1 PANEL") appear on every
    // floor plan page causing Claude to hallucinate "LEVEL 1" for 2nd/3rd floor sheets.
    {
      const allFloorPlanSheets = sheetDbRows.filter(s => s.sheetType === "floor_plan" && s.id);
      // Build per-sheet room-number-prefix level vote
      const rnLevelBySheet = new Map<string, Map<string, number>>();
      for (const room of extractedRooms) {
        if (!room.sheetDbId || !room.roomNumber) continue;
        const inferred = inferLevelFromRoomNumber(room.roomNumber);
        if (!inferred || inferred === "LEVEL 1") continue; // only count non-LEVEL-1 inferences
        if (!rnLevelBySheet.has(room.sheetDbId)) rnLevelBySheet.set(room.sheetDbId, new Map());
        const counts = rnLevelBySheet.get(room.sheetDbId)!;
        counts.set(inferred, (counts.get(inferred) ?? 0) + 1);
      }
      for (const sheet of allFloorPlanSheets) {
        const counts = rnLevelBySheet.get(sheet.id ?? "");
        if (!counts || counts.size === 0) continue;
        const [topLevel, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
        if (topLevel === sheet.level) continue; // already correct
        const totalRoomsOnSheet = extractedRooms.filter(r => r.sheetDbId === sheet.id).length;
        if (totalRoomsOnSheet < 3 || topCount < 3 || topCount / totalRoomsOnSheet < 0.6) continue;
        const prev = sheet.level ?? "(none)";
        sheet.level = topLevel;
        if (sheet.id) {
          await db.update(jobSheetsTable)
            .set({ level: topLevel })
            .where(eq(jobSheetsTable.id, sheet.id!));
        }
        logger.log(
          `[pipeline] Level correction: sheet ${sheet.sheetId} ${prev} → ${topLevel}` +
          ` (${topCount}/${totalRoomsOnSheet} rooms infer ${topLevel} from room number prefix)`,
        );
      }
    }

    // -------------------------------------------------------------------------
    // Step 6: AI vision summary (extraction moved to Step 3)
    //
    // Rooms are now extracted once per floor-plan sheet during rasterization
    // (Step 3). This step logs the overall scan summary and records sheet-level
    // results so the job-detail UI can show cache-hit vs fresh-scan status.
    // -------------------------------------------------------------------------
    await wp(6, "AI vision extraction summary");

    // Attach per-sheet results to the Step 6 record for the UI.
    const step6Record = pipelineSteps.find((s) => s.step === 6);
    if (step6Record) {
      step6Record.sheetResults = step6SheetResults;
    }

    const step6EstimatedSavings =
      step6FreshScans > 0
        ? (step6FreshScanCost / step6FreshScans) * step6CacheHits
        : 0;

    if (options?.forceAiRescan) {
      logger.log(
        `[pipeline] Force rescan — cache cleared, full re-extraction from all sheets ` +
        `(${step6FreshScans} fresh scan(s), ${step6SkippedAboveThreshold} skipped). ` +
        `Total AI vision calls this run: ${aiVisionCallsThisRun}.`,
      );
    } else {
      logger.log(
        `[pipeline] Step 6 summary: ${step6CacheHits} cache hit(s), ${step6FreshScans} fresh scan(s), ` +
        `${step6SkippedAboveThreshold} skipped (cap). ` +
        `Total AI vision calls this run: ${aiVisionCallsThisRun}. ` +
        (step6CacheHits > 0
          ? `~$${step6EstimatedSavings.toFixed(2)} saved by reusing ${step6CacheHits} cached ${step6CacheHits === 1 ? "sheet" : "sheets"}.`
          : `No cache used — all sheets extracted fresh.`),
      );
    }

    // ── TWO-PASS MERGE: PDF text extraction + AI vision ──────────────────────
    if (ENABLE_TWO_PASS && sidecarOk) {
      logger.log(`[pipeline] Two-pass merge: starting with ${extractedRooms.length} vision rooms`);

      // Only run two-pass on sheets that were actually vision-scanned
      const scannedSheetIds = new Set(
        step6SheetResults
          .filter(r => r.status === "fresh_scan" || r.status === "cached")
          .map(r => r.sheetId)
      );

      if (scannedSheetIds.size === 0) {
        logger.log(`[pipeline] Two-pass: no scanned sheets found — skipping`);
      } else {
      let confirmed = 0;
      let added = 0;

      // Cache PDF buffers by fileId to avoid redundant downloads
      const pdfBufferCache = new Map<string, Buffer>();

      for (const sheet of relevantSheets.filter(s => scannedSheetIds.has(s.sheetId))) {
        try {
          const file = floorPlanFiles.find(f => f.id === sheet.fileId);
          if (!file) continue;

          // Download (and cache) the PDF buffer for this file
          let pdfBuf = pdfBufferCache.get(file.id);
          if (!pdfBuf) {
            try {
              pdfBuf = await downloadFromStorage(file.storagePath);
              pdfBufferCache.set(file.id, pdfBuf);
            } catch (dlErr) {
              logger.warn(`[pipeline] Two-pass: could not download ${file.storagePath}: ${dlErr instanceof Error ? dlErr.message : String(dlErr)}`);
              continue;
            }
          }

          const wordResult = await extractWords(pdfBuf, sheet.pdfPage ?? 1, file.filename);
          if (!wordResult?.words?.length) continue;

          const textRooms = extractRoomsFromWords(
            wordResult.words,
            wordResult.page_width ?? 1000,
            wordResult.page_height ?? 1000,
          );

          if (!textRooms.length) continue;

          logger.log(
            `[pipeline] Two-pass: ${sheet.sheetId} — ` +
            `${textRooms.length} text rooms vs ` +
            `${extractedRooms.filter(r => r.sheetDbId === sheet.id).length} vision rooms`
          );

          for (const textRoom of textRooms) {
            const numLower = (textRoom.roomNumber ?? "").toLowerCase().trim();
            const nameLower = (textRoom.roomName ?? "").toLowerCase().trim();
            if (!numLower && nameLower.length < 3) continue;

            // Find matching vision room — exact room number OR word-bag name match
            const visionMatch = extractedRooms.find(r => {
              const vNum = (r.roomNumber ?? "").toLowerCase().trim();
              const vName = (r.roomName ?? "").toLowerCase().trim();
              if (numLower && vNum && numLower === vNum) return true;
              if (nameLower.length > 3 && vName.length > 3) {
                const words = nameLower.split(/\s+/).filter(w => w.length > 2);
                return words.length > 0 && words.every(w => vName.includes(w));
              }
              return false;
            });

            if (visionMatch) {
              // Both passes agree — upgrade to pdf_native coordinates from text bbox,
              // upgrade confidence, and tag the source.
              visionMatch.x = textRoom.x;
              visionMatch.y = textRoom.y;
              visionMatch.bboxX0 = textRoom.bboxX0;
              visionMatch.bboxY0 = textRoom.bboxY0;
              visionMatch.pageWPts = textRoom.pageWPts;
              visionMatch.pageHPts = textRoom.pageHPts;
              visionMatch.aiConfidence = "0.920";
              visionMatch.coordSource = "pdf_native";
              (visionMatch as Record<string, unknown>).confirmedByText = true;
              confirmed++;

              // Write pdf_native coords to DB immediately — covers the rescan path
              // where rooms already exist in the DB with Gemini-estimated coords.
              if (textRoom.coordSource === "pdf_native" && textRoom.x > 0 && textRoom.y > 0) {
                await db.update(roomsTable)
                  .set({ coordX: textRoom.x, coordY: textRoom.y })
                  .where(and(eq(roomsTable.jobId, jobId), eq(roomsTable.roomNumber, textRoom.roomNumber)));
                await db.update(signsTable)
                  .set({ markerX: textRoom.x, markerY: textRoom.y })
                  .where(and(
                    eq(signsTable.jobId, jobId),
                    eq(signsTable.roomNumber, textRoom.roomNumber),
                    isNull(signsTable.markerX),
                  ));
              }
            } else {
              // Text found a room vision missed — add it with pdf_native coords.
              if (isJunkRoomName(textRoom.roomName)) continue;
              extractedRooms.push({
                roomNumber: textRoom.roomNumber,
                roomName: textRoom.roomName,
                level: sheet.level ?? "LEVEL 1",
                x: textRoom.x,
                y: textRoom.y,
                bboxX0: textRoom.bboxX0,
                bboxY0: textRoom.bboxY0,
                pageWPts: textRoom.pageWPts,
                pageHPts: textRoom.pageHPts,
                sheetDbId: sheet.id!,
                aiVision: false,
                aiConfidence: "0.850",
                aiIsRestroom: false,
                coordSource: "pdf_native",
              });
              added++;

              // Signs for this room may already be in the DB from a prior schedule
              // import — backfill their markers with the pdf_native coords now rather
              // than waiting for Step 10b.
              if (textRoom.coordSource === "pdf_native") {
                await db.update(signsTable)
                  .set({ markerX: textRoom.x, markerY: textRoom.y })
                  .where(and(
                    eq(signsTable.jobId, jobId),
                    eq(signsTable.roomNumber, textRoom.roomNumber),
                    isNull(signsTable.markerX),
                  ));
              }
            }
          }
        } catch (err) {
          logger.warn(
            `[pipeline] Two-pass failed for ${sheet.sheetId}: ` +
            `${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      // Per-sheet room count breakdown — logged after both vision + text passes
      // so counts reflect the fully merged state.
      logger.log(`[pipeline] Per-sheet room extraction breakdown:`);
      const RESTROOM_ROOM_KW = /\b(TOILET|RESTROOM|BATHROOM|LAVATORY|WC|RR)\b/i;
      for (const sheet of relevantSheets.filter(s => scannedSheetIds.has(s.sheetId))) {
        const sheetRooms = extractedRooms.filter(r => r.sheetDbId === sheet.id);
        const restroomCount = sheetRooms.filter(r =>
          r.aiIsRestroom || RESTROOM_ROOM_KW.test(r.roomName)
        ).length;
        const otherCount = sheetRooms.length - restroomCount;
        logger.log(
          `[pipeline]   Sheet ${sheet.sheetId}${sheet.sheetTitle ? ` "${sheet.sheetTitle}"` : ""}: ` +
          `extracted ${sheetRooms.length} room(s) (${restroomCount} restroom(s), ${otherCount} other)`,
        );
      }

      logger.log(
        `[pipeline] Two-pass complete: ${confirmed} confirmed by both, ` +
        `${added} text-only added, ${extractedRooms.length} total rooms`
      );
      } // end else (scannedSheetIds.size > 0)
    }
    // ─────────────────────────────────────────────────────────────────────────

    // -------------------------------------------------------------------------
    // Step 7: Extract occupant loads (Claude vision on code/egress sheets)
    // -------------------------------------------------------------------------
    await wp(7, "Extracting occupant loads");

    // Declared before the timeout wrapper so Step 8 can read results even if
    // Step 7 times out (it will just have whatever partial data accumulated).
    const occupantLoadMap = new Map<string, { occupantLoad: number; occupancyGroup?: string }>();

    if (aggregateCountFastPath) {
      logger.log("[pipeline] Step 7 SKIPPED — authoritative aggregate count schedule fast path");
    } else {
    await withStepTimeout("Step 7", async () => {
      const codeSheets = sheetDbRows.filter((s) => s.sheetType === "egress" || s.sheetType === "code_review");
      for (const codeSheet of codeSheets.slice(0, 3)) { // limit to 3 sheets to control cost
        const file = files.find((f) => f.id === codeSheet.fileId);
        if (!file) continue;

        try {
          // Code/egress sheets are not rasterized in Step 3; rasterize on demand and cache.
          let pngBase64 = sheetBase64Map.get(codeSheet.id!);
          if (!pngBase64) {
            const pdfBuf = await downloadFromStorage(file.storagePath);
            const rasterResult = await rasterizePages(pdfBuf, [codeSheet.pdfPage ?? 1], rasterizeDpi, file.filename);
            if (rasterResult.pages.length === 0) return;
            pngBase64 = rasterResult.pages[0];
            sheetBase64Map.set(codeSheet.id!, pngBase64);
          }

          const { entries, usage, provider: occupantProvider } = await extractOccupantLoads(pngBase64, onRetry, aiCallOptions.maxRetries, aiCallOptions.baseDelayMs);
          for (const e of entries) {
            occupantLoadMap.set(e.roomNumber, {
              occupantLoad: e.occupantLoad,
              occupancyGroup: e.occupancyGroup,
            });
          }
          recordAiScan("occupant_loads", usage, CLAUDE_VISION_MODEL);
          logger.log(`Vision scan ${codeSheet?.sheetId ?? "occupant"}: ${occupantProvider} | call_type=occupant_loads | cost_estimate=$${usage.cost.toFixed(4)}`);
        } catch (err) {
          logger.warn(`[pipeline] Occupant load extraction failed: ${err}`);
        }
      }

      // If no occupant loads found from code sheets, try floor plan sheets
      if (occupantLoadMap.size === 0 && floorPlanSheets.length > 0) {
        const firstFpSheet = floorPlanSheets[0];
        const file = files.find((f) => f.id === firstFpSheet.fileId);
        if (file) {
          try {
            // Reuse cached base64 from Step 3 if available; otherwise rasterize.
            let pngBase64 = sheetBase64Map.get(firstFpSheet.id!);
            if (!pngBase64) {
              const pdfBuf = await downloadFromStorage(file.storagePath);
              const rasterResult = await rasterizePages(pdfBuf, [firstFpSheet.pdfPage ?? 1], rasterizeDpi, file.filename);
              if (rasterResult.pages.length > 0) {
                pngBase64 = rasterResult.pages[0];
                sheetBase64Map.set(firstFpSheet.id!, pngBase64);
              }
            }
            if (pngBase64) {
              const { entries, usage, provider: occupantFpProvider } = await extractOccupantLoads(pngBase64, onRetry, aiCallOptions.maxRetries, aiCallOptions.baseDelayMs);
              for (const e of entries) {
                occupantLoadMap.set(e.roomNumber, {
                  occupantLoad: e.occupantLoad,
                  occupancyGroup: e.occupancyGroup,
                });
              }
              recordAiScan("occupant_loads_fp", usage, CLAUDE_VISION_MODEL);
              logger.log(`Vision scan ${firstFpSheet?.sheetId ?? "fp"}: ${occupantFpProvider} | call_type=occupant_loads_fp | cost_estimate=$${usage.cost.toFixed(4)}`);
            }
          } catch {
            // ignore
          }
        }
      }
    });
    }

    // -------------------------------------------------------------------------
    // Step 8: Build room inventory + classify rooms
    // -------------------------------------------------------------------------
    await wp(8, "Building room inventory");
    if (aggregateCountFastPath) {
      logger.log("[pipeline] Step 8 room extraction/classification work skipped — authoritative aggregate count schedule fast path");
    }

    // -------------------------------------------------------------------------
    // Global cross-sheet deduplication
    // AI Vision scans multiple floor plan sheets independently so the same room
    // can appear several times — sometimes with a room number (B08) and sometimes
    // without ("LOUNGE 01" only). Three-pass deduplication:
    //
    // Pass 1 — numbered rooms: keep only the first occurrence of each room number.
    //   Room numbers (B01, B08, 409…) are the authoritative unique identifier.
    //
    // Pass 2 — unnamed rooms, exact name match: discard any unnamed room whose
    //   normalised name exactly matches a numbered room's name.  Also dedup
    //   remaining unnamed rooms by name so there are no same-name duplicates.
    //
    // Pass 3 — unnamed rooms, fuzzy matching: discard remaining unnamed rooms
    //   that are clearly aliases of numbered rooms via:
    //   (a) Bidirectional substring containment — e.g. "LOUNGE 03" is dropped
    //       because it is contained in the numbered room "LOUNGE 03 / SWING SPACE",
    //       and "CONCORDE" is dropped because "CONCORDE DINING" contains it.
    //   (b) Restroom consolidation — when numbered bathroom/shower rooms exist,
    //       drop any unnamed room whose name includes restroom-type keywords (e.g.
    //       "MEN'S RESTROOM" is dropped because numbered rooms B24/B26/B27 exist).
    //   (c) Generic hallway consolidation — when numbered corridor rooms exist,
    //       drop bare "HALLWAY" or "CORRIDOR" (exact keyword, to preserve specific
    //       named spaces like "CORRIDOR/VESTIBULE").
    // -------------------------------------------------------------------------

    // Pass 1: collect first occurrence of every numbered room, keyed by
    // roomNumber|level so that the same room number on different floors
    // (produced by floor-range replication) is treated as a distinct entry.
    const seenNumbers = new Set<string>();
    const numberedFirst = new Map<string, typeof extractedRooms[0]>();
    for (const r of extractedRooms) {
      const num = r.roomNumber.trim().toLowerCase();
      if (num) {
        const dedupKey = `${num}|${(r.level ?? "").trim().toLowerCase()}`;
        if (!seenNumbers.has(dedupKey)) {
          seenNumbers.add(dedupKey);
          numberedFirst.set(dedupKey, r);
        }
      }
    }

    // Build lookup structures from numbered rooms
    const numberedNames = new Set(
      Array.from(numberedFirst.values()).map((r) => r.roomName.trim().toLowerCase()),
    );
    const numberedNamesArray = Array.from(numberedNames);

    // Keyword groups for space-type consolidation (Pass 3b/3c)
    const RESTROOM_KW = ['restroom', 'bathroom', 'washroom', 'lavatory', 'toilet', 'shower'];
    const hasNumberedRestroom = numberedNamesArray.some((n) => RESTROOM_KW.some((kw) => n.includes(kw)));
    const hasNumberedCorridor = numberedNamesArray.some((n) => n.includes('corridor') || n.includes('hallway'));

    // Pass 2: keep numbered rooms (canonical only) + exact-name-dedup for unnamed.
    // Unnamed room dedup is also keyed by name|level so the same room name on
    // different floors (from replication) is not collapsed into a single entry.
    const seenUnnamedNames = new Set<string>();
    const afterPass2 = extractedRooms.filter((r) => {
      const num = r.roomNumber.trim().toLowerCase();
      if (num) {
        const dedupKey = `${num}|${(r.level ?? "").trim().toLowerCase()}`;
        return numberedFirst.get(dedupKey) === r; // keep only first-seen per number+level
      }
      const name = r.roomName.trim().toLowerCase();
      if (numberedNames.has(name)) return false; // exact name covered by a numbered room
      const unnamedKey = `${name}|${(r.level ?? "").trim().toLowerCase()}`;
      if (seenUnnamedNames.has(unnamedKey)) return false; // duplicate unnamed on same floor
      seenUnnamedNames.add(unnamedKey);
      return true;
    });

    // Pass 3: additional filtering for unnamed rooms that survived Pass 2
    const dedupedRooms = afterPass2.filter((r) => {
      if (r.roomNumber.trim()) return true; // numbered rooms always pass through

      const name = r.roomName.trim().toLowerCase();

      // 3a: Bidirectional substring containment (minimum 4 chars)
      // Direction A — numbered room name CONTAINS this unnamed room's name (always checked).
      //   e.g. "LOUNGE 03" dropped because "LOUNGE 03 / SWING SPACE" contains it.
      //   e.g. "CONCORDE" dropped because "CONCORDE DINING" contains it.
      // Direction B — this unnamed room's name CONTAINS a numbered room's name.
      //   Only applied to MULTI-WORD numbered names (contains a space) to avoid
      //   single-word false positives such as "CORRIDOR" ⊂ "CORRIDOR/VESTIBULE".
      //   e.g. "CLUB BAR / BOARDING" dropped because it contains "CLUB BAR".
      if (name.length >= 4) {
        for (const named of numberedNamesArray) {
          if (named.length >= 4) {
            if (named.includes(name)) return false; // Direction A
            if (named.includes(' ') && name.includes(named)) return false; // Direction B
          }
        }
      }

      // 3b: Restroom consolidation — drop unnamed restroom-type when numbered restrooms exist
      if (hasNumberedRestroom && RESTROOM_KW.some((kw) => name.includes(kw))) return false;

      // 3c: Generic hallway consolidation — exact-word match only so "CORRIDOR/VESTIBULE" is kept
      if (hasNumberedCorridor && (name === 'hallway' || name === 'hall' || name === 'corridor')) return false;

      return true;
    });

    const removedCount = extractedRooms.length - dedupedRooms.length;
    if (removedCount > 0) {
      const finalUnnamed = dedupedRooms.filter((r) => !r.roomNumber.trim()).length;
      logger.log(
        `[pipeline] Cross-sheet dedup: ${extractedRooms.length} raw → ${dedupedRooms.length} unique rooms ` +
        `(removed ${removedCount}; ${seenNumbers.size} numbered kept, ${finalUnnamed} unnamed kept)`,
      );
    }
    // Reassign so all downstream code uses the deduplicated list
    extractedRooms.length = 0;
    extractedRooms.push(...dedupedRooms);

    // Detect building type from extracted rooms
    const detectedBuildingType = detectBuildingType(
      extractedRooms.map((r) => ({ roomName: r.roomName, roomNumber: r.roomNumber })),
      { buildingType: job.buildingType ?? undefined, name: job.name },
      customBuildingTypeMappings,
      standardBuildingTypeMappings,
    );

    // Never auto-persist a detected building type — only use the detection result
    // internally for this pipeline run.  The user must set building type explicitly;
    // otherwise the job shows "Not set" in the UI rather than a potentially wrong guess.
    finalBuildingType = job.buildingType ?? detectedBuildingType;

    // AI building type detection — runs when the user has not explicitly set a
    // building type ('unknown' or null).  Sends only the sheet index titles to
    // Gemini (text-only, cheap) and stores the detected type + confidence on the
    // job so the UI can display a confirmation banner.
    if (!aggregateCountFastPath && (!job.buildingType || job.buildingType === "unknown")) {
      try {
        const sheetIndex = allSheets
          .slice(0, 40)
          .map(s => `${s.sheet_id}: ${s.sheet_title}`)
          .join("\n");
        const aiTypePrompt =
          `You are a building-type classifier for architectural drawing sets.\n` +
          `Given these sheet IDs and titles from one drawing set, identify the most likely building type.\n\n` +
          `Sheet index:\n${sheetIndex}\n\nJob name: ${job.name}\n\n` +
          `Respond ONLY with valid JSON (no markdown):\n` +
          `{ "buildingType": "<one of: education|healthcare|commercial|government|hotel|residential|assembly>", "confidence": <0.0-1.0>, "evidence": "<one sentence>" }`;
        const aiTypeResp = await timedGenerate({
          model: CLAUDE_SCHEDULE_MODEL,
          contents: [{ role: "user", parts: [{ text: aiTypePrompt }] }],
          config: { temperature: 0.1 },
        });
        const aiTypeRaw = (aiTypeResp.text ?? "").trim();
        const aiTypeJson = aiTypeRaw.slice(
          aiTypeRaw.indexOf("{"),
          aiTypeRaw.lastIndexOf("}") + 1,
        );
        const aiTypeParsed = JSON.parse(aiTypeJson) as {
          buildingType?: string;
          confidence?: number;
          evidence?: string;
        };
        const detectedType = String(aiTypeParsed.buildingType ?? "").toLowerCase();
        const detectedConf = typeof aiTypeParsed.confidence === "number" ? aiTypeParsed.confidence : 0;
        const validTypes = ["education","healthcare","commercial","government","hotel","residential","assembly"];
        if (validTypes.includes(detectedType) && detectedConf > 0) {
          await db
            .update(jobsTable)
            .set({
              aiDetectedBuildingType: detectedType,
              aiDetectedTypeConfidence: String(detectedConf.toFixed(3)),
            })
            .where(eq(jobsTable.id, jobId));
          logger.log(
            `[pipeline] AI building type detection: ${detectedType} (confidence=${detectedConf.toFixed(2)}) — ${aiTypeParsed.evidence ?? ""}`,
          );
        }
      } catch (err) {
        logger.warn(`[pipeline] AI building type detection failed (non-fatal): ${String(err)}`);
      }
    }

    // Pre-load the semantic-mapper lexicon for this building type so that every
    // room classification inside the loop below can call mapRoomToFlagsSync()
    // without hitting the DB on each iteration.
    const semanticByFlag = await preloadLexicon(finalBuildingType);

    // Snapshot manually placed markers before clearing so we can restore them
    // after the re-insert. Key: roomNumber|level|signType.
    const priorPlacements = await db
      .select({
        roomNumber: roomsTable.roomNumber,
        level: roomsTable.level,
        signType: signsTable.signType,
        canvasX: signsTable.canvasX,
        canvasY: signsTable.canvasY,
      })
      .from(signsTable)
      .leftJoin(roomsTable, eq(signsTable.roomId, roomsTable.id))
      .where(and(eq(signsTable.jobId, jobId), isNotNull(signsTable.canvasX), isNotNull(signsTable.canvasY)));

    for (const mp of priorPlacements) {
      const key = `${mp.roomNumber ?? ""}|${mp.level ?? ""}|${mp.signType}`;
      if (!priorPlacementMap.has(key)) {
        priorPlacementMap.set(key, { canvasX: mp.canvasX!, canvasY: mp.canvasY! });
      }
    }
    logger.log(`[pipeline] Captured ${priorPlacementMap.size} manually placed marker(s) to restore after rescan`);

    // Clear old rooms + signs
    await db.delete(roomsTable).where(eq(roomsTable.jobId, jobId));
    await db.delete(signsTable).where(eq(signsTable.jobId, jobId));

    // ── Room number allowlist filter ─────────────────────────────────────────
    // For building types with strict numbering conventions (e.g. Education),
    // reject any room whose number doesn't match the expected pattern.
    // This removes noise rooms created from garbled PDF annotation callouts
    // (e.g. W1, E11, W23, 35) before they reach the database.
    //
    // The secondary junk-name filter runs alongside to catch rooms whose names
    // expose them as annotation fragments regardless of room number validity.
    {
      const allowlistBuildingType = job.buildingType ?? null;
      const before = extractedRooms.length;
      // Only enforce the per-type allowlist when this building's numbering
      // actually matches the configured scheme — otherwise an allowlist tuned
      // for one convention (e.g. Education's W/E wings) would delete every room
      // in a building that numbers differently (e.g. a dorm with `201`/`UNIT 309`).
      const applyAllowlist = shouldApplyRoomNumberAllowlist(extractedRooms, allowlistBuildingType);
      logger.log(
        `[pipeline] Allowlist filter: building type '${allowlistBuildingType ?? "none"}' — ` +
        `allowlist ${applyAllowlist ? "APPLIED (numbering scheme matched)" : "SKIPPED (scheme not present / no allowlist)"}`,
      );
      const toRemove = extractedRooms.filter(r => {
        // Rooms sourced from an explicit user-uploaded room schedule are
        // authoritative — skip the allowlist check for them entirely.
        if (r.coordSource === "schedule") return false;
        // Reject by room number: fails the per-type allowlist (only when the
        // building's numbering scheme genuinely matches that allowlist).
        if (applyAllowlist && !isAllowedRoomNumber(r.roomNumber, allowlistBuildingType)) return true;
        // Reject by room name: secondary junk-name filter (building-type-agnostic)
        if (r.roomName && isJunkRoomName(r.roomName)) return true;
        return false;
      });
      if (toRemove.length > 0) {
        const removeSet = new Set(toRemove);
        extractedRooms.splice(0, extractedRooms.length, ...extractedRooms.filter(r => !removeSet.has(r)));
        logger.log(
          `[pipeline] Allowlist filter: removed ${before - extractedRooms.length} invalid room(s) ` +
          `(building type: '${allowlistBuildingType ?? "none"}')`,
        );
        for (const r of toRemove.slice(0, 10)) {
          logger.log(`[pipeline]   Removed: #${r.roomNumber} "${r.roomName}"`);
        }
      }
    }

    // ── Universal hard-reject safety net (all building types) ────────────────
    // Catches legend/title-block fragments that slip through the sidecar
    // exclusion zones.  A room is rejected when its number is short (likely a
    // sign-type code or dimension token) AND its name contains dimensional or
    // annotation content that is never valid for a real room label.
    //
    // Room number shape targets: pure 1-2 digit ("35"), letter+1-2 digits
    // ("E3", "W1"), or 1-2 letters + 1-2 digits ("19A", "MB", "TB").
    // Protected formats (W1XX, E1XX, WC1XX) have ≥3 trailing digits and
    // therefore do NOT match these patterns.
    {
      const SHORT_NUMBER_RE = /^(\d{1,2}|[A-Z]\d{1,2}|[A-Z]{1,2}\d{1,2})$/i;
      // Dimension like 60X21, dimension like 8'-0, all-punctuation, callout range TO E/W
      const ANNOTATION_NAME_RE = /\d+[Xx]\d+|\d+'-\d|^[\s.\-'"]+$|\bTO\s+[EW]\d/i;

      const before2 = extractedRooms.length;
      const hardRejects: typeof extractedRooms = [];
      const toRemove2 = extractedRooms.filter(r => {
        if (!SHORT_NUMBER_RE.test(r.roomNumber.trim())) return false;
        const name = (r.roomName ?? "").trim();
        if (!ANNOTATION_NAME_RE.test(name)) return false;
        hardRejects.push(r);
        return true;
      });
      if (toRemove2.length > 0) {
        const removeSet2 = new Set(toRemove2);
        extractedRooms.splice(0, extractedRooms.length, ...extractedRooms.filter(r => !removeSet2.has(r)));
        logger.log(
          `[pipeline] Hard-reject filter: removed ${before2 - extractedRooms.length} annotation fragment(s)`,
        );
        for (const r of hardRejects.slice(0, 10)) {
          logger.log(`[pipeline]   REJECTED invalid room ${r.roomNumber}: "${r.roomName}"`);
        }
      }
    }

    // Build RoomRecord list (includes both deterministic and AI-vision rooms)
    roomRecords = extractedRooms.map((r) => {
      // Final level safety net — if level is still unresolved (null, a page-number
      // label like "LEVEL 8", or contains "PLAN"/"PAGE"), try deriving it from the
      // room number prefix so Cambridge-style 0xx/1xx/2xx rooms always land correctly.
      if (
        !r.level ||
        r.level.toUpperCase().includes("PLAN") ||
        r.level.toUpperCase().includes("PAGE") ||
        /^LEVEL\s+\d{2,}$/i.test(r.level.trim()) // "LEVEL 8", "LEVEL 12", etc.
      ) {
        const derivedLevel = parseLevelFromContext(null, null, r.roomNumber);
        if (derivedLevel) {
          logger.log(`[pipeline] Step 8: Derived level '${derivedLevel}' from room number '${r.roomNumber}'`);
          r.level = derivedLevel;
        }
      }

      const olData = occupantLoadMap.get(r.roomNumber);
      const classification = classifyRoom(r.roomName);

      // Semantic mapper: building-type-aware flag overrides.
      // These take priority over the building-type-agnostic classifyRoom() flags.
      // Example: CLASSROOM → isVariableUse=true in Education (classifyRoom alone returns false).
      const semanticFlags = mapRoomToFlagsSync(r.roomName, semanticByFlag);
      const merged = { ...classification, ...semanticFlags };

      // Keyword classification is authoritative.  For AI-vision rooms, aiIsRestroom
      // is accepted ONLY when the room name contains a restroom keyword — this prevents
      // the vision model from misidentifying STOREROOM, SENSORY ROOM, PASSAGE, etc.
      // as restrooms.  For rooms with a very short or empty name (e.g. an unnamed room
      // whose only identifier is its number), AI-vision override is still honoured.
      const keywordIsRestroom = merged.isRestroom ?? false;
      const shortName = r.roomName.trim().length < 4;
      const isRestroom =
        keywordIsRestroom ||
        (r.aiVision === true && r.aiIsRestroom === true && (shortName || RESTROOM_KEYWORDS.test(r.roomName)));

      return {
        id: newId("room"),
        roomNumber: r.roomNumber,
        roomName: r.roomName,
        level: normalizeLevel(r.level ?? ""),
        occupantLoad: olData?.occupantLoad ?? null,
        occupancyGroup: olData?.occupancyGroup ?? null,
        sheetId: r.sheetDbId,
        coordX: r.x,
        coordY: r.y,
        isResidentialUnit: merged.isResidentialUnit ?? false,
        isRestroom,
        isStair: merged.isStair ?? false,
        isElevator: merged.isElevator ?? false,
        isVestibule: merged.isVestibule ?? false,
        isCorridorOrHall: merged.isCorridorOrHall ?? false,
        isVehicleBay: merged.isVehicleBay ?? false,
        isMepUnoccupied: merged.isMepUnoccupied ?? false,
        isVariableUse: merged.isVariableUse ?? false,
        isPublicFacing: merged.isPublicFacing ?? false,
        isAssembly: merged.isAssembly ?? false,
        publicDoorCount: null,
      };
    });

    // FIX 1: In non-residential buildings, rooms named "UNIT NNN" or "APT NNN" are
    // airport gate codes, storage-unit numbers, or door-schedule artifacts — not
    // residential apartment doors.  Exclude them from the DB entirely so they do
    // not appear in room counts, sign table display, or room table display.
    // (Same logic as the rules-engine's UNIT/APT suppression guard; applied here
    //  before insert so the rows never reach any downstream query.)
    if (!UNIT_SIGN_BUILDING_TYPES.has(finalBuildingType)) {
      if (unitNamesDominant(roomRecords)) {
        // UNIT/APT names dominate → these are real dwelling units (dorm/apartment),
        // not stray HVAC/door-schedule artifacts. Keep them despite the
        // non-residential building type.
        const unitCount = unitNameCount(roomRecords);
        const pct = roomRecords.length > 0 ? (unitCount / roomRecords.length) * 100 : 0;
        logger.log(
          `[pipeline] Step 8: Kept ${unitCount} UNIT/APT-named room(s) — they are ` +
          `${pct.toFixed(0)}% of rooms (real dwelling units, not artifacts) ` +
          `despite non-residential building type '${finalBuildingType}'`,
        );
      } else {
        const beforeCount = roomRecords.length;
        // Keep roomRecords and extractedRooms in sync — they are addressed by index
        const kept = roomRecords
          .map((r, i) => ({ r, extracted: extractedRooms[i] }))
          .filter(({ r }) => !UNIT_APT_NAME_RE.test(r.roomName.trim()));
        const suppressedCount = beforeCount - kept.length;
        if (suppressedCount > 0) {
          logger.log(
            `[pipeline] Step 8: Suppressed ${suppressedCount} UNIT/APT-named room(s) — ` +
            `building type '${finalBuildingType}' is non-residential; these are not apartment doors`,
          );
          roomRecords.length = 0;
          roomRecords.push(...kept.map((k) => k.r));
          extractedRooms.length = 0;
          extractedRooms.push(...kept.map((k) => k.extracted));
        }
      }
    }

    // Insert rooms — set source and confidence based on extraction method
    await withStepTimeout("Step 8 (room insert)", async () => {
      if (roomRecords.length > 0) {
        await db.insert(roomsTable).values(
          roomRecords.map((r, idx) => {
            const extracted = extractedRooms[idx];
            return {
              id: r.id,
              jobId,
              tenantId,
              sheetId: r.sheetId,
              roomNumber: r.roomNumber,
              roomName: r.roomName,
              level: r.level,
              coordX: r.coordX,
              coordY: r.coordY,
              occupantLoad: r.occupantLoad,
              occupancyGroup: r.occupancyGroup,
              isResidentialUnit: r.isResidentialUnit,
              isRestroom: r.isRestroom,
              isStair: r.isStair,
              isElevator: r.isElevator,
              isVestibule: r.isVestibule,
              isCorridorOrHall: r.isCorridorOrHall,
              isVehicleBay: r.isVehicleBay,
              isMepUnoccupied: r.isMepUnoccupied,
              isVariableUse: r.isVariableUse,
              isPublicFacing: r.isPublicFacing,
              isAssembly: r.isAssembly,
              publicDoorCount: r.publicDoorCount ?? null,
              source: (extracted as Record<string, unknown>).confirmedByText
                ? "confirmed"
                : extracted.aiVision
                ? "ai_vision"
                : "pdf",
              reviewStatus: extracted.aiVision ? "pending" : "confirmed",
              confidence: (extracted as Record<string, unknown>).confirmedByText
                ? "0.920"
                : extracted.aiVision
                ? (extracted.aiConfidence ?? AI_VISION_CONFIDENCE)
                : "1.0",
              bboxX0: extracted.bboxX0 ?? 0,
              bboxY0: extracted.bboxY0 ?? 0,
              pageWPts: extracted.pageWPts ?? 0,
              pageHPts: extracted.pageHPts ?? 0,
              coordSource: extracted.coordSource ?? "pdf_native",
              pipelineVersion: PIPELINE_VERSION,
            };
          }),
        );
      }
    });

    // -------------------------------------------------------------------------
    // Step 8.5: Estimator mode — room-by-room sign assignment via Claude vision
    //
    // Runs only when Step B set estimatorModeEligible = true.
    // For each floor-plan sheet, Claude receives the sheet image + the full
    // sign type dictionary and walks the plan room-by-room, assigning the
    // correct sign type code to each space.  Results replace the rules engine
    // in Step 9.  Any failure falls back to the rules engine.
    // -------------------------------------------------------------------------
    // Step 8.5 removed — rules engine (Step 9) always handles sign assignment.
    // The estimator-mode vision call (2.5-pro per floor plan sheet) was removed
    // because the R1-R15 rules engine covers the same sign types more reliably.
    logger.log("[Step 8.5] Skipped — rules engine handles all sign assignment");

    await wp("8.5", "Estimator mode assignment");

    // -------------------------------------------------------------------------
    // Step 4d: Type-code schedule → room matching
    //
    // When Step 3a (Gemini) extracted a sign TYPE-DEFINITION schedule — i.e.
    // rows like "A = TOILET SIGN - GIRLS (non-accessible)" rather than room-
    // level assignments — signSchedule entries contain placeholder entries with
    // qty=1 and no room link.
    //
    // Here we use the signSchedule entries (typeCode stored in `signType`,
    // description stored in `roomName`) to build keyword-based match rules,
    // then expand the placeholders into one row per matched room.
    // -------------------------------------------------------------------------
    {
      // Step 4d only applies when there is NO dedicated sign schedule file.
      // When a dedicated sign schedule exists (e.g. AA831 / SIGN-SCHED),
      // signSchedule[] is already correctly populated from Step 3a and must
      // not be expanded here.  Step 4d is for combined-document projects where
      // type codes (A, B, H2 …) need to be expanded into per-room assignments.
      if (dedicatedSignScheduleFiles.length > 0) {
        logger.log(
          `[Step 4d] SKIPPED — dedicated sign schedule file present ` +
          `(${dedicatedSignScheduleFiles.length} file(s)). ` +
          `signSchedule preserved: ${signSchedule.length} entries`,
        );
      } else {
      // Detect type-definition format: entries where signType is a short
      // project code (A, B, A1, H2 …) and there is no room number.
      const TYPE_CODE_RE = /^[A-Z][0-9]?[A-Z]?[0-9]?$/i;
      const typeDefEntries = signSchedule.filter(
        (e) => TYPE_CODE_RE.test(e.signType.trim()) && !e.roomNumber,
      );

      if (typeDefEntries.length > 0 && roomRecords.length > 0) {
        logger.log(`[Step 4d] Type-definition schedule detected: ${typeDefEntries.length} type code(s)`);

        // ── Keyword-based match function factory ─────────────────────────────
        const IS_RESTROOM_RN = /\b(TOILET|RESTROOM|RR\b|LAVATORY|WC|BATHROOM|POWDER\s*ROOM)\b/i;
        const IS_GIRLS_RN    = /\b(GIRLS?|WOMEN|FEMALE)\b/i;
        const IS_BOYS_RN     = /\b(BOYS?|MEN\b|MALE)\b/i;
        const IS_UNISEX_RN   = /\b(UNISEX|GENDER[\s-]*NEUTRAL|FAMILY|SINGLE[\s-]*USER|SINGLE[\s-]*OCC|SINGLE[\s-]*STALL|ACCESSIBLE\s+TOILET)\b/i;

        function descToMatchFn(desc: string): (roomName: string) => boolean {
          const d = desc.toUpperCase();
          const hasRestroom = IS_RESTROOM_RN.test(d);
          const hasGirls    = IS_GIRLS_RN.test(d);
          const hasBoys     = IS_BOYS_RN.test(d);
          const hasUnisex   = IS_UNISEX_RN.test(d);

          if (hasRestroom) {
            if (hasGirls)  return (rn) => IS_GIRLS_RN.test(rn)  && IS_RESTROOM_RN.test(rn);
            if (hasBoys)   return (rn) => IS_BOYS_RN.test(rn)   && IS_RESTROOM_RN.test(rn);
            if (hasUnisex) return (rn) =>
              IS_UNISEX_RN.test(rn) ||
              (IS_RESTROOM_RN.test(rn) && !IS_GIRLS_RN.test(rn) && !IS_BOYS_RN.test(rn));
            // Generic accessible / staff / other restroom → any restroom room
            return (rn) => IS_RESTROOM_RN.test(rn);
          }
          if (/\b(ROOM\s*(SIGN|NAME|ID)|OCCUPANCY|CONFERENCE|ROOM\s*IDENTIFICATION)\b/i.test(d)) {
            return (rn) =>
              !IS_RESTROOM_RN.test(rn) &&
              !/\b(STAIR|ELEVATOR|LIFT|EXIT|ENTRANCE)\b/i.test(rn);
          }
          if (/\b(ENTRANCE|ENTRY|ACCESSIBLE\s+ENTRANCE|BUILDING\s*(ID|ENTRANCE|ENTRY))\b/i.test(d)) {
            return (rn) => /\b(ENTRANCE|ENTRY|LOBBY|FOYER|RECEPTION|MAIN\s+ENTRY)\b/i.test(rn);
          }
          if (/\b(STAIR)\b/i.test(d))    return (rn) => /\b(STAIR)\b/i.test(rn);
          if (/\b(ELEVATOR|LIFT)\b/i.test(d)) return (rn) => /\b(ELEVATOR|LIFT)\b/i.test(rn);
          if (/\b(EXIT)\b/i.test(d))     return (rn) => /\b(EXIT)\b/i.test(rn);
          return () => false; // unknown type — no match
        }

        // Build signTypeMap: one entry per extracted type code.
        const signTypeDefs = typeDefEntries.map((e) => ({
          typeCode:    e.signType.trim().toUpperCase(),
          description: e.roomName || e.signType,
          isAccessible: /\b(ACCESSIBLE|ISA|HANDICAP|ADA)\b/i.test(e.roomName),
          matchFn:     descToMatchFn(e.roomName || e.signType),
        }));

        // ── Match roomRecords to type definitions ─────────────────────────────
        const expandedScheduleRows: typeof signsTable.$inferInsert[] = [];
        let _4dMatchCount = 0;
        let _4dUnmatched  = 0;
        const _4dUsedCodes = new Set<string>();

        for (const typeDef of signTypeDefs) {
          const matched = roomRecords.filter((r) => typeDef.matchFn(r.roomName));
          for (const room of matched) {
            expandedScheduleRows.push({
              id:         newId("sign"),
              jobId,
              tenantId,
              roomId:     room.id,
              sheetId:    room.sheetId ?? null,
              signType:   typeDef.description,
              qty:        1,
              ruleRef:    `type_code_match:${typeDef.typeCode}`,
              color:      null,
              confidence: "0.900",
              status:     "extracted",
              source:     "schedule",
              message:    `Type ${typeDef.typeCode} | ${room.roomNumber} ${room.roomName}`.trim(),
            });
            _4dMatchCount++;
            _4dUsedCodes.add(typeDef.typeCode);
          }
        }

        for (const room of roomRecords) {
          if (!signTypeDefs.some((td) => td.matchFn(room.roomName))) _4dUnmatched++;
        }

        logger.log(
          `Sign type matching: ${_4dMatchCount} rooms matched to schedule types, ` +
          `${_4dUnmatched} unmatched rooms, ${_4dUsedCodes.size} sign type codes used`,
        );

        if (expandedScheduleRows.length > 0) {
          logger.log(
            `[Step 4d] Replaced ${typeDefEntries.length} placeholder type-def row(s) with ` +
            `${expandedScheduleRows.length} room-matched row(s)`,
          );
          // expandedScheduleRows are DB insert rows — convert to SignScheduleEntry format
          // and push to signSchedule[] (single source of truth).
          for (const r of expandedScheduleRows) {
            signSchedule.push({
              roomNumber: (r.roomNumber as string | undefined) ?? "",
              roomName: "",
              signType: r.signType ?? "",
              quantity: r.qty ?? 1,
              size: "",
              message: r.message ?? "",
              notes: "",
              source: "text",
              sheetId: r.sheetId ?? "",
              substrate: null,
              finishMethod: null,
              brailleSpec: null,
              mountingHeight: null,
              manufacturer: null,
            });
          }
        }
      }
      } // end else (no dedicated sign schedule file — type-code expansion path)
    }

    // -------------------------------------------------------------------------
    // Step 4d-2: Room-level schedule entries with type codes → roomRecord matching
    //
    // When Step 4b's Gemini fallback extracted room-level entries (roomNumber +
    // signType = short code like "J"), they sit in signSchedule[] but have no
    // room link yet.
    // Here we match those entries to actual roomRecords by room number and push
    // proper room-linked entries back to signSchedule[].
    // -------------------------------------------------------------------------
    {
      const TYPE_CODE_RE2 = /^[A-Z][0-9]?[A-Z]?[0-9]?$/i;
      const roomLevelTypeCodeEntries = signSchedule.filter(
        (e) => TYPE_CODE_RE2.test(e.signType.trim()) && !!e.roomNumber,
      );

      if (roomLevelTypeCodeEntries.length > 0 && roomRecords.length > 0) {
        logger.log(`[Step 4d-2] Room-level type-code entries: ${roomLevelTypeCodeEntries.length}`);

        // Build a type-code → description map from any type-def entries in the same schedule
        const typeCodeDesc = new Map<string, string>();
        for (const e of signSchedule) {
          if (TYPE_CODE_RE2.test(e.signType.trim()) && !e.roomNumber && e.roomName) {
            typeCodeDesc.set(e.signType.trim().toUpperCase(), e.roomName);
          }
        }

        // Build a roomNumber → roomRecord lookup (normalise room numbers: strip leading zeros, uppercase)
        const normaliseRoomNum = (rn: string) => rn.toUpperCase().trim().replace(/^0+/, "");
        const roomByNumber = new Map<string, typeof roomRecords[0]>();
        for (const r of roomRecords) {
          if (r.roomNumber) {
            roomByNumber.set(normaliseRoomNum(r.roomNumber), r);
            roomByNumber.set(r.roomNumber.toUpperCase().trim(), r); // also exact match
          }
        }

        // Residential unit normalization: strips floor digit so schedule entry "A307"
        // (Wing A, Floor 3, Unit 07) also matches replicated rooms A407/A507/A607.
        function normalizeUnitNumber(roomNum: string): string {
          const match = roomNum.match(/^([A-Z])(\d)(\d{2,})$/);
          if (match) return `${match[1]}${match[3]}`; // e.g. A307 → A07
          return roomNum;
        }
        // Build base-unit → rooms[] lookup for normalized fallback matching.
        // Only meaningful for residential buildings where the same unit repeats
        // across floors (e.g. A307/A407/A507). Gate strictly to avoid incorrect
        // cross-room merging on non-residential jobs (education, healthcare, etc.).
        const roomsByNormalizedUnit = new Map<string, (typeof roomRecords[0])[]>();
        if (finalBuildingType === "residential") {
          for (const r of roomRecords) {
            if (!r.roomNumber) continue;
            const base = normalizeUnitNumber(r.roomNumber.toUpperCase().trim());
            if (base === r.roomNumber.toUpperCase().trim()) continue; // normalization had no effect
            if (!roomsByNormalizedUnit.has(base)) roomsByNormalizedUnit.set(base, []);
            roomsByNormalizedUnit.get(base)!.push(r);
          }
        }

        let _4d2Matched = 0;
        let _4d2Unmatched = 0;
        const _4d2Rows: typeof signsTable.$inferInsert[] = [];

        for (const entry of roomLevelTypeCodeEntries) {
          const normNum = normaliseRoomNum(entry.roomNumber);
          const room = roomByNumber.get(normNum) ?? roomByNumber.get(entry.roomNumber.toUpperCase().trim());
          const desc = typeCodeDesc.get(entry.signType.trim().toUpperCase()) || entry.signType;

          if (room) {
            _4d2Rows.push({
              id:         newId("sign"),
              jobId,
              tenantId,
              roomId:     room.id,
              floorLabel: room.level ? normalizeLevel(room.level) : null,
              sheetId:    room.sheetId ?? null,
              signType:   desc,
              qty:        entry.quantity || 1,
              ruleRef:    `schedule_room_match:${entry.signType}`,
              color:      null,
              confidence: "0.950",
              status:     "extracted",
              source:     "schedule",
              message:    `Type ${entry.signType} | ${entry.roomNumber} ${entry.roomName}`.trim(),
            });
            _4d2Matched++;
          } else {
            // Normalized fallback: strip floor digit and match all rooms with the
            // same base unit identifier (handles replicated residential floors).
            // Gated to residential only — non-residential room numbers that happen
            // to match the pattern (e.g. "B201" classroom) must not merge.
            const baseUnit = finalBuildingType === "residential"
              ? normalizeUnitNumber(entry.roomNumber.toUpperCase().trim())
              : entry.roomNumber.toUpperCase().trim();
            const normalizedRooms = finalBuildingType === "residential" ? roomsByNormalizedUnit.get(baseUnit) : undefined;
            if (normalizedRooms && normalizedRooms.length > 0) {
              logger.log(`[Step 9] Normalized match: ${normalizedRooms.length} room(s) found for "${entry.roomNumber}" — levels: ${normalizedRooms.map(r => r.level).join(", ")}`);
              for (const nr of normalizedRooms) {
                _4d2Rows.push({
                  id:         newId("sign"),
                  jobId,
                  tenantId,
                  roomId:     nr.id,
                  floorLabel: nr.level ? normalizeLevel(nr.level) : null,
                  sheetId:    nr.sheetId ?? null,
                  signType:   desc,
                  qty:        entry.quantity || 1,
                  ruleRef:    `schedule_room_match:${entry.signType}`,
                  color:      null,
                  confidence: "0.950",
                  status:     "extracted",
                  source:     "schedule",
                  message:    `Type ${entry.signType} | ${entry.roomNumber} ${nr.roomNumber} ${entry.roomName}`.trim(),
                });
                _4d2Matched++;
              }
            } else {
              _4d2Unmatched++;
              logger.log(`[Step 4d-2] No room match for room number "${entry.roomNumber}" (Type ${entry.signType})`);
            }
          }
        }

        logger.log(`[Step 4d-2] Matched ${_4d2Matched}/${roomLevelTypeCodeEntries.length} room-level entries (${_4d2Unmatched} unmatched)`);

        if (_4d2Rows.length > 0) {
          for (const row of _4d2Rows) {
            signSchedule.push({
              roomNumber: (row.roomNumber as string | undefined) ?? "",
              roomName: "",
              signType: row.signType ?? "",
              quantity: row.qty ?? 1,
              size: "",
              message: row.message ?? "",
              notes: "",
              source: "text",
              sheetId: (row.sheetId as string | undefined) ?? "",
              substrate: null,
              finishMethod: null,
              brailleSpec: null,
              mountingHeight: null,
              manufacturer: null,
            });
          }
        }
      }
    }

    // -------------------------------------------------------------------------
    // Hoisted reconciliation state — populated in Step 9.5, consumed in final DB write.
    let reconciliationResult: {
      detectedRooms: number;
      scheduleRows: number;
      finalSigns: number;
      benchmarkCount: number | null;
      roomCoverage: number | null;
      warnings: string[];
      reconciledAt: string;
    } | null = null;
    let reconciliationNeedsReview = false;

    // Step 9: Apply rules engine (R1-R17) + tenant overrides
    // Skipped if Step 4b produced a signage schedule import.
    // -------------------------------------------------------------------------
    await wp(9, "Applying rules engine (R1–R17)");
    logger.log(
      `[pipeline] Step 9 entry: hasScheduleImport=${hasScheduleImport}, ` +
      `hasAuthoritativeCountSchedule=${hasAuthoritativeCountSchedule}, signSchedule=${signSchedule.length}`,
    );

    // Hoisted so Step 10 can access them regardless of the skip path.
    let ruleOutput: ReturnType<typeof applyRules> | null = null;
    const signRows: typeof signsTable.$inferInsert[] = [];

    // FIX 1: Rules engine ALWAYS runs regardless of schedule file presence.
    // Previously, dedicatedFileTypeDefMatch caused the rules engine to be skipped,
    // leaving signRows = [] and allSignRows = [] (0 room signs in the Takeoff tab).
    // Schedule-first mode: derived from strategy. When the pipeline resolved to
    // "schedule_primary" (100+ schedule entries extracted in Step 3a), treat the
    // schedule as the authoritative sign count and filter rules-engine output to
    // egress signs + rooms not already covered by the schedule.
    const scheduleFirstMode = pipelineStrategy === "schedule_primary";
    if (scheduleFirstMode) {
      logger.log(
        `[pipeline] scheduleFirstMode=true (strategy=schedule_primary) — ` +
        `${signSchedule.length} schedule entries, rules engine filtering to egress + unmatched rooms only`,
      );
    }
    // Rules engine always runs. Strategy resolver + Fix 2 filter handle schedule priority.
    // Previously skipRulesForSchedule could bypass the rules engine when an embedded schedule
    // crossed a low row-count threshold (10). With fresh AI scans this count became unreliable
    // (Fox Hill: 5 rows cached → 12 rows fresh), causing a regression from 182→35 signs.
    // The strategy resolver (resolveStrategy) now owns the schedule-vs-rules decision, so
    // skipRulesForSchedule is permanently disabled.
    const skipRulesForSchedule = false;

    if (!skipRulesForSchedule && !hasAuthoritativeCountSchedule) {

    // Step 9 — rules engine always runs (estimator mode removed).
    logger.log("[Step 9] MODE: rules_engine");

    // Load tenant rule overrides
    const ruleOverrides = await db.select().from(ruleOverridesTable)
      .where(and(eq(ruleOverridesTable.tenantId, tenantId), eq(ruleOverridesTable.isActive, true)));

    // Load active training corrections and convert to rule-override shape
    const trainingCorrections = await db.select().from(trainingCorrectionsTable)
      .where(and(
        eq(trainingCorrectionsTable.tenantId, tenantId),
        eq(trainingCorrectionsTable.isActive, true),
      ));

    const correctionOverrides = trainingCorrections
      .filter((c) => c.roomNamePattern && c.signType)
      .map((c) => ({
        ruleRef: c.ruleRef ?? "training_correction",
        overrideType: "sign_type",
        condition: { roomNamePattern: c.roomNamePattern } as Record<string, unknown>,
        action: { signType: c.signType } as Record<string, unknown>,
      }));

    // FIX 3 — Build sign type alias from embedded schedule definitions.
    // When a definition's description matches a canonical sign type (e.g. "Room Identification"
    // → "Room ID"), rename the canonical type to the project's type code label ("Type A").
    const signTypeAlias: Record<string, string> = {};
    if (signTypeDefinitions.length > 0) {
      for (const def of signTypeDefinitions) {
        const desc = def.description.toLowerCase().trim();
        const label = `Type ${def.typeCode}`;
        if (/\broom[\s\-]?id\b|\broom[\s\-]?identification\b|\broom[\s\-]?number\b/.test(desc)) {
          signTypeAlias["Room ID"] = label;
        }
        // Future canonical mappings can be added here (Restroom, Exit, etc.)
      }
    }

    const ruleInput = {
      rooms: roomRecords,
      buildingType: finalBuildingType,
      ruleOverrides: [
        ...correctionOverrides,  // Training corrections first — highest priority
        ...ruleOverrides.map((o) => ({
          ruleRef: o.ruleRef,
          overrideType: o.overrideType,
          condition: o.condition as Record<string, unknown>,
          action: o.action as Record<string, unknown>,
        })),
      ],
      customMultiEntryKeywords,
      signTypeDefinitions: signTypeDefinitions.length > 0 ? signTypeDefinitions : undefined,
      signTypeAlias: Object.keys(signTypeAlias).length > 0 ? signTypeAlias : undefined,
    };

    logger.log(`[pipeline] Step 9: Loaded ${correctionOverrides.length} training correction(s): ${correctionOverrides.map(c => `${c.condition.roomNamePattern}→${c.action.signType}`).join(", ")}`);

    // Diagnostic: surface any training corrections with a suspiciously short
    // roomNamePattern (< 3 chars) — these are the most likely "pattern leak" culprits
    // that cause a correction to match every room in the job.
    try {
      const shortPatternRows = await db.execute(sql`
        SELECT id, room_name_pattern, sign_type
        FROM training_corrections
        WHERE tenant_id = ${tenantId}
          AND is_active = true
          AND LENGTH(COALESCE(room_name_pattern, '')) < 3
      `);
      if (shortPatternRows.rows.length > 0) {
        logger.warn(
          `[pipeline] Step 9 DIAG: Found ${shortPatternRows.rows.length} training correction(s) ` +
          `with room_name_pattern shorter than 3 chars — these will match NO rooms (safe, but likely wrong): ` +
          shortPatternRows.rows
            .map((r: Record<string, unknown>) => `id=${r.id} pattern='${r.room_name_pattern ?? ""}' signType=${r.sign_type}`)
            .join("; "),
        );
      } else {
        logger.log(`[pipeline] Step 9 DIAG: No short-pattern training corrections found for tenant.`);
      }
    } catch {
      // Non-fatal — diagnostics should never break the pipeline
    }

    ruleOutput = applyRules(ruleInput);

    // FIX 2: log any types suppressed because they weren't in the embedded sign schedule
    if (ruleOutput.suppressionLog.length > 0) {
      for (const t of ruleOutput.suppressionLog) {
        logger.log(`[pipeline] Step 9: Suppressed ${t} — not in embedded schedule`);
      }
    }

    // FIX 3: log alias mappings in use
    if (Object.keys(signTypeAlias).length > 0) {
      logger.log(
        `[pipeline] Step 9: Sign type alias active — ${Object.entries(signTypeAlias).map(([from, to]) => `"${from}"→"${to}"`).join(", ")}`,
      );
    }

    // Build sign rows to insert

    // Clamp a coordinate value to the valid 0-100000 normalized range.
    const clampCoord = (v: number | null | undefined): number | null => {
      if (v == null) return null;
      return Math.max(0, Math.min(100000, v));
    };

    // Offset a room marker 20% toward the nearest corridor/hallway centroid on
    // the same sheet, so markers appear near the door rather than at room center.
    function applyDoorProximityOffset(
      roomCoordX: number,
      roomCoordY: number,
      corridorRooms: Array<{ coordX: number | null; coordY: number | null }>,
      offsetFraction = 0.20,
    ): { x: number; y: number } {
      if (corridorRooms.length === 0) {
        return { x: roomCoordX, y: roomCoordY };
      }
      let nearestCorridor: { coordX: number; coordY: number } | null = null;
      let minDistance = Infinity;
      for (const corridor of corridorRooms) {
        if (!corridor.coordX || !corridor.coordY) continue;
        const dx = corridor.coordX - roomCoordX;
        const dy = corridor.coordY - roomCoordY;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance < minDistance && distance < 30_000) {
          minDistance = distance;
          nearestCorridor = { coordX: corridor.coordX, coordY: corridor.coordY };
        }
      }
      if (!nearestCorridor) {
        return { x: roomCoordX, y: roomCoordY };
      }
      const offsetX = Math.round(
        roomCoordX + (nearestCorridor.coordX - roomCoordX) * offsetFraction,
      );
      const offsetY = Math.round(
        roomCoordY + (nearestCorridor.coordY - roomCoordY) * offsetFraction,
      );
      return {
        x: Math.max(1_000, Math.min(99_000, offsetX)),
        y: Math.max(1_000, Math.min(99_000, offsetY)),
      };
    }

    // Level → best matching floor plan sheet ID (used when a sign has no specific room sheet).
    // For buildings with multiple sheets per floor (wings), prefer the sheet with the most
    // sign markers (so egress signs land on the most populated wing sheet).  Break ties by
    // preferring architectural floor plans over engineering sheets, then by sheet ID order.
    const signCountBySheet = new Map<string, number>();
    for (const sr of signRows) {
      if (sr.sheetId) signCountBySheet.set(sr.sheetId, (signCountBySheet.get(sr.sheetId) ?? 0) + 1);
    }
    const sheetsByLevel = new Map<string, typeof floorPlanSheets>();
    for (const s of floorPlanSheets) {
      if (!s.level) continue;
      const arr = sheetsByLevel.get(s.level) ?? [];
      arr.push(s);
      sheetsByLevel.set(s.level, arr);
    }
    const sheetByLevel = new Map<string, { id: string; sheetNumber: string | null }>();
    for (const [level, sheets] of sheetsByLevel) {
      // Score: prefer more signs, then lower sheetId (architectural before engineering)
      const best = sheets.slice().sort((a, b) => {
        const cntDiff = (signCountBySheet.get(b.id) ?? 0) - (signCountBySheet.get(a.id) ?? 0);
        if (cntDiff !== 0) return cntDiff;
        return (a.sheetId ?? "").localeCompare(b.sheetId ?? "", undefined, { numeric: true });
      })[0];
      if (best) sheetByLevel.set(level, { id: best.id, sheetNumber: best.sheetId ?? null });
    }
    // Fallback entry for signs that have no floorLabel
    const defaultSheetEntry = floorPlanSheets[0]
      ? { id: floorPlanSheets[0].id, sheetNumber: floorPlanSheets[0].sheetId ?? null }
      : null;

    // When a level has multiple sheets (multi-wing buildings), build a secondary lookup
    // keyed by "LEVEL N:LETTER" so a room like "101A" can prefer the sheet whose
    // architectural sheet ID or title contains the letter "A".
    const sheetByLevelAndBuilding = new Map<string, { id: string; sheetNumber: string | null }>();
    for (const [level, sheets] of sheetsByLevel) {
      if (sheets.length < 2) continue; // single-sheet levels don't need per-building resolution
      for (const sheet of sheets) {
        const sheetRef = `${sheet.sheetId ?? ""} ${sheet.sheetTitle ?? ""}`.toUpperCase();
        // Extract trailing/leading single letter from the sheet reference (e.g. "A1.1" → "A")
        const sheetLetterMatch = /\b([A-Z])\b/.exec(sheetRef);
        if (sheetLetterMatch) {
          const key = `${level}:${sheetLetterMatch[1]}`;
          if (!sheetByLevelAndBuilding.has(key)) {
            sheetByLevelAndBuilding.set(key, { id: sheet.id, sheetNumber: sheet.sheetId ?? null });
          }
        }
      }
    }

    // Query corridor rooms for door proximity offset — fetched once before the loop.
    const allRoomsForJob = await db.select({
      id: roomsTable.id,
      sheetId: roomsTable.sheetId,
      coordX: roomsTable.coordX,
      coordY: roomsTable.coordY,
      isCorridorOrHall: roomsTable.isCorridorOrHall,
    }).from(roomsTable).where(eq(roomsTable.jobId, jobId));

    // Per-room signs
    for (const result of ruleOutput.results) {
      for (const sa of result.signs) {
        // Resolve sheet for this room: prefer the room's own sheet, fall back to the
        // building-letter-aware lookup (for multi-wing levels), then the best-sign-count
        // sheet for that level, then the first floor plan sheet.
        const buildingLetter = extractBuildingFromRoomNumber(result.room.roomNumber ?? "");
        const levelAndBuilding = (result.room.level && buildingLetter)
          ? sheetByLevelAndBuilding.get(`${result.room.level}:${buildingLetter}`)
          : null;
        const levelEntry = result.room.level ? sheetByLevel.get(result.room.level) : null;
        const resolvedSheetId = result.room.sheetId ?? levelAndBuilding?.id ?? levelEntry?.id ?? defaultSheetEntry?.id ?? null;
        // Look up the architectural sheet number (e.g. "3.9.51") for the resolved sheet
        const resolvedSheetNumber = resolvedSheetId
          ? (sheetDbRows.find(s => s.id === resolvedSheetId)?.sheetId ?? null)
          : null;
        // Skip stair/exit/evac signs from rules engine — egress generator handles these
        if (
          sa.signType === "Stair(Corridor)" || sa.signType === "Stair (Corridor)" ||
          sa.signType === "Stair(Landing)" || sa.signType === "Stair (Landing)" ||
          sa.signType === "Area of Rescue" ||
          sa.signType === "Evacuation Map" ||
          (sa.signType === "Exit" && result.room.isStair)
        ) {
          continue;
        }
        const signRow: typeof signRows[0] = {
          id: newId("sign"),
          jobId,
          tenantId,
          roomId: result.room.id,
          sheetId: resolvedSheetId,
          signType: sa.signType,
          qty: sa.qty,
          ruleRef: sa.ruleRef,
          color: sa.color,
          confidence: String(sa.confidence),
          status: "extracted",
          source: "rules_engine",
          markerX: clampCoord(result.room.coordX),
          markerY: clampCoord(result.room.coordY),
          dimensions: sa.dimensions ?? null,
          dimSource: sa.dimSource ?? null,
          adaRequired: sa.adaRequired ?? null,
          notes: sa.notes ?? null,
          floorLabel: result.room.level ? normalizeLevel(result.room.level) : null,
          sourceSheetNumber: resolvedSheetNumber,
        };
        // Apply door proximity offset for room-linked signs: shift marker 20% toward
        // the nearest corridor centroid on the same sheet so it appears near the door.
        if (
          signRow.markerX != null &&
          signRow.markerY != null &&
          signRow.roomId != null
        ) {
          const corridorRoomsForSheet = allRoomsForJob.filter(r =>
            r.sheetId === signRow.sheetId &&
            r.isCorridorOrHall === true &&
            r.coordX != null &&
            r.coordY != null,
          );
          const offset = applyDoorProximityOffset(
            signRow.markerX,
            signRow.markerY,
            corridorRoomsForSheet,
          );
          signRow.markerX = offset.x;
          signRow.markerY = offset.y;
        }
        signRows.push(signRow);
      }
    }

    // Elevator signs (still from rules engine — not replaced by egress generator)
    for (const sa of ruleOutput.elevatorSigns) {
      signRows.push({
        id: newId("sign"),
        jobId,
        tenantId,
        roomId: sa.roomId ?? null,
        sheetId: defaultSheetEntry?.id ?? null,
        signType: sa.signType,
        qty: sa.qty,
        ruleRef: sa.ruleRef,
        color: sa.color,
        confidence: String(sa.confidence),
        status: "extracted",
        source: "rules_engine",
        dimensions: sa.dimensions ?? null,
        dimSource: sa.dimSource ?? null,
        adaRequired: sa.adaRequired ?? null,
        notes: sa.notes ?? null,
        floorLabel: sa.floorLabel ?? null,
        sourceSheetNumber: defaultSheetEntry?.sheetNumber ?? null,
      });
    }

    // ── Egress Sign Generator (replaces stairSigns / evacMapSigns / exitSigns) ──
    // Load building type profile for stair defaults, lexicons, etc.
    const resolvedBuildingType = finalBuildingType ?? ruleOutput.detectedBuildingType ?? "commercial";
    const profileRows = await db
      .select()
      .from(buildingTypeProfilesTable)
      .where(eq(buildingTypeProfilesTable.buildingType, resolvedBuildingType));
    const buildingProfile = profileRows[0] ?? null;

    if (buildingProfile) {
      const egressRooms = roomRecords.map((r) => ({
        id: r.id,
        roomNumber: r.roomNumber,
        roomName: r.roomName,
        level: r.level,
        isAssembly: r.isAssembly,
        isCorridorOrHall: r.isCorridorOrHall,
        isMepUnoccupied: r.isMepUnoccupied,
        isStair: r.isStair,
      }));

      const egressRows = generateEgressSigns({
        jobId,
        tenantId,
        buildingType: resolvedBuildingType,
        rooms: egressRooms,
        sheetId: defaultSheetEntry?.id ?? null,
        profile: buildingProfile,
      });

      logger.log(
        `[pipeline] Step 9: Egress generator produced ${egressRows.length} sign(s) ` +
        `(type: ${resolvedBuildingType}, rooms: ${egressRooms.length})`,
      );

      for (const er of egressRows) {
        // Use level-matched sheet so egress signs for Level 2 appear on the Level 2 sheet,
        // not always on the first floor plan sheet (which would be wrong for multi-floor buildings).
        const egressLevelEntry = er.floorLabel ? sheetByLevel.get(er.floorLabel) : null;
        const egressSheetEntry = egressLevelEntry ?? defaultSheetEntry;
        signRows.push({
          id: er.id,
          jobId: er.jobId,
          tenantId: er.tenantId,
          roomId: er.roomId,
          sheetId: egressSheetEntry?.id ?? null,
          signType: er.signType,
          qty: er.qty,
          ruleRef: er.ruleRef,
          color: er.color,
          confidence: er.confidence,
          status: er.status,
          source: er.source,
          dimensions: er.dimensions,
          dimSource: er.dimSource,
          adaRequired: er.adaRequired,
          notes: er.notes,
          floorLabel: er.floorLabel,
          roomNumber: er.roomNumber ?? null,
          roomName: er.roomName ?? null,
          sourceSheetNumber: egressSheetEntry?.sheetNumber ?? null,
        });
      }
    } else {
      logger.log(
        `[pipeline] Step 9: No profile found for building type "${resolvedBuildingType}" — ` +
        `falling back to rules engine stair/evac signs`,
      );
      // Fallback: use rules engine stair/evac signs if no profile found
      for (const sa of ruleOutput.stairSigns) {
        signRows.push({
          id: newId("sign"),
          jobId,
          tenantId,
          roomId: null,
          sheetId: defaultSheetEntry?.id ?? null,
          signType: sa.signType,
          qty: sa.qty,
          ruleRef: sa.ruleRef,
          color: sa.color,
          confidence: String(sa.confidence),
          status: "extracted",
          source: "rules_engine",
          dimensions: sa.dimensions ?? null,
          dimSource: sa.dimSource ?? null,
          adaRequired: sa.adaRequired ?? null,
          notes: sa.notes ?? null,
          floorLabel: null,
          sourceSheetNumber: defaultSheetEntry?.sheetNumber ?? null,
        });
      }
      for (const sa of ruleOutput.evacMapSigns) {
        signRows.push({
          id: newId("sign"),
          jobId,
          tenantId,
          roomId: null,
          sheetId: defaultSheetEntry?.id ?? null,
          signType: sa.signType,
          qty: sa.qty,
          ruleRef: sa.ruleRef,
          color: sa.color,
          confidence: String(sa.confidence),
          status: "extracted",
          source: "rules_engine",
          dimensions: sa.dimensions ?? null,
          dimSource: sa.dimSource ?? null,
          adaRequired: null,
          notes: null,
          sourceSheetNumber: defaultSheetEntry?.sheetNumber ?? null,
          floorLabel: null,
        });
      }
    }

    const correctionCount = signRows.filter((s) => s.ruleRef === "training_correction").length;
    if (correctionCount > 0) {
      logger.log(`[pipeline] Applied ${correctionCount} training correction(s) to sign rows`);
    }

    } else if (hasAuthoritativeCountSchedule) {
      const aggregateTotal = signSchedule.reduce((sum, entry) => sum + (entry.quantity ?? 1), 0);
      logger.log(
        `[pipeline] Step 9: authoritative aggregate count schedule present — ` +
        `skipping rules engine and egress generation (${signSchedule.length} type row(s), ${aggregateTotal} sign(s))`,
      );
    } // end: else (rules engine path)

    // Restroom-only scope filter: suppress Room ID, Exit, Stair, Elevator, etc.
    if (restroomOnlyScope) {
      const before = signRows.length;
      signRows.splice(0, signRows.length, ...signRows.filter(s => !RESTROOM_ONLY_EXCLUDED_SIGN_TYPES.has(s.signType ?? "")));
      logger.log(
        `[pipeline] Step 9: Restroom-only scope — suppressed ${before - signRows.length} non-restroom sign(s), ` +
        `${signRows.length} restroom sign(s) remain`,
      );

      // Restroom-only room-name filter: do not assign signs to clearly non-restroom
      // rooms (classroom, office, lobby, etc.) even if the rules engine matched them.
      const NON_RESTROOM_ROOM_NAMES = /\b(CLASSROOM|OFFICE|STORAGE|CORRIDOR|LOBBY|GYM|CAFETERIA|LIBRARY)\b/i;
      const roomById = new Map(roomRecords.map(r => [r.id, r]));
      const beforeRoom = signRows.length;
      signRows.splice(0, signRows.length, ...signRows.filter(s => {
        if (!s.roomId) return true; // unlinked signs pass through
        const room = roomById.get(String(s.roomId));
        if (!room) return true;    // unknown room — keep
        return !NON_RESTROOM_ROOM_NAMES.test(room.roomName);
      }));
      if (beforeRoom > signRows.length) {
        logger.log(
          `[pipeline] Step 9: Restroom-only scope — suppressed ${beforeRoom - signRows.length} sign(s) ` +
          `for non-restroom rooms (classroom, office, corridor, etc.), ${signRows.length} remain`,
        );
      }
    }

    // FIX 4: Evacuation Maps must not be assigned to open/pass-through room types.
    // PROJECT AREAs, alcoves, passages, closets, and storage rooms lack the traffic
    // density and fixed-egress framing that justify a posted evacuation map.
    // This filter applies to ALL sources (rules engine + schedule import + training).
    {
      const EVAC_INELIGIBLE = /\bPROJECT\s*AREA\b|\bALCOVE\b|\bPASSAGE\b|\bCLOSET\b|\bSTORAGE\b/i;
      const roomForId = new Map(roomRecords.map(r => [r.id, r]));
      const before = signRows.length;
      signRows.splice(0, signRows.length, ...signRows.filter(s => {
        if (s.signType !== "Evacuation Map") return true;
        if (!s.roomId) return true; // aggregate (unlinked) evac maps are always kept
        const room = roomForId.get(String(s.roomId));
        if (!room) return true;
        return !EVAC_INELIGIBLE.test(room.roomName);
      }));
      if (signRows.length < before) {
        logger.log(
          `[pipeline] FIX 4: Suppressed ${before - signRows.length} Evacuation Map sign(s) ` +
          `assigned to ineligible room type(s) (PROJECT AREA, ALCOVE, PASSAGE, CLOSET, STORAGE)`,
        );
      }
    }

    // Dedicated schedule diagnostic: log which sign types the schedule covers.
    if (dedicatedSignScheduleFiles.length > 0 && signSchedule.length > 0) {
      const scheduleTypes = [...new Set(signSchedule.map(e => e.signType).filter((t): t is string => !!t))];
      logger.log(
        `[pipeline] Step 9: Dedicated schedule has ${scheduleTypes.length} type(s): ${scheduleTypes.join(", ")} — ` +
        `will merge with ${signRows.length} rules-engine sign(s) (no filtering)`,
      );
    }

    // Signage-notes sheet whitelist: constrain rules engine output to sign types
    // defined on an embedded signage-notes sheet (e.g. "A0. Signage Notes").
    // Exempt: training corrections and project-specific type codes (e.g. "Type B.1").
    // These are explicit human decisions and must never be filtered by the whitelist.
    if (signageNotesWhitelist && signageNotesWhitelist.size > 0) {
      const before = signRows.length;
      signRows.splice(0, signRows.length, ...signRows.filter(s => {
        // Always keep training corrections — human overrides trump the whitelist.
        if (s.ruleRef === "training_correction" || s.ruleRef?.startsWith("training_correction:")) return true;
        // Always keep project type codes ("Type A", "Type B.1", "Type D" …).
        if (isTypeCodeSignType(s.signType)) return true;
        // All other sign rows must appear in the signage-notes whitelist.
        return signageNotesWhitelist!.has(s.signType ?? "");
      }));
      logger.log(
        `[pipeline] Step 9: Signage notes whitelist "${signageNotesSheetName}" ` +
        `(${signageNotesWhitelist.size} type(s)) — kept ${signRows.length} of ${before} sign(s) ` +
        `(training corrections and type-code signs are exempt)`,
      );
    }

    // Change 5: schedule_primary egress-only filter — keep only rules-engine signs
    // produced by egress rules (R9/R11/R13/R16: exit, stair, evac map, area of rescue).
    // The sign schedule is the authoritative source for unit/office/corridor signs;
    // the rules engine is reserved for egress signs not covered by the schedule.
    // Training corrections always pass through unconditionally UNLESS a dedicated
    // sign schedule is present (see Fix 8 below).
    //
    // Fix 8: When a dedicated sign schedule is present:
    //   (a) Exclude R16 (Residential Unit signs) from EGRESS_RULES — the schedule
    //       covers those. R16 is only kept when there is NO dedicated schedule file.
    //   (b) Suppress training corrections for non-egress sign types — training
    //       corrections are learned from rules-engine-primary jobs and should not
    //       add residential/office/corridor signs that the dedicated schedule already
    //       covers authoritatively. Only training corrections that produce an egress
    //       sign type (Exit, Stair*, Evacuation Map, Area of Rescue, Directional) are
    //       kept.
    if (scheduleFirstMode) {
      const hasDedicatedSchedule = dedicatedSignScheduleFiles.length > 0;
      const EGRESS_RULES = hasDedicatedSchedule
        ? ["R9", "R11", "R13"]          // dedicated schedule covers R16 (unit signs)
        : ["R9", "R11", "R13", "R16"];  // no dedicated schedule — R16 fills unit gaps
      const EGRESS_SIGN_TYPES = new Set([
        "Exit", "Stair", "Stair (Corridor)", "Stair (Landing)", "Stair (Corridor)/(Landing)",
        "Evacuation Map", "Area of Rescue", "Directional", "Exit Sign",
        "Fire Exit", "Emergency Exit", "Egress Door",
      ]);
      const beforeCount = signRows.length;
      signRows.splice(0, signRows.length, ...signRows.filter(s => {
        const isTrainingCorrection =
          s.source === "training_correction" ||
          s.ruleRef === "training_correction" ||
          (s.ruleRef?.startsWith("training_correction:") ?? false);
        if (isTrainingCorrection) {
          // With dedicated schedule: only keep training corrections for egress sign types.
          // Without dedicated schedule: keep all training corrections unconditionally.
          if (hasDedicatedSchedule) {
            return EGRESS_SIGN_TYPES.has(s.signType ?? "");
          }
          return true;
        }
        return EGRESS_RULES.some(r => s.ruleRef === r);
      }));
      logger.log(
        `[Step 9] schedule_primary — egress filter: ` +
        `${beforeCount} → ${signRows.length} sign(s) kept ` +
        `(${EGRESS_RULES.join("/")} + ${hasDedicatedSchedule ? "egress-only training corrections, R16 suppressed (dedicated schedule)" : "all training corrections"})`,
      );
    }

    // Final sign dedup: keep highest-confidence row per room+signType combination.
    // Groups by roomNumber + roomName + signType (normalised uppercase) so that
    // the same physical room detected with different IDs is still deduplicated.
    // Source priority tiebreaker: training_correction > schedule > rules_engine > ai_vision
    {
      const beforeDedup = signRows.length;

      // Source priority scores
      const SOURCE_PRIORITY: Record<string, number> = {
        training_correction: 4,
        schedule:            3,
        rules_engine:        2,
        ai_vision:           1,
      };
      function rowPriority(s: typeof signRows[number]): number {
        if (s.ruleRef === "training_correction" || (s.ruleRef ?? "").startsWith("training_correction:")) return 4;
        return SOURCE_PRIORITY[s.source ?? ""] ?? 0;
      }

      // Build roomId → {num, name} lookup from rules engine results
      const roomMeta = new Map<string, { num: string; name: string }>();
      if (ruleOutput) {
        for (const r of ruleOutput.results) {
          if (!roomMeta.has(r.room.id)) {
            roomMeta.set(r.room.id, { num: r.room.roomNumber, name: r.room.roomName });
          }
        }
      }

      // Group rows by dedup key
      const groups = new Map<string, typeof signRows>();
      for (const s of signRows) {
        const meta = s.roomId ? roomMeta.get(s.roomId) : null;
        const roomNum  = (meta?.num  ?? "").trim().toUpperCase();
        const roomName = (meta?.name ?? "").trim().toUpperCase();
        const signTypeKey = (s.signType ?? "").trim().toUpperCase();
        // For room-linked signs use room+type+floor so that the same room name
        // (e.g. "UNIT A") at different levels (replicated residential floors)
        // is NOT collapsed — each floor keeps its own sign rows.
        // For aggregate signs (roomId=null, e.g. per-stair-per-floor egress
        // signs) also include floorLabel + first 40 chars of notes so each
        // stair-floor combination survives dedup.
        const key = (roomNum || roomName)
          ? `${roomNum}|${roomName}|${signTypeKey}|${(s.floorLabel ?? "").trim().toUpperCase()}`
          : `||${signTypeKey}|${(s.floorLabel ?? "").trim().toUpperCase()}|${(s.notes ?? "").slice(0, 40).toUpperCase()}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(s);
      }

      // Within each group keep the best row (highest confidence, then source priority)
      const kept: typeof signRows = [];
      for (const [, group] of groups) {
        if (group.length === 1) { kept.push(group[0]); continue; }
        const best = [...group].sort((a, b) => {
          const confDiff = parseFloat(String(b.confidence ?? "0")) - parseFloat(String(a.confidence ?? "0"));
          if (Math.abs(confDiff) > 0.001) return confDiff;
          return rowPriority(b) - rowPriority(a);
        })[0];
        kept.push(best);
      }

      signRows.splice(0, signRows.length, ...kept);

      const collapsed = beforeDedup - signRows.length;
      if (collapsed > 0) {
        logger.log(
          `[pipeline] Step 9: Final dedup: removed ${collapsed} duplicate sign row(s) ` +
          `(kept highest confidence per room+type combination)`,
        );
      }
    }

    // signSchedule[] is the single source of truth — canonical insert at Step 9 below
    // handles all schedule strategies (schedule_primary, hybrid, embedded A-7XX).

    // FIX 5: Post-assembly cleanup — remove Exit/Elevator signs that slipped
    // through the rules engine but don't belong.  Runs AFTER dedup as the
    // absolute last step before DB insert.
    //
    // Rules:
    //  • Exit signs MUST come exclusively from the egress generator
    //    (source='rules_engine'). Any Exit assigned by the rules engine via
    //    room-name matching (LOBBY, GYMNASIUM, CORRIDOR, etc.) is removed.
    //  • Elevator/In Case of Fire signs must come from the egress generator
    //    OR be linked to an actual elevator room.
    {
      const roomById = new Map(roomRecords.map((r) => [r.id, r]));
      const beforeCleanup = signRows.length;
      let removedWrongExit = 0;
      let removedNonElevElevator = 0;

      signRows.splice(0, signRows.length, ...signRows.filter((s) => {
        // Exit signs: ONLY keep if generated by the egress generator
        // (source='rules_engine' AND roomId=null means aggregate egress sign).
        // Any Exit with a linked roomId was assigned by the rules engine to a
        // specific room — that path is now deprecated; egress generator owns Exit.
        if (s.signType === "Exit" && s.roomId !== null && s.roomId !== undefined) {
          removedWrongExit++;
          return false;
        }

        // Elevator / In Case of Fire: only keep if roomId=null (egress generator)
        // or linked room is actually an elevator room.
        if ((s.signType === "Elevator" || s.signType === "In Case of Fire") && s.roomId) {
          const room = roomById.get(s.roomId);
          if (room && !room.isElevator) {
            removedNonElevElevator++;
            return false;
          }
        }
        return true;
      }));

      if (removedWrongExit + removedNonElevElevator > 0) {
        logger.log(
          `[pipeline] FIX 5 cleanup: removed ${removedWrongExit} room-linked Exit sign(s), ` +
          `${removedNonElevElevator} Elevator/ICF sign(s) on non-elevator rooms ` +
          `(${beforeCleanup} → ${signRows.length} total)`,
        );
      }
    }

    // Pre-insert sign count verification: log any rooms with unusually many signs.
    {
      const countByRoom = new Map<string, number>();
      for (const s of signRows) {
        const meta = s.roomId ? (() => {
          if (ruleOutput) {
            for (const r of ruleOutput.results) {
              if (r.room.id === s.roomId) return r.room.roomName;
            }
          }
          return null;
        })() : null;
        const label = meta ?? s.roomId ?? "(no-room)";
        countByRoom.set(label, (countByRoom.get(label) ?? 0) + 1);
      }
      const highCount = [...countByRoom.entries()].filter(([, n]) => n > 3);
      logger.log(
        `[pipeline] Step 9: Pre-insert totals — ${signRows.length} sign(s) across ` +
        `${countByRoom.size} room(s).` +
        (highCount.length > 0
          ? ` High-count rooms (>3 signs): ${highCount.map(([n, c]) => `${n}(${c})`).join(", ")}`
          : ""),
      );
    }

    // Validate: warn when a rules-engine sign type is a project type code that is
    // not listed in the definitions extracted from the embedded schedule sheet.
    // This surfaces type-code typos and missing schedule entries without blocking.
    if (signTypeDefinitions.length > 0) {
      const definedCodes = new Set(
        signTypeDefinitions.map((d) => `Type ${d.typeCode}`.toUpperCase()),
      );
      const unrecognised = [
        ...new Set(
          signRows
            .filter((s) => isTypeCodeSignType(s.signType) && !definedCodes.has((s.signType ?? "").toUpperCase()))
            .map((s) => s.signType ?? "")
            .filter(Boolean),
        ),
      ];
      if (unrecognised.length > 0) {
        logger.warn(
          `[pipeline] Step 9: Sign type(s) assigned but not defined in extracted schedule: ${unrecognised.join(", ")}`,
        );
      }
    }
    // Insert ALWAYS runs when the rules engine ran — must be OUTSIDE the
    // signTypeDefinitions guard above, which is only a warning.  Previously
    // the insert was mistakenly nested inside the if-block, so any job without
    // a schedule file (signTypeDefinitions empty) would fall into the else branch
    // and use signSchedule[] instead of the rules-engine signRows.
    logger.log(`[pipeline] Step 9: About to insert ${signRows.length} sign(s) for job ${jobId}`);
    await withStepTimeout("Step 9 (sign insert)", async () => {
      if (signRows.length > 0) {
        await db.insert(signsTable).values(signRows);
      }
    });

    logger.log(`[pipeline] Step 9: Inserted ${signRows.length} rules-engine sign(s) for job ${jobId}`);

    // Canonical schedule sign insert — reads from signSchedule[] which is the
    // single source of truth populated by Step 3a (Gemini) and Step 4b (text fallback).
    // Runs for ALL strategies that have schedule entries — schedule_primary, hybrid, and
    // combo/embedded schedules.
    // The `signSchedule.length > 0` sub-condition is intentionally omitted here:
    // deduplicateSignSchedule (and the inline bridge dedup below) already
    // short-circuits safely on empty input, so adding the length guard would
    // only create a silent-skip risk — the same risk that was removed from the
    // Steps 3a and 4b blocks.
    if (hasScheduleImport) {
      // Dedup guard keyed on sheetId + roomNumber + signType — prevents duplicate
      // rows when the same sheet is processed by multiple pipeline paths in the
      // same run (e.g. Step 3a Gemini + Step 4b text) or when a rescan re-runs
      // a path that appended entries without clearing signSchedule first.
      const bridgeSeenKeys = new Set<string>();
      const dedupedSchedule = signSchedule.filter(entry => {
        const key = [
          (entry.sheetId ?? "").trim().toLowerCase(),
          (entry.roomNumber ?? "").trim().toLowerCase(),
          (entry.signType ?? "").trim().toLowerCase(),
          (entry.typeMark ?? "").trim().toLowerCase(),
        ].join("|");
        if (bridgeSeenKeys.has(key)) return false;
        bridgeSeenKeys.add(key);
        return true;
      });
      const bridgeDuplicatesSkipped = signSchedule.length - dedupedSchedule.length;
      if (bridgeDuplicatesSkipped > 0) {
        logger.log(
          `[pipeline] Step 9 bridge dedup: ${signSchedule.length} entries → ` +
          `${dedupedSchedule.length} unique (skipped ${bridgeDuplicatesSkipped} duplicate(s) by sheetId+roomNumber+signType)`,
        );
      }
      const scheduleInserts = dedupedSchedule.map(entry => ({
        id: newId("sign"),
        jobId,
        tenantId,
        roomId: null,
        sheetId: String(_3aAnchorSheetId ?? ""),
        signType: entry.signType,
        qty: entry.quantity ?? 1,
        ruleRef: "schedule" as const,
        color: null,
        confidence: "1.000",
        status: "extracted" as const,
        source: "schedule" as const,
        notes: entry.typeMark ? `Type mark: ${entry.typeMark}` : null,
        message: entry.message || [entry.roomNumber, entry.roomName, entry.signType]
          .filter(Boolean).join(" | ") || undefined,
        floorLabel: (() => {
          const matchedRoom = extractedRooms.find(
            r => r.roomNumber === entry.roomNumber
          );
          if (matchedRoom?.level != null) return String(matchedRoom.level);
          return entry.floor ? parseScheduleFloor(entry.floor as string) : null;
        })(),
      }));

      await withStepTimeout("Step 9 (schedule sign insert)", async () => {
        if (scheduleInserts.length > 0) {
          await db.insert(signsTable).values(scheduleInserts);
        }
      });
      logger.log(
        `[pipeline] Step 9: inserted ${scheduleInserts.length} schedule sign(s) ` +
        `from signSchedule[] (strategy=${pipelineStrategy})`,
      );
    }

    // ── Step 9.5: Two-pass coordinate + sheet routing for schedule signs ────────
    // Schedule signs land with sheetId=_3aAnchorSheetId and markerX=NULL.
    // Pass 1 matches sign_type exactly to rooms.room_number (unit signs: A418, B615…).
    // Pass 2 matches UPPER(sign_type) to UPPER(rooms.room_name) (common areas:
    //   CORRIDOR, JANITOR CLOSET, UNISEX TOILET, …).
    // Both passes write the correct sheet_id + real coord_x/coord_y so signs appear
    // on the right wing plan.  Signs that still have markerX=NULL after both passes
    // are left for Step 10b to stamp with the 50000 sentinel (unlocated).
    if (hasScheduleImport && signSchedule.length > 0) {
      await wp("9.5", "Resolving schedule sign coordinates from room data");

      // Pass 1 — sign_type = room_number (exact, case-sensitive).
      // DISTINCT ON sign id ensures one deterministic update per sign when
      // multiple rooms share a number (rare, but possible in multi-building jobs).
      const pass1 = await db.execute(sql`
        UPDATE signs AS sg
        SET
          sheet_id = sub.sheet_id,
          marker_x = sub.coord_x,
          marker_y = sub.coord_y
        FROM (
          SELECT DISTINCT ON (sg2.id)
            sg2.id   AS sign_id,
            r.sheet_id,
            r.coord_x,
            r.coord_y
          FROM signs sg2
          JOIN rooms r
            ON  r.room_number = sg2.sign_type
            AND r.job_id      = sg2.job_id
          WHERE sg2.job_id   = ${jobId}
            AND sg2.marker_x IS NULL
            AND r.coord_x    IS NOT NULL
          ORDER BY sg2.id, r.coord_x
        ) AS sub
        WHERE sg.id = sub.sign_id
      `);
      const pass1Count = Number((pass1 as unknown as { rowCount?: number }).rowCount ?? 0);
      logger.log(`[pipeline] Step 9.5 Pass 1 (sign_type=room_number): ${pass1Count} sign(s) resolved`);

      // Pass 2 — UPPER(sign_type) = UPPER(room_name) (common-area names).
      // Runs only on signs that pass 1 did not resolve (marker_x IS NULL).
      const pass2 = await db.execute(sql`
        UPDATE signs AS sg
        SET
          sheet_id = sub.sheet_id,
          marker_x = sub.coord_x,
          marker_y = sub.coord_y
        FROM (
          SELECT DISTINCT ON (sg2.id)
            sg2.id   AS sign_id,
            r.sheet_id,
            r.coord_x,
            r.coord_y
          FROM signs sg2
          JOIN rooms r
            ON  UPPER(r.room_name) = UPPER(sg2.sign_type)
            AND r.job_id           = sg2.job_id
          WHERE sg2.job_id   = ${jobId}
            AND sg2.marker_x IS NULL
            AND r.coord_x    IS NOT NULL
          ORDER BY sg2.id, r.coord_x
        ) AS sub
        WHERE sg.id = sub.sign_id
      `);
      const pass2Count = Number((pass2 as unknown as { rowCount?: number }).rowCount ?? 0);
      logger.log(`[pipeline] Step 9.5 Pass 2 (sign_type=room_name): ${pass2Count} sign(s) resolved`);

      const totalResolved = pass1Count + pass2Count;
      const totalInserted = signSchedule.length;
      logger.log(
        `[pipeline] Step 9.5: ${totalResolved}/${totalInserted} schedule sign(s) located — ` +
        `${totalInserted - totalResolved} remain unlocated (will receive 50000 sentinel in Step 10b)`,
      );
    }

    // Restore manually placed markers (canvasX/Y) that were captured before the
    // delete. Match by roomNumber + level + signType so placements survive rescans.
    if (priorPlacementMap.size > 0) {
      const newSigns = await db
        .select({
          id: signsTable.id,
          signType: signsTable.signType,
          roomNumber: roomsTable.roomNumber,
          level: roomsTable.level,
        })
        .from(signsTable)
        .leftJoin(roomsTable, eq(signsTable.roomId, roomsTable.id))
        .where(eq(signsTable.jobId, jobId));

      const restorations: Promise<unknown>[] = [];
      for (const s of newSigns) {
        const key = `${s.roomNumber ?? ""}|${s.level ?? ""}|${s.signType}`;
        const placement = priorPlacementMap.get(key);
        if (placement) {
          restorations.push(
            db.update(signsTable)
              .set({ canvasX: placement.canvasX, canvasY: placement.canvasY })
              .where(eq(signsTable.id, s.id)),
          );
        }
      }
      if (restorations.length > 0) {
        await Promise.all(restorations);
        logger.log(`[pipeline] Restored ${restorations.length} manually placed marker(s) after rescan`);
      }
    }

    // -------------------------------------------------------------------------
    // Step 9.2: Specialty Sign Extraction
    // Extracts specialty sign data from:
    //   a) sign_details sheets (dedicated detail/wallcovering sheets)
    //   b) signage_schedule sheets that contain sign-panel imagery (e.g. Fox
    //      Hill 3.9.56 which shows acrylic panel types and interpretive graphics)
    // Falls back to the Step B projectSignDictionary when no vision sheets are
    // available — inserting non-room-id sign types directly as specialty rows.
    // -------------------------------------------------------------------------
    {
      const SPECIALTY_CATEGORIES = new Set(["stair", "wayfinding", "exit", "elevator", "other"]);

      // Log the sheet type breakdown so it's easy to diagnose if specialty
      // items are present on a sheet type that falls outside the filter below.
      const _sheetTypeBreakdown: Record<string, string[]> = {};
      for (const s of sheetDbRows) {
        const t = s.sheetType ?? "unknown";
        if (!_sheetTypeBreakdown[t]) _sheetTypeBreakdown[t] = [];
        _sheetTypeBreakdown[t].push(s.sheetId ?? "?");
      }
      logger.log(
        `[pipeline] Step 9.2: Sheet type breakdown — ` +
        Object.entries(_sheetTypeBreakdown)
          .map(([t, ids]) => `${t}(${ids.length}): ${ids.join(", ")}`)
          .join(" | "),
      );

      const signDetailSheets = aggregateCountFastPath
        ? []
        : sheetDbRows.filter(
          (s) => s.sheetType === "sign_details" || s.sheetType === "signage_schedule",
        );
      if (aggregateCountFastPath) {
        logger.log("[pipeline] Step 9.2 SKIPPED — authoritative aggregate count schedule fast path");
      }
      if (signDetailSheets.length > 0) {
        logger.log(`[pipeline] Step 9.2: Processing ${signDetailSheets.length} sign_details/signage_schedule sheet(s) for specialty sign extraction`);
        // Clear prior specialty signs before re-extracting so rescans don't accumulate duplicates.
        await db.execute(sql`DELETE FROM specialty_signs WHERE job_id = ${jobId}`);
        const specialtyRows: typeof specialtySignsTable.$inferInsert[] = [];

        for (const detailSheet of signDetailSheets) {
          const sheetFile = files.find((f) => f.id === detailSheet.fileId);
          if (!sheetFile) {
            logger.log(`[pipeline] Step 9.2: No file found for sheet ${detailSheet.sheetId} — skipping`);
            continue;
          }
          try {
            // Use the prefetch cache (populated during the batch PNG conversion step)
            // to avoid downloading the PDF again for every specialty sheet.
            const prefetchKey = `${detailSheet.fileId ?? ""}:${detailSheet.pdfPage ?? 1}`;
            let pageBase64 = prefetchedPageBase64.get(prefetchKey) ?? null;
            if (!pageBase64) {
              // Prefetch miss — rasterize on demand (happens when sidecarOk=false or
              // when the sheet was added after the prefetch batch ran). Reuse the
              // Step-2 PDF buffer and cache the result so it is rendered only once.
              logger.log(`[pipeline] Step 9.2: Prefetch miss for ${detailSheet.sheetId} — rasterizing on-demand`);
              const pdfBuf = pdfBufferByFileId.get(sheetFile.id)
                ?? await downloadFromStorage(sheetFile.storagePath);
              const rasterResult = await rasterizePages(
                pdfBuf,
                [detailSheet.pdfPage ?? 1],
                rasterizeDpi,
                sheetFile.filename,
              );
              pageBase64 = rasterResult.pages[0] ?? null;
              if (pageBase64) prefetchedPageBase64.set(prefetchKey, pageBase64);
            }
            if (!pageBase64) {
              logger.log(`[pipeline] Step 9.2: Rasterization returned no page for ${detailSheet.sheetId} — skipping`);
              continue;
            }

            const specialtyPrompt = `You are analyzing an architectural sign detail or specialty finish schedule sheet.
Extract every specialty sign, wallcovering, or graphic element listed on this sheet.
Return a JSON array (no markdown, no code fences). Each object must have:
  "signCode"     : string  — the sign type code or designation (e.g. "WC-1", "G-3", "Type A")
  "description"  : string  — full description of the sign or finish
  "dimensions"   : string | null — dimensions if shown (e.g. "12\\" x 18\\"", "24\\" x 36\\"")
  "material"     : string | null — material or substrate (e.g. "Vinyl", "Aluminum", "Acrylic")
  "finish"       : string | null — finish or color (e.g. "Matte Black", "Brushed Stainless")
  "qty"          : number | null — quantity shown anywhere on the sheet for this item (look for a count column, quantity column, "#", "QTY", or a number next to the item code). Return null only if truly absent.
  "notes"        : string | null — any additional notes or specifications

Return [] if no specialty signs or finish items are found.`;

            const geminiResponse = await timedGenerate({
              model: CLAUDE_SCHEDULE_MODEL,
              contents: [
                {
                  role: "user",
                  parts: [
                    {
                      inlineData: {
                        mimeType: "image/png",
                        data: pageBase64,
                      },
                    },
                    { text: specialtyPrompt },
                  ],
                },
              ],
              config: { temperature: 0.1 },
            });

            const rawText = geminiResponse.text ?? "";
            let extracted: Array<{
              signCode?: string;
              description?: string;
              dimensions?: string | null;
              material?: string | null;
              finish?: string | null;
              qty?: number | null;
              notes?: string | null;
            }> = [];

            try {
              const cleaned = rawText.replace(/^```[a-z]*\n?/i, "").replace(/```$/m, "").trim();
              extracted = JSON.parse(cleaned);
              if (!Array.isArray(extracted)) extracted = [];
            } catch {
              logger.log(`[pipeline] Step 9.2: JSON parse failed for ${detailSheet.sheetId} — raw: ${rawText.slice(0, 200)}`);
            }

            logger.log(`[pipeline] Step 9.2: Extracted ${extracted.length} specialty item(s) from sheet ${detailSheet.sheetId}`);

            for (const item of extracted) {
              if (!item.signCode && !item.description) continue;
              specialtyRows.push({
                id: newId("spsign"),
                jobId,
                tenantId,
                sheetId: detailSheet.id,
                sourceSheetNumber: detailSheet.sheetId ?? null,
                signCode: item.signCode ?? null,
                description: item.description ?? "(no description)",
                dimensions: item.dimensions ?? null,
                material: item.material ?? null,
                finish: item.finish ?? null,
                qty: item.qty ?? null,
                notes: item.notes ?? null,
              });
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.log(`[pipeline] Step 9.2: Failed to extract from sheet ${detailSheet.sheetId}: ${msg}`);
          }
        }

        if (specialtyRows.length > 0) {
          // Delete any prior specialty signs for this job before inserting fresh rows.
          await db.delete(specialtySignsTable).where(eq(specialtySignsTable.jobId, jobId));
          logger.log(`[Step 9.2] Cleared stale specialty_signs for job ${jobId}`);
          await db.insert(specialtySignsTable).values(specialtyRows);
          logger.log(`[pipeline] Step 9.2: Inserted ${specialtyRows.length} specialty sign(s) for job ${jobId}`);
        } else {
          logger.log(`[pipeline] Step 9.2: No specialty sign items found across ${signDetailSheets.length} sheet(s)`);
        }
      } else if (!aggregateCountFastPath && projectSignDictionary && projectSignDictionary.signTypes.length > 0) {
        // No dedicated specialty sheets available. Fall back to the Step B dictionary:
        // insert non-room-id sign types (stair, wayfinding, exit, elevator, other)
        // as specialty rows so the Review tab and XLSX export are not empty.
        const specialtyRows: typeof specialtySignsTable.$inferInsert[] = [];
        const signageSheet = signageSheets[0]; // source sheet for attribution
        for (const t of projectSignDictionary.signTypes) {
          if (!SPECIALTY_CATEGORIES.has(t.category ?? "")) continue;
          // SignTypeDictionaryEntry has no qty/quantity in its interface, but
          // Claude may return those fields as extras in the raw JSON.  Cast to
          // access them defensively so we never silently discard a real count.
          const tExt = t as typeof t & { qty?: number | null; quantity?: number | null };
          specialtyRows.push({
            id: newId("spsign"),
            jobId,
            tenantId,
            sheetId: signageSheet?.id ?? null,
            sourceSheetNumber: signageSheet?.sheetId ?? null,
            signCode: t.code,
            description: t.name,
            dimensions: t.dimensions ?? null,
            material: null,
            finish: null,
            qty: tExt.qty ?? tExt.quantity ?? null,
            notes: `Category: ${t.category ?? "other"}`,
          });
        }
        if (specialtyRows.length > 0) {
          await db.delete(specialtySignsTable).where(eq(specialtySignsTable.jobId, jobId));
          logger.log(`[Step 9.2] Cleared stale specialty_signs for job ${jobId}`);
          await db.insert(specialtySignsTable).values(specialtyRows);
          logger.log(`[pipeline] Step 9.2: Inserted ${specialtyRows.length} specialty sign(s) from Step B dictionary (no sign_details sheets)`);
        } else {
          logger.log(`[pipeline] Step 9.2: Step B dictionary has no specialty categories — skipped`);
        }
      } else {
        logger.log(`[pipeline] Step 9.2: No sign_details/signage_schedule sheets and no Step B dictionary — specialty extraction skipped`);
      }
    }

    // -------------------------------------------------------------------------
    // Step 9.5: Reconciliation
    // Compare detected rooms vs scheduled rows and final sign count vs benchmark.
    // Flags the job as "needs_review" if coverage or count ratios are too low.
    // -------------------------------------------------------------------------
    await wp("9.5", "Reconciliation");

    {
      const detectedRoomCount = roomRecords.length;
      // signSchedule = entries from uploaded sign schedule (0 when no schedule imported)
      const scheduledRowCount = signSchedule.length;
      const authoritativeScheduleSignCount = signSchedule.reduce((sum, entry) => sum + (entry.quantity ?? 1), 0);
      const finalSignCount = hasAuthoritativeCountSchedule
        ? authoritativeScheduleSignCount
        : skipRulesForSchedule
          ? signSchedule.length
          : signRows.length;
      const jobMeta95 = (job.metadata ?? {}) as Record<string, unknown>;
      const benchmarkCount = typeof jobMeta95.benchmarkCount === "number"
        ? jobMeta95.benchmarkCount
        : null;

      const warnings: string[] = [];
      let roomCoverage: number | null = null;

      // Room coverage check is not meaningful for aggregate count schedules:
      // no room extraction is required or expected in that fast path.
      if (hasAuthoritativeCountSchedule) {
        roomCoverage = null;
      } else if (scheduledRowCount > 0) {
        roomCoverage = detectedRoomCount / scheduledRowCount;
        if (roomCoverage < 0.7) {
          warnings.push(
            `Only ${detectedRoomCount} of ${scheduledRowCount} scheduled rooms detected — job may be incomplete`,
          );
        }
      }

      // Benchmark count check — only fires when a benchmark was set on the job
      if (benchmarkCount !== null && finalSignCount < benchmarkCount * 0.6) {
        warnings.push(
          `Sign count (${finalSignCount}) is significantly below benchmark (${benchmarkCount})`,
        );
      }

      // Full reconciliation log
      logger.log(`[Step 9.5] Reconciliation report:`);
      logger.log(`  detectedRooms : ${detectedRoomCount}`);
      logger.log(`  scheduleRows  : ${scheduledRowCount}`);
      logger.log(`  finalSigns    : ${finalSignCount}`);
      logger.log(`  benchmarkCount: ${benchmarkCount ?? "not set"}`);
      logger.log(
        `  roomCoverage  : ${
          roomCoverage !== null
            ? (roomCoverage * 100).toFixed(1) + "%"
            : hasAuthoritativeCountSchedule
              ? "N/A (authoritative aggregate schedule)"
              : "N/A (no schedule import)"
        }`,
      );
      if (warnings.length > 0) {
        for (const w of warnings) {
          logger.warn(`[Step 9.5] ⚠ ${w}`);
        }
        reconciliationNeedsReview = true;
        logger.log(`[Step 9.5] Job flagged needs_review due to ${warnings.length} reconciliation warning(s)`);
      } else {
        logger.log(`[Step 9.5] ✓ No reconciliation issues detected`);
      }

      reconciliationResult = {
        detectedRooms: detectedRoomCount,
        scheduleRows: scheduledRowCount,
        finalSigns: finalSignCount,
        benchmarkCount,
        roomCoverage,
        warnings,
        reconciledAt: new Date().toISOString(),
      };
    }

    // -------------------------------------------------------------------------
    // Step 10: Validation checks + save results
    // -------------------------------------------------------------------------
    await wp(10, "Validating results and generating schedule");

    const checks = ruleOutput ? runValidationChecks(ruleOutput) : [];

    await db.delete(validationResultsTable).where(eq(validationResultsTable.jobId, jobId));
    if (checks.length > 0) {
      await db.insert(validationResultsTable).values(
        checks.map((c) => ({
          id: newId("val"),
          jobId,
          tenantId,
          checkName: c.checkName,
          status: c.status,
          details: c.details,
        })),
      );
    }

    // Save AI scan records
    if (aiScanRecords.length > 0) {
      await db.insert(aiScansTable).values(
        aiScanRecords.map((s) => ({
          id: newId("scan"),
          jobId,
          tenantId,
          callType: s.callType,
          model: s.model,
          inputTokens: s.inputTokens,
          outputTokens: s.outputTokens,
          cost: String(s.cost.toFixed(6)),
        })),
      );
    }

    // -------------------------------------------------------------------------
    // Step 10b: Populate markerX / markerY for signs that still lack them.
    // Covers the schedule-import path where signs are built without room context.
    // -------------------------------------------------------------------------
    const signsWithoutMarkers = await db
      .select({
        id: signsTable.id,
        roomId: signsTable.roomId,
        roomNumber: signsTable.roomNumber,
        message: signsTable.message,
        sheetId: signsTable.sheetId,
      })
      .from(signsTable)
      .where(and(eq(signsTable.jobId, jobId), isNull(signsTable.markerX)));

    if (signsWithoutMarkers.length > 0) {
      // Load all rooms for this job and index by room number.
      const jobRooms = await db
        .select({
          id: roomsTable.id,
          roomNumber: roomsTable.roomNumber,
          coordX: roomsTable.coordX,
          coordY: roomsTable.coordY,
        })
        .from(roomsTable)
        .where(eq(roomsTable.jobId, jobId));

      // Last room wins if there are duplicates — sufficient for marker placement.
      const roomByNumber = new Map<string, typeof jobRooms[0]>();
      for (const room of jobRooms) {
        if (room.roomNumber) roomByNumber.set(room.roomNumber, room);
      }

      let markerUpdates = 0;
      await Promise.all(
        signsWithoutMarkers.map(async (sign) => {
          // Resolve room: prefer existing roomId, else parse room number from message.
          let room = sign.roomId ? jobRooms.find((r) => r.id === sign.roomId) ?? null : null;

          if (!room && sign.message) {
            // Message format: "S1 | 1101 | ROOM NAME"
            const parts = sign.message.split(" | ");
            const roomNumber = parts[1]?.trim();
            if (roomNumber) room = roomByNumber.get(roomNumber) ?? null;
          }

          // Fallback: match via the sign's own roomNumber column.
          // This covers building-suffix room numbers (e.g. 318A, 302A) and any
          // message format that doesn't put the room number at parts[1].
          if (!room && sign.roomNumber) {
            room = roomByNumber.get(sign.roomNumber) ?? null;
          }

          // coordX / coordY are already 0-100000 normalized — use directly as markerX / markerY.
          const mx = room?.coordX != null ? Math.max(0, Math.min(100000, room.coordX)) : null;
          const my = room?.coordY != null ? Math.max(0, Math.min(100000, room.coordY)) : null;

          if (mx != null && my != null) {
            // Matched a room with known coordinates — use them.
            await db
              .update(signsTable)
              .set({ roomId: room!.id, markerX: mx, markerY: my })
              .where(eq(signsTable.id, sign.id));
            markerUpdates++;
          } else if (sign.sheetId) {
            // No room match (or room has no coords) — place at sheet center so the
            // sign appears on the plan rather than being invisible. Position is
            // estimated; the user can move it in the editor.
            const CENTER_X = 50_000;
            const CENTER_Y = 50_000;
            await db
              .update(signsTable)
              .set({ markerX: CENTER_X, markerY: CENTER_Y })
              .where(eq(signsTable.id, sign.id));
            markerUpdates++;
          }
        }),
      );

      logger.log(`[pipeline] Step 10b: Populated markers for ${markerUpdates}/${signsWithoutMarkers.length} sign(s)`);
    }

    // -------------------------------------------------------------------------
    // Pre-completion validation gate
    // -------------------------------------------------------------------------
    const floorPlanSheetCount = sheetDbRows.filter((s) => s.sheetType === "floor_plan").length;
    // Use the vision-confirmed count as the authoritative floor plan count.
    // Fall back to the rules-engine count for jobs processed before this change.
    const effectivePlanCount = Math.max(floorPlanSheetCount, visionConfirmedPlanCount);
    if (effectivePlanCount > 0 && extractedRooms.length === 0 && !hasScheduleImport) {
      const warnMsg =
        `⚠️ No rooms extracted from ${effectivePlanCount} floor plan sheet(s). ` +
        "Check that uploaded PDFs contain floor plans with room labels. " +
        "Egress signs will still be generated.";
      logger.log(`[pipeline] ${warnMsg}`);
      pipelineSteps.push({
        step: "validation_warning",
        label: warnMsg,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 0,
        status: "warning" as unknown as "completed",
      });
      // Continue pipeline — do NOT throw
    }

    // Query live sign counts directly from the database so the summary
    // includes egress signs (inserted separately) and uses the same
    // 0.75 threshold and dismissed-room exclusion as the /counts endpoint.
    const { totalSigns, highConfidence, needsReview } = await computeLiveSignCounts(jobId, tenantId);

    // ── PIPELINE SUMMARY ─────────────────────────────────────────────────────
    {
      const embeddedScheduleOnly = hasScheduleImport && dedicatedSignScheduleFiles.length === 0;
      const dedicatedScheduleUsed = hasScheduleImport && dedicatedSignScheduleFiles.length > 0;

      const pipelineMode = embeddedScheduleOnly
        ? "schedule_import"
        : estimatorSignRows.length > 0
        ? "estimator"
        : "rules_engine";

      const scheduleSuffix = dedicatedScheduleUsed ? "+schedule_whitelist" : "";

      const pipelineReason = embeddedScheduleOnly
        ? "embedded_sign_schedule_used"
        : estimatorSignRows.length > 0
        ? `dictionary_found_with_${projectSignDictionary?.signTypes.length ?? 0}_types${scheduleSuffix}`
        : _signageNotesFound.length === 0
        ? `no_signage_sheet${scheduleSuffix}`
        : !estimatorModeEligible
        ? `dictionary_extraction_failed${scheduleSuffix}`
        : `estimator_returned_empty${scheduleSuffix}`;

      const scopeApplied = restroomOnlyScope
        ? "restroom_only"
        : projectSignDictionary?.scope === "full_building"
        ? "full_building"
        : "none";

      // Name of the signage notes sheet used (A0.x or title-matched).
      const sigNotesSrc = (() => {
        if (_signageNotesFound.length > 0) return _signageNotesFound.join(", ");
        if (projectSignDictionary?.sourceSheet) return projectSignDictionary.sourceSheet;
        return "NONE";
      })();

      logger.log("[PIPELINE SUMMARY]");
      logger.log(`  Mode executed: ${pipelineMode}`);
      logger.log(`  Reason: ${pipelineReason}`);
      logger.log(`  Total signs: ${totalSigns}`);
      logger.log(`  Scope applied: ${scopeApplied}`);
      logger.log(`  Signage notes sheet: ${sigNotesSrc}`);
    }
    // ─────────────────────────────────────────────────────────────────────────
    await wp("summary", "Pipeline summary");

    const completionTime = new Date().toISOString();

    // Finalize the last running step
    if (pipelineSteps.length > 0) {
      const last = pipelineSteps[pipelineSteps.length - 1];
      if (last.status === "running") {
        last.completedAt = completionTime;
        last.durationMs = new Date(completionTime).getTime() - new Date(last.startedAt).getTime();
        last.status = "completed";
      }
    }

    const completedProgress: PipelineProgress = {
      step: TOTAL_STEPS,
      totalSteps: TOTAL_STEPS,
      label: "Completed",
      startedAt,
      stepStartedAt: completionTime,
      estimatedTotalSeconds: _knownSheetCount != null && _knownSheetCount > 0
        ? Math.max(ESTIMATED_TOTAL_SECONDS, _knownSheetCount * ESTIMATED_SECONDS_PER_SHEET)
        : ESTIMATED_TOTAL_SECONDS,
      estimatedSecondsPerSheet: ESTIMATED_SECONDS_PER_SHEET,
      retryLog,
      ...(_aiRetryMax !== undefined && { aiRetryMax: _aiRetryMax }),
      ...(_effectiveBaseDelayMs !== undefined && { effectiveBaseDelayMs: _effectiveBaseDelayMs }),
    };

    await db.update(jobsTable).set({
      status: reconciliationNeedsReview ? "needs_review" : "completed",
      totalSigns,
      highConfidence,
      needsReview,
      hasScheduleImport,
      aiTokenCost: String(totalAiCost.value.toFixed(6)),
      // Only persist what the user explicitly selected — never overwrite with auto-detected value.
      buildingType: job.buildingType ?? null,
      // Preserve pipelineStrategy as scopeFlag so the API always returns the
      // correct strategy after completion (restroom_only overrides any strategy).
      scopeFlag: restroomOnlyScope ? "restroom_only" : pipelineStrategy,
      metadata: {
        progress: completedProgress,
        steps: pipelineSteps,
        pipelineStrategy,
        aiVisionSheetsSkipped: step6SkippedAboveThreshold,
        aiVisionSheetsSkippedTitles: step6SheetResults
          .filter((r) => r.status === "skipped_cap")
          .map((r) => r.sheetId ?? "Unknown"),
        aiScanSummary: {
          cacheHits: step6CacheHits,
          freshScans: step6FreshScans,
          skippedAboveThreshold: step6SkippedAboveThreshold,
          estimatedSavings: parseFloat(step6EstimatedSavings.toFixed(4)),
          capPerRun: effectiveVisionCap,
          capHit: aiVisionCallsThisRun >= effectiveVisionCap,
        },
        processingStartedAt: startedAt,
        timing: getTimingSummary(),
        projectSignDictionary: projectSignDictionary ?? null,
        estimatorModeEligible,
        reconciliation: reconciliationResult,
      },
    }).where(eq(jobsTable.id, jobId));

    // Log coordinate source breakdown across all inserted rooms.
    const coordCounts = extractedRooms.reduce<Record<string, number>>((acc, r) => {
      const src = r.coordSource ?? "pdf_native";
      acc[src] = (acc[src] ?? 0) + 1;
      return acc;
    }, {});
    logger.log(
      `[pipeline] Markers: ${coordCounts["pdf_native"] ?? 0} pdf_native, ` +
      `${(coordCounts["vision_estimated_gemini"] ?? 0) + (coordCounts["vision_estimated"] ?? 0)} vision_estimated, ` +
      `${coordCounts["human_corrected"] ?? 0} human_corrected`
    );

    await syncJobSignCounts(jobId, tenantId);
    logger.log(`[pipeline] Final sign counts synced`);
    logger.log(`[pipeline] Job ${jobId} completed. ${totalSigns} total signs, ${ruleOutput?.results?.length ?? signSchedule.length} sign source record(s). scheduleImport=${hasScheduleImport}`);

  } catch (err) {
    console.error(`[pipeline] Job ${jobId} FAILED:`, err);

    const errorMessage =
      err instanceof Error
        ? err.message
        : typeof err === "string"
        ? err
        : "An unexpected error occurred during processing.";

    // Mark the currently running step as failed
    const now = new Date().toISOString();
    if (pipelineSteps.length > 0) {
      const last = pipelineSteps[pipelineSteps.length - 1];
      if (last.status === "running") {
        last.completedAt = now;
        last.durationMs = new Date(now).getTime() - new Date(last.startedAt).getTime();
        last.status = "failed";
      }
    }

    const errorMetadata: Record<string, unknown> = { errorMessage, failedAt: now, steps: pipelineSteps, processingStartedAt: startedAt, timing: getTimingSummary() };
    if (lastProgress) {
      errorMetadata.progress = lastProgress;
    }

    await db.update(jobsTable)
      .set({ status: "error", metadata: errorMetadata })
      .where(eq(jobsTable.id, jobId));

    throw err;
  }

  } finally {
    logger.log(`[pipeline] materialSpec final: ${jobMaterialSpec ? `substrate="${jobMaterialSpec.substrate}" finishMethod="${jobMaterialSpec.finishMethod}"` : "null"}`);
    if (jobMaterialSpec) {
      await setJobMaterialSpec(jobMaterialSpec);
      logger.log(`[pipeline] Saved materialSpec for job ${jobId}: substrate="${jobMaterialSpec.substrate}" manufacturer="${jobMaterialSpec.manufacturer}"`);
    }
    logger.log(formatTimingSummary(getTimingSummary(), jobId));
    _activePipelineCount--;
    logger.log(
      `[pipeline] Pipeline complete. Active: ${_activePipelineCount}/${MAX_CONCURRENT_PIPELINES}`
    );

    // Persist the full console narrative (all [pipeline]/[timing]/[Step] lines) to
    // the job record so the UI can display it. Uses a JSONB merge so we don't have
    // to re-read the full metadata object.
    const pipelineLog = getLogLines();
    if (pipelineLog.length > 0) {
      await db.update(jobsTable)
        .set({ metadata: sql`${jobsTable.metadata} || ${JSON.stringify({ pipelineLog })}::jsonb` })
        .where(eq(jobsTable.id, jobId))
        .catch((err) => console.error("[pipeline] Failed to save pipelineLog to DB:", err));
    }
  }
}
