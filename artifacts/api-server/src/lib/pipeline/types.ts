// Shared pipeline domain types.

export interface SignScheduleEntry {
  roomNumber: string;
  roomName: string;
  signType: string;
  typeMark?: string | null;
  quantity: number;
  size: string;
  message: string;
  notes: string;
  floor?: string | null;
  source: "text" | "gemini";
  sheetId: string;
  substrate:      string | null;
  finishMethod:   string | null;
  brailleSpec:    string | null;
  mountingHeight: string | null;
  manufacturer:   string | null;
}

/**
 * Step 4b cross-path dedup: removes entries where sheetId + roomNumber +
 * signType collide (trimmed, lowercased).  Mutates the array in-place and
 * returns it so callers can use it inline.
 */

export interface SignTypeDictionaryEntry {
  code: string;       // "A", "B", "1", "2A", etc.
  name: string;       // "Toilet Sign – Girls", "Room ID", etc.
  placement?: string; // "above door", "latch side", "60 inches AFF"
  dimensions?: string;
  category: string;   // "restroom" | "room_id" | "exit" | "stair" | "elevator" | "wayfinding" | "other"
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

// ---------------------------------------------------------------------------
// Claude vision helpers
// ---------------------------------------------------------------------------

// Model ids are operator-configurable (env: VISION_MODEL / ROOM_EXTRACTION_MODEL /
// SCHEDULE_MODEL) so the pipeline can be upgraded to a Gemini 3 model and rolled
// back without a code change. Defaults preserve the proven gemini-2.5 behaviour;
// validate any swap with scripts/takeoff-eval before rollout.
