export function inferLevelFromRoomNumber(roomNumber: string): string | null {
  const rn = roomNumber.trim().toUpperCase();
  // Letter-prefix: W206, E127, WC301, EC312, SA21 …
  const letterMatch = /^[A-Z]{1,3}([0-9])\d{2}/.exec(rn);
  if (letterMatch) {
    const d = parseInt(letterMatch[1], 10);
    return d === 0 ? "LEVEL B1" : `LEVEL ${d}`;
  }
  // Plain 3-digit (avoid 4-digit hospital room IDs which start with floor independently)
  const plainMatch = /^([0-9])\d{2}(?:[A-Z])?$/.exec(rn);
  if (plainMatch) {
    const d = parseInt(plainMatch[1], 10);
    return d === 0 ? "LEVEL B1" : `LEVEL ${d}`;
  }
  return null;
}

/**
 * Extract a building identifier from a room number that encodes the building as a
 * trailing or leading letter suffix/prefix.
 *
 * Examples:
 *   "101A"  → "A"   (number + single letter suffix — Tower District style)
 *   "A101"  → "A"   (single letter prefix + number — wing-prefix style)
 *   "1012"  → null  (plain number, no building indicator)
 *   "WC301" → null  (multi-letter prefix already captured by inferLevelFromRoomNumber)
 *
 * Returns the single capital letter, or null when the pattern is not recognised.
 */

export function extractBuildingFromRoomNumber(roomNumber: string): string | null {
  const rn = roomNumber.trim().toUpperCase();
  // Trailing single letter on a 3–4 digit number: 101A, 2210B
  const suffixMatch = /^\d{3,4}([A-Z])$/.exec(rn);
  if (suffixMatch) return suffixMatch[1];
  // Leading single letter on a 3–4 digit number: A101, B2034
  const prefixMatch = /^([A-Z])\d{3,4}$/.exec(rn);
  if (prefixMatch) return prefixMatch[1];
  return null;
}

/**
 * Normalize any raw level string to the canonical "LEVEL N" format.
 * Examples: "First Floor" → "LEVEL 1", "2nd" → "LEVEL 2", "level-3" → "LEVEL 3".
 * Returns "LEVEL 1" for null/empty input.
 * Call this ONLY at the two DB-write sites (final room insert and sign floorLabel).
 */

export function normalizeLevel(raw: string): string {
  if (!raw) return "LEVEL 1";
  const t = raw.trim();
  // Already canonical (e.g. "LEVEL 2", "LEVEL B1", "MEZZANINE", "ROOF")
  if (/^LEVEL\s+\S+$/i.test(t) || /^(MEZZANINE|ROOF|PARKING|LEVEL B\d+)$/i.test(t)) {
    return t.toUpperCase();
  }
  // "Level 2", "Floor 3", "FL 1", "L2" patterns
  const m = t.match(/^(?:level|floor|fl|l)\s*[-–]?\s*(\w+)$/i);
  if (m) return `LEVEL ${m[1].toUpperCase()}`;
  // Plain digit(s) only — treat as floor number
  if (/^\d+$/.test(t)) return `LEVEL ${t}`;
  // Named floors
  const u = t.toUpperCase();
  if (/^FIRST/.test(u) || /^1ST/.test(u) || /^GROUND/.test(u)) return "LEVEL 1";
  if (/^SECOND/.test(u) || /^2ND/.test(u)) return "LEVEL 2";
  if (/^THIRD/.test(u) || /^3RD/.test(u)) return "LEVEL 3";
  if (/^FOURTH/.test(u) || /^4TH/.test(u)) return "LEVEL 4";
  if (/^FIFTH/.test(u) || /^5TH/.test(u)) return "LEVEL 5";
  if (/BASEMENT|LOWER LEVEL|^B1$/.test(u)) return "LEVEL B1";
  if (/MEZZ/.test(u)) return "MEZZANINE";
  if (/\bROOF\b/.test(u)) return "ROOF";
  return u;
}

export function parseLevelFromContext(
  rawLevel: string | null,
  sheetTitle: string | null,
  roomNumber?: string | null,
): string | null {
  // Pass 0 — room number prefix, highest priority for letter-prefix rooms.
  // W206, E127, WC301 are unambiguously "Level 2", "Level 1", "Level 3" by convention.
  // Only overrides rawLevel when rawLevel is absent or the generic "LEVEL 1" default
  // (which Claude often hallucinates on multi-floor PDFs with noisy title blocks).
  if (roomNumber) {
    const rnLevel = inferLevelFromRoomNumber(roomNumber);
    if (rnLevel) {
      const rawUpper = (rawLevel ?? "").toUpperCase().trim();
      // Trust room number over "LEVEL 1" (common Claude default) and over absent level.
      // Yield to explicit "LEVEL 2+", "2ND FLOOR", etc. from Claude — those are deliberate.
      const rawIsGenericOrAbsent =
        !rawUpper ||
        rawUpper === "LEVEL 1" ||
        rawUpper.startsWith("FIRST") ||
        rawUpper.startsWith("GROUND") ||
        rawUpper.startsWith("GRADE");
      if (rawIsGenericOrAbsent) return rnLevel;
    }
  }

  const sources = [rawLevel, sheetTitle].filter(Boolean).map(s => s!.toUpperCase());

  // Pass 1 — keyword match from level string or sheet title
  for (const src of sources) {
    if (src.includes("BASEMENT") || src.includes("B1") || src.includes("LOWER LEVEL"))
      return "LEVEL B1";
    if (src.includes("GROUND") || src.includes("GRADE") || src.includes("LEVEL 1") || src.includes("1ST"))
      return "LEVEL 1";
    if (src.includes("LEVEL 2") || src.includes("2ND") || src.includes("SECOND"))
      return "LEVEL 2";
    if (src.includes("LEVEL 3") || src.includes("3RD") || src.includes("THIRD"))
      return "LEVEL 3";
    if (src.includes("LEVEL 4") || src.includes("4TH") || src.includes("FOURTH"))
      return "LEVEL 4";
    if (src.includes("LEVEL 5") || src.includes("5TH") || src.includes("FIFTH"))
      return "LEVEL 5";
    if (src.includes("MEZZANINE") || src.includes("MEZZ"))
      return "MEZZANINE";
    if (src.includes("ROOF"))
      return "ROOF";
  }

  // Pass 2 — room number prefix fallback.
  // Handles both plain-digit (2xx → LEVEL 2) and letter-prefix (W2xx, E2xx → LEVEL 2).
  // Also handles B-prefix (B01, BS-1) and P-prefix (P1, P-2) for parking/basement.
  if (roomNumber) {
    const rn = roomNumber.trim().toUpperCase();
    // Letter-prefix pattern: W206, E127, WC201, EC310, SA12 …
    // Extract the FIRST digit after the letter prefix to determine floor.
    const letterPrefixMatch = /^[A-Z]{1,3}([0-9])\d{2}/.exec(rn);
    if (letterPrefixMatch) {
      const d = parseInt(letterPrefixMatch[1], 10);
      if (d === 0) return "LEVEL B1";
      return `LEVEL ${d}`;
    }
    // Plain leading-digit pattern (3-digit rooms only — avoids false positives on 4-digit IDs).
    if (/^0\d{2}/.test(rn)) return "LEVEL B1";
    if (/^1\d{2}/.test(rn)) return "LEVEL 1";
    if (/^2\d{2}/.test(rn)) return "LEVEL 2";
    if (/^3\d{2}/.test(rn)) return "LEVEL 3";
    if (/^4\d{2}/.test(rn)) return "LEVEL 4";
    if (/^[BS]-?\d/.test(rn)) return "LEVEL B1";
    if (/^[P]-?\d/.test(rn)) return "PARKING";
  }

  return null;
}
