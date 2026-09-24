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

import { db } from "@workspace/db";
import {
  jobsTable,
  jobFilesTable,
  jobSheetsTable,
  roomsTable,
  signsTable,
  aiScansTable,
  plaqueScheduleTable,
  validationResultsTable,
  ruleOverridesTable,
  tenantsTable,
  trainingCorrectionsTable,
} from "@workspace/db";
import { eq, and, isNull, isNotNull, inArray } from "drizzle-orm";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { isRateLimitError } from "@workspace/integrations-anthropic-ai/batch";
import { objectStorageClient } from "./objectStorage";
import { newId } from "./ids";
import {
  parseDrawingIndex,
  rasterizePages,
  extractTable,
  extractWords,
  sidecarHealthCheck,
  type SidecarWord,
} from "./sidecar-client";
import {
  applyRules,
  detectBuildingType,
  classifyRoom,
  runValidationChecks,
  type RoomRecord,
} from "./rules-engine";
import {
  rasterizeDpi,
  maxAiVisionCallsPerRun,
  claudeVisionBaseDelayMs,
} from "./config";
import { getTrainingContext } from "./trainingContext";

// ---------------------------------------------------------------------------
// Progress tracking
// ---------------------------------------------------------------------------

export interface RetryEvent {
  attempt: number;
  errorType: string;
  errorMessage: string;
  stepLabel: string;
  timestamp: string;
}

export interface PipelineProgress {
  step: number;
  totalSteps: number;
  label: string;
  startedAt: string;
  stepStartedAt: string;
  estimatedTotalSeconds: number;
  estimatedSecondsPerSheet: number;
  retryLog: RetryEvent[];
  aiRetryMax?: number;
  effectiveBaseDelayMs?: number;
}

export interface Step6SheetResult {
  sheetId: string;
  status:
    | "cached"
    | "fresh_scan"
    | "skipped_threshold"
    | "skipped_cap"
    | "timeout"
    | "skipped_filter";
}

export interface PipelineStepRecord {
  step: number | string;
  label: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  status: "completed" | "running" | "failed";
  sheetResults?: Step6SheetResult[];
}

const TOTAL_STEPS = 10;
const ESTIMATED_TOTAL_SECONDS = 120; // fallback estimate when sheet count is unknown
export const ESTIMATED_SECONDS_PER_SHEET = 30; // per-sheet time estimate used to scale the total

function toNumericStep(step: number | string): number {
  if (typeof step === "number") return step;
  const map: Record<string, number> = {
    "4b": 2.5,
    B: 4.5,
    "8.5": 8.5,
    summary: 10.5,
  };
  return map[step] ?? 0;
}

async function writeProgress(
  jobId: string,
  step: number | string,
  label: string,
  startedAt: string,
  steps: PipelineStepRecord[],
  retryLog: RetryEvent[] = [],
  sheetCount?: number,
  aiRetryMax?: number,
  effectiveBaseDelayMs?: number,
): Promise<PipelineProgress> {
  const now = new Date().toISOString();

  // Finalize the previously running step now that the next one is starting
  if (steps.length > 0) {
    const last = steps[steps.length - 1];
    if (last.status === "running") {
      last.completedAt = now;
      last.durationMs =
        new Date(now).getTime() - new Date(last.startedAt).getTime();
      last.status = "completed";
    }
  }

  // Record this new step as running
  steps.push({ step, label, startedAt: now, status: "running" });

  // Scale the estimate by sheet count when known; fall back to the fixed constant.
  const estimatedTotalSeconds =
    sheetCount != null && sheetCount > 0
      ? Math.max(
          ESTIMATED_TOTAL_SECONDS,
          sheetCount * ESTIMATED_SECONDS_PER_SHEET,
        )
      : ESTIMATED_TOTAL_SECONDS;

  const progress: PipelineProgress = {
    step: toNumericStep(step),
    totalSteps: TOTAL_STEPS,
    label,
    startedAt,
    stepStartedAt: now,
    estimatedTotalSeconds,
    estimatedSecondsPerSheet: ESTIMATED_SECONDS_PER_SHEET,
    retryLog,
    ...(aiRetryMax !== undefined && { aiRetryMax }),
    ...(effectiveBaseDelayMs !== undefined && { effectiveBaseDelayMs }),
  };
  await db
    .update(jobsTable)
    .set({
      metadata: {
        progress,
        steps,
        estimatedSecondsPerSheet: ESTIMATED_SECONDS_PER_SHEET,
        processingStartedAt: startedAt,
      } as Record<string, unknown>,
    })
    .where(eq(jobsTable.id, jobId));
  return progress;
}

// ---------------------------------------------------------------------------
// Object-storage helpers
// ---------------------------------------------------------------------------

// Parse PRIVATE_OBJECT_DIR into its component parts so we can write to the
// same path that ObjectStorageService.getObjectEntityFile() will look for.
// PRIVATE_OBJECT_DIR format: /bucket-name[/optional-prefix]
const _GCS_DIR = (() => {
  const raw = (process.env.PRIVATE_OBJECT_DIR ?? "")
    .replace(/^\//, "")
    .replace(/\/$/, "");
  if (!raw) return null;
  const parts = raw.split("/");
  return {
    bucket: parts[0],
    prefix: parts.slice(1).join("/"), // empty string when no prefix
  };
})();

const GCS_BUCKET = _GCS_DIR?.bucket ?? null;
const GCS_PREFIX = _GCS_DIR?.prefix ?? "";

/**
 * Download a file from GCS using the normalised /objects/ path stored in the DB.
 * Uploaded files live at: <bucket>/<prefix>/<objectPath>
 * (where objectPath = the path after /objects/ in the stored reference)
 */
async function downloadFromStorage(storagePath: string): Promise<Buffer> {
  if (!GCS_BUCKET) throw new Error("PRIVATE_OBJECT_DIR not set");

  // storagePath may be "/objects/uploads/<uuid>" (upload) or "/objects/rasterized/..." (pipeline)
  const entityId = storagePath.replace(/^\/objects\//, "").replace(/^\//, "");
  const gcsPath = GCS_PREFIX ? `${GCS_PREFIX}/${entityId}` : entityId;

  const bucket = objectStorageClient.bucket(GCS_BUCKET);
  const [buf] = await bucket
    .file(gcsPath)
    .download()
    .catch(async () => {
      // Fallback: try with explicit uploads/ prefix (legacy upload path)
      const [alt] = await bucket
        .file(
          GCS_PREFIX
            ? `${GCS_PREFIX}/uploads/${entityId}`
            : `uploads/${entityId}`,
        )
        .download();
      return [alt];
    });
  return buf as Buffer;
}

/**
 * Upload a buffer to GCS at a path that mirrors ObjectStorageService's convention:
 *   GCS path: <prefix>/<path>  (inside the PRIVATE_OBJECT_DIR bucket)
 *   Stored reference: /objects/<path>   (served via GET /storage/objects/<path>)
 *
 * When tenantId is provided the path is stored under a tenant-scoped prefix
 * (tenants/<tenantId>/<path>) so that guest cleanup can sweep all tenant
 * objects with a single bucket prefix listing.
 *
 * getObjectEntityFile("/objects/<path>") resolves to:
 *   <PRIVATE_OBJECT_DIR>/<path>  →  bucket=<GCS_BUCKET>, object=<GCS_PREFIX>/<path>
 */
async function uploadToStorage(
  path: string,
  buffer: Buffer,
  contentType = "image/png",
  tenantId?: string,
): Promise<string> {
  if (!GCS_BUCKET) throw new Error("PRIVATE_OBJECT_DIR not set");

  const scopedPath = tenantId ? `tenants/${tenantId}/${path}` : path;
  const gcsObjectName = GCS_PREFIX ? `${GCS_PREFIX}/${scopedPath}` : scopedPath;
  const bucket = objectStorageClient.bucket(GCS_BUCKET);
  await bucket
    .file(gcsObjectName)
    .save(buffer, { contentType, resumable: false });
  return `/objects/${scopedPath}`;
}

// ---------------------------------------------------------------------------
// Room synonym expansion map
// ---------------------------------------------------------------------------

const ROOM_SYNONYMS: Record<string, string> = {
  VEST: "VESTIBULE",
  VESTIBULE: "VESTIBULE",
  CORR: "CORRIDOR",
  CORRIDOR: "CORRIDOR",
  HALL: "HALLWAY",
  HALLWAY: "HALLWAY",
  STOR: "STORAGE",
  STORAGE: "STORAGE",
  MECH: "MECHANICAL",
  MECHANICAL: "MECHANICAL",
  ELEC: "ELECTRICAL",
  ELECTRICAL: "ELECTRICAL",
  CONF: "CONFERENCE",
  CONFERENCE: "CONFERENCE",
  TLTL: "TOILET",
  TLT: "TOILET",
  TOIL: "TOILET",
  TOILET: "TOILET",
  REST: "RESTROOM",
  RESTROOM: "RESTROOM",
  BLDG: "BUILDING",
  RR: "RESTROOM",
  MRR: "MENS RESTROOM",
  WRR: "WOMENS RESTROOM",
  EMERG: "EMERGENCY",
  EMERGENCY: "EMERGENCY",
  INTERROG: "INTERROGATION",
  INTERROGATION: "INTERROGATION",
};

export function expandSynonyms(roomName: string): string {
  const parts = roomName.toUpperCase().split(/\s+/);
  const expanded = parts.map((p) => ROOM_SYNONYMS[p] ?? p);
  return expanded.join(" ");
}

// ---------------------------------------------------------------------------
// Room name extraction from words
// ---------------------------------------------------------------------------

interface ExtractedRoom {
  roomNumber: string;
  roomName: string;
  x: number;
  y: number;
  pageWidth: number;
  pageHeight: number;
  /** PDF bbox metadata for accurate pixel coordinate conversion. */
  bboxX0?: number;
  bboxY0?: number;
  pageWPts?: number;
  pageHPts?: number;
  /** Set to true for rooms discovered by the AI vision pass (Step 6b). */
  aiVision?: boolean;
  /** Confidence override for AI-vision rooms (stored as string for numeric column). */
  aiConfidence?: string;
  /** isRestroom flag set by AI vision when no classification is available yet. */
  aiIsRestroom?: boolean;
}

// Matches:
//   \d{3}[A-Z]?               residential 3-digit units (103, 204A)
//   1[0-4]\d{2}[A-Z]?(\.\d)?   government floors 1000-1499 with optional alpha/decimal (1101, 1101.1)
//   2[0-4]\d{2}[A-Z]?(\.\d)?   government floors 2000-2499 with optional alpha/decimal (2102, 2102A)
//   [A-Z]{1,2}P?\d?-\d{3}[A-Z]? service rooms (BP1-101, A1-103, SP1-201, EP1-102)
//   [A-Z]\d{3}[A-Z]?           alpha-prefix rooms (A101, B204)
// Does NOT match: 7087 (building#), 2026/2024 (years caught by YEAR_RE), 12345 (5 digits)
export const ROOM_NUMBER_RE =
  /^(\d{3}[A-Z]?|1[0-4]\d{2}[A-Z]?(\.\d)?|2[0-4]\d{2}[A-Z]?(\.\d)?|[A-Z]{1,2}P?\d?-\d{3}[A-Z]?|[A-Z]\d{3}[A-Z]?)$/;

// Used to reject years (2026, 2024, etc.) that could match the digit pattern.
const YEAR_RE = /^(19|20)\d{2}$/;

const IGNORE_WORDS = new Set([
  "THE",
  "AND",
  "OR",
  "OF",
  "A",
  "AN",
  "IN",
  "AT",
  "BY",
  "FOR",
  "N",
  "S",
  "E",
  "W",
  "NE",
  "NW",
  "SE",
  "SW",
  "FT",
  "SF",
  "SQ",
  "FT²",
  "M²",
  "FF",
  "EQ",
  "TYP",
  "SIM",
  "REF",
]);

export function extractRoomsFromWords(
  words: SidecarWord[],
  pageWidth: number,
  pageHeight: number,
): ExtractedRoom[] {
  const rooms: ExtractedRoom[] = [];
  const usedIndices = new Set<number>();

  // Title block exclusion: rightmost 22% and bottom 12% of the page contain
  // the title block (architect name, address, sheet number, copyright) and
  // must be excluded entirely to avoid matching metadata as room numbers.
  const titleBlockXThreshold = pageWidth * 0.78;
  const titleBlockYThreshold = pageHeight * 0.88;

  for (let i = 0; i < words.length; i++) {
    const word = words[i];

    // Must match the room number pattern
    if (!ROOM_NUMBER_RE.test(word.text)) continue;

    // Reject years (2026, 2024, 2023, etc.)
    if (YEAR_RE.test(word.text)) continue;

    if (usedIndices.has(i)) continue;

    const rx0 = word.x0;
    const ry0 = word.y0;

    // Skip words in the title block region
    if (rx0 > titleBlockXThreshold || ry0 > titleBlockYThreshold) continue;

    const roomNumber = word.text;

    // Collect nearby words that form the room name label (full bounding box stored
    // so we can compute a centroid over the entire label group).
    const nearby: Array<{
      text: string;
      x0: number;
      x1: number;
      y0: number;
      y1: number;
    }> = [];
    for (let j = 0; j < words.length; j++) {
      if (j === i || usedIndices.has(j)) continue;
      const w2 = words[j];
      const dy = Math.abs(w2.y0 - ry0);
      const dx = Math.abs(w2.x0 - rx0);

      // Fix 1: Tighter spatial filter — prefer words in the same label group
      // (tight cluster) or very close on the same horizontal line.
      // This prevents grabbing names from adjacent rooms or grid references.
      const tightCluster = dy < 40 && dx < 80;
      const sameLineClose = dy < 15 && dx < 200;
      if ((!tightCluster && !sameLineClose) || ROOM_NUMBER_RE.test(w2.text))
        continue;

      const upper = w2.text.toUpperCase();

      // Fix 2: Filter architectural grid reference text
      // Single capital letters are column/row grid lines (A, B, C … N)
      if (upper.length === 1 && /[A-Z]/.test(upper)) continue;
      // Decimal numbers are grid axis labels (2.2, 4.8, 10.2, etc.)
      if (/^\d+\.\d+$/.test(w2.text)) continue;
      // Small pure integers on plans are usually room-count callouts, not names
      if (/^\d+$/.test(w2.text) && w2.text.length <= 2) continue;

      if (
        !IGNORE_WORDS.has(upper) &&
        !YEAR_RE.test(w2.text) &&
        w2.text.length <= 30 &&
        !/^\d+['"\-\/]/.test(w2.text) // skip dimension annotations like 8'-0"
      ) {
        nearby.push({
          text: upper,
          x0: w2.x0,
          x1: w2.x1,
          y0: w2.y0,
          y1: w2.y1,
        });
      }
    }

    // Sort by x position (left to right) and take up to 5 words
    const sortedNearby = nearby.sort((a, b) => a.x0 - b.x0).map((n) => n.text);

    const rawName = sortedNearby.slice(0, 5).join(" ").trim();

    // Place marker at the centroid of the full label group (room number word +
    // all nearby name words).  The label is typically at the TOP of the room
    // space, so add a downward offset (~3 % of page height) so the marker pin
    // sits inside the room rather than on top of the text.
    const allLabelXs = [
      word.x0,
      word.x1,
      ...nearby.map((w) => w.x0),
      ...nearby.map((w) => w.x1),
    ];
    const allLabelYs = [
      word.y0,
      word.y1,
      ...nearby.map((w) => w.y0),
      ...nearby.map((w) => w.y1),
    ];
    const rx = (Math.min(...allLabelXs) + Math.max(...allLabelXs)) / 2;
    const ry =
      (Math.min(...allLabelYs) + Math.max(...allLabelYs)) / 2 +
      pageHeight * 0.03;

    // Reject if name looks like a street address or copyright notice
    const isAddressLike =
      rawName.includes(",") ||
      /\b(AVE|BLVD|ST\b|RD\b|DR\b|MA\b|NY\b|CA\b|COPYRIGHT|DRAWING|PROJECT|JACOBS|CORPS)\b/.test(
        rawName,
      );
    if (isAddressLike) continue;

    // Normalize coordinates to 0-1000 range (must come before early-exit checks
    // so that the residential-unit push below can reference normX/normY).
    // Clamp to [10, 990] so markers stay within the visible image even when
    // a room's PDF coordinate falls outside the drawn page bounds.
    const normX = Math.max(
      10,
      Math.min(990, Math.round((rx / pageWidth) * 1000)),
    );
    const normY = Math.max(
      10,
      Math.min(990, Math.round((ry / pageHeight) * 1000)),
    );

    // Reject finish material codes that appear near room numbers on residential
    // finish plans (e.g. "WD1", "C4 B3", "A1-420", "C6J", "C1.7").
    // A name is all-codes if every space-separated token is either a letter(s)+digit
    // code (C4, WD1, A1-420) or a pure integer, and the whole string is short.
    const FINISH_CODE_TOKEN = /^[A-Z]{1,3}-?\d|^\d+$/;
    const isAllFinishCodes =
      rawName.length > 0 &&
      rawName.length < 25 &&
      rawName.split(/\s+/).every((w) => FINISH_CODE_TOKEN.test(w));

    // 3-digit room numbers (201, 318…) are residential unit numbers in most projects.
    const isResidentialUnit = /^\d{3}[A-Z]?$/.test(roomNumber);

    if (
      isAllFinishCodes ||
      (isResidentialUnit && rawName.split(/\s+/).length > 4)
    ) {
      // For residential units we still emit the room with a clean "UNIT NNN" label
      // so markers appear on the plan even when no text label is readable.
      if (isResidentialUnit) {
        usedIndices.add(i);
        rooms.push({
          roomNumber,
          roomName: `UNIT ${roomNumber}`,
          x: normX,
          y: normY,
          pageWidth,
          pageHeight,
        });
      }
      continue;
    }

    // For empty names: residential units default to "UNIT NNN", others to "ROOM NNN"
    const roomName = rawName
      ? expandSynonyms(rawName)
      : isResidentialUnit
        ? `UNIT ${roomNumber}`
        : `ROOM ${roomNumber}`;

    usedIndices.add(i);
    rooms.push({
      roomNumber,
      roomName,
      x: normX,
      y: normY,
      pageWidth,
      pageHeight,
    });
  }

  return rooms;
}

// ---------------------------------------------------------------------------
// Estimator mode types
// ---------------------------------------------------------------------------

/** A single sign type entry as extracted from a signage notes sheet. */
export interface SignTypeDictionaryEntry {
  code: string; // "A", "B", "1", "2A", etc.
  name: string; // "Toilet Sign – Girls", "Room ID", etc.
  placement?: string; // "above door", "latch side", "60 inches AFF"
  dimensions?: string;
  category: string; // "restroom" | "room_id" | "exit" | "stair" | "elevator" | "wayfinding" | "other"
}

/** Dictionary extracted from the signage notes sheet for a job. */
export interface ProjectSignDictionary {
  signTypes: SignTypeDictionaryEntry[];
  scope: "restroom_only" | "full_building" | "partial" | "unknown";
  scopeNotes?: string;
  roomLabel?: "ROOM #" | "ROOM NAME" | "both";
  extractedAt?: string;
  sourceSheet?: string;
}

/** One sign assignment returned by the estimator-mode Claude call (Step D). */
interface EstimatorAssignment {
  room_number: string;
  room_name: string;
  sign_type_code: string;
  sign_type_name: string;
  level: string;
  confidence: number;
  reasoning?: string;
}

// ---------------------------------------------------------------------------
// Claude vision helpers
// ---------------------------------------------------------------------------

export const CLAUDE_VISION_MODEL = "claude-sonnet-4-6";
/** Cheaper model used for floor-plan room extraction (high volume, one call per sheet). */
export const CLAUDE_ROOM_EXTRACTION_MODEL = "claude-sonnet-4-6";
export const CLAUDE_VISION_PROVIDER = "Anthropic";

/** Per-model pricing in $/million tokens for cost tracking. */
const MODEL_PRICING: Record<
  string,
  { inputPer1M: number; outputPer1M: number }
> = {
  "claude-sonnet-4-6": { inputPer1M: 3, outputPer1M: 15 },
  "claude-3-5-sonnet-20241022": { inputPer1M: 3, outputPer1M: 15 },
  "claude-3-5-haiku-20241022": { inputPer1M: 0.8, outputPer1M: 4 },
  "claude-3-haiku-20240307": { inputPer1M: 0.25, outputPer1M: 1.25 },
};

/**
 * Default maximum number of retry attempts for a failed AI vision call.
 *
 * Can be overridden per-tenant via the `aiRetryMax` tenant setting (stored in
 * tenantsTable.settings.aiRetryMax) or at the environment level via the
 * CLAUDE_VISION_BASE_DELAY_MS env var for the base delay.
 *
 * Trade-offs:
 *  - Fewer retries (e.g. 1–2) fail faster — good for teams on high-tier API
 *    plans where rate limits are rarely hit and speed matters more.
 *  - More retries (e.g. 8–10) are more resilient to transient rate limits but
 *    can hold a job queue slot much longer on congested plans.
 *  - The default of 3 balances resilience and latency for most plans.
 *
 * Range accepted: 0–10 (values outside this range are clamped at read time).
 * A value of 0 means one initial attempt with no retries on failure.
 */
export const CLAUDE_RETRY_MAX_DEFAULT = 3;

/**
 * Resolve the effective aiRetryMax from tenant settings.
 *
 * Reads `settings.aiRetryMax`, falls back to CLAUDE_RETRY_MAX_DEFAULT when
 * absent or non-numeric, and clamps the result to [0, 10].
 * Exported for unit-testing so the wiring logic can be verified independently
 * of the full processJob pipeline.
 */
export function resolveAiRetryMax(settings: Record<string, unknown>): number {
  const raw =
    typeof settings.aiRetryMax === "number"
      ? settings.aiRetryMax
      : CLAUDE_RETRY_MAX_DEFAULT;
  return Math.max(0, Math.min(10, Math.round(raw)));
}

/**
 * Build the retry options passed to every AI call in the pipeline.
 *
 * Encapsulates the full threading from tenant settings (maxRetries) and the
 * server-level env config (baseDelayMs) into a single object that all
 * `callClaudeVision` call sites receive.
 *
 * Exported so that a unit test can assert: given these tenant settings, this
 * is the exact `{ maxRetries, baseDelayMs }` that will be forwarded to every
 * AI call — without needing to run the full processJob pipeline.
 */
export function buildAiCallOptions(tenantSettings: Record<string, unknown>): {
  maxRetries: number;
  baseDelayMs: number;
} {
  return {
    maxRetries: resolveAiRetryMax(tenantSettings),
    baseDelayMs: claudeVisionBaseDelayMs,
  };
}

interface ClaudeUsage {
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

// ---------------------------------------------------------------------------
// Retry helpers for transient AI errors
// ---------------------------------------------------------------------------

/**
 * Module-level fallback constants — used when no per-call overrides are given.
 * Prefer passing explicit values via callClaudeVision() parameters so that
 * tenant settings and environment config are respected.
 *
 * CLAUDE_VISION_MAX_RETRIES  — total attempts (1 original + N-1 retries).
 * claudeVisionBaseDelayMs — starting back-off delay in ms; doubles each retry
 *   up to CLAUDE_VISION_MAX_DELAY_MS.  Read from CLAUDE_VISION_BASE_DELAY_MS
 *   env var at startup via config.ts (default 5 000 ms).
 */
const CLAUDE_VISION_MAX_RETRIES = CLAUDE_RETRY_MAX_DEFAULT;
export const CLAUDE_VISION_MAX_DELAY_MS = 64_000;

/**
 * Compute the worst-case total retry wait time (no jitter) for the given
 * base delay and retry count, mirroring the exponential back-off policy used
 * in callClaudeVision (delay doubles each attempt, capped at capMs).
 *
 * With maxRetries attempts total, there are (effectiveMaxRetries - 1) waits
 * because no sleep occurs after the final failed attempt.
 */
export function computeMaxRetryWaitMs(
  baseDelayMs: number,
  maxRetries: number,
  capMs: number = CLAUDE_VISION_MAX_DELAY_MS,
): number {
  const effectiveMaxRetries = Math.max(1, maxRetries);
  let total = 0;
  let delay = baseDelayMs;
  for (let attempt = 1; attempt < effectiveMaxRetries; attempt++) {
    total += Math.min(delay, capMs);
    delay = Math.min(delay * 2, capMs);
  }
  return total;
}

function classifyApiError(err: unknown): string {
  if (isRateLimitError(err)) return "rate_limit";
  const msg = String(err instanceof Error ? err.message : err).toLowerCase();
  if (
    msg.includes("rate_limit") ||
    msg.includes("rate limit") ||
    msg.includes("429")
  )
    return "rate_limit";
  if (msg.includes("overload") || msg.includes("529") || msg.includes("503"))
    return "overload";
  if (
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("etimedout")
  )
    return "timeout";
  if (
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("socket hang up") ||
    msg.includes("network") ||
    msg.includes("enotfound")
  )
    return "network";
  if (
    msg.includes("500") ||
    msg.includes("502") ||
    msg.includes("504") ||
    msg.includes("internal server error")
  )
    return "server_error";
  return "api_error";
}

export async function callClaudeVision(
  systemPrompt: string,
  userPrompt: string,
  imageBase64: string,
  mediaType: "image/png" | "image/jpeg" = "image/png",
  onRetry?: (
    attempt: number,
    errorType: string,
    errorMessage: string,
  ) => Promise<void>,
  maxRetries: number = CLAUDE_VISION_MAX_RETRIES,
  baseDelayMs: number = claudeVisionBaseDelayMs,
  model: string = CLAUDE_VISION_MODEL,
): Promise<{ text: string; usage: ClaudeUsage }> {
  // Clamp to at least 1 so the loop always runs one initial attempt.
  // A caller-supplied value of 0 means "one attempt, no retries on failure."
  const effectiveMaxRetries = Math.max(1, maxRetries);

  let lastError: unknown;
  let delay = baseDelayMs;
  for (let attempt = 1; attempt <= effectiveMaxRetries; attempt++) {
    try {
      const response = await anthropic.messages.create({
        model,
        max_tokens: 8192,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: mediaType,
                  data: imageBase64,
                },
              },
              { type: "text", text: userPrompt },
            ],
          },
        ],
      });

      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { type: "text"; text: string }).text)
        .join("\n");
      const inputTokens = response.usage.input_tokens;
      const outputTokens = response.usage.output_tokens;
      const pricing = MODEL_PRICING[model] ?? {
        inputPer1M: 3,
        outputPer1M: 15,
      };
      const cost =
        (inputTokens / 1_000_000) * pricing.inputPer1M +
        (outputTokens / 1_000_000) * pricing.outputPer1M;

      return { text, usage: { inputTokens, outputTokens, cost } };
    } catch (err) {
      lastError = err;
      const errorType = classifyApiError(err);
      const errorMessage = err instanceof Error ? err.message : String(err);

      const isRetryable = [
        "rate_limit",
        "overload",
        "timeout",
        "network",
        "server_error",
      ].includes(errorType);
      if (!isRetryable || attempt === effectiveMaxRetries) throw err;

      if (onRetry) {
        await onRetry(attempt, errorType, errorMessage.slice(0, 300));
      }

      // Exponential back-off with 30% jitter, capped at CLAUDE_VISION_MAX_DELAY_MS
      const jitter = Math.floor(Math.random() * delay * 0.3);
      const waitMs = Math.min(delay + jitter, CLAUDE_VISION_MAX_DELAY_MS);
      await new Promise((res) => setTimeout(res, waitMs));
      delay = Math.min(delay * 2, CLAUDE_VISION_MAX_DELAY_MS);
    }
  }

  throw lastError;
}

// ---------------------------------------------------------------------------
// Plaque schedule extraction
// ---------------------------------------------------------------------------

interface PlaqueEntry {
  typeId: string;
  name: string;
  braille: boolean;
  hasInsert: boolean;
  insertSize?: string;
  letterHeight?: string;
  mapsToColumn?: string;
  materialNotes?: string;
}

async function extractPlaqueSchedule(
  imageBase64: string,
  onRetry?: (
    attempt: number,
    errorType: string,
    errorMessage: string,
  ) => Promise<void>,
  maxRetries?: number,
  baseDelayMs?: number,
): Promise<{ entries: PlaqueEntry[]; usage: ClaudeUsage }> {
  const { text, usage } = await callClaudeVision(
    "You are an expert architectural sign takeoff assistant. Extract plaque schedule data accurately.",
    `Analyze this architectural drawing image. Look for a plaque schedule, sign schedule, or door hardware schedule table.
Extract each plaque type with:
- type_id: the plaque identifier (A, B, C, EXIT, etc.)
- name: the full description
- braille: true/false
- has_insert: true/false if it takes an insert panel
- insert_size: dimensions if applicable
- letter_height: letter height specification
- maps_to_column: which sign column it maps to (Room ID, Restroom, Exit, etc.)
- material_notes: finish, material specifications

Return a JSON array of objects. If no schedule is visible, return [].
Example: [{"type_id": "A", "name": "Room ID Plaque", "braille": true, "has_insert": false}]`,
    imageBase64,
    "image/png",
    onRetry,
    maxRetries,
    baseDelayMs,
  );

  let entries: PlaqueEntry[] = [];
  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const raw = JSON.parse(jsonMatch[0]) as Array<Record<string, unknown>>;
      entries = raw
        .map((e) => ({
          typeId: String(e.type_id ?? e.typeId ?? ""),
          name: String(e.name ?? ""),
          braille: Boolean(e.braille),
          hasInsert: Boolean(e.has_insert ?? e.hasInsert),
          insertSize: e.insert_size ? String(e.insert_size) : undefined,
          letterHeight: e.letter_height ? String(e.letter_height) : undefined,
          mapsToColumn: e.maps_to_column ? String(e.maps_to_column) : undefined,
          materialNotes: e.material_notes
            ? String(e.material_notes)
            : undefined,
        }))
        .filter((e) => e.typeId);
    }
  } catch {
    // Claude couldn't parse — return empty
  }

  return { entries, usage };
}

// ---------------------------------------------------------------------------
// Occupant load extraction
// ---------------------------------------------------------------------------

interface OccupantLoadEntry {
  roomNumber: string;
  occupantLoad: number;
  occupancyGroup?: string;
}

async function extractOccupantLoads(
  imageBase64: string,
  onRetry?: (
    attempt: number,
    errorType: string,
    errorMessage: string,
  ) => Promise<void>,
  maxRetries?: number,
  baseDelayMs?: number,
): Promise<{ entries: OccupantLoadEntry[]; usage: ClaudeUsage }> {
  const { text, usage } = await callClaudeVision(
    "You are an expert architectural sign takeoff assistant. Extract occupant load data accurately.",
    `Analyze this architectural drawing. Look for an occupant load table, code analysis table, or occupancy schedule.
Extract each room's:
- room_number: the room number (e.g., "101", "135")
- occupant_load: integer occupant load (number of persons)
- occupancy_group: IBC occupancy group if shown (A-1, A-2, A-3, B, E, I-1, I-2, R-1, R-2, S-1, etc.)

Return a JSON array. If no occupant load table is visible, return [].
Example: [{"room_number": "138", "occupant_load": 75, "occupancy_group": "A-2"}]`,
    imageBase64,
    "image/png",
    onRetry,
    maxRetries,
    baseDelayMs,
  );

  let entries: OccupantLoadEntry[] = [];
  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const raw = JSON.parse(jsonMatch[0]) as Array<Record<string, unknown>>;
      entries = raw
        .map((e) => ({
          roomNumber: String(e.room_number ?? e.roomNumber ?? ""),
          occupantLoad:
            parseInt(String(e.occupant_load ?? e.occupantLoad ?? "0")) || 0,
          occupancyGroup: e.occupancy_group
            ? String(e.occupancy_group)
            : undefined,
        }))
        .filter((e) => e.roomNumber && e.occupantLoad >= 0);
    }
  } catch {
    // ignore
  }

  return { entries, usage };
}

// ---------------------------------------------------------------------------
// Step 6b: AI vision room verification helpers
// ---------------------------------------------------------------------------

interface MissedRoom {
  roomNumber: string;
  roomName: string;
  level: string;
  x?: number;
  y?: number;
  isRestroom?: boolean;
}

interface VisionResponse {
  isPlanView: boolean;
  floorLevel?: string | null;
  missedRooms: MissedRoom[];
}

/** Threshold: run vision on a sheet only if it has fewer than this many rooms extracted
 *  by the deterministic rules engine. At 3, vision fills in sheets that have very few
 *  confirmed rooms. A job-level visionThreshold override can raise or lower this. */
export const MIN_ROOMS_PER_SHEET_FOR_VISION = 3;

/** Confidence assigned to rooms discovered via AI vision. */
const AI_VISION_CONFIDENCE = "0.65";

/**
 * Converts a raw level string from Claude or the sheet title into a canonical
 * architectural floor label (e.g. "Basement", "Level 1", "Level 2").
 * Returns null when the sources contain no recognisable floor keyword so
 * the caller can fall back to whatever the sheet metadata says.
 */
function parseLevelFromContext(
  rawLevel: string | null,
  sheetTitle: string | null,
  roomNumber?: string | null,
): string | null {
  const sources = [rawLevel, sheetTitle]
    .filter(Boolean)
    .map((s) => s!.toUpperCase());

  // Pass 1 — keyword match from level string or sheet title
  for (const src of sources) {
    if (
      src.includes("BASEMENT") ||
      src.includes("B1") ||
      src.includes("LOWER LEVEL")
    )
      return "Basement";
    if (
      src.includes("GROUND") ||
      src.includes("GRADE") ||
      src.includes("LEVEL 1") ||
      src.includes("1ST")
    )
      return "Level 1";
    if (
      src.includes("LEVEL 2") ||
      src.includes("2ND") ||
      src.includes("SECOND")
    )
      return "Level 2";
    if (src.includes("LEVEL 3") || src.includes("3RD") || src.includes("THIRD"))
      return "Level 3";
    if (src.includes("MEZZANINE") || src.includes("MEZZ")) return "Mezzanine";
    if (src.includes("ROOF")) return "Roof";
  }

  // Pass 2 — room number prefix fallback.
  // Standard convention: 0xx/00x = Basement, 1xx = Level 1, 2xx = Level 2, etc.
  // Also handles B-prefix (B01, BS-1) and P-prefix (P1, P-2) for parking/basement.
  if (roomNumber) {
    const rn = roomNumber.trim().toUpperCase();
    if (/^0/.test(rn)) return "Basement";
    if (/^1/.test(rn)) return "Level 1";
    if (/^2/.test(rn)) return "Level 2";
    if (/^3/.test(rn)) return "Level 3";
    if (/^4/.test(rn)) return "Level 4";
    if (/^[BS]-?\d/.test(rn)) return "Basement";
    if (/^[P]-?\d/.test(rn)) return "Parking";
  }

  return null;
}

function buildRoomExtractionPrompt(
  sheetTitle: string | null,
  level: string | null,
  trainingContext = "",
): { systemPrompt: string; userPrompt: string } {
  const systemPrompt =
    "You are a construction document analyst. Return only valid JSON — no explanations. Return coordinates relative to the floor plan area only, ignoring any schedule tables or legends on the same sheet.";

  const userPrompt = `You are reading a floor plan sheet${sheetTitle ? ` titled "${sheetTitle}"` : ""}${level ? ` for level "${level}"` : ""}.

Your task: locate every ADA room identification sign mounting position by finding door symbols.

Step 1 — Find door swing symbols.
A door on an architectural floor plan is drawn as a thin straight line (the door slab) meeting a wall at one end, plus a quarter-circle arc whose center is the hinge point and whose radius equals the door width. Look for these arc-and-line pairs. Every such symbol is a real door.

Step 2 — Associate each door with the nearest room.
For each door, identify the room number and room name whose label text is closest to that door. The label is usually printed inside the room polygon near its geometric center, but use it only to name the room — do NOT place the coordinate there.

Step 3 — Place the coordinate at the door, not the room center.
The x/y must be placed at the point where the door slab meets the wall (i.e. the latch/strike jamb corner of the opening, on the wall face). This is where an ADA room ID sign is physically mounted. Do NOT use the room label centroid.

Include every door that leads into a named room or numbered space (offices, conference rooms, restrooms, mechanical rooms, stairwells, etc.). Exclude:
- Doors inside the title block or legend panel
- Doors with no identifiable adjacent room (pure corridor openings with no label)
- Overhead door symbols (loading docks) — these are parallel lines, not arc-and-line

Include ALL named rooms visible on the plan regardless of size — utility rooms, storage rooms, IDF/telecom rooms, custodial rooms, mechanical rooms, and any room with a visible label and number even if no door swing arc is visible. A room label with a number is sufficient — a door arc is not required.

Before you begin, assess whether this sheet shows an overhead (plan-view) floor plan:
- isPlanView = true  if the sheet shows an overhead layout of rooms with wall polygons and door symbols (quarter-circle arcs)
- isPlanView = false if the sheet is an elevation, section, detail, schedule table, or any other non-plan view

CRITICAL — identify the architectural floor level from the drawing title block, legend, or sheet notes.
Look for text such as "BASEMENT PLAN", "LEVEL 1 FLOOR PLAN", "GROUND FLOOR", "2ND FLOOR PLAN", "SECOND FLOOR", etc.
Return the canonical floor level in the "floorLevel" field using ONLY these exact string values:
  "Basement"   — basement / lower level / sub-grade / B1
  "Level 1"    — ground floor / first floor / grade level / 1st floor
  "Level 2"    — second floor / 2nd floor
  "Level 3"    — third floor / 3rd floor
  "Mezzanine"  — mezzanine / mezz level
  "Roof"       — roof level / rooftop
Do NOT use page numbers, sheet IDs, or any other value. Return null if you cannot determine the floor level from the drawing content.

Return valid JSON only:
{
  "isPlanView": true,
  "floorLevel": "Level 1",
  "missedRooms": [
    {
      "roomNumber": "101",
      "roomName": "CONFERENCE ROOM",
      "level": "${level || "1"}",
      "x": 23,
      "y": 67,
      "isRestroom": false
    }
  ]
}

Field rules:
- isPlanView: true only if the sheet shows an overhead floor plan view with room outlines and door swing arcs; false for elevations, sections, details, schedules
- floorLevel: canonical floor name from the title block — one of "Basement", "Level 1", "Level 2", "Level 3", "Mezzanine", "Roof", or null
- x / y: integer percentage of the image dimensions, 0–100. (0,0) = top-left corner, (100,100) = bottom-right corner. Place at the wall-face strike-jamb corner of the door opening. Formula: x = round(pixelX / imageWidth * 100), y = round(pixelY / imageHeight * 100)

IMPORTANT: If the sheet contains a sign schedule table, legend panel, or any non-floor-plan content occupying a portion of the image, place coordinates ONLY within the floor plan boundary. Do not place any coordinate in the schedule/legend area. The floor plan is the overhead room layout with wall polygons — coordinates must reference door positions within that area only.

- isRestroom: true only for bathrooms / restrooms / toilet rooms
- roomNumber: copy the room number EXACTLY as printed on the plan — do not infer, increment, or guess. If a number is partially obscured, use only the digits/letters you can clearly read. Never generate a room number that is not explicitly visible on the plan. Use "" only if no number is visible at all.
- roomName: copy the room label text exactly as printed on the plan; use "ROOM" if no name label is visible; required field — never omit
- level: use "${level || "LEVEL 1"}"
- If isPlanView is false or the sheet has no identifiable rooms or no door symbols: {"isPlanView": false, "floorLevel": null, "missedRooms": []}${trainingContext ? `\n\n${trainingContext}` : ""}`;

  return { systemPrompt, userPrompt };
}

// ---------------------------------------------------------------------------
// Signage schedule table parser (Step 4b)
// ---------------------------------------------------------------------------

const SCHEDULE_TYPE_MAP: Record<string, string> = {
  BB2A: "Room ID",
  BB2B: "Room ID w/insert",
  BB2C: "Conference",
  BB2D: "Occupancy(MaxCapacity)",
  BB2E: "Egress(Emergency)",
  BB3: "Stair(Landing)",
  BB4: "Exit(Tactile)",
  BB5: "Entry(Building)",
  BB7A: "Restroom(Men)",
  BB7B: "Restroom(Women)",
  SS1A: "Stair ID",
  AA1: "Directory(Building)",
  AA2: "Directory(Floor)",
  AA3: "Directory(Floor)",
  DD1: "Regulatory(NoSmoking)",
  LED: "LED(Programmable)",
  BB6: "Evac Map",
};

interface ScheduleRow {
  signIdentifier: string;
  roomNumber: string;
  roomName: string;
  signType: string;
  verbage: string;
  detailRef: string;
}

/**
 * Returns true if a sheet should receive an AI vision scan in Step 3.
 *
 * Positive whitelist (scan these):
 *   A-1XX, A-2XX, A-3XX  — floor plans with rooms and doors
 *   A-7XX                 — sign schedule sheets
 *
 * Everything else is text-extraction-only. Additionally, any sheet whose
 * title contains the listed keywords is skipped even if its ID would
 * otherwise qualify (except A-7XX sign-schedule sheets, which are exempt
 * from the SCHEDULE keyword block).
 */
/**
 * Pass 1 of the two-pass sheet classifier.
 *
 * Returns false for sheets that can NEVER be overhead floor plans regardless
 * of their visual content — i.e. structural/MEP discipline prefixes and title
 * keywords that describe a geometrically different drawing type.
 *
 * Everything else returns true and proceeds to Pass 2: the AI vision model
 * sets isPlanView=true/false in the response JSON to make the final call.
 * This means sheets with titles like "FOR FINISH SCHEDULE" or
 * "POWER, COMMUNICATION & LAMP LIGHTING PLAN" are not pre-blocked; the model
 * inspects the actual image and decides.
 */
export function shouldRunVisionScan(
  sheetId: string,
  sheetTitle: string | null,
): boolean {
  const id = sheetId.trim().toUpperCase();
  const title = (sheetTitle ?? "").toUpperCase();

  // Hard-block by sheet number — always administrative/cover sheets.
  const EXCLUDED_SHEET_IDS = [
    "A-001",
    "A001",
    "A-002",
    "A002",
    "A-003",
    "A003",
  ];
  if (EXCLUDED_SHEET_IDS.includes(id)) return false;

  // Hard-block by discipline prefix — structural, mechanical, electrical,
  // plumbing, civil, and fire-protection drawings are never floor plans.
  const EXCLUDED_PREFIXES = ["S-", "M-", "E-", "P-", "C-", "FP-"];
  if (EXCLUDED_PREFIXES.some((pfx) => id.startsWith(pfx))) return false;

  // Hard-block by title keyword — drawing types that are geometrically or
  // semantically impossible to be an overhead floor plan view.
  // These are blocked unconditionally regardless of other title words.
  const ALWAYS_EXCLUDE_TITLE = [
    "ELEVATION", // vertical wall projection
    "SECTION", // vertical building cross-section
    "EGRESS", // egress path / life-safety diagram
    "ACCESSORY LEGEND", // symbol/legend key page
    "LIGHT FIXTURE SCHEDULE", // MEP fixture data table
    "BATHROOM FINISH", // finish annotation, not a plan view
    "DRAWING INDEX", // sheet list cover page
    "SYMBOL LEGEND", // drawing symbol key
    "ABBREVIATIONS", // text-only abbreviation list
    "SPECIFICATIONS", // written specification section
    "CODE ANALYSIS", // code compliance text
    "LIFE SAFETY NOTES", // text-only life-safety narrative
    "PLUMBING FIXTURE SCHEDULE", // fixture count table
    "LIGHTING SCHEDULE", // electrical lighting data table
    "LIGHTING PLAN", // electrical lighting layout
    "ELECTRICAL SCHEDULE", // electrical panel/load schedule
    "PLUMBING SCHEDULE", // plumbing fixture schedule
    "MECHANICAL SCHEDULE", // HVAC/mechanical equipment table
    "REFLECTED CEILING", // RCP — not an overhead floor plan
    "FINISH PLAN", // interior finish annotation plan
    "FURNITURE PLAN", // FF&E layout, no room-name labels
    "POWER PLAN", // electrical power layout
    "DATA PLAN", // low-voltage/data layout
  ];
  if (ALWAYS_EXCLUDE_TITLE.some((kw) => title.includes(kw))) return false;

  // Conditional block — excluded UNLESS "PLAN" also appears in the title.
  // Handles edge cases where these words appear in floor plan annotations
  // (e.g. "FOR FINISH SCHEDULE" vs. pure "FINISH SCHEDULE" data table).
  const EXCLUDE_UNLESS_PLAN = [
    "GENERAL NOTES", // text spec page, but "GENERAL NOTES ON PLAN" is possible
    "FINISH SCHEDULE", // data table, but "FOR FINISH SCHEDULE" may annotate a plan
    "DOOR SCHEDULE", // door data table, rarely annotated on a plan view
    "WINDOW SCHEDULE", // window data table
  ];
  if (
    EXCLUDE_UNLESS_PLAN.some((kw) => title.includes(kw)) &&
    !title.includes("PLAN")
  )
    return false;

  // Everything else is a visual candidate — let the vision model decide via
  // isPlanView. This covers A-1XX/2XX/3XX, A-7XX, and any other sheet whose
  // title is ambiguous or non-standard.
  return true;
}

/**
 * Returns a human-readable reason why a sheet is excluded from vision scanning,
 * or null if the sheet passes all filters (i.e. shouldRunVisionScan = true).
 * Must stay in sync with the keyword lists in shouldRunVisionScan.
 */
export function getExclusionReason(
  sheetId: string,
  sheetTitle: string | null,
): string | null {
  const id = sheetId.trim().toUpperCase();
  const title = (sheetTitle ?? "").toUpperCase();

  const EXCLUDED_SHEET_IDS = [
    "A-001",
    "A001",
    "A-002",
    "A002",
    "A-003",
    "A003",
  ];
  if (EXCLUDED_SHEET_IDS.includes(id)) return `administrative sheet id (${id})`;

  const EXCLUDED_PREFIXES = ["S-", "M-", "E-", "P-", "C-", "FP-"];
  const matchedPrefix = EXCLUDED_PREFIXES.find((pfx) => id.startsWith(pfx));
  if (matchedPrefix)
    return `non-architectural discipline prefix "${matchedPrefix}"`;

  const ALWAYS_EXCLUDE_TITLE = [
    "ELEVATION",
    "SECTION",
    "EGRESS",
    "ACCESSORY LEGEND",
    "LIGHT FIXTURE SCHEDULE",
    "BATHROOM FINISH",
    "DRAWING INDEX",
    "SYMBOL LEGEND",
    "ABBREVIATIONS",
    "SPECIFICATIONS",
    "CODE ANALYSIS",
    "LIFE SAFETY NOTES",
    "PLUMBING FIXTURE SCHEDULE",
    "LIGHTING SCHEDULE",
    "LIGHTING PLAN",
    "ELECTRICAL SCHEDULE",
    "PLUMBING SCHEDULE",
    "MECHANICAL SCHEDULE",
    "REFLECTED CEILING",
    "FINISH PLAN",
    "FURNITURE PLAN",
    "POWER PLAN",
    "DATA PLAN",
  ];
  const matchedKw = ALWAYS_EXCLUDE_TITLE.find((kw) => title.includes(kw));
  if (matchedKw) return `title contains hard-exclude keyword "${matchedKw}"`;

  const EXCLUDE_UNLESS_PLAN = [
    "GENERAL NOTES",
    "FINISH SCHEDULE",
    "DOOR SCHEDULE",
    "WINDOW SCHEDULE",
  ];
  const matchedCond = EXCLUDE_UNLESS_PLAN.find((kw) => title.includes(kw));
  if (matchedCond && !title.includes("PLAN"))
    return `title contains "${matchedCond}" without "PLAN" qualifier`;

  return null; // passes filter
}

function mapScheduleSignType(rawType: string): string {
  const normalized = rawType.trim().toUpperCase().replace(/\s+/g, "");
  return SCHEDULE_TYPE_MAP[normalized] ?? rawType.trim();
}

interface ColumnGroup {
  signCol: number;
  roomNumCol: number;
  roomNameCol: number;
  verbageCol: number;
  typeCol: number;
  detailCol: number;
}

function findColumnGroups(headerRow: string[]): ColumnGroup[] {
  const normalized = headerRow.map((c) =>
    c
      .trim()
      .toUpperCase()
      .replace(/[\n\r]+/g, " "),
  );
  const groups: ColumnGroup[] = [];

  // Find ALL "SIGN" column positions in the header (handles dual-column layouts)
  const signCols: number[] = [];
  for (let i = 0; i < normalized.length; i++) {
    const c = normalized[i];
    if (
      c === "SIGN" ||
      c.startsWith("SIGN ") ||
      c === "SIGN NO" ||
      c === "SIGN NO."
    ) {
      signCols.push(i);
    }
  }

  for (const signCol of signCols) {
    // Search in the range from this SIGN col to the next SIGN col (or end)
    const nextSignCol = signCols.find((s) => s > signCol) ?? normalized.length;
    const range = normalized.slice(signCol, nextSignCol);

    const localIdx = (pred: (c: string) => boolean) => {
      const i = range.findIndex(pred);
      return i >= 0 ? signCol + i : -1;
    };

    const roomNumCol =
      localIdx((c) => /ROOM.*(NUMBER|NUM|NO\.?$)/.test(c)) !== -1
        ? localIdx((c) => /ROOM.*(NUMBER|NUM|NO\.?$)/.test(c))
        : localIdx((c) => c.startsWith("ROOM") && !c.includes("NAME"));
    const roomNameCol = localIdx(
      (c) => c.includes("ROOM NAME") || c === "ROOM NAME",
    );
    const verbageCol = localIdx((c) => /VERB(A|I)GE|MESSAGE/.test(c));
    const typeCol = localIdx(
      (c) =>
        c === "TYPE" ||
        c === "SIGN TYPE" ||
        c === "TYPE NO" ||
        c === "TYPE NO.",
    );
    const detailCol = localIdx((c) => c.includes("DETAIL"));

    if (typeCol >= 0) {
      groups.push({
        signCol,
        roomNumCol,
        roomNameCol,
        verbageCol,
        typeCol,
        detailCol,
      });
    }
  }

  return groups;
}

function parseScheduleTableRows(tables: string[][][]): ScheduleRow[] {
  const rows: ScheduleRow[] = [];

  for (const table of tables) {
    let columnGroups: ColumnGroup[] = [];
    let dataStartIdx = 0;

    // Find header row (first row containing a "SIGN" cell within first 5 rows)
    for (let i = 0; i < Math.min(5, table.length); i++) {
      const groups = findColumnGroups(table[i]);
      if (groups.length > 0) {
        columnGroups = groups;
        dataStartIdx = i + 1;
        break;
      }
    }

    if (columnGroups.length === 0) continue;

    for (let i = dataStartIdx; i < table.length; i++) {
      const row = table[i];

      for (const g of columnGroups) {
        const signId = row[g.signCol]?.trim() ?? "";
        // Skip blank rows and repeated headers
        if (!signId || /^SIGN$/i.test(signId)) continue;

        const rawType = row[g.typeCol]?.trim() ?? "";
        if (!rawType) continue;

        rows.push({
          signIdentifier: signId,
          roomNumber:
            g.roomNumCol >= 0 ? (row[g.roomNumCol]?.trim() ?? "") : "",
          roomName:
            g.roomNameCol >= 0 ? (row[g.roomNameCol]?.trim() ?? "") : "",
          signType: mapScheduleSignType(rawType),
          verbage: g.verbageCol >= 0 ? (row[g.verbageCol]?.trim() ?? "") : "",
          detailRef: g.detailCol >= 0 ? (row[g.detailCol]?.trim() ?? "") : "",
        });
      }
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

export async function processJob(
  jobId: string,
  tenantId: string,
  options?: { forceAiRescan?: boolean; forceRescanSheetIds?: string[] },
): Promise<void> {
  const logger = console;
  const ENABLE_TWO_PASS = process.env.ENABLE_TWO_PASS !== "false"; // opt-OUT (on by default) — set ENABLE_TWO_PASS=false to disable

  // Hard ceiling for any single pipeline step that has async IO.
  // Any step that exceeds this is aborted and the pipeline continues
  // with whatever partial results have accumulated up to that point.
  const STEP_TIMEOUT_MS = 60_000;

  // Races `fn` against a 60-second deadline.  If the deadline fires first,
  // `fn` is abandoned in place (its promise is still running but its result
  // is discarded) and the pipeline moves on.  Any error thrown by `fn` is
  // logged as a warning rather than re-thrown so the pipeline stays alive.
  async function withStepTimeout(
    label: string,
    fn: () => Promise<void>,
  ): Promise<void> {
    let timedOut = false;
    await Promise.race([
      fn().catch((err: unknown) => {
        logger.warn(
          `[pipeline] ${label} error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }),
      new Promise<void>((resolve) => {
        setTimeout(() => {
          timedOut = true;
          resolve();
        }, STEP_TIMEOUT_MS);
      }),
    ]);
    if (timedOut) {
      logger.warn(
        `[pipeline] ${label} timed out after ${STEP_TIMEOUT_MS / 1000}s — continuing with partial results`,
      );
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
    lastProgress = await writeProgress(
      jobId,
      step,
      label,
      startedAt,
      pipelineSteps,
      retryLog,
      _knownSheetCount,
      _aiRetryMax,
      _effectiveBaseDelayMs,
    );
  }

  // Lightweight mid-step flush used by the Step 6 loop to persist incremental
  // per-sheet results without starting a new step or altering step sequencing.
  async function flushStep6Progress(
    partialResults: Step6SheetResult[],
  ): Promise<void> {
    const step6Record = pipelineSteps.find((s) => s.step === 6);
    if (!step6Record) return;
    step6Record.sheetResults = [...partialResults];
    const estimatedTotalSeconds =
      _knownSheetCount != null && _knownSheetCount > 0
        ? Math.max(
            ESTIMATED_TOTAL_SECONDS,
            _knownSheetCount * ESTIMATED_SECONDS_PER_SHEET,
          )
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
      ...(_effectiveBaseDelayMs !== undefined && {
        effectiveBaseDelayMs: _effectiveBaseDelayMs,
      }),
    };
    await db
      .update(jobsTable)
      .set({
        metadata: {
          progress,
          steps: pipelineSteps,
          estimatedSecondsPerSheet: ESTIMATED_SECONDS_PER_SHEET,
          processingStartedAt: startedAt,
        } as Record<string, unknown>,
      })
      .where(eq(jobsTable.id, jobId));
  }

  // Called by callClaudeVision whenever it retries after a transient error.
  async function onRetry(
    attempt: number,
    errorType: string,
    errorMessage: string,
  ): Promise<void> {
    logger.warn(
      `[pipeline] AI retry attempt ${attempt} during step ${_currentStep} (${_currentLabel}): [${errorType}] ${errorMessage}`,
    );
    retryLog.push({
      attempt,
      errorType,
      errorMessage,
      stepLabel: _currentLabel,
      timestamp: new Date().toISOString(),
    });
    // Persist the updated retry log so the UI shows the event immediately.
    await writeProgress(
      jobId,
      _currentStep,
      _currentLabel,
      startedAt,
      pipelineSteps,
      retryLog,
      _knownSheetCount,
      _aiRetryMax,
      _effectiveBaseDelayMs,
    );
  }

  try {
    // -------------------------------------------------------------------------
    // Step 1: Intake — load job + files
    // -------------------------------------------------------------------------
    await wp(1, "Reading file manifest");

    const [job] = await db
      .select()
      .from(jobsTable)
      .where(and(eq(jobsTable.id, jobId), eq(jobsTable.tenantId, tenantId)));
    if (!job) throw new Error(`Job ${jobId} not found`);

    // Load tenant settings to pick up configurable pipeline parameters.
    const [tenant] = await db
      .select({ settings: tenantsTable.settings })
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
        ? (tenantSettings.standardBuildingTypeMappings as Record<
            string,
            string
          >)
        : {};

    // Build retry options from tenant settings + env config and thread them into
    // every AI call site. Using buildAiCallOptions keeps the wiring in one place
    // and makes it directly testable without running the full pipeline.
    const aiCallOptions = buildAiCallOptions(tenantSettings);
    const aiRetryMax = aiCallOptions.maxRetries;
    logger.log(
      `[pipeline] Job ${jobId}: aiRetryMax=${aiRetryMax} baseDelayMs=${aiCallOptions.baseDelayMs}`,
    );

    // Base back-off delay (ms) before the first AI retry.
    // Per-tenant setting takes precedence over the server env var (claudeVisionBaseDelayMs).
    const rawBaseDelay =
      typeof tenantSettings.aiBaseDelayMs === "number"
        ? tenantSettings.aiBaseDelayMs
        : claudeVisionBaseDelayMs;
    const effectiveBaseDelayMs = Math.max(
      500,
      Math.min(30000, Math.round(rawBaseDelay)),
    );
    logger.log(
      `[pipeline] Job ${jobId}: aiBaseDelayMs=${effectiveBaseDelayMs}`,
    );

    // Surface retry settings through the pipeline progress so the UI can display them.
    _aiRetryMax = aiRetryMax;
    _effectiveBaseDelayMs = effectiveBaseDelayMs;

    // Maximum AI vision calls allowed for this run.
    // Per-tenant setting overrides the server-level default.
    const rawVisionCap =
      typeof tenantSettings.aiVisionCallsPerRun === "number"
        ? tenantSettings.aiVisionCallsPerRun
        : maxAiVisionCallsPerRun;
    let effectiveVisionCap = Math.max(1, Math.round(rawVisionCap));
    logger.log(
      `[pipeline] Job ${jobId}: aiVisionCallsPerRun cap=${effectiveVisionCap}`,
    );

    // Custom multi-entry room keywords configured by the tenant admin.
    // These are merged with the built-in keyword list at rule-evaluation time.
    const rawCustomKeywords = tenantSettings.multiEntryRoomKeywords;
    const customMultiEntryKeywords: string[] = Array.isArray(rawCustomKeywords)
      ? rawCustomKeywords.filter(
          (k): k is string => typeof k === "string" && k.trim().length > 0,
        )
      : [];

    // Load approved training patterns + validated reference jobs for this tenant.
    // The result is injected into every Claude vision prompt (Prompt 3) so the
    // model benefits from human-verified corrections made in previous runs.
    const trainingContext = await getTrainingContext(
      tenantId,
      job.buildingType ?? null,
    ).catch(() => "");
    if (trainingContext) {
      logger.log(
        `[pipeline] Job ${jobId}: training context loaded (${trainingContext.length} chars)`,
      );
    }

    const files = await db
      .select()
      .from(jobFilesTable)
      .where(
        and(
          eq(jobFilesTable.jobId, jobId),
          eq(jobFilesTable.tenantId, tenantId),
        ),
      );

    if (files.length === 0) {
      throw new Error(
        "No files uploaded for this job. Upload PDF files before processing.",
      );
    }

    logger.log(`[pipeline] Job ${jobId}: ${files.length} file(s)`);

    // Route files by category so the pipeline only runs the right extraction
    // logic on each file.  Files with no category (legacy uploads) are treated
    // as floor plans for backward compatibility.
    const floorPlanFiles = files.filter(
      (f) => !f.fileCategory || f.fileCategory === "floor_plan",
    );
    const dedicatedSignScheduleFiles = files.filter(
      (f) => f.fileCategory === "sign_schedule",
    );

    logger.log(
      `[pipeline] Job ${jobId}: ${floorPlanFiles.length} floor-plan file(s), ` +
        `${dedicatedSignScheduleFiles.length} dedicated sign-schedule file(s), ` +
        `${files.length - floorPlanFiles.length - dedicatedSignScheduleFiles.length} other/plaque file(s)`,
    );

    const totalAiCost = { value: 0 };
    const aiScanRecords: Array<{
      callType: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      cost: number;
    }> = [];

    function recordAiScan(
      callType: string,
      usage: ClaudeUsage,
      model: string = CLAUDE_VISION_MODEL,
    ) {
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
          "Ensure the 'PDF Sidecar' workflow is running before triggering processing.",
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
    const priorAiVisionBySheetKey = new Map<
      string,
      Array<{
        roomNumber: string;
        roomName: string;
        level: string | null;
        coordX: number | null;
        coordY: number | null;
        confidence: string;
        isRestroom: boolean;
      }>
    >();

    if (options?.forceAiRescan) {
      // Force Full Re-process: wipe ALL cached state so the pipeline starts
      // completely from scratch with no results carried over from prior runs.
      //
      // 1. All rooms (ai_vision + any other source) — snapshot will be empty,
      //    guaranteeing Step 6b makes fresh Claude vision calls for every sheet.
      await db.delete(roomsTable).where(eq(roomsTable.jobId, jobId));
      //
      // 2. All previous AI scan billing records — resets the cost display so the
      //    UI shows only costs accrued in this run.
      await db
        .delete(aiScansTable)
        .where(
          and(
            eq(aiScansTable.jobId, jobId),
            eq(aiScansTable.tenantId, tenantId),
          ),
        );
      //
      // Note: job.metadata (including any cached projectSignDictionary) is already
      // reset to a clean slate by the /rescan route before processJob is called,
      // so no additional metadata clearing is required here.
      logger.log(
        `[pipeline] forceFullReprocess=true — cleared all rooms and prior AI scan records`,
      );
    } else {
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

        for (const room of existingAiRooms) {
          const sheet = existingSheets.find((s) => s.id === room.sheetId);
          if (!sheet) continue;
          if (forcedSheetIds.has(sheet.id)) {
            skippedForForce++;
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
          });
          priorAiVisionBySheetKey.set(key, arr);
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
    const maxFileSizeMB = Math.max(
      0,
      ...floorPlanFiles.map((f) => (f.fileSizeBytes ?? 0) / 1024 / 1024),
    );
    const STEP2_TIMEOUT_MS =
      maxFileSizeMB > 50
        ? 180_000 // 3 minutes for large files (>50 MB)
        : maxFileSizeMB > 20
          ? 120_000 // 2 minutes for medium files (20–50 MB)
          : 60_000; // 1 minute for small files
    logger.log(
      `[pipeline] Drawing index timeout: ${STEP2_TIMEOUT_MS / 1000}s (file size: ${maxFileSizeMB.toFixed(1)} MB)`,
    );
    let step2TimedOut = false;

    await Promise.race([
      (async () => {
        for (const file of floorPlanFiles) {
          if (!file.filename.toLowerCase().endsWith(".pdf")) {
            logger.warn(`[pipeline] Skipping non-PDF file: ${file.filename}`);
            continue;
          }

          let pdfBuffer: Buffer;
          try {
            pdfBuffer = await downloadFromStorage(file.storagePath);
          } catch (err) {
            logger.warn(
              `[pipeline] Could not download ${file.storagePath}: ${err}`,
            );
            continue;
          }

          if (pdfBuffer.slice(0, 4).toString("ascii") !== "%PDF") {
            logger.warn(
              `[pipeline] File ${file.filename} does not appear to be a valid PDF (bad magic bytes) — skipping`,
            );
            continue;
          }

          // If page count was not recorded at upload time, derive it now from the
          // raw PDF bytes.  We sample the first 500 KB which covers the cross-ref
          // table and catalog for the vast majority of PDFs.
          if (file.pageCount == null) {
            const sample = pdfBuffer
              .slice(0, Math.min(pdfBuffer.length, 500_000))
              .toString("binary");
            const m = sample.match(/\/Type\s*\/Page[^s]/g);
            if (m && m.length > 0) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (file as any).pageCount = m.length;
              logger.log(
                `[pipeline] Detected ${m.length} pages in ${file.filename} from PDF bytes`,
              );
            }
          }

          if (sidecarOk) {
            const indexResult = await parseDrawingIndex(
              pdfBuffer,
              file.filename,
            );
            for (const s of indexResult.sheets) {
              allSheets.push({ ...s, fileId: file.id });
            }
          }
        }
      })(),
      new Promise<void>((resolve) =>
        setTimeout(() => {
          step2TimedOut = true;
          resolve();
        }, STEP2_TIMEOUT_MS),
      ),
    ]);

    if (step2TimedOut) {
      logger.warn(
        "[pipeline] Drawing index parse timeout — continuing with sheet pattern matching fallback",
      );
    }

    // Large permit set filter: when the drawing index yields more than 20 sheets
    // (typical of a full architectural permit set), aggressively filter out
    // non-floor-plan sheets (MEP, structural, civil, schedules, etc.) before
    // the vision scan cap limits what actually gets processed.
    if (allSheets.length > 20) {
      const FLOOR_PLAN_INCLUDE_KEYWORDS = [
        "FLOOR PLAN",
        "FLOOR PLN",
        "FLR PLAN",
        "ARCHITECTURAL",
        "ARCH PLAN",
        "LEVEL",
        "BASEMENT",
        "GROUND FLOOR",
        "PLAN VIEW",
        "ROOM LAYOUT",
      ];
      const FLOOR_PLAN_EXCLUDE_KEYWORDS = [
        "ELECTRICAL",
        "MECHANICAL",
        "PLUMBING",
        "STRUCTURAL",
        "CIVIL",
        "LANDSCAPE",
        "LIGHTING",
        "REFLECTED CEILING",
        "RCP",
        "HVAC",
        "SPRINKLER",
        "FIRE PROTECTION",
        "DETAIL",
        "SECTION",
        "ELEVATION",
        "SCHEDULE",
        "LEGEND",
        "NOTES",
        "SPECIFICATION",
        "COVER",
        "INDEX",
        "SITE PLAN",
        "SURVEY",
        "DEMOLITION",
      ];

      const filteredForFloorPlan = allSheets.filter((sheet) => {
        const title = (sheet.sheet_title ?? "").toUpperCase();
        const id = (sheet.sheet_id ?? "").toUpperCase();

        // Always keep signage schedule sheets and signage notes sheets, even in large
        // permit sets where "SCHEDULE" and "NOTES" would otherwise be excluded.
        if (sheet.sheet_type === "signage_schedule") return true;
        if (
          /SIGN(AGE)?\s*(NOTES?|SCHEDULE|TYPES?|PLAN|LEGEND)/i.test(
            sheet.sheet_title ?? "",
          )
        )
          return true;
        if (
          /^A0[.\-]/i.test(sheet.sheet_id) &&
          /SIGN/i.test(sheet.sheet_title ?? "")
        )
          return true;

        // Always drop MEP / non-architectural sheets
        if (FLOOR_PLAN_EXCLUDE_KEYWORDS.some((kw) => title.includes(kw)))
          return false;

        // Keep A-series sheets (architectural)
        if (/^A[-\s]?\d/.test(id)) return true;

        // Keep sheets whose title mentions a floor plan keyword
        if (FLOOR_PLAN_INCLUDE_KEYWORDS.some((kw) => title.includes(kw)))
          return true;

        // Conservative default for large permit sets — drop unknowns
        return false;
      });

      if (filteredForFloorPlan.length > 0) {
        logger.log(
          `[pipeline] Large permit set: filtered ${allSheets.length} sheets → ${filteredForFloorPlan.length} floor plan sheets`,
        );
        allSheets = filteredForFloorPlan;
      } else {
        logger.log(
          `[pipeline] Large permit set: no A-series / floor-plan sheets found — keeping all ${allSheets.length} sheets`,
        );
      }
    }

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

    if (allSheets.length === 0) {
      didSynthesize = true;
      logger.warn(
        "[pipeline] No sheets found via drawing index — synthesising floor plan sheets for all PDF pages",
      );
      for (let fileIndex = 0; fileIndex < floorPlanFiles.length; fileIndex++) {
        const file = floorPlanFiles[fileIndex];
        if (!file.filename.toLowerCase().endsWith(".pdf")) continue;

        const fileSizeMBForSynth = (file.fileSizeBytes ?? 0) / 1024 / 1024;
        const pageCount = Math.max(
          3,
          Math.min(file.pageCount ?? synthSizeCap, synthSizeCap),
        );
        logger.log(
          `[pipeline] Synthesising ${pageCount} page(s) for ${file.filename} (${fileSizeMBForSynth.toFixed(1)} MB, synthSizeCap=${synthSizeCap})`,
        );

        for (let p = 1; p <= pageCount; p++) {
          const estimatedLevel =
            p <= 3 ? `LEVEL ${p}` : p === 4 ? "MEZZANINE" : `LEVEL ${p}`;
          allSheets.push({
            sheet_id: `PLAN-${fileIndex}-P${p}`,
            sheet_title: `FLOOR PLAN LEVEL ${p}`,
            pdf_page: p,
            sheet_type: "floor_plan",
            level: estimatedLevel,
            fileId: file.id,
          });
        }
      }
    }

    // For synthesized-sheet jobs, match the vision cap exactly to synthSizeCap so the
    // scanner can reach every page we synthesized (no more, no fewer).
    // For real drawing-index jobs, use the raw tenant setting unchanged.
    if (didSynthesize) {
      effectiveVisionCap = Math.min(synthSizeCap, rawVisionCap);
      logger.log(
        `[pipeline] Synthesized-sheet job — vision cap = min(synthSizeCap=${synthSizeCap}, rawCap=${rawVisionCap}) → ${effectiveVisionCap}`,
      );
    }
    logger.log(
      `[pipeline] Vision cap: ${effectiveVisionCap} (file size: ${maxFileSizeMB.toFixed(1)} MB, synthesized=${didSynthesize})`,
    );

    // ── Step 4b: Sheet reclassification ───────────────────────────────────────
    // Reclassify any sheet whose title matches signage-notes patterns as
    // signage_schedule so Step B can extract the project sign dictionary from it.
    // A0.x sheets are ALWAYS treated as signage notes candidates — the sidecar
    // often returns a garbled label (e.g. "SHEET") from the title-block label
    // field rather than the actual drawing title; we rely on the sheet number
    // as the authoritative classifier rather than the (potentially garbled) title.
    const SIGNAGE_NOTES_DETECT =
      /SIGN(AGE)?\b.*?\b(NOTES?|SCHEDULE|TYPES?|LEGEND)/i;
    const _signageNotesFound: string[] = [];
    logger.log(
      `[Step 4b] Reclassifying sheets — scanning ${allSheets.length} sheets...`,
    );
    for (const s of allSheets) {
      if (s.sheet_type !== "signage_schedule") {
        // title match: "SIGNAGE AND GENERAL NOTES", "SIGN SCHEDULE", "SIGN TYPES", etc.
        const titlematch = SIGNAGE_NOTES_DETECT.test(s.sheet_title ?? "");
        // A0.x match: any A0.N sheet number is a general/signage notes candidate
        // regardless of what the sidecar extracted as the title.
        const a0match = /^A0\.\d+$/i.test(s.sheet_id);
        if (titlematch || a0match) {
          (s as Record<string, unknown>).sheet_type = "signage_schedule";
          _signageNotesFound.push(s.sheet_id);
          logger.log(
            `[Step 4b] → ${s.sheet_id} classified as signage_schedule (title="${s.sheet_title ?? ""}", titlematch=${titlematch}, a0match=${a0match})`,
          );
        }
      }
    }
    logger.log(
      `[Step 4b] Found ${_signageNotesFound.length} signage notes sheet(s): ${_signageNotesFound.join(", ") || "NONE"}`,
    );
    await wp("4b", "Reclassifying signage sheets");

    // Deduplicate sheets: if the same PDF is uploaded more than once every
    // loop iteration emits the same (sheet_id, pdf_page) pair.  Keep only the
    // first occurrence of each combination so the DB insert doesn't create
    // phantom duplicate sheets that inflate room/sign counts.
    const _sheetDedupeKeys = new Set<string>();
    const dedupedSheets = allSheets.filter((s) => {
      const key = `${s.sheet_id}|${s.pdf_page}`;
      if (_sheetDedupeKeys.has(key)) return false;
      _sheetDedupeKeys.add(key);
      return true;
    });
    if (dedupedSheets.length < allSheets.length) {
      logger.log(
        `[pipeline] Deduped sheets: ${allSheets.length} → ${dedupedSheets.length} (removed ${allSheets.length - dedupedSheets.length} duplicate(s) caused by multiple uploads of the same PDF)`,
      );
    }

    logger.log(`[pipeline] ${dedupedSheets.length} sheets identified`);

    // Record sheet count so subsequent writeProgress calls scale the time estimate.
    _knownSheetCount = dedupedSheets.length;

    // Insert sheets into DB
    const sheetDbRows: (typeof jobSheetsTable.$inferInsert)[] =
      dedupedSheets.map((s) => ({
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
        isRelevant:
          shouldRunVisionScan(s.sheet_id, s.sheet_title ?? null) ||
          s.sheet_type === "signage_schedule", // signage sheets always stay relevant for Step 4
      }));

    if (sheetDbRows.length > 0) {
      await db.insert(jobSheetsTable).values(sheetDbRows);
    }

    // Filter relevant sheets
    const relevantSheets = sheetDbRows.filter((s) => s.isRelevant);
    let floorPlanSheets = sheetDbRows.filter(
      (s) => s.sheetType === "floor_plan",
    );
    const signageSheets = sheetDbRows.filter(
      (s) => s.sheetType === "signage_schedule",
    );

    // Schedule import state — set in Step 4b, consumed in Step 9 (rules-engine skip).
    let hasScheduleImport = false;
    const scheduleSignRows: (typeof signsTable.$inferInsert)[] = [];

    // Signage notes sheet whitelist — populated in Step 4b when a sheet whose title
    // matches the signage-notes pattern is found.  The whitelist constrains Step 9
    // without skipping the rules engine (unlike the dedicated-file path).
    let signageNotesWhitelist: Set<string> | null = null;
    let signageNotesSheetName: string | null = null;

    // Estimator mode state — populated in Step B (dictionary) and Step 8.5 (assignments).
    // When estimatorSignRows is non-empty, Step 9 uses it instead of the rules engine.
    let projectSignDictionary: ProjectSignDictionary | null = null;
    // estimatorModeEligible tracks whether Step B successfully produced a dictionary.
    // Step 8.5 checks this before calling Claude; Step 9 uses it for the summary log.
    let estimatorModeEligible = false;
    const estimatorSignRows: (typeof signsTable.$inferInsert)[] = [];

    // -------------------------------------------------------------------------
    // Room inventory state — populated during Step 3 rasterization (one AI vision
    // call per floor plan sheet, immediately after rasterization).
    // -------------------------------------------------------------------------
    const extractedRooms: Array<{
      roomNumber: string;
      roomName: string;
      level: string;
      x: number;
      y: number;
      sheetDbId: string;
      aiVision?: boolean;
      aiConfidence?: string;
      aiIsRestroom?: boolean;
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
      logger.log(
        `[pipeline] Step 3 DIAG: full sheet manifest from Step 2 (${sheetDbRows.length} sheet(s)):`,
      );
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
        sheetDbRows
          .filter((s) => s.sheetType === "signage_schedule")
          .map((s) => s.sheetId),
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
        const reason =
          getExclusionReason(s.sheetId, s.sheetTitle ?? null) ??
          "unknown reason";
        const label = s.sheetTitle ? `"${s.sheetTitle}"` : "(no title)";
        logger.log(
          `[pipeline] Step 3 excluded: ${s.sheetId} ${label} — ${reason}`,
        );
      }

      if (visionCandidateIds.size === 0) {
        logger.warn(
          `[pipeline] Step 3 WARNING: all ${totalSheets} sheet(s) excluded — ` +
            `falling back to scanning all A-prefix sheets`,
        );
        const fallbackSheets = sheetDbRows.filter((s) => /^A/i.test(s.sheetId));
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

    logger.log(
      `[pipeline] Step 3: total sheets before filter = ${allSheets.length}`,
    );
    logger.log(
      `[pipeline] Step 3: relevantSheets count = ${relevantSheets.length}`,
    );

    for (const sheet of relevantSheets) {
      const file = files.find((f) => f.id === sheet.fileId);
      if (!file) continue;
      if (!file.filename.toLowerCase().endsWith(".pdf")) continue;

      let pdfBuffer: Buffer;
      try {
        pdfBuffer = await downloadFromStorage(file.storagePath);
      } catch {
        continue;
      }

      if (!sidecarOk) continue;

      try {
        const rasterResult = await rasterizePages(
          pdfBuffer,
          [sheet.pdfPage ?? 1],
          rasterizeDpi,
          file.filename,
        );
        if (rasterResult.pages.length === 0) continue;

        const pngBase64 = rasterResult.pages[0];
        sheetBase64Map.set(sheet.id!, pngBase64);

        const pngBuffer = Buffer.from(pngBase64, "base64");
        // Include page number in filename: the same sheet_id (e.g. "I-001") can
        // appear on multiple PDF pages; using just the id would overwrite earlier images.
        const pngPath = `rasterized/${jobId}/${sheet.sheetId}-p${sheet.pdfPage ?? 1}.png`;

        try {
          const storagePath = await uploadToStorage(
            pngPath,
            pngBuffer,
            "image/png",
            tenantId,
          );
          sheetImageMap.set(sheet.id!, storagePath);

          await db
            .update(jobSheetsTable)
            .set({ rasterizedPath: storagePath })
            .where(eq(jobSheetsTable.id, sheet.id!));
        } catch (uploadErr) {
          logger.warn(
            `[pipeline] Could not upload rasterized page: ${uploadErr}`,
          );
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
          const priorAiVisionRooms =
            priorAiVisionBySheetKey.get(sheetKey) ?? [];

          if (priorAiVisionRooms.length > 0) {
            // Reuse cached rooms — skip AI call.
            // Cached rooms means this sheet was previously confirmed as a floor plan.
            visionConfirmedPlanCount++;
            const clampCoordCached = (v: number | undefined | null) =>
              Math.max(0, Math.min(1000, Math.round(v ?? 500)));
            let reusedCount = 0;
            const dedupKeys = new Set<string>();
            for (const r of priorAiVisionRooms) {
              const dk = `${r.roomNumber.trim().toLowerCase()}|${r.roomName.trim().toLowerCase()}`;
              if (dedupKeys.has(dk)) continue;
              dedupKeys.add(dk);
              extractedRooms.push({
                roomNumber: r.roomNumber,
                roomName: expandSynonyms(r.roomName),
                level:
                  parseLevelFromContext(
                    r.level ?? null,
                    sheet.sheetTitle ?? null,
                    r.roomNumber,
                  ) ??
                  r.level ??
                  sheet.level ??
                  "LEVEL 1",
                x: clampCoordCached(r.coordX),
                y: clampCoordCached(r.coordY),
                sheetDbId: sheet.id!,
                aiVision: true,
                aiConfidence: r.confidence ?? AI_VISION_CONFIDENCE,
                aiIsRestroom: r.isRestroom ?? false,
              });
              reusedCount++;
            }
            step6CacheHits++;
            step6SheetResults.push({
              sheetId: sheet.sheetId,
              status: "cached",
            });
            logger.log(
              `[pipeline] Step 3/rooms: ${sheet.sheetId} — reused ${reusedCount}/${priorAiVisionRooms.length} cached ai_vision rooms`,
            );
          } else if (
            // Only confirmed floor-plan scans (fresh_scan) and cache hits count toward the cap.
            // Text-only sheets (isPlanView=false → skipped_filter) don't consume quota
            // so the scanner can reach the actual floor plan even when early pages are
            // title/index sheets.
            step6SheetResults.filter(
              (r) => r.status === "fresh_scan" || r.status === "cached",
            ).length < effectiveVisionCap
          ) {
            // Fresh AI scan using the Sonnet model
            const { systemPrompt, userPrompt } = buildRoomExtractionPrompt(
              sheet.sheetTitle ?? null,
              sheet.level ?? null,
              trainingContext,
            );

            try {
              const { text, usage } = await callClaudeVision(
                systemPrompt,
                userPrompt,
                pngBase64,
                "image/png",
                onRetry,
                aiCallOptions.maxRetries,
                aiCallOptions.baseDelayMs,
                CLAUDE_ROOM_EXTRACTION_MODEL,
              );
              aiVisionCallsThisRun++;
              recordAiScan(
                "room_extraction",
                usage,
                CLAUDE_ROOM_EXTRACTION_MODEL,
              );
              step6FreshScans++;
              step6FreshScanCost += usage.cost;
              step6SheetResults.push({
                sheetId: sheet.sheetId,
                status: "fresh_scan",
              });

              // DIAGNOSTIC: log the FULL raw response so we can see exactly
              // what the model returned (format, field names, values).
              logger.log(
                `[pipeline] Step 3 DIAG: FULL raw vision response for ${sheet.sheetId} (${text.length} chars):\n${text}`,
              );

              let parsed: VisionResponse;
              try {
                const jsonStart = text.indexOf("{");
                const jsonEnd = text.lastIndexOf("}");
                parsed = JSON.parse(
                  jsonStart !== -1 && jsonEnd !== -1
                    ? text.slice(jsonStart, jsonEnd + 1)
                    : text,
                ) as VisionResponse;
              } catch {
                logger.warn(
                  `[pipeline] Step 3/rooms: Could not parse vision JSON for ${sheet.sheetId}`,
                );
                if (++step6ProcessedCount % STEP6_FLUSH_INTERVAL === 0)
                  await flushStep6Progress(step6SheetResults);
                continue;
              }

              // DIAGNOSTIC: log isPlanView decision + room count from parsed response.
              logger.log(
                `[pipeline] Step 3 DIAG: parsed response for ${sheet.sheetId}` +
                  ` | isPlanView=${JSON.stringify(parsed.isPlanView)}` +
                  ` | missedRooms.length=${Array.isArray(parsed.missedRooms) ? parsed.missedRooms.length : `NOT_ARRAY(${typeof parsed.missedRooms})`}`,
              );

              // Content-based plan-view gate (Pass 2): if the model says this sheet
              // is not an overhead floor plan (elevation, section, detail, schedule,
              // etc.) discard all rooms and record as skipped.
              if (parsed.isPlanView === false) {
                logger.log(
                  `[pipeline] Step 3/rooms: ${sheet.sheetId} — skipped (isPlanView=false, not an overhead plan view)`,
                );
                step6SheetResults[step6SheetResults.length - 1] = {
                  sheetId: sheet.sheetId,
                  status: "skipped_filter",
                };
                if (++step6ProcessedCount % STEP6_FLUSH_INTERVAL === 0)
                  await flushStep6Progress(step6SheetResults);
                continue;
              }

              // isPlanView=true (or omitted, treated as true for back-compat):
              // this sheet is a confirmed overhead floor plan. Promote the
              // in-memory sheetType so floorPlanSheets rebuild picks it up.
              visionConfirmedPlanCount++;
              sheet.sheetType = "floor_plan";

              const missedRooms = Array.isArray(parsed.missedRooms)
                ? parsed.missedRooms
                : [];
              let addedCount = 0;
              const existingKeys = new Set<string>();

              for (const raw of missedRooms) {
                // Normalize both camelCase and snake_case field names.
                // Claude sometimes returns snake_case despite the prompt
                // showing camelCase examples, which silently drops all rooms.
                const item = raw as unknown as Record<string, unknown>;
                const roomNumber = String(
                  item.roomNumber ?? item.room_number ?? "",
                ).trim();
                const roomName = String(
                  item.roomName ?? item.room_name ?? "",
                ).trim();
                const isRestroom = Boolean(
                  item.isRestroom ?? item.is_restroom ?? false,
                );
                const rawX = item.x;
                const rawY = item.y;
                const numX =
                  typeof rawX === "number"
                    ? rawX
                    : typeof rawX === "string"
                      ? parseFloat(rawX)
                      : undefined;
                const numY =
                  typeof rawY === "number"
                    ? rawY
                    : typeof rawY === "string"
                      ? parseFloat(rawY)
                      : undefined;
                const rawItemLevel = String(item.level ?? "").trim() || null;
                const level =
                  parseLevelFromContext(
                    rawItemLevel,
                    sheet.sheetTitle ?? null,
                    roomNumber,
                  ) ??
                  rawItemLevel ??
                  sheet.level ??
                  "LEVEL 1";

                // Keep if at least one of roomName / roomNumber is non-empty
                if (!roomNumber && !roomName) continue;
                const key = `${roomNumber.toLowerCase()}|${roomName.toLowerCase()}`;
                if (existingKeys.has(key)) continue;
                existingKeys.add(key);

                // x/y are percentages (0–100) returned by the vision prompt.
                // Multiply by 10 to convert to the 0–1000 internal scale used
                // throughout the frontend and cached rooms.
                const clampPct = (v: number | undefined | null) =>
                  Math.max(0, Math.min(100, Math.round(v ?? 50)));
                extractedRooms.push({
                  roomNumber,
                  roomName: expandSynonyms(roomName),
                  level,
                  x: clampPct(numX) * 10,
                  y: clampPct(numY) * 10,
                  sheetDbId: sheet.id!,
                  aiVision: true,
                  aiConfidence: AI_VISION_CONFIDENCE,
                  aiIsRestroom: isRestroom,
                });
                addedCount++;
              }

              // Apply Claude's detected floor level to all rooms just added from this sheet.
              // This overrides the per-room level field (which may be a page-number label)
              // with the canonical level Claude read directly from the title block.
              const extractedFloorLevel =
                typeof parsed.floorLevel === "string" &&
                parsed.floorLevel.trim().length > 0
                  ? parsed.floorLevel.trim()
                  : null;

              if (extractedFloorLevel) {
                for (const room of extractedRooms) {
                  if (room.sheetDbId === sheet.id)
                    room.level = extractedFloorLevel;
                }
                logger.log(
                  `[pipeline] Step 3: ${sheet.sheetId} — Claude detected floor level: ${extractedFloorLevel}`,
                );
              } else {
                // Fall back to static keyword matching against sheet metadata
                const fallbackLevel = parseLevelFromContext(
                  sheet.level ?? null,
                  sheet.sheetTitle ?? null,
                );
                if (fallbackLevel) {
                  for (const room of extractedRooms) {
                    if (room.sheetDbId === sheet.id) room.level = fallbackLevel;
                  }
                  logger.log(
                    `[pipeline] Step 3: ${sheet.sheetId} — fallback floor level: ${fallbackLevel}`,
                  );
                }
              }

              logger.log(
                `[pipeline] Step 3/rooms: ${sheet.sheetId} — extracted ${addedCount} room(s) via AI vision (cost $${usage.cost.toFixed(4)})`,
              );

              // Only break early when we've genuinely seen multiple floors.
              // Require at least 3 confirmed plan scans AND either:
              //   (a) rooms from >1 distinct level have been found (multi-floor confirmed), or
              //   (b) 5+ sheets scanned (single-floor large set, safe to stop).
              // This lets Basement + Level 1 + Level 2 all be scanned before the
              // early exit fires (fixes Cambridge Moses stopping after pages 8-9).
              const roomsFromThisSheet = extractedRooms.filter(
                (r) => r.sheetDbId === sheet.id,
              ).length;
              const sheetsScannedSoFar = step6SheetResults.filter(
                (r) => r.status === "fresh_scan",
              ).length;
              const levelsFound = new Set(extractedRooms.map((r) => r.level))
                .size;
              const shouldExitEarly =
                roomsFromThisSheet >= 10 &&
                sheetsScannedSoFar >= 3 &&
                sheet.sheetId.startsWith("PLAN-") &&
                (levelsFound > 1 || sheetsScannedSoFar >= 5);
              if (shouldExitEarly) {
                logger.log(
                  `[pipeline] Step 3: Found ${roomsFromThisSheet} rooms on ${sheet.sheetId} after ${sheetsScannedSoFar} scan(s) across ${levelsFound} level(s) — stopping early`,
                );
                break;
              }
            } catch (visionErr) {
              logger.warn(
                `[pipeline] Step 3/rooms: vision failed for ${sheet.sheetId}: ${visionErr}`,
              );
              step6SheetResults.push({
                sheetId: sheet.sheetId,
                status: "fresh_scan",
              });
            }
          } else {
            // Vision cap reached
            logger.warn(
              `[pipeline] Step 3/rooms: ${sheet.sheetId} — skipped (AI vision cap of ${effectiveVisionCap} calls/run reached)`,
            );
            step6SkippedAboveThreshold++;
            step6SheetResults.push({
              sheetId: sheet.sheetId,
              status: "skipped_cap",
            });
          }

          if (++step6ProcessedCount % STEP6_FLUSH_INTERVAL === 0)
            await flushStep6Progress(step6SheetResults);
        }
      } catch (rastErr) {
        logger.warn(
          `[pipeline] Could not rasterize ${sheet.sheetId}: ${rastErr}`,
        );
      }
    }

    // Flush remaining room extraction results
    await flushStep6Progress(step6SheetResults);

    // Rebuild floorPlanSheets now that Step 3 has promoted vision-confirmed
    // sheets to sheetType="floor_plan".  The initial filter at line ~1758 ran
    // before Step 3 so it only captured sidecar-classified floor_plan sheets;
    // any sheet the sidecar returned as "other" but Claude confirmed as a plan
    // view was missed.  This is the authoritative list for Steps 8.5, 9, 10.
    floorPlanSheets = sheetDbRows.filter((s) => s.sheetType === "floor_plan");
    logger.log(
      `[pipeline] Step 3: floorPlanSheets rebuilt — ${floorPlanSheets.length} confirmed floor-plan sheet(s)`,
    );

    // Persist the promoted sheet_type to the DB so the UI and future queries
    // reflect the correct classification.
    const _visionPromotedIds = floorPlanSheets
      .map((s) => s.id!)
      .filter(Boolean);
    if (_visionPromotedIds.length > 0) {
      await db
        .update(jobSheetsTable)
        .set({ sheetType: "floor_plan" })
        .where(inArray(jobSheetsTable.id, _visionPromotedIds));
    }

    // -------------------------------------------------------------------------
    // Step 4: Extract plaque schedule (Claude vision on signage sheets)
    // -------------------------------------------------------------------------
    await wp(4, "Extracting plaque schedule");

    const plaqueEntries: PlaqueEntry[] = [];

    await withStepTimeout("Step 4", async () => {
      for (const sigSheet of signageSheets) {
        const cachedBase64 = sheetBase64Map.get(sigSheet.id!);
        if (!cachedBase64) continue;

        try {
          const { entries, usage } = await extractPlaqueSchedule(
            cachedBase64,
            onRetry,
            aiCallOptions.maxRetries,
            aiCallOptions.baseDelayMs,
          );
          plaqueEntries.push(...entries);
          recordAiScan("plaque_schedule", usage);
        } catch (err) {
          logger.warn(`[pipeline] Plaque schedule extraction failed: ${err}`);
        }
      }

      // Save plaque schedule
      await db
        .delete(plaqueScheduleTable)
        .where(eq(plaqueScheduleTable.jobId, jobId));
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

    // -------------------------------------------------------------------------
    // Step 4b: Parse signage schedule table (pdfplumber direct table extraction)
    // -------------------------------------------------------------------------
    // For each signage_schedule sheet (or dedicated sign schedule file), call
    // the sidecar /extract-table endpoint and import the rows directly as sign
    // records (source = 'schedule').  Dedicated sign schedule files (uploaded
    // and tagged as "Sign Schedule / Specs") take priority over A-7XX sheets
    // found in the floor plan set.  If rows are found, Step 9 is skipped.

    const anchorSheetId =
      floorPlanSheets.find(
        (s) => s.level?.includes("1") || s.level?.includes("L1"),
      )?.id ??
      floorPlanSheets[0]?.id ??
      null;

    if (dedicatedSignScheduleFiles.length > 0 && sidecarOk) {
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
          logger.warn(
            `[pipeline] Step 4b: Could not download sign schedule file ${schedFile.filename}: ${err}`,
          );
          continue;
        }

        const pageCount = Math.max(1, schedFile.pageCount ?? 1);
        logger.log(
          `[pipeline] Step 4b: Processing ${schedFile.filename} (${pageCount} page(s))`,
        );

        for (let page = 1; page <= pageCount; page++) {
          try {
            const tableResult = await extractTable(
              pdfBuf,
              page,
              schedFile.filename,
            );
            if (tableResult.table_count === 0) continue;
            logger.log(
              `[pipeline] Step 4b: ${schedFile.filename} p.${page} — ${tableResult.table_count} table(s) found`,
            );

            const parsed = parseScheduleTableRows(tableResult.tables);
            logger.log(
              `[pipeline] Step 4b: ${schedFile.filename} p.${page} — ${parsed.length} schedule row(s) parsed`,
            );

            for (const row of parsed) {
              scheduleSignRows.push({
                id: newId("sign"),
                jobId,
                tenantId,
                roomId: null,
                sheetId: String(anchorSheetId ?? ""),
                signType: row.signType,
                qty: 1,
                ruleRef: "schedule",
                color: null,
                confidence: "1.000",
                status: "extracted",
                source: "schedule",
                message:
                  [row.signIdentifier, row.roomNumber, row.roomName]
                    .filter(Boolean)
                    .join(" | ") || undefined,
              });
            }

            if (parsed.length > 0) hasScheduleImport = true;
          } catch (err) {
            logger.warn(
              `[pipeline] Step 4b: Table extraction failed for ${schedFile.filename} p.${page}: ${err}`,
            );
          }
        }
      }
    } else if (signageSheets.length > 0 && sidecarOk) {
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
      logger.log(
        `[pipeline] Step 4b: No dedicated sign schedule file — using ${signageSheets.length} signage sheet(s) from floor plan set`,
      );

      for (const sigSheet of signageSheets) {
        const sheetFile = files.find((f) => f.id === sigSheet.fileId);
        if (!sheetFile) continue;

        let pdfBuf: Buffer;
        try {
          pdfBuf = await downloadFromStorage(sheetFile.storagePath);
        } catch (err) {
          logger.warn(
            `[pipeline] Step 4b: Could not download PDF for ${sigSheet.sheetId}: ${err}`,
          );
          continue;
        }

        // Detect whether this is a signage-notes sheet (type whitelist) or a
        // classic A-7XX room-level schedule (direct insert).
        const isNotesSheet =
          SIGNAGE_NOTES_DETECT.test(sigSheet.sheetTitle ?? "") ||
          (/^A0[.\-]/i.test(sigSheet.sheetId) &&
            /SIGN/i.test(sigSheet.sheetTitle ?? ""));

        try {
          const tableResult = await extractTable(
            pdfBuf,
            sigSheet.pdfPage ?? 1,
            sheetFile.filename,
          );
          logger.log(
            `[pipeline] Step 4b: ${sigSheet.sheetId} (page ${sigSheet.pdfPage}) — ${tableResult.table_count} table(s) found`,
          );

          const parsed = parseScheduleTableRows(tableResult.tables);
          logger.log(
            `[pipeline] Step 4b: ${sigSheet.sheetId} — ${parsed.length} schedule row(s) parsed`,
          );

          if (isNotesSheet) {
            // Signage-notes sheet: build a type whitelist; rules engine still runs.
            const types = [
              ...new Set(
                parsed.map((r) => r.signType).filter((t): t is string => !!t),
              ),
            ];
            if (types.length > 0) {
              signageNotesWhitelist =
                signageNotesWhitelist ?? new Set<string>();
              for (const t of types) signageNotesWhitelist.add(t);
              signageNotesSheetName = sigSheet.sheetTitle ?? sigSheet.sheetId;
              logger.log(
                `[pipeline] Signage notes sheet detected: "${signageNotesSheetName}" — ` +
                  `restricting output to defined sign types: ${types.join(", ")}`,
              );
            } else {
              logger.log(
                `[pipeline] Step 4b: Signage notes sheet ${sigSheet.sheetId} — no parseable sign types found, skipping whitelist`,
              );
            }
            // Do NOT set hasScheduleImport — the rules engine must run.
          } else {
            // Classic A-7XX room-level schedule: insert rows directly.
            for (const row of parsed) {
              scheduleSignRows.push({
                id: newId("sign"),
                jobId,
                tenantId,
                roomId: null,
                sheetId: String(anchorSheetId ?? sigSheet.id ?? ""),
                signType: row.signType,
                qty: 1,
                ruleRef: "schedule",
                color: null,
                confidence: "1.000",
                status: "extracted",
                source: "schedule",
                message:
                  [row.signIdentifier, row.roomNumber, row.roomName]
                    .filter(Boolean)
                    .join(" | ") || undefined,
              });
            }
            if (parsed.length > 0) hasScheduleImport = true;
          }
        } catch (err) {
          logger.warn(
            `[pipeline] Step 4b: Table extraction failed for ${sigSheet.sheetId}: ${err}`,
          );
        }
      }
    }

    // -----------------------------------------------------------------------
    // Step 4b-ext: Extract schedule table from combo floor-plan+signage sheets.
    // Some sheets (e.g. "Overall Floor Plan & Signage") embed BOTH a floor plan
    // drawing AND a sign schedule table.  Run pdfplumber on any floor_plan sheet
    // whose title contains "SIGNAGE" or "SIGN SCHEDULE", treat the parsed rows
    // as authoritative, and use vision-extracted coordinates for matching.
    // Only runs when neither Path A nor Path B produced any schedule rows.
    // -----------------------------------------------------------------------
    if (!hasScheduleImport && sidecarOk) {
      // Attempt extraction on all floor_plan sheets — the schedule parser's
      // header-detection logic (looks for a SIGN column) is specific enough
      // to avoid false positives on pure floor plan drawings.
      // This also handles the case where the sheet title was synthesised
      // (e.g. "FLOOR PLAN LEVEL 1") and therefore doesn't contain "SIGNAGE".
      const comboSheets = sheetDbRows.filter(
        (s) => s.sheetType === "floor_plan",
      );

      if (comboSheets.length > 0) {
        logger.log(
          `[pipeline] Step 4b-ext: trying ${comboSheets.length} floor-plan sheet(s) for embedded schedule tables`,
        );

        // Helper: normalize a room name for fuzzy matching
        const normName = (s: string) =>
          s
            .toUpperCase()
            .replace(/[^A-Z0-9 ]/g, " ")
            .replace(/\s+/g, " ")
            .trim();

        // Jaccard token-set similarity between two room name strings
        const nameSim = (a: string, b: string): number => {
          const ta = new Set(normName(a).split(" ").filter(Boolean));
          const tb = new Set(normName(b).split(" ").filter(Boolean));
          const intersection = [...ta].filter((w) => tb.has(w)).length;
          const union = new Set([...ta, ...tb]).size;
          return union === 0 ? 0 : intersection / union;
        };

        for (const comboSheet of comboSheets) {
          const sheetFile = files.find((f) => f.id === comboSheet.fileId);
          if (!sheetFile) continue;

          let pdfBuf: Buffer;
          try {
            pdfBuf = await downloadFromStorage(sheetFile.storagePath);
          } catch (err) {
            logger.warn(
              `[pipeline] Step 4b-ext: Could not download PDF for ${comboSheet.sheetId}: ${err}`,
            );
            continue;
          }

          try {
            const tableResult = await extractTable(
              pdfBuf,
              comboSheet.pdfPage ?? 1,
              sheetFile.filename,
            );
            logger.log(
              `[pipeline] Step 4b-ext: ${comboSheet.sheetId} (page ${comboSheet.pdfPage}) — ${tableResult.table_count} table(s) found`,
            );

            const parsed = parseScheduleTableRows(tableResult.tables);
            logger.log(
              `[pipeline] Step 4b-ext: ${comboSheet.sheetId} — ${parsed.length} schedule row(s) parsed`,
            );

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
                logger.log(
                  `[pipeline] Step 4b-ext: no vision match for "${row.roomName}" (${row.roomNumber})`,
                );
              }

              // Push the schedule sign row.  Step 10b will link it to the vision room
              // (now carrying the schedule's room number) to assign markerX/markerY.
              scheduleSignRows.push({
                id: newId("sign"),
                jobId,
                tenantId,
                roomId: null,
                sheetId: String(comboSheet.id ?? anchorSheetId ?? ""),
                signType: row.signType,
                qty: 1,
                ruleRef: "schedule",
                color: null,
                confidence: "1.000",
                status: "extracted",
                source: "schedule",
                message:
                  [row.signIdentifier, row.roomNumber, row.roomName]
                    .filter(Boolean)
                    .join(" | ") || undefined,
              });
            }

            hasScheduleImport = true;
            break; // Stop scanning further sheets once rows are found
          } catch (err) {
            logger.warn(
              `[pipeline] Step 4b-ext: Table extraction failed for ${comboSheet.sheetId}: ${err}`,
            );
          }
        }
      }
    }

    if (scheduleSignRows.length > 0) {
      logger.log(
        `[pipeline] Step 4b: ${scheduleSignRows.length} schedule sign(s) queued for insert — rules engine will be skipped`,
      );
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
    const RESTROOM_SCOPE_PATTERN =
      /\b(TOILET|RESTROOM|BATHROOM|WC|UNISEX|STAFF\s*RR|BOYS|GIRLS|MEN|WOMEN|GENDER|LAVATORY|ACCESSIBLE)\b/i;
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
    if (dedicatedSignScheduleFiles.length > 0 && scheduleSignRows.length > 0) {
      const scheduleTypes = [
        ...new Set(scheduleSignRows.map((r) => r.signType)),
      ];
      if (
        scheduleTypes.length > 0 &&
        scheduleTypes.every((t) => RESTROOM_SCOPE_PATTERN.test(t))
      ) {
        restroomOnlyScope = true;
        logger.log(
          `[pipeline] Step 4c: Restroom-only scope detected from sign schedule ` +
            `(${scheduleTypes.length} type(s): ${scheduleTypes.join(", ")}) — ` +
            `skipping standard room ID, exit, egress, stair, and elevator rules`,
        );
        // Persist immediately so the flag is visible on the job overview during processing.
        await db
          .update(jobsTable)
          .set({ scopeFlag: "restroom_only" })
          .where(eq(jobsTable.id, jobId));
      }
    }

    // -------------------------------------------------------------------------
    // Step B: Extract project sign dictionary from signage notes sheet
    //
    // If a signage notes sheet is present (detected and reclassified in Step 4b),
    // send its image to Claude for structured extraction of sign types, scope,
    // placement rules, and dimensions.  The result is cached in job.metadata so
    // re-scans skip this call unless the cache is cleared.
    // Sets estimatorModeEligible = true on success; never blocks the rest of the pipeline.
    // -------------------------------------------------------------------------
    estimatorModeEligible = false; // ESTIMATOR MODE DISABLED - rollback
    logger.log("[Step B] Starting dictionary extraction...");

    const cachedDictRaw = (job.metadata as Record<string, unknown> | null)
      ?.projectSignDictionary;
    if (
      cachedDictRaw &&
      typeof cachedDictRaw === "object" &&
      Array.isArray((cachedDictRaw as ProjectSignDictionary).signTypes)
    ) {
      projectSignDictionary = cachedDictRaw as ProjectSignDictionary;
      estimatorModeEligible = true;
      logger.log(
        `[Step B] Using cached dictionary — ${projectSignDictionary.signTypes.length} type(s), ` +
          `scope: ${projectSignDictionary.scope} (${projectSignDictionary.sourceSheet ?? "unknown sheet"})`,
      );
      for (const t of projectSignDictionary.signTypes) {
        logger.log(
          `[Step B] → Type ${t.code}: ${t.name} (category: ${t.category ?? "unknown"})`,
        );
      }
    } else {
      // Find the first signage notes sheet that has a rasterized image.
      // A0.x sheet IDs are accepted without requiring "SIGN" in the title since
      // the sidecar title-block parser can return garbled labels (e.g. "SHEET").
      const notesSheet = signageSheets.find(
        (s) =>
          SIGNAGE_NOTES_DETECT.test(s.sheetTitle ?? "") ||
          /^A0\.\d+$/i.test(s.sheetId),
      );
      const notesBase64 = notesSheet
        ? sheetBase64Map.get(notesSheet.id!)
        : undefined;

      if (!notesSheet) {
        estimatorModeEligible = false;
        logger.log(
          "[Step B] SKIPPED — no signage notes sheet found in project (no title match, no A0.x sheet)",
        );
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

          const { text: dictText, usage: dictUsage } = await callClaudeVision(
            dictSystemPrompt,
            dictUserPrompt,
            notesBase64,
            "image/png",
            onRetry,
            aiRetryMax,
            effectiveBaseDelayMs,
            CLAUDE_VISION_MODEL,
          );
          recordAiScan("estimator_dict", dictUsage);

          // Strip markdown fences if Claude wraps output
          const dictJson = dictText
            .replace(/^```(?:json)?\s*/i, "")
            .replace(/\s*```\s*$/i, "")
            .trim();
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
            await db
              .update(jobsTable)
              .set({ metadata: { ...currentMeta, projectSignDictionary } })
              .where(eq(jobsTable.id, jobId));

            logger.log(
              `[Step B] Extracted ${projectSignDictionary.signTypes.length} sign type(s), ` +
                `scope: ${projectSignDictionary.scope}`,
            );
            for (const t of projectSignDictionary.signTypes) {
              logger.log(
                `[Step B] → Type ${t.code}: ${t.name} (category: ${t.category ?? "unknown"})`,
              );
            }

            // Apply scope from dictionary if stronger than existing restroom detection.
            if (
              projectSignDictionary.scope === "restroom_only" &&
              !restroomOnlyScope
            ) {
              restroomOnlyScope = true;
              await db
                .update(jobsTable)
                .set({ scopeFlag: "restroom_only" })
                .where(eq(jobsTable.id, jobId));
              logger.log(
                `[Step B] Dictionary scope is restroom_only — applied scopeFlag`,
              );
            }
          } else {
            estimatorModeEligible = false;
            logger.log(
              `[Step B] FAILED — dictionary has no sign types (Claude returned ${Array.isArray(parsed.signTypes) ? 0 : "non-array"} entries)`,
            );
          }
        } catch (err) {
          estimatorModeEligible = false;
          logger.warn(
            `[Step B] FAILED — Claude error: ${err instanceof Error ? err.message : String(err)}. Falling back to rules engine.`,
          );
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
    logger.log(
      `[pipeline] Step 6 summary: ${step6CacheHits} cache hit(s), ${step6FreshScans} fresh scan(s), ` +
        `${step6SkippedAboveThreshold} skipped (cap). ` +
        `Total AI vision calls this run: ${aiVisionCallsThisRun}. ` +
        `Estimated savings from cache: $${step6EstimatedSavings.toFixed(4)}`,
    );

    // ── TWO-PASS MERGE: PDF text extraction + AI vision ──────────────────────
    if (ENABLE_TWO_PASS && sidecarOk) {
      logger.log(
        `[pipeline] Two-pass merge: starting with ${extractedRooms.length} vision rooms`,
      );

      // Only run two-pass on sheets that were actually vision-scanned
      const scannedSheetIds = new Set(
        step6SheetResults
          .filter((r) => r.status === "fresh_scan" || r.status === "cached")
          .map((r) => r.sheetId),
      );

      if (scannedSheetIds.size === 0) {
        logger.log(`[pipeline] Two-pass: no scanned sheets found — skipping`);
      } else {
        let confirmed = 0;
        let added = 0;

        // Cache PDF buffers by fileId to avoid redundant downloads
        const pdfBufferCache = new Map<string, Buffer>();

        for (const sheet of relevantSheets.filter((s) =>
          scannedSheetIds.has(s.sheetId),
        )) {
          try {
            const file = floorPlanFiles.find((f) => f.id === sheet.fileId);
            if (!file) continue;

            // Download (and cache) the PDF buffer for this file
            let pdfBuf = pdfBufferCache.get(file.id);
            if (!pdfBuf) {
              try {
                pdfBuf = await downloadFromStorage(file.storagePath);
                pdfBufferCache.set(file.id, pdfBuf);
              } catch (dlErr) {
                logger.warn(
                  `[pipeline] Two-pass: could not download ${file.storagePath}: ${dlErr instanceof Error ? dlErr.message : String(dlErr)}`,
                );
                continue;
              }
            }

            const wordResult = await extractWords(
              pdfBuf,
              sheet.pdfPage ?? 1,
              file.filename,
            );
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
                `${extractedRooms.filter((r) => r.sheetDbId === sheet.id).length} vision rooms`,
            );

            for (const textRoom of textRooms) {
              const numLower = (textRoom.roomNumber ?? "").toLowerCase().trim();
              const nameLower = (textRoom.roomName ?? "").toLowerCase().trim();
              if (!numLower && nameLower.length < 3) continue;

              // Find matching vision room — exact room number OR word-bag name match
              const visionMatch = extractedRooms.find((r) => {
                const vNum = (r.roomNumber ?? "").toLowerCase().trim();
                const vName = (r.roomName ?? "").toLowerCase().trim();
                if (numLower && vNum && numLower === vNum) return true;
                if (nameLower.length > 3 && vName.length > 3) {
                  const words = nameLower
                    .split(/\s+/)
                    .filter((w) => w.length > 2);
                  return (
                    words.length > 0 && words.every((w) => vName.includes(w))
                  );
                }
                return false;
              });

              if (visionMatch) {
                // Both passes agree — upgrade confidence
                visionMatch.aiConfidence = "0.920";
                (visionMatch as Record<string, unknown>).confirmedByText = true;
                confirmed++;
              } else {
                // Text found a room vision missed — add it
                extractedRooms.push({
                  roomNumber: textRoom.roomNumber,
                  roomName: textRoom.roomName,
                  level: sheet.level ?? "LEVEL 1",
                  x: textRoom.x,
                  y: textRoom.y,
                  sheetDbId: sheet.id!,
                  aiVision: false,
                  aiConfidence: "0.850",
                  aiIsRestroom: false,
                });
                added++;
              }
            }
          } catch (err) {
            logger.warn(
              `[pipeline] Two-pass failed for ${sheet.sheetId}: ` +
                `${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        logger.log(
          `[pipeline] Two-pass complete: ${confirmed} confirmed by both, ` +
            `${added} text-only added, ${extractedRooms.length} total rooms`,
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
    const occupantLoadMap = new Map<
      string,
      { occupantLoad: number; occupancyGroup?: string }
    >();

    await withStepTimeout("Step 7", async () => {
      const codeSheets = sheetDbRows.filter(
        (s) => s.sheetType === "egress" || s.sheetType === "code_review",
      );
      for (const codeSheet of codeSheets.slice(0, 3)) {
        // limit to 3 sheets to control cost
        const file = files.find((f) => f.id === codeSheet.fileId);
        if (!file) continue;

        try {
          // Code/egress sheets are not rasterized in Step 3; rasterize on demand and cache.
          let pngBase64 = sheetBase64Map.get(codeSheet.id!);
          if (!pngBase64) {
            const pdfBuf = await downloadFromStorage(file.storagePath);
            const rasterResult = await rasterizePages(
              pdfBuf,
              [codeSheet.pdfPage ?? 1],
              rasterizeDpi,
              file.filename,
            );
            if (rasterResult.pages.length === 0) return;
            pngBase64 = rasterResult.pages[0];
            sheetBase64Map.set(codeSheet.id!, pngBase64);
          }

          const { entries, usage } = await extractOccupantLoads(
            pngBase64,
            onRetry,
            aiCallOptions.maxRetries,
            aiCallOptions.baseDelayMs,
          );
          for (const e of entries) {
            occupantLoadMap.set(e.roomNumber, {
              occupantLoad: e.occupantLoad,
              occupancyGroup: e.occupancyGroup,
            });
          }
          recordAiScan("occupant_loads", usage);
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
              const rasterResult = await rasterizePages(
                pdfBuf,
                [firstFpSheet.pdfPage ?? 1],
                rasterizeDpi,
                file.filename,
              );
              if (rasterResult.pages.length > 0) {
                pngBase64 = rasterResult.pages[0];
                sheetBase64Map.set(firstFpSheet.id!, pngBase64);
              }
            }
            if (pngBase64) {
              const { entries, usage } = await extractOccupantLoads(
                pngBase64,
                onRetry,
                aiCallOptions.maxRetries,
                aiCallOptions.baseDelayMs,
              );
              for (const e of entries) {
                occupantLoadMap.set(e.roomNumber, {
                  occupantLoad: e.occupantLoad,
                  occupancyGroup: e.occupancyGroup,
                });
              }
              recordAiScan("occupant_loads_fp", usage);
            }
          } catch {
            // ignore
          }
        }
      }
    });

    // -------------------------------------------------------------------------
    // Step 8: Build room inventory + classify rooms
    // -------------------------------------------------------------------------
    await wp(8, "Building room inventory");

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

    // Pass 1: collect first occurrence of every numbered room
    const seenNumbers = new Set<string>();
    const numberedFirst = new Map<string, (typeof extractedRooms)[0]>();
    for (const r of extractedRooms) {
      const num = r.roomNumber.trim().toLowerCase();
      if (num && !seenNumbers.has(num)) {
        seenNumbers.add(num);
        numberedFirst.set(num, r);
      }
    }

    // Build lookup structures from numbered rooms
    const numberedNames = new Set(
      Array.from(numberedFirst.values()).map((r) =>
        r.roomName.trim().toLowerCase(),
      ),
    );
    const numberedNamesArray = Array.from(numberedNames);

    // Keyword groups for space-type consolidation (Pass 3b/3c)
    const RESTROOM_KW = [
      "restroom",
      "bathroom",
      "washroom",
      "lavatory",
      "toilet",
      "shower",
    ];
    const hasNumberedRestroom = numberedNamesArray.some((n) =>
      RESTROOM_KW.some((kw) => n.includes(kw)),
    );
    const hasNumberedCorridor = numberedNamesArray.some(
      (n) => n.includes("corridor") || n.includes("hallway"),
    );

    // Pass 2: keep numbered rooms (canonical only) + exact-name-dedup for unnamed
    const seenUnnamedNames = new Set<string>();
    const afterPass2 = extractedRooms.filter((r) => {
      const num = r.roomNumber.trim().toLowerCase();
      if (num) {
        return numberedFirst.get(num) === r; // keep only the first-seen numbered room
      }
      const name = r.roomName.trim().toLowerCase();
      if (numberedNames.has(name)) return false; // exact name covered by a numbered room
      if (seenUnnamedNames.has(name)) return false; // duplicate unnamed
      seenUnnamedNames.add(name);
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
            if (named.includes(" ") && name.includes(named)) return false; // Direction B
          }
        }
      }

      // 3b: Restroom consolidation — drop unnamed restroom-type when numbered restrooms exist
      if (hasNumberedRestroom && RESTROOM_KW.some((kw) => name.includes(kw)))
        return false;

      // 3c: Generic hallway consolidation — exact-word match only so "CORRIDOR/VESTIBULE" is kept
      if (
        hasNumberedCorridor &&
        (name === "hallway" || name === "hall" || name === "corridor")
      )
        return false;

      return true;
    });

    const removedCount = extractedRooms.length - dedupedRooms.length;
    if (removedCount > 0) {
      const finalUnnamed = dedupedRooms.filter(
        (r) => !r.roomNumber.trim(),
      ).length;
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
      extractedRooms.map((r) => ({
        roomName: r.roomName,
        roomNumber: r.roomNumber,
      })),
      { buildingType: job.buildingType ?? undefined, name: job.name },
      customBuildingTypeMappings,
      standardBuildingTypeMappings,
    );

    // Never auto-persist a detected building type — only use the detection result
    // internally for this pipeline run.  The user must set building type explicitly;
    // otherwise the job shows "Not set" in the UI rather than a potentially wrong guess.
    const finalBuildingType = job.buildingType ?? detectedBuildingType;

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
      .where(
        and(
          eq(signsTable.jobId, jobId),
          isNotNull(signsTable.canvasX),
          isNotNull(signsTable.canvasY),
        ),
      );

    const priorPlacementMap = new Map<
      string,
      { canvasX: number; canvasY: number }
    >();
    for (const mp of priorPlacements) {
      const key = `${mp.roomNumber ?? ""}|${mp.level ?? ""}|${mp.signType}`;
      if (!priorPlacementMap.has(key)) {
        priorPlacementMap.set(key, {
          canvasX: mp.canvasX!,
          canvasY: mp.canvasY!,
        });
      }
    }
    logger.log(
      `[pipeline] Captured ${priorPlacementMap.size} manually placed marker(s) to restore after rescan`,
    );

    // Clear old rooms + signs
    await db.delete(roomsTable).where(eq(roomsTable.jobId, jobId));
    await db.delete(signsTable).where(eq(signsTable.jobId, jobId));

    // Build RoomRecord list (includes both deterministic and AI-vision rooms)
    const roomRecords: RoomRecord[] = extractedRooms.map((r) => {
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
          logger.log(
            `[pipeline] Step 8: Derived level '${derivedLevel}' from room number '${r.roomNumber}'`,
          );
          r.level = derivedLevel;
        }
      }

      const olData = occupantLoadMap.get(r.roomNumber);
      const classification = classifyRoom(r.roomName);

      // AI-vision rooms: trust the isRestroom flag from Claude if classification disagrees
      const isRestroom = r.aiVision
        ? (r.aiIsRestroom ?? classification.isRestroom ?? false)
        : (classification.isRestroom ?? false);

      return {
        id: newId("room"),
        roomNumber: r.roomNumber,
        roomName: r.roomName,
        level: r.level,
        occupantLoad: olData?.occupantLoad ?? null,
        occupancyGroup: olData?.occupancyGroup ?? null,
        sheetId: r.sheetDbId,
        coordX: r.x,
        coordY: r.y,
        isResidentialUnit: classification.isResidentialUnit ?? false,
        isRestroom,
        isStair: classification.isStair ?? false,
        isElevator: classification.isElevator ?? false,
        isVestibule: classification.isVestibule ?? false,
        isCorridorOrHall: classification.isCorridorOrHall ?? false,
        isVehicleBay: classification.isVehicleBay ?? false,
        isMepUnoccupied: classification.isMepUnoccupied ?? false,
        isVariableUse: classification.isVariableUse ?? false,
        isPublicFacing: classification.isPublicFacing ?? false,
        isAssembly: classification.isAssembly ?? false,
      };
    });

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
              bboxX0: 0,
              bboxY0: 0,
              pageWPts: 0,
              pageHPts: 0,
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
    logger.log("[Step 8.5] Starting estimator mode...");

    if (!estimatorModeEligible || !projectSignDictionary || hasScheduleImport) {
      const skipReason = !estimatorModeEligible
        ? "not eligible (no dictionary)"
        : hasScheduleImport
          ? "schedule import takes precedence"
          : "no dictionary";
      logger.log(`[Step 8.5] SKIPPED — ${skipReason}`);
    } else {
      logger.log(
        `[Step 8.5] Calling Claude with ${roomRecords.length} rooms + ${projectSignDictionary.signTypes.length} sign types ` +
          `across ${floorPlanSheets.length} floor-plan sheet(s)...`,
      );

      const dictJson = JSON.stringify(projectSignDictionary, null, 2);

      const estimatorSystemPrompt =
        "You are a licensed sign estimator performing a sign takeoff from architectural floor plans. " +
        "You have been given the project sign dictionary defining every sign type used on this job. " +
        "Walk the floor plan systematically — every labeled room, corridor, and space — and assign " +
        "the correct sign type(s) from the dictionary. " +
        "Return ONLY a valid JSON array — no markdown, no commentary.";

      // Build a room-number → roomId lookup for quick join after Claude returns assignments.
      const roomByNumber = new Map<
        string,
        { id: string; sheetId: string | null }
      >();
      for (const r of roomRecords) {
        if (r.roomNumber)
          roomByNumber.set(r.roomNumber.trim().toUpperCase(), {
            id: r.id,
            sheetId: r.sheetId ?? null,
          });
      }

      for (const fpSheet of floorPlanSheets) {
        const fpBase64 = sheetBase64Map.get(fpSheet.id!);
        if (!fpBase64) {
          logger.log(
            `[pipeline] Step 8.5: No image for sheet "${fpSheet.sheetTitle ?? fpSheet.sheetId}" — skipping`,
          );
          continue;
        }

        try {
          const estimatorUserPrompt =
            `Project Sign Dictionary:\n${dictJson}\n\n` +
            `Walk every labeled room and space on this floor plan (${fpSheet.sheetTitle ?? fpSheet.sheetId}). ` +
            `For each space that requires a sign per the dictionary, return one entry:\n` +
            `[\n` +
            `  {\n` +
            `    "room_number": "101",\n` +
            `    "room_name": "GIRLS RESTROOM",\n` +
            `    "sign_type_code": "A",\n` +
            `    "sign_type_name": "Toilet Sign - Girls",\n` +
            `    "level": "${fpSheet.level ?? "LEVEL 1"}",\n` +
            `    "confidence": 0.95,\n` +
            `    "reasoning": "Room label matches Girls Restroom"\n` +
            `  }\n` +
            `]\n` +
            `Rules:\n` +
            `- Only assign sign types that are in the dictionary.\n` +
            `- Use the code (A, B, 1, 2A …) exactly as defined.\n` +
            `- Skip residential units, mechanical/electrical rooms, and storage unless the dictionary explicitly covers them.\n` +
            `- Confidence 0.9+ means you clearly read the room label; 0.5–0.9 means the label is partially legible or inferred.\n` +
            `- If a room needs multiple different sign types, emit one entry per type.\n` +
            `- If no rooms on this sheet need signs per the dictionary, return an empty array [].`;

          const { text: assignText, usage: assignUsage } =
            await callClaudeVision(
              estimatorSystemPrompt,
              estimatorUserPrompt,
              fpBase64,
              "image/png",
              onRetry,
              aiRetryMax,
              effectiveBaseDelayMs,
              CLAUDE_VISION_MODEL,
            );
          recordAiScan("estimator_assign", assignUsage);

          const assignJson = assignText
            .replace(/^```(?:json)?\s*/i, "")
            .replace(/\s*```\s*$/i, "")
            .trim();
          const assignments = JSON.parse(assignJson) as EstimatorAssignment[];

          if (!Array.isArray(assignments))
            throw new Error("Expected JSON array");

          let sheetCount = 0;
          for (const a of assignments) {
            if (!a.sign_type_name || !a.room_number) continue;

            const conf =
              typeof a.confidence === "number"
                ? Math.min(1, Math.max(0, a.confidence))
                : 0.8;

            // Normalize sign type name through the same mapper used by the schedule import path.
            const canonicalType =
              mapScheduleSignType(a.sign_type_name) ?? a.sign_type_name;

            // Look up the room record if possible.
            const roomKey = a.room_number.trim().toUpperCase();
            const roomRef = roomByNumber.get(roomKey);

            estimatorSignRows.push({
              id: newId("sign"),
              jobId,
              tenantId,
              sheetId: fpSheet.id,
              roomId: roomRef?.id ?? null,
              signType: canonicalType,
              qty: 1,
              ruleRef: `estimator_mode:${a.sign_type_code}`,
              color: null,
              confidence: String(conf),
              status: conf >= 0.9 ? "confirmed" : "needs_review",
              source: "estimator",
              message:
                [a.room_number, a.room_name].filter(Boolean).join(" | ") ||
                undefined,
            });
            sheetCount++;
          }

          logger.log(
            `[pipeline] Step 8.5: Sheet "${fpSheet.sheetTitle ?? fpSheet.sheetId}" — ` +
              `${sheetCount} sign assignment(s) (${assignments.length} total from Claude)`,
          );
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.log(
            `[Step 8.5] Sheet "${fpSheet.sheetTitle ?? fpSheet.sheetId}" FAILED — ${errMsg}`,
          );
          logger.warn(
            `[pipeline] Step 8.5: Sheet "${fpSheet.sheetTitle ?? fpSheet.sheetId}" assignment failed — ` +
              `falling back to rules engine for this job.`,
          );
          // Clear any partial results so the rules engine takes over cleanly.
          estimatorSignRows.length = 0;
          break;
        }
      }

      if (estimatorSignRows.length > 0) {
        logger.log(
          `[Step 8.5] Generated ${estimatorSignRows.length} sign assignments across ${floorPlanSheets.length} sheet(s)`,
        );
        logger.log(`[Step 8.5] Rules engine will be SKIPPED`);
      } else {
        logger.log(
          `[Step 8.5] Generated 0 sign assignments — rules engine will run instead`,
        );
      }
    }

    await wp("8.5", "Estimator mode assignment");

    // -------------------------------------------------------------------------
    // Step 9: Apply rules engine (R1-R17) + tenant overrides
    // Skipped if Step 4b produced a signage schedule import.
    // -------------------------------------------------------------------------
    await wp(9, "Applying rules engine (R1–R17)");

    // Hoisted so Step 10 can access them regardless of the skip path.
    let ruleOutput: ReturnType<typeof applyRules> | null = null;
    const signRows: (typeof signsTable.$inferInsert)[] = [];

    // When a dedicated sign schedule PDF is uploaded, always run the rules engine so signs
    // get assigned to actual rooms — the schedule's sign types are applied as a whitelist
    // filter after the engine runs (see below).  Only skip the rules engine when the
    // schedule came from an A-7XX/combo sheet where the rows are already room-matched.
    const skipRulesForSchedule =
      hasScheduleImport && dedicatedSignScheduleFiles.length === 0;

    if (!skipRulesForSchedule) {
      // Step 9 explicit routing — log the decision before branching.
      logger.log("[Step 9] Routing sign assignment...");
      logger.log(
        `[Step 9] estimatorSignRows.length = ${estimatorSignRows.length}`,
      );
      logger.log(`[Step 9] estimatorModeEligible = ${estimatorModeEligible}`);

      // When estimator mode produced sign assignments (Step 8.5), use those directly
      // and skip the rules engine entirely.  Otherwise fall through to the rules engine.
      if (estimatorSignRows.length > 0) {
        logger.log(
          `[Step 9] MODE: estimator — using ${estimatorSignRows.length} estimator rows`,
        );
        signRows.push(...estimatorSignRows);
        logger.log(
          `[pipeline] Step 9: Using estimator-mode assignments — ` +
            `${signRows.length} sign(s), rules engine SKIPPED`,
        );
      } else {
        logger.log("[Step 9] MODE: rules_engine — estimator produced no rows");

        // Load tenant rule overrides
        const ruleOverrides = await db
          .select()
          .from(ruleOverridesTable)
          .where(
            and(
              eq(ruleOverridesTable.tenantId, tenantId),
              eq(ruleOverridesTable.isActive, true),
            ),
          );

        // Load active training corrections and convert to rule-override shape
        const trainingCorrections = await db
          .select()
          .from(trainingCorrectionsTable)
          .where(
            and(
              eq(trainingCorrectionsTable.tenantId, tenantId),
              eq(trainingCorrectionsTable.isActive, true),
            ),
          );

        const correctionOverrides = trainingCorrections
          .filter((c) => c.roomNamePattern && c.signType)
          .map((c) => ({
            ruleRef: c.ruleRef ?? "training_correction",
            overrideType: "sign_type",
            condition: { roomNamePattern: c.roomNamePattern } as Record<
              string,
              unknown
            >,
            action: { signType: c.signType } as Record<string, unknown>,
          }));

        const ruleInput = {
          rooms: roomRecords,
          buildingType: finalBuildingType,
          ruleOverrides: [
            ...correctionOverrides, // Training corrections first — highest priority
            ...ruleOverrides.map((o) => ({
              ruleRef: o.ruleRef,
              overrideType: o.overrideType,
              condition: o.condition as Record<string, unknown>,
              action: o.action as Record<string, unknown>,
            })),
          ],
          customMultiEntryKeywords,
        };

        logger.log(
          `[pipeline] Step 9: Loaded ${correctionOverrides.length} training correction(s): ${correctionOverrides.map((c) => `${c.condition.roomNamePattern}→${c.action.signType}`).join(", ")}`,
        );

        ruleOutput = applyRules(ruleInput);

        // Build sign rows to insert

        // Clamp a coordinate value to the valid 0-1000 normalized range.
        const clampCoord = (v: number | null | undefined): number | null => {
          if (v == null) return null;
          return Math.max(0, Math.min(1000, v));
        };

        // Per-room signs
        for (const result of ruleOutput.results) {
          for (const sa of result.signs) {
            const firstFpSheetId =
              floorPlanSheets.find((s) => s.level === result.room.level)?.id ??
              floorPlanSheets[0]?.id;
            signRows.push({
              id: newId("sign"),
              jobId,
              tenantId,
              roomId: result.room.id,
              sheetId: result.room.sheetId ?? firstFpSheetId ?? null,
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
            });
          }
        }

        // Stair signs (level-aggregate)
        for (const sa of ruleOutput.stairSigns) {
          signRows.push({
            id: newId("sign"),
            jobId,
            tenantId,
            roomId: null,
            sheetId: floorPlanSheets[0]?.id ?? null,
            signType: sa.signType,
            qty: sa.qty,
            ruleRef: sa.ruleRef,
            color: sa.color,
            confidence: String(sa.confidence),
            status: "extracted",
            source: "rules_engine",
            dimensions: sa.dimensions ?? null,
            dimSource: sa.dimSource ?? null,
          });
        }

        // Elevator signs
        for (const sa of ruleOutput.elevatorSigns) {
          signRows.push({
            id: newId("sign"),
            jobId,
            tenantId,
            roomId: null,
            sheetId: floorPlanSheets[0]?.id ?? null,
            signType: sa.signType,
            qty: sa.qty,
            ruleRef: sa.ruleRef,
            color: sa.color,
            confidence: String(sa.confidence),
            status: "extracted",
            source: "rules_engine",
            dimensions: sa.dimensions ?? null,
            dimSource: sa.dimSource ?? null,
          });
        }

        // Evac map signs
        for (const sa of ruleOutput.evacMapSigns) {
          signRows.push({
            id: newId("sign"),
            jobId,
            tenantId,
            roomId: null,
            sheetId: floorPlanSheets[0]?.id ?? null,
            signType: sa.signType,
            qty: sa.qty,
            ruleRef: sa.ruleRef,
            color: sa.color,
            confidence: String(sa.confidence),
            status: "extracted",
            source: "rules_engine",
            dimensions: sa.dimensions ?? null,
            dimSource: sa.dimSource ?? null,
          });
        }

        const correctionCount = signRows.filter(
          (s) => s.ruleRef === "training_correction",
        ).length;
        if (correctionCount > 0) {
          logger.log(
            `[pipeline] Applied ${correctionCount} training correction(s) to sign rows`,
          );
        }
      } // end: else (rules engine path)

      // Restroom-only scope filter: suppress Room ID, Exit, Stair, Elevator, etc.
      if (restroomOnlyScope) {
        const before = signRows.length;
        signRows.splice(
          0,
          signRows.length,
          ...signRows.filter(
            (s) => !RESTROOM_ONLY_EXCLUDED_SIGN_TYPES.has(s.signType ?? ""),
          ),
        );
        logger.log(
          `[pipeline] Step 9: Restroom-only scope — suppressed ${before - signRows.length} non-restroom sign(s), ` +
            `${signRows.length} restroom sign(s) remain`,
        );
      }

      // Dedicated sign schedule whitelist: when a sign schedule PDF was uploaded, keep ONLY
      // sign types that appear in it.  This ensures the rules engine output is constrained
      // to what the architect actually specified — Room ID, Exit, Stair, etc. are silently
      // dropped when they are absent from the schedule.
      if (
        dedicatedSignScheduleFiles.length > 0 &&
        scheduleSignRows.length > 0
      ) {
        const allowedTypes = new Set(
          scheduleSignRows
            .map((r) => r.signType)
            .filter((t): t is string => !!t),
        );
        const before = signRows.length;
        signRows.splice(
          0,
          signRows.length,
          ...signRows.filter((s) => allowedTypes.has(s.signType ?? "")),
        );
        logger.log(
          `[pipeline] Step 9: Schedule whitelist (${allowedTypes.size} type(s): ${[...allowedTypes].join(", ")}) — ` +
            `kept ${signRows.length} of ${before} sign(s)`,
        );
      }

      // Signage-notes sheet whitelist: constrain rules engine output to sign types
      // defined on an embedded signage-notes sheet (e.g. "A0. Signage Notes").
      if (signageNotesWhitelist && signageNotesWhitelist.size > 0) {
        const before = signRows.length;
        signRows.splice(
          0,
          signRows.length,
          ...signRows.filter((s) =>
            signageNotesWhitelist!.has(s.signType ?? ""),
          ),
        );
        logger.log(
          `[pipeline] Step 9: Signage notes whitelist "${signageNotesSheetName}" ` +
            `(${signageNotesWhitelist.size} type(s)) — kept ${signRows.length} of ${before} sign(s)`,
        );
      }

      await withStepTimeout("Step 9 (sign insert)", async () => {
        if (signRows.length > 0) {
          await db.insert(signsTable).values(signRows);
        }
      });

      logger.log(
        `[pipeline] Step 9: Inserted ${signRows.length} rules-engine sign(s) for job ${jobId}`,
      );
    } else {
      // A-7XX / combo-sheet schedule path — rows already matched to rooms, insert directly.
      await withStepTimeout("Step 9 (schedule sign insert)", async () => {
        if (scheduleSignRows.length > 0) {
          await db.insert(signsTable).values(scheduleSignRows);
        }
      });
      logger.log(
        `[pipeline] Step 9: A-7XX/combo schedule — inserted ${scheduleSignRows.length} room-matched sign(s) for job ${jobId}`,
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
            db
              .update(signsTable)
              .set({ canvasX: placement.canvasX, canvasY: placement.canvasY })
              .where(eq(signsTable.id, s.id)),
          );
        }
      }
      if (restorations.length > 0) {
        await Promise.all(restorations);
        logger.log(
          `[pipeline] Restored ${restorations.length} manually placed marker(s) after rescan`,
        );
      }
    }

    // -------------------------------------------------------------------------
    // Step 10: Validation checks + save results
    // -------------------------------------------------------------------------
    await wp(10, "Validating results and generating schedule");

    const checks = ruleOutput ? runValidationChecks(ruleOutput) : [];

    await db
      .delete(validationResultsTable)
      .where(eq(validationResultsTable.jobId, jobId));
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
        message: signsTable.message,
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
      const roomByNumber = new Map<string, (typeof jobRooms)[0]>();
      for (const room of jobRooms) {
        if (room.roomNumber) roomByNumber.set(room.roomNumber, room);
      }

      let markerUpdates = 0;
      await Promise.all(
        signsWithoutMarkers.map(async (sign) => {
          // Resolve room: prefer existing roomId, else parse room number from message.
          let room = sign.roomId
            ? (jobRooms.find((r) => r.id === sign.roomId) ?? null)
            : null;

          if (!room && sign.message) {
            // Message format: "S1 | 1101 | ROOM NAME"
            const parts = sign.message.split(" | ");
            const roomNumber = parts[1]?.trim();
            if (roomNumber) room = roomByNumber.get(roomNumber) ?? null;
          }

          if (!room) return;

          // coordX / coordY are already 0-1000 normalized — use directly as markerX / markerY.
          const mx =
            room.coordX != null
              ? Math.max(0, Math.min(1000, room.coordX))
              : null;
          const my =
            room.coordY != null
              ? Math.max(0, Math.min(1000, room.coordY))
              : null;
          if (mx == null || my == null) return;

          await db
            .update(signsTable)
            .set({ roomId: room.id, markerX: mx, markerY: my })
            .where(eq(signsTable.id, sign.id));

          markerUpdates++;
        }),
      );

      logger.log(
        `[pipeline] Step 10b: Populated markers for ${markerUpdates}/${signsWithoutMarkers.length} sign(s)`,
      );
    }

    // -------------------------------------------------------------------------
    // Pre-completion validation gate
    // -------------------------------------------------------------------------
    const floorPlanSheetCount = sheetDbRows.filter(
      (s) => s.sheetType === "floor_plan",
    ).length;
    // Use the vision-confirmed count as the authoritative floor plan count.
    // Fall back to the rules-engine count for jobs processed before this change.
    const effectivePlanCount = Math.max(
      floorPlanSheetCount,
      visionConfirmedPlanCount,
    );
    if (
      effectivePlanCount > 0 &&
      extractedRooms.length === 0 &&
      !hasScheduleImport
    ) {
      throw new Error(
        `No rooms could be extracted from ${effectivePlanCount} floor plan sheet(s). ` +
          "Verify that the uploaded PDFs contain readable room labels and numbers, " +
          "or that the sidecar word-extraction results are non-empty.",
      );
    }

    // Update job summary stats — use schedule rows when rules engine was skipped.
    const allSignRows = hasScheduleImport ? scheduleSignRows : signRows;
    const totalSigns = allSignRows.reduce((sum, s) => sum + (s.qty ?? 1), 0);
    const highConfidence = allSignRows.filter(
      (s) => parseFloat(String(s.confidence)) >= 0.7,
    ).length;
    const needsReview = allSignRows.filter(
      (s) => parseFloat(String(s.confidence)) < 0.7,
    ).length;

    // ── PIPELINE SUMMARY ─────────────────────────────────────────────────────
    {
      const pipelineMode = hasScheduleImport
        ? "schedule_import"
        : estimatorSignRows.length > 0
          ? "estimator"
          : "rules_engine";

      const pipelineReason = hasScheduleImport
        ? "dedicated_sign_schedule_uploaded"
        : estimatorSignRows.length > 0
          ? `dictionary_found_with_${projectSignDictionary?.signTypes.length ?? 0}_types`
          : _signageNotesFound.length === 0
            ? "no_signage_sheet"
            : !estimatorModeEligible
              ? "dictionary_extraction_failed"
              : "estimator_returned_empty";

      const scopeApplied = restroomOnlyScope
        ? "restroom_only"
        : projectSignDictionary?.scope === "full_building"
          ? "full_building"
          : "none";

      // Name of the signage notes sheet used (A0.x or title-matched).
      const sigNotesSrc = (() => {
        if (_signageNotesFound.length > 0) return _signageNotesFound.join(", ");
        if (projectSignDictionary?.sourceSheet)
          return projectSignDictionary.sourceSheet;
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
        last.durationMs =
          new Date(completionTime).getTime() -
          new Date(last.startedAt).getTime();
        last.status = "completed";
      }
    }

    const completedProgress: PipelineProgress = {
      step: TOTAL_STEPS,
      totalSteps: TOTAL_STEPS,
      label: "Completed",
      startedAt,
      stepStartedAt: completionTime,
      estimatedTotalSeconds:
        _knownSheetCount != null && _knownSheetCount > 0
          ? Math.max(
              ESTIMATED_TOTAL_SECONDS,
              _knownSheetCount * ESTIMATED_SECONDS_PER_SHEET,
            )
          : ESTIMATED_TOTAL_SECONDS,
      estimatedSecondsPerSheet: ESTIMATED_SECONDS_PER_SHEET,
      retryLog,
      ...(_aiRetryMax !== undefined && { aiRetryMax: _aiRetryMax }),
      ...(_effectiveBaseDelayMs !== undefined && {
        effectiveBaseDelayMs: _effectiveBaseDelayMs,
      }),
    };

    await db
      .update(jobsTable)
      .set({
        status: "completed",
        totalSigns,
        highConfidence,
        needsReview,
        hasScheduleImport,
        aiTokenCost: String(totalAiCost.value.toFixed(6)),
        // Only persist what the user explicitly selected — never overwrite with auto-detected value.
        buildingType: job.buildingType ?? null,
        scopeFlag: restroomOnlyScope ? "restroom_only" : null,
        metadata: {
          progress: completedProgress,
          steps: pipelineSteps,
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
          projectSignDictionary: projectSignDictionary ?? null,
          estimatorModeEligible,
        },
      })
      .where(eq(jobsTable.id, jobId));

    logger.log(
      `[pipeline] Job ${jobId} completed. ${totalSigns} total signs, ${ruleOutput?.results?.length ?? scheduleSignRows.length} sign source record(s). scheduleImport=${hasScheduleImport}`,
    );
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
        last.durationMs =
          new Date(now).getTime() - new Date(last.startedAt).getTime();
        last.status = "failed";
      }
    }

    const errorMetadata: Record<string, unknown> = {
      errorMessage,
      failedAt: now,
      steps: pipelineSteps,
      processingStartedAt: startedAt,
    };
    if (lastProgress) {
      errorMetadata.progress = lastProgress;
    }

    await db
      .update(jobsTable)
      .set({ status: "error", metadata: errorMetadata })
      .where(eq(jobsTable.id, jobId));

    throw err;
  }
}
