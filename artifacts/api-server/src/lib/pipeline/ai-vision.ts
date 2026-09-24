import { isRateLimitError } from "@workspace/integrations-anthropic-ai/batch";
import { ai as geminiAi } from "@workspace/integrations-gemini-ai";
import { claudeVisionBaseDelayMs, roomExtractionModel, scheduleModel, visionModel } from "../config";
import { time as timeOp } from "../timing";
import type { SignTypeDictionaryEntry } from "./types";

export const CLAUDE_VISION_MODEL = visionModel;
/** Model used for floor-plan room extraction (one call per sheet / tile). */

export const CLAUDE_ROOM_EXTRACTION_MODEL = roomExtractionModel;
/** Model used for dense schedule / plaque / specialty table extraction. */

export const CLAUDE_SCHEDULE_MODEL = scheduleModel;

export const CLAUDE_VISION_PROVIDER = "Google";

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
  const raw = typeof settings.aiRetryMax === "number" ? settings.aiRetryMax : CLAUDE_RETRY_MAX_DEFAULT;
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

export interface ClaudeUsage {
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
  if (msg.includes("rate_limit") || msg.includes("rate limit") || msg.includes("429")) return "rate_limit";
  if (msg.includes("overload") || msg.includes("529") || msg.includes("503")) return "overload";
  if (msg.includes("timeout") || msg.includes("timed out") || msg.includes("etimedout")) return "timeout";
  if (msg.includes("econnreset") || msg.includes("econnrefused") || msg.includes("socket hang up") || msg.includes("network") || msg.includes("enotfound")) return "network";
  if (msg.includes("500") || msg.includes("502") || msg.includes("504") || msg.includes("internal server error")) return "server_error";
  return "api_error";
}

/**
 * Phase 0 timing wrapper around the Gemini SDK call. Every Gemini call in this
 * module routes through here (the `geminiAi.models.generateContent(` calls were
 * rewritten to `timedGenerate(`), so the per-job timing breakdown captures total
 * Gemini time split by model. Behaviour is identical to calling the SDK directly.
 * See lib/timing.ts.
 */

export function timedGenerate(
  params: Parameters<typeof geminiAi.models.generateContent>[0],
): ReturnType<typeof geminiAi.models.generateContent> {
  const rawModel = (params as { model?: unknown }).model;
  const model = typeof rawModel === "string" ? rawModel : "unknown";
  return timeOp(`gemini:${model}`, () => geminiAi.models.generateContent(params), { model });
}

export async function callClaudeVision(
  systemPrompt: string,
  userPrompt: string,
  imageBase64: string,
  mediaType: "image/png" | "image/jpeg" = "image/png",
  onRetry?: (attempt: number, errorType: string, errorMessage: string) => Promise<void>,
  maxRetries: number = CLAUDE_VISION_MAX_RETRIES,
  baseDelayMs: number = claudeVisionBaseDelayMs,
  model: string = CLAUDE_VISION_MODEL,
  temperature?: number,
): Promise<{ text: string; usage: ClaudeUsage; provider: string }> {
  // Gemini has no separate system-prompt field, so combine both into one part.
  const combinedPrompt = [systemPrompt, userPrompt].filter(Boolean).join("\n\n");

  // Clamp to at least 1 so the loop always runs one initial attempt.
  const effectiveMaxRetries = Math.max(1, maxRetries);

  let lastError: unknown;
  let delay = baseDelayMs;
  for (let attempt = 1; attempt <= effectiveMaxRetries; attempt++) {
    try {
      const response = await timedGenerate({
        model,
        contents: [{
          role: "user",
          parts: [
            { inlineData: { mimeType: mediaType, data: imageBase64 } },
            { text: combinedPrompt },
          ],
        }],
        config: {
          // A dense floor-plan sheet can yield 90-120 rooms (~6 lines / ~70
          // tokens each). 8192 truncated those responses mid-array, breaking the
          // JSON parse and dropping the whole sheet. Billing is per token
          // generated (not per cap), so a larger ceiling costs nothing extra.
          maxOutputTokens: 32768,
          ...(temperature !== undefined ? { temperature } : {}),
        },
      });

      const text = response.text ?? "";
      // Extract actual token usage from Gemini response to track real cost.
      // The Google AI SDK returns usageMetadata on the GenerateContentResponse.
      const _um = (response as unknown as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } }).usageMetadata;
      const inputTokens = _um?.promptTokenCount ?? 0;
      const outputTokens = _um?.candidatesTokenCount ?? 0;
      // Gemini 2.5 Pro pricing (≤200K context): $1.25/1M input, $10.00/1M output
      // Gemini 2.5 Flash pricing: $0.15/1M input, $0.60/1M output
      // Using model string to pick the correct tier
      const _isFlash = model.includes("flash");
      const _inputPrice = _isFlash ? 0.15 : 1.25;
      const _outputPrice = _isFlash ? 0.60 : 10.00;
      const cost = (inputTokens / 1_000_000) * _inputPrice + (outputTokens / 1_000_000) * _outputPrice;
      return { text, usage: { inputTokens, outputTokens, cost }, provider: model };
    } catch (err) {
      lastError = err;
      const errorType = classifyApiError(err);
      const errorMessage = err instanceof Error ? err.message : String(err);

      const isRetryable = ["rate_limit", "overload", "timeout", "network", "server_error"].includes(errorType);
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

export interface PlaqueEntry {
  typeId: string;
  name: string;
  braille: boolean;
  hasInsert: boolean;
  insertSize?: string;
  letterHeight?: string;
  mapsToColumn?: string;
  materialNotes?: string;
}

export async function extractPlaqueSchedule(
  imageBase64: string,
  onRetry?: (attempt: number, errorType: string, errorMessage: string) => Promise<void>,
  maxRetries?: number,
  baseDelayMs?: number,
  model: string = CLAUDE_VISION_MODEL,
): Promise<{ entries: PlaqueEntry[]; usage: ClaudeUsage; provider: string }> {
  const { text, usage, provider } = await callClaudeVision(
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
    model,
  );

  let entries: PlaqueEntry[] = [];
  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const raw = JSON.parse(jsonMatch[0]) as Array<Record<string, unknown>>;
      entries = raw.map((e) => ({
        typeId: String(e.type_id ?? e.typeId ?? ""),
        name: String(e.name ?? ""),
        braille: Boolean(e.braille),
        hasInsert: Boolean(e.has_insert ?? e.hasInsert),
        insertSize: e.insert_size ? String(e.insert_size) : undefined,
        letterHeight: e.letter_height ? String(e.letter_height) : undefined,
        mapsToColumn: e.maps_to_column ? String(e.maps_to_column) : undefined,
        materialNotes: e.material_notes ? String(e.material_notes) : undefined,
      })).filter((e) => e.typeId);
    }
  } catch {
    // model couldn't parse — return empty
  }

  return { entries, usage, provider };
}

// ---------------------------------------------------------------------------
// Occupant load extraction
// ---------------------------------------------------------------------------

export interface OccupantLoadEntry {
  roomNumber: string;
  occupantLoad: number;
  occupancyGroup?: string;
}

export async function extractOccupantLoads(
  imageBase64: string,
  onRetry?: (attempt: number, errorType: string, errorMessage: string) => Promise<void>,
  maxRetries?: number,
  baseDelayMs?: number,
): Promise<{ entries: OccupantLoadEntry[]; usage: ClaudeUsage; provider: string }> {
  const { text, usage, provider } = await callClaudeVision(
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
      entries = raw.map((e) => ({
        roomNumber: String(e.room_number ?? e.roomNumber ?? ""),
        occupantLoad: parseInt(String(e.occupant_load ?? e.occupantLoad ?? "0")) || 0,
        occupancyGroup: e.occupancy_group ? String(e.occupancy_group) : undefined,
      })).filter((e) => e.roomNumber && e.occupantLoad >= 0);
    }
  } catch {
    // ignore
  }

  return { entries, usage, provider };
}

// ---------------------------------------------------------------------------
// Step 6b: AI vision room verification helpers
// ---------------------------------------------------------------------------

export interface MissedRoom {
  roomNumber: string;
  roomName: string;
  level: string;
  x?: number;
  y?: number;
  isRestroom?: boolean;
  confidence?: number;
}

export interface VisionResponse {
  isPlanView: boolean;
  floorLevel?: string | null;
  /** Canonical key (new prompt). */
  rooms?: MissedRoom[];
  /** Legacy key — accepted for backward compatibility. */
  missedRooms?: MissedRoom[];
}

/** Threshold: run vision on a sheet only if it has fewer than this many rooms extracted
 *  by the deterministic rules engine. At 3, vision fills in sheets that have very few
 *  confirmed rooms. A job-level visionThreshold override can raise or lower this. */

export const MIN_ROOMS_PER_SHEET_FOR_VISION = 3;

/** Confidence assigned to rooms discovered via AI vision. */

export const AI_VISION_CONFIDENCE = "0.65";

/**
 * Converts a raw level string from Claude or the sheet title into a canonical
 * architectural floor label (e.g. "Basement", "Level 1", "Level 2").
 * Returns null when the sources contain no recognisable floor keyword so
 * the caller can fall back to whatever the sheet metadata says.
 */
/**
 * Infer floor level from a room number using the architectural standard:
 *   - Letter-prefix + leading digit (W206, E127, WC201) → Level N
 *   - Plain 3-digit (206, 127) → Level N
 * Returns null when the room number doesn't follow a recognisable pattern.
 */

export function buildRoomExtractionPrompt(
  sheetTitle: string | null,
  level: string | null,
  trainingContext = "",
  detectedRoomsList = "",
  restroomScope = false,
  buildingType: string | null = null,
): { systemPrompt: string; userPrompt: string } {

  // ── Building-type-specific valid room number rules ──────────────────────
  const roomNumberRules: Record<string, string> = {
    education:
      "VALID room numbers for this building type (Education/School) MUST match one of:\n" +
      "  W + 3 digits  (W100–W999)\n" +
      "  E + 3 digits  (E100–E999)\n" +
      "  WC + 3 digits (WC100–WC999)\n" +
      "  EC + 3 digits (EC100–EC999)\n" +
      "  SA/SB/SC/SD + 2 digits\n" +
      "  EV + 2 digits\n" +
      "REJECT anything else as an annotation: single or double digit numbers (10, 14, 15), " +
      "short codes (W1, E1, M0, V01, A19, C1), and codes ending in .1 .2 .3.",
    school:
      "VALID room numbers for this building type (School) MUST match one of:\n" +
      "  W + 3 digits  (W100–W999)\n" +
      "  E + 3 digits  (E100–E999)\n" +
      "  WC + 3 digits (WC100–WC999)\n" +
      "  EC + 3 digits (EC100–EC999)\n" +
      "  SA/SB/SC/SD + 2 digits\n" +
      "  EV + 2 digits\n" +
      "REJECT anything else.",
    healthcare:
      "VALID room numbers must be 3–4 digits, optionally followed by a single letter (e.g. 101, 202A). " +
      "REJECT 1–2 digit numbers and short letter+digit codes as annotation fragments.",
    residential:
      "VALID room numbers are 3–4 digit unit numbers (e.g. 101, 204B). " +
      "REJECT 1–2 digit numbers as grid lines.",
    hotel:
      "VALID room numbers are 3–4 digit guest room numbers (e.g. 101, 312). " +
      "REJECT 1–2 digit numbers as grid lines.",
    commercial:
      "VALID room numbers are 3–4 digits, optionally with a letter suffix. " +
      "REJECT 1–2 digit numbers and short codes as annotation fragments.",
  };
  const btKey = (buildingType ?? "").toLowerCase().trim();
  const roomNumberRule = roomNumberRules[btKey] ?? roomNumberRules["commercial"];

  const systemPrompt =
    "You are a construction document analyst. Return only valid JSON — no explanations.\n\n" +

    "CRITICAL — DO NOT extract these as rooms. Ignore ALL of the following:\n\n" +

    "DRAWING ANNOTATION CALLOUTS:\n" +
    "Any alphanumeric tag ending in .1 .2 .3 etc (e.g. W139.1, E100.2, SA01.1, WC100.3). " +
    "These are drawing reference tags, NOT room numbers. Ignore any token that contains a decimal point.\n\n" +

    "DIMENSION STRINGS:\n" +
    "Any text containing feet/inch notation or NxN format: " +
    "8'-0'', 6'-0'', MB 8'-0'', TB 4'-0'', 60X21, 48X21, 36X24. " +
    "These are casework and marker board dimensions — NOT room names.\n\n" +

    "DRAWING GRID REFERENCES:\n" +
    "Single letters or numbers at sheet margins (A B C D … N, 1 2 3 … 9) and grid intersection labels (A.1, K.4, L.2). " +
    "These are column/row grid lines — NOT rooms.\n\n" +

    "SIGNAGE LEGEND CODES:\n" +
    "19A 19B 19C 19D 19E 19F 19G 19H 19I 19J and similar number+letter codes from a legend box. " +
    "1 2 3 4 5 6 7 8 9 10A 10B 10C 10D 11A 11B 12 13 14 15 16 16A. " +
    "These are sign type legend symbols printed in a bordered table at the bottom of the sheet — NOT rooms.\n\n" +

    "MARKER/TACKBOARD CALLOUTS:\n" +
    "MB 8'-0'', MB 6'-0'', TB 4'-0'', TB 6'-0'', CB 8'-0'', MIRROR 4'-0''. " +
    "These are wall-mounted board callouts — NOT rooms.\n\n" +

    "PARTIAL/SPLIT WORDS:\n" +
    "KIT EN (= KITCHEN split across lines), CAF ERIA (= CAFETERIA split), " +
    "MECHANI CAL, CORRI DOR, RY CT, and any other word that is clearly a fragment. " +
    "If a word appears split, skip it entirely — the full room label appears elsewhere on the plan.\n\n" +

    `${roomNumberRule}`;

  const detectedBlock = detectedRoomsList.trim()
    ? `Here is a list of rooms already detected on this floor plan from text extraction:\n${detectedRoomsList}\n\n`
    : "No rooms have been detected yet on this floor plan from text extraction.\n\n";

  // When the drawing set is restroom-focused, ask the model to apply a 15%-lower
  // confidence threshold so borderline restroom rooms are included rather than skipped.
  const confidenceRule = restroomScope
    ? "- confidence: your confidence that this room is genuinely missing (0.0 = uncertain, 1.0 = certain). For restroom rooms (TOILET, RESTROOM, LAVATORY, RR, WC, BATHROOM) include the room when confidence ≥ 0.50 — it is better to over-detect restrooms than miss them."
    : "- confidence: your confidence that this room is genuinely missing (0.0 = uncertain, 1.0 = certain).";

  const residentialBlock = btKey === "residential"
    ? "\n\nRESIDENTIAL BUILDINGS: Floor plans often label apartment or condo units in formats like 'SEE UNIT A A209', 'UNIT B301', or a standalone alphanumeric like 'A209' near a door symbol or unit outline. The alphanumeric code (A209, B301, 101) is the room identifier — not the descriptive label above it like 'SEE UNIT A'. Extract each unit number as a separate room entry, using the alphanumeric code as the roomNumber field. Do not collapse multiple unit numbers into a single entry. Each individual unit number is a separate sign location."
    : "";

  const userPrompt = `${detectedBlock}Look at the floor plan image and identify ONLY rooms that are missing from this list. A room is missing if it has a visible room number or name label on the plan that is NOT in the detected list above.

Respond ONLY with valid JSON:
{
  "rooms": [
    { "roomNumber": "<string>", "roomName": "<string>", "confidence": <0.0–1.0> }
  ]
}

If no rooms are missing, return: { "rooms": [] }

Rules:
- roomNumber: copy the room number EXACTLY as printed on the plan. Use "" if no number is visible.
- roomName: copy the room label text exactly as printed on the plan. Use "ROOM" if no name label is visible.
- PRESERVE FUNCTIONAL QUALIFIERS: when a room label pairs a function word — ELEV, ELEVATOR, LIFT, STAIR, MECH, ELEC, IDF, MDF, TELECOM, JANITOR, STORAGE — with a generic word like LOBBY, ROOM, VESTIBULE, or CORRIDOR, keep the qualifier in roomName (e.g. "ELEV LOBBY", NOT "LOBBY"; "ELEC STAIR", NOT "STAIR"). The qualifier determines the sign type, so dropping it silently changes the result. The qualifier may sit on a separate line directly above or beside the generic word — include it.
${confidenceRule}
- Only include rooms whose label is clearly visible on the overhead floor plan. Ignore schedule tables, legends, title blocks, and elevations/sections.
- Do NOT include annotation callouts, dimension strings, grid references, legend codes, or split words (see system prompt for full exclusion list).
- Do NOT include rooms already in the detected list above.${trainingContext ? `\n\n${trainingContext}` : ""}${residentialBlock}`;

  return { systemPrompt, userPrompt };
}

// ---------------------------------------------------------------------------
// Signage schedule table parser (Step 4b)
// ---------------------------------------------------------------------------
