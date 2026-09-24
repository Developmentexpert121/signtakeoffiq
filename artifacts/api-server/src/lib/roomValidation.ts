/**
 * Shared room validation module.
 *
 * Used by BOTH the fresh extraction path and the cache restore path in the
 * pipeline so they can never diverge.  Also used by the allowlist post-filter
 * before rooms are written to the database.
 */

// ---------------------------------------------------------------------------
// Valid room number patterns — keyed by canonical building type
// ---------------------------------------------------------------------------

export const VALID_ROOM_NUMBER_PATTERNS: Record<string, RegExp[]> = {
  education: [
    /^[WE]C?\d{3}[A-Z]?$/i,    // W123, E456A, WC100, EC110A
    /^S[ABCD]\d{2}$/i,          // SA01, SB02, SC12, SD03
    /^EV\d{2}$/i,               // EV01, EV02
  ],
  school: [
    /^[WE]C?\d{3}[A-Z]?$/i,
    /^S[ABCD]\d{2}$/i,
    /^EV\d{2}$/i,
  ],
  healthcare: [/^\d{3,4}[A-Z]?$/, /^[A-Z]{1,3}\d{3}$/i],
  hospital:   [/^\d{3,4}[A-Z]?$/, /^[A-Z]{1,3}\d{3}$/i],
  office:     [/^\d{3,4}[A-Z]?$/, /^[A-Z]\d{3}$/i],
  commercial: [/^\d{3,4}[A-Z]?$/, /^[A-Z]\d{3}$/i],
  government: [/^\d{3,4}[A-Z]?$/, /^[A-Z]-?\d{3}$/i],
  hotel:      [/^\d{3,4}[A-Z]?$/],
  residential:[/^\d{3,4}[A-Z]?$/],
  assembly:   [/^\d{3,4}[A-Z]?$/, /^[A-Z]{1,2}-?\d{2,3}$/i],
  unknown:    [/^.{2,10}$/],
};

/**
 * Returns true when the room number is valid for the given building type.
 * Falls back to permissive matching when no pattern list is configured.
 */
export function isValidRoomNumber(roomNumber: string, buildingType: string): boolean {
  const key = buildingType.toLowerCase().trim();
  const patterns = VALID_ROOM_NUMBER_PATTERNS[key] ?? VALID_ROOM_NUMBER_PATTERNS.unknown;
  return patterns.some((p) => p.test(roomNumber));
}

// ---------------------------------------------------------------------------
// Garbled name detection
// ---------------------------------------------------------------------------

/**
 * Patterns that definitively identify garbled room names — legend callouts,
 * dimension strings, LEED code fragments, and PDF split-word artefacts.
 * Any single match means the name is invalid.
 */
export const GARBLED_NAME_PATTERNS: RegExp[] = [
  /\d+[Xx]\d+/,           // casework dimensions: 60X21, 48X24
  /\d+'-\d/,              // imperial dimensions: 8'-0'', 4'-6''
  /\bTO\s+[EW]\d/i,       // callout ranges: E119C.1 TO E119C.2
  /(\.\d+){2,}/,          // dotted callout refs: .1 .1 .1
  /\b19[A-J]\b/,          // LEED sign codes: 19A, 19B, 19E
  /\bMB\b.*\d|\d.*\bMB\b/i,  // marker-board callouts with adjacent number
  /\bTB\b.*\d|\d.*\bTB\b/i,  // tackboard callouts with adjacent number
  // Known PDF split-word artefacts (word broken at render boundary)
  /\bRY\s+CT\b/i,         // fragment: …PANTRY COAT… or similar
  /\bKIT\s+EN\b/i,        // fragment: KITCHEN
  /\bCAF\s+ERIA\b/i,      // fragment: CAFETERIA
  /\bAFETER\b/i,          // fragment: cAFETERia
];

/**
 * Returns true when the room name is a valid, readable room label.
 * Requires:
 *   - Non-empty and at least 2 characters long
 *   - Does not match any GARBLED_NAME_PATTERNS entry
 *   - At least 40% of its characters are alphabetic
 */
export function isValidRoomName(name: string | null | undefined): boolean {
  if (!name) return false;
  const trimmed = name.trim();
  if (trimmed.length < 2) return false;

  if (GARBLED_NAME_PATTERNS.some((p) => p.test(trimmed))) return false;

  // Alpha-density gate: at least 40% of non-space characters must be letters.
  const noSpace = trimmed.replace(/\s+/g, "");
  if (noSpace.length > 3) {
    const alphaCount = (noSpace.match(/[A-Za-z]/g) ?? []).length;
    if (alphaCount / noSpace.length < 0.40) return false;
  }

  return true;
}
