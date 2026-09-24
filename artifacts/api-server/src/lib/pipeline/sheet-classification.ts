export function shouldRunVisionScan(sheetId: string, sheetTitle: string | null): boolean {
  const id = sheetId.trim().toUpperCase();
  const title = (sheetTitle ?? "").toUpperCase();

  // Hard-block by sheet number — always administrative/cover sheets.
  const EXCLUDED_SHEET_IDS = ["A-001", "A001", "A-002", "A002", "A-003", "A003"];
  if (EXCLUDED_SHEET_IDS.includes(id)) return false;

  // Hard-block by discipline prefix — structural, mechanical, electrical,
  // plumbing, civil, and fire-protection drawings are never floor plans.
  const EXCLUDED_PREFIXES = ["S-", "M-", "E-", "P-", "C-", "FP-"];
  if (EXCLUDED_PREFIXES.some((pfx) => id.startsWith(pfx))) return false;

  // Restroom-specific rescue: sheets explicitly labeled for restrooms (TOILET,
  // RESTROOM, LAVATORY) are always vision-scanned because they contain room labels
  // even on RCP or reflected-ceiling views.  "BATHROOM FINISH" is still excluded
  // (finish annotation, not a plan view with room tags).
  const RESTROOM_RESCUE_KW = /\b(TOILET|RESTROOM|LAVATORY)\b|\bRR\b/i;
  if (RESTROOM_RESCUE_KW.test(title) && !title.includes("BATHROOM FINISH") && !title.includes("FINISH PLAN")) {
    return true;
  }

  // Hard-block by title keyword — drawing types that are geometrically or
  // semantically impossible to be an overhead floor plan view.
  // These are blocked unconditionally regardless of other title words.
  const ALWAYS_EXCLUDE_TITLE = [
    "ELEVATION",               // vertical wall projection
    "SECTION",                 // vertical building cross-section
    "EGRESS",                  // egress path / life-safety diagram
    "ACCESSORY LEGEND",        // symbol/legend key page
    "LIGHT FIXTURE SCHEDULE",  // MEP fixture data table
    "BATHROOM FINISH",         // finish annotation, not a plan view
    "DRAWING INDEX",           // sheet list cover page
    "SYMBOL LEGEND",           // drawing symbol key
    "ABBREVIATIONS",           // text-only abbreviation list
    "SPECIFICATIONS",          // written specification section
    "CODE ANALYSIS",           // code compliance text
    "LIFE SAFETY NOTES",       // text-only life-safety narrative
    "PLUMBING FIXTURE SCHEDULE", // fixture count table
    "LIGHTING SCHEDULE",       // electrical lighting data table
    "LIGHTING PLAN",           // electrical lighting layout
    "ELECTRICAL SCHEDULE",     // electrical panel/load schedule
    "PLUMBING SCHEDULE",       // plumbing fixture schedule
    "MECHANICAL SCHEDULE",     // HVAC/mechanical equipment table
    "REFLECTED CEILING",       // RCP — not an overhead floor plan
    "FINISH PLAN",             // interior finish annotation plan
    "FURNITURE PLAN",          // FF&E layout, no room-name labels
    "POWER PLAN",              // electrical power layout
    "DATA PLAN",               // low-voltage/data layout
  ];
  if (ALWAYS_EXCLUDE_TITLE.some((kw) => title.includes(kw))) return false;

  // Conditional block — excluded UNLESS "PLAN" also appears in the title.
  // Handles edge cases where these words appear in floor plan annotations
  // (e.g. "FOR FINISH SCHEDULE" vs. pure "FINISH SCHEDULE" data table).
  const EXCLUDE_UNLESS_PLAN = [
    "GENERAL NOTES",    // text spec page, but "GENERAL NOTES ON PLAN" is possible
    "DOOR SCHEDULE",    // door data table, rarely annotated on a plan view
    "WINDOW SCHEDULE",  // window data table
  ];
  if (EXCLUDE_UNLESS_PLAN.some((kw) => title.includes(kw)) && !title.includes("PLAN")) return false;

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

export function getExclusionReason(sheetId: string, sheetTitle: string | null): string | null {
  const id = sheetId.trim().toUpperCase();
  const title = (sheetTitle ?? "").toUpperCase();

  const EXCLUDED_SHEET_IDS = ["A-001", "A001", "A-002", "A002", "A-003", "A003"];
  if (EXCLUDED_SHEET_IDS.includes(id)) return `administrative sheet id (${id})`;

  const EXCLUDED_PREFIXES = ["S-", "M-", "E-", "P-", "C-", "FP-"];
  const matchedPrefix = EXCLUDED_PREFIXES.find((pfx) => id.startsWith(pfx));
  if (matchedPrefix) return `non-architectural discipline prefix "${matchedPrefix}"`;

  const ALWAYS_EXCLUDE_TITLE = [
    "ELEVATION", "SECTION", "EGRESS", "ACCESSORY LEGEND",
    "LIGHT FIXTURE SCHEDULE", "BATHROOM FINISH",
    "DRAWING INDEX", "SYMBOL LEGEND", "ABBREVIATIONS", "SPECIFICATIONS",
    "CODE ANALYSIS", "LIFE SAFETY NOTES", "PLUMBING FIXTURE SCHEDULE",
    "LIGHTING SCHEDULE", "LIGHTING PLAN", "ELECTRICAL SCHEDULE",
    "PLUMBING SCHEDULE", "MECHANICAL SCHEDULE", "REFLECTED CEILING",
    "FINISH PLAN", "FURNITURE PLAN", "POWER PLAN", "DATA PLAN",
  ];
  const matchedKw = ALWAYS_EXCLUDE_TITLE.find((kw) => title.includes(kw));
  if (matchedKw) return `title contains hard-exclude keyword "${matchedKw}"`;

  const EXCLUDE_UNLESS_PLAN = ["GENERAL NOTES", "DOOR SCHEDULE", "WINDOW SCHEDULE"];
  const matchedCond = EXCLUDE_UNLESS_PLAN.find((kw) => title.includes(kw));
  if (matchedCond && !title.includes("PLAN")) return `title contains "${matchedCond}" without "PLAN" qualifier`;

  return null; // passes filter
}
