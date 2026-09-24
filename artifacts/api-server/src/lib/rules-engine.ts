/**
 * Sign Takeoff IQ — Rules Engine (R1–R17)
 *
 * Implements the full 17-rule sign assignment system with building-type traits.
 * Rules are applied in order: later rules ADD signs, they do not override earlier ones
 * unless explicitly stated.
 */

import { SIGN_COLORS, DEFAULT_SIGN_COLOR } from "./signColors";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RoomRecord {
  id: string;
  roomNumber: string;
  roomName: string;
  level: string;
  occupantLoad: number | null;
  occupancyGroup: string | null;
  isResidentialUnit: boolean;
  isRestroom: boolean;
  isStair: boolean;
  isElevator: boolean;
  isVestibule: boolean;
  isCorridorOrHall: boolean;
  isVehicleBay: boolean;
  isMepUnoccupied: boolean;
  isVariableUse: boolean;
  isPublicFacing: boolean;
  isAssembly: boolean;
  sheetId: string | null;
  coordX?: number | null;
  coordY?: number | null;
  /** True when the room name looks like a raw door-schedule code (e.g. "106A", "110C").
   *  These entries carry no descriptive room name and should be skipped for sign assignment. */
  isDoorScheduleEntry?: boolean;
  /**
   * R3: Number of public-facing doors (doors that open to a public corridor or lobby,
   * excluding connecting doors between private spaces and service/back-of-house doors).
   * When > 1, the room gets one Room ID sign per public door.
   * null = not yet set by user; treated as 0 (default qty = 1).
   */
  publicDoorCount?: number | null;
}

export interface SignAssignment {
  signType: string;
  qty: number;
  ruleRef: string;
  confidence: number;
  color: string;
  status: "auto" | "needs_review";
  source: "rules_engine";
  dimensions?: string;
  dimSource?: "ada_suggested";
  /** True when 2010 ADA §703 / IBC §1110 requires tactile characters + Grade 2 Braille. */
  adaRequired: boolean;
  /** Optional freeform note stored with the sign (e.g. stair variant, mounting note). */
  notes?: string;
  /**
   * For aggregate signs that map to a specific source room (e.g. an elevator
   * cab), the originating room id. The pipeline links the sign to this room so
   * the final per-room sign dedup can tell distinct elevators apart — without
   * it, every roomId=null "Elevator" row collapses to a single key.
   */
  roomId?: string;
  /** Floor/level label of the source room, for display + dedup distinctness. */
  floorLabel?: string;
}

// Standard ADA/ADAAG suggested dimensions per sign type.
// Used when no dimension is found in the plans or schedule.
// Values are width × height in inches.
export const ADA_SIGN_DIMENSIONS: Record<string, string> = {
  // Room identification (ADA 216.2)
  "Room ID":              "6 × 8",
  "Room ID w/insert":     "6 × 8",
  // Restrooms (ADA 216.8)
  "Restroom":             "6 × 8",
  "Restroom(Women)":      "6 × 8",
  "Restroom(Men)":        "6 × 8",
  "Restroom(Unisex)":     "6 × 8",
  // Exits and stairs (ADA 216.3)
  "Exit":                 "6 × 8",
  "Exit(Tactile)":        "6 × 8",
  "Stair(Corridor)":      "6 × 8",
  "Stair(Landing)":       "6 × 8",
  // Elevator (ADA 216.4)
  "Elevator":             "6 × 8",
  "Elevator Mach Rm":     "6 × 8",
  // Accessible features
  "Accessible Entrance":  "6 × 8",   // ISA sign (ADA 216.6)
  "Accessible Parking":   "12 × 18", // ISA parking sign (ADA 216.5)
  // Egress / navigation (ADA 216.3)
  "Evacuation Map":       "18 × 24",
  // Directory and identification
  "Office Directory":     "18 × 24",
  "Building ID":          "18 × 24",
  // Wayfinding
  "Directional":          "6 × 8",
  // Residential unit (multifamily)
  "Unit ID":              "6 × 8",
  // Assembly occupancy (IBC)
  "Max Occupancy":        "6 × 8",
  // Life safety / emergency egress (ADA 216.3, IBC 1007)
  "Area of Rescue":       "6 × 8",
};

/**
 * Exhaustive set of ADA-compliant sign types this rules engine may output.
 * Any sign type not in this set is silently dropped (with a warning log).
 * Training corrections that assign non-canonical types are also skipped.
 */
export const ADA_CANONICAL_SIGN_TYPES = new Set<string>([
  "Room ID",
  "Room ID w/insert",
  "Restroom",
  "Restroom(Women)",
  "Restroom(Men)",
  "Restroom(Unisex)",
  "Exit",
  "Exit(Tactile)",
  "Stair(Corridor)",
  "Stair(Landing)",
  "Elevator",
  "Elevator Mach Rm",
  "Accessible Entrance",
  "Accessible Parking",
  "Evacuation Map",
  "Office Directory",
  "Building ID",
  "Directional",
  "Unit ID",
  "Max Occupancy",
  "Area of Rescue",
]);

/**
 * Sign types that require tactile characters + Grade 2 Braille per 2010 ADA §703 / IBC §1110.
 * All permanently designated interior room signs must meet this standard.
 */
export const ADA_REQUIRED_SIGN_TYPES = new Set<string>([
  "Room ID",
  "Room ID w/insert",
  "Room ID w/Insert",
  "Restroom",
  "Restroom(Women)",
  "Restroom(Men)",
  "Restroom(Unisex)",
  "Stair(Corridor)",
  "Stair(Landing)",
  "Stair (Corridor)",
  "Stair (Landing)",
  "Exit(Tactile)",
  "Area of Rescue",
  "Elevator",
  "Elevator Mach Rm",
  "Accessible Entrance",
  "Unit ID",
  "In Case of Fire",
  "Boys",
  "Girls",
  "Men",
  "Women",
  "Unisex Restroom",
  "Family Restroom",
  "Accessible Room",
  "Patient Room ID",
  "Courtroom ID",
]);

export interface RoomResult {
  room: RoomRecord;
  signs: SignAssignment[];
}

// ---------------------------------------------------------------------------
// Building Traits
// ---------------------------------------------------------------------------

export type MepPolicy = "all" | "occupied_only" | "minimal";
export type ElevatorMode = "per_building" | "per_level";
export type StairMode = "separate" | "combined";

export interface BuildingTraits {
  hasUnitNumbers: boolean;
  mepPolicy: MepPolicy;
  hasAssemblyRules: boolean;
  hasDirectory: boolean;
  elevatorMode: ElevatorMode;
  stairMode: StairMode;
  /** Government and Assembly buildings require Area of Rescue signs at every stair landing (IBC 1007). */
  requiresAreaOfRescue: boolean;
}

// ---------------------------------------------------------------------------
// Building type groups — canonical 8-type set with legacy aliases
// ---------------------------------------------------------------------------

export const BUILDING_TYPE_GROUPS: Record<string, string[]> = {
  commercial:  ["commercial", "office", "retail", "restaurant", "airport", "transit", "warehouse", "industrial", "mixed_use", "mixed"],
  residential: ["residential", "multifamily", "apartment", "condo", "senior_living", "dormitory", "affordable_housing"],
  education:   ["education", "school", "university", "college", "daycare", "library"],
  healthcare:  ["healthcare", "hospital", "clinic", "medical", "dental", "nursing_home"],
  government:  ["government", "municipal", "federal", "courthouse", "police", "fire_station", "military"],
  hotel:       ["hotel", "motel", "resort", "inn"],
  assembly:    ["assembly", "church", "theater", "theatre", "arena", "stadium", "convention", "museum", "gym_venue"],
  unknown:     ["unknown"],
};

/** Map every alias → canonical group key (e.g. "hospital" → "healthcare", "church" → "assembly"). */
export function normalizeBuildingType(t: string): string {
  const lower = t.toLowerCase().trim();
  for (const [canonical, aliases] of Object.entries(BUILDING_TYPE_GROUPS)) {
    if (aliases.includes(lower)) return canonical;
  }
  return lower; // return as-is (may be a specific legacy key like "bank", "lab", etc.)
}

export const BUILDING_TRAITS: Record<string, BuildingTraits> = {
  residential: {
    hasUnitNumbers: true,
    mepPolicy: "all",
    hasAssemblyRules: false,
    hasDirectory: false,
    elevatorMode: "per_level",
    stairMode: "combined",
    requiresAreaOfRescue: false,
  },
  commercial: {
    hasUnitNumbers: false,
    mepPolicy: "occupied_only",
    hasAssemblyRules: true,
    hasDirectory: true,
    elevatorMode: "per_building",
    stairMode: "separate",
    requiresAreaOfRescue: false,
  },
  school: {
    hasUnitNumbers: false,
    mepPolicy: "minimal",
    hasAssemblyRules: true,
    hasDirectory: false,
    elevatorMode: "per_building",
    stairMode: "separate",
    requiresAreaOfRescue: false,
  },
  hospital: {
    hasUnitNumbers: false,
    mepPolicy: "minimal",
    hasAssemblyRules: true,
    hasDirectory: false,
    elevatorMode: "per_level",
    stairMode: "separate",
    requiresAreaOfRescue: false,
  },
  hotel: {
    hasUnitNumbers: true,
    mepPolicy: "all",
    hasAssemblyRules: true,
    hasDirectory: false,
    elevatorMode: "per_level",
    stairMode: "separate",
    requiresAreaOfRescue: false,
  },
  retail: {
    hasUnitNumbers: false,
    mepPolicy: "all",
    hasAssemblyRules: true,
    hasDirectory: false,
    elevatorMode: "per_building",
    stairMode: "separate",
    requiresAreaOfRescue: false,
  },
  warehouse: {
    hasUnitNumbers: false,
    mepPolicy: "all",
    hasAssemblyRules: false,
    hasDirectory: false,
    elevatorMode: "per_building",
    stairMode: "combined",
    requiresAreaOfRescue: false,
  },
  lab: {
    hasUnitNumbers: false,
    mepPolicy: "occupied_only",
    hasAssemblyRules: false,
    hasDirectory: true,
    elevatorMode: "per_building",
    stairMode: "separate",
    requiresAreaOfRescue: false,
  },
  bank: {
    hasUnitNumbers: false,
    mepPolicy: "occupied_only",
    hasAssemblyRules: false,
    hasDirectory: true,
    elevatorMode: "per_building",
    stairMode: "separate",
    requiresAreaOfRescue: false,
  },
  government: {
    hasUnitNumbers: false,
    mepPolicy: "occupied_only",
    hasAssemblyRules: true,
    hasDirectory: true,
    elevatorMode: "per_building",
    stairMode: "separate",
    requiresAreaOfRescue: true,   // IBC 1007: Area of Rescue at every stair landing in public buildings
  },
  church: {
    hasUnitNumbers: false,
    mepPolicy: "occupied_only",
    hasAssemblyRules: true,
    hasDirectory: false,
    elevatorMode: "per_building",
    stairMode: "separate",
    requiresAreaOfRescue: true,   // Assembly occupancy — IBC 1007
  },
  "senior_living": {
    hasUnitNumbers: true,
    mepPolicy: "all",
    hasAssemblyRules: true,
    hasDirectory: false,
    elevatorMode: "per_level",
    stairMode: "combined",
    requiresAreaOfRescue: false,
  },
  mixed: {
    hasUnitNumbers: false,
    mepPolicy: "occupied_only",
    hasAssemblyRules: true,
    hasDirectory: true,
    elevatorMode: "per_building",
    stairMode: "separate",
    requiresAreaOfRescue: false,
  },
  // ── Canonical 8-type entries ─────────────────────────────────────────────
  // These are the primary keys used by the new canonical system.
  // Legacy keys above (school, hospital, church…) remain for backward compat.
  education: {
    hasUnitNumbers: false,
    mepPolicy: "all",           // ALL rooms including storage, mechanical, custodial
    hasAssemblyRules: true,
    hasDirectory: false,
    elevatorMode: "per_building",
    stairMode: "separate",
    requiresAreaOfRescue: false,
  },
  healthcare: {
    hasUnitNumbers: false,
    mepPolicy: "all",           // ALL rooms including patient rooms, storage, mechanical
    hasAssemblyRules: true,
    hasDirectory: false,
    elevatorMode: "per_level",
    stairMode: "separate",
    requiresAreaOfRescue: false,
  },
  assembly: {
    hasUnitNumbers: false,
    mepPolicy: "occupied_only",
    hasAssemblyRules: true,
    hasDirectory: false,
    elevatorMode: "per_building",
    stairMode: "separate",
    requiresAreaOfRescue: true,   // Assembly occupancy (Group A) — IBC 1007
  },
  unknown: {
    hasUnitNumbers: false,
    mepPolicy: "occupied_only",
    hasAssemblyRules: true,
    hasDirectory: true,
    elevatorMode: "per_building",
    stairMode: "separate",
    requiresAreaOfRescue: false,
  },
};


// ---------------------------------------------------------------------------
// Building type detection
// ---------------------------------------------------------------------------

/**
 * Detect building type from room names, respecting an explicit override when set.
 * Returns a BUILDING_TRAITS key (canonical or legacy).
 *
 * When buildingType is "unknown", room-name auto-detection runs and the result is
 * logged as "Building type auto-detected as [type]".
 * Detection returns canonical group keys for healthcare, education, and assembly.
 */
export function detectBuildingType(
  rooms: Pick<RoomRecord, "roomName" | "roomNumber">[],
  projectMetadata: { buildingType?: string; name?: string } = {},
  customMappings: Record<string, string> = {},
  standardMappings: Record<string, string> = {},
): string {
  // 1. Explicit override (skip for "unknown" — treat as "run detection")
  if (projectMetadata.buildingType && projectMetadata.buildingType.toLowerCase().trim() !== "unknown") {
    const t = projectMetadata.buildingType.toLowerCase().trim();
    // Admin standard-type override takes precedence (try original label then lowercased)
    const standardOverride =
      standardMappings[projectMetadata.buildingType] ??
      standardMappings[t];
    if (standardOverride && BUILDING_TRAITS[standardOverride]) return standardOverride;
    // Direct profile key match (e.g. buildingType already is "commercial")
    if (BUILDING_TRAITS[t]) return t;
    // Check custom mapping — try exact key then lowercased key
    const mapped =
      customMappings[projectMetadata.buildingType] ??
      customMappings[t];
    if (mapped && BUILDING_TRAITS[mapped]) return mapped;
  }

  // 2. Room-name based detection
  const wasUnknown = projectMetadata.buildingType?.toLowerCase().trim() === "unknown";
  const detectedType = _detectFromRoomNames(rooms);

  if (wasUnknown) {
    console.log(`[rules] Building type auto-detected as ${detectedType} (was: unknown)`);
  }
  return detectedType;
}

/**
 * Core room-name detection. Returns canonical types where applicable:
 *  healthcare (not hospital), education (not school), assembly (not church).
 * Legacy types retained: residential, hotel, government, commercial, bank, lab,
 * warehouse, retail, senior_living.
 */
function _detectFromRoomNames(rooms: Pick<RoomRecord, "roomName" | "roomNumber">[]): string {
  const names = rooms.map((r) => r.roomName.toUpperCase());
  const total = names.length;

  // >30% unit-style names → Residential.
  // Accepts:
  //   • Names starting with "UNIT <anything>" (traditional: "UNIT 101", "UNIT 5A")
  //   • Names containing "UNIT <digit>" anywhere (garbled OCR: "HTRON_A UNIT 2A")
  // The UNIT_DOOR_CODE_PATTERN exclusion is intentionally removed here — in a
  // residential building, "UNIT 101A" IS a real apartment (building-letter suffix),
  // not a door-schedule code, so it should count toward building-type detection.
  const unitCount = names.filter(
    (n) => /^UNIT\s+\S/.test(n) || /\bUNIT\s+\d/.test(n),
  ).length;
  if (total > 0 && unitCount / total > 0.3) return "residential";

  // Hotel signatures
  const hasRoom = names.some((n) => /^ROOM\s+\d/.test(n));
  const hasLobby = names.some((n) => /\bLOBBY\b/.test(n));
  const hasFrontDesk = names.some((n) => n.includes("FRONT DESK") || n.includes("CHECK-IN") || /\bRECEPTION\b/.test(n));
  if (hasRoom && hasLobby && hasFrontDesk) return "hotel";

  // Healthcare (canonical — maps hospital/clinic/medical keywords)
  if (names.some((n) => /\bPATIENT\b|\bNURSE\b|\bEXAM ROOM\b|\bICU\b|\bOPERATING\b|\bER\b|\bEMERGENCY DEPT\b|\bSURGERY\b/.test(n))) return "healthcare";

  // Education (canonical — maps school/university keywords)
  if (names.some((n) => /\bCLASSROOM\b|\bGYMNASIUM\b|\bGYM\b|\bCAFETERIA\b|\bPRINCIPAL\b|\bLIBRARY\b|\bMEDIA CENTER\b/.test(n))) return "education";

  // Assembly (canonical — maps church/theater/arena keywords)
  if (names.some((n) => /\bNAVE\b|\bSANCTUARY\b|\bALTAR\b|\bPARISH\b|\bNARTHEX\b|\bCHANCEL\b|\bAUDITORIUM\b|\bARENACT\b/.test(n))) return "assembly";

  // Lab (legacy specific — kept for accuracy)
  if (names.some((n) => /\bCLEAN ROOM\b|\bFUME HOOD\b|BSL-|\bLABORATORY\b|\bLAB\b/.test(n))) return "lab";

  // Bank (legacy specific)
  if (names.some((n) => /\bVAULT\b|\bTELLER\b|\bSAFE DEPOSIT\b|\bCOUNTING ROOM\b/.test(n))) return "bank";

  // Warehouse/Factory (legacy specific)
  if (names.some((n) => /\bASSEMBLY LINE\b|\bLOADING DOCK\b|\bSHIPPING\b|\bRECEIVING\b|\bWAREHOUSE\b|\bFACTORY\b/.test(n))) return "warehouse";

  // Retail (legacy specific)
  if (names.some((n) => /\bMERCHANDISE\b|\bFITTING ROOM\b|\bPOS\b|\bSTOCK ROOM\b|\bRETAIL\b|\bSHOWROOM\b/.test(n))) return "retail";

  // Senior living (legacy specific)
  if (names.some((n) => /\bMEMORY CARE\b|\bASSISTED LIVING\b|\bSKILLED NURSING\b|\bRESIDENT ROOM\b/.test(n))) return "senior_living";

  // Government
  if (names.some((n) => /\bCOUNCIL CHAMBER\b|\bCOURT ROOM\b|\bCOURT CLERK\b|\bPOLICE\b|\bFIRE STATION\b|\bAPPARATUS\b/.test(n))) return "government";

  // Default: Commercial
  return "commercial";
}

// ---------------------------------------------------------------------------
// Room classification helpers
// ---------------------------------------------------------------------------

// Whole-word restroom keyword list.
// Do NOT add "ROOM" — "STOREROOM"/"SENSORY ROOM" must NOT match.
// WC (water closet), BOYS, GIRLS added for school projects.
export const RESTROOM_KEYWORDS = /\bTOILET\b|\bRESTROOM\b|\bBATHROOM\b|\bLAVATORY\b|\bSHOWER\b|SHOWER.?LOCKER|\bLOCKER\b|\bMEN'?S\b|\bMENS\b|\bWOMEN'?S\b|\bWOMEN\b|\bMALE\b|\bFEMALE\b|\bGENDER\b|\bUNISEX\b|\bWC\b|\bBOYS\b|\bGIRLS\b|ADA RESTROOM/i;
export const STAIR_KEYWORDS = /\bSTAIR(S|WELL|WAY|CASE|CORE|SHAFT)?\b/i;
// Reject: STAIR is the very last word and the name does NOT start with a stair/exit qualifier.
// Handles: "TRAINING AIRCREW BREAK STAIR", "JANITOR STAIR", "BREAK STAIR"
// Preserves: "EXIT STAIR", "EMERGENCY STAIR", "STAIR 1"
export const STAIR_NOISE_TRAILING = /^(?!(?:STAIR|EXIT|EMERGENCY|EGRESS)\b).+\bSTAIR\s*$/i;
// Reject: STAIR is sandwiched between known-unrelated room-type words on both sides
// e.g. "MEN'S STAIR MECHANICAL"
export const STAIR_NOISE_MIDDLE = /\b(MEN'?S|WOMEN'?S|JAN(ITOR)?|BREAK|MECH(ANICAL)?)\b.+\bSTAIR\b/i;
export const ELEVATOR_KEYWORDS = /\bELEV(ATOR)?\b|\bLIFT\b/i;
export const VESTIBULE_KEYWORDS = /\bVEST(IBULE)?\b|ENTRY VEST|EXIT VEST|AIR LOCK/i;
export const CORRIDOR_KEYWORDS = /\bCORR(IDOR)?\b|\bHALL(WAY)?\b|\bHALL\b|\bPASSAGE\b|\bGALLERY\b|\bCIRCULATION\b|\bWALKWAY\b|\bCONCOURSE\b|\bBREEZEWAY\b|\bRAMP\b/i;
export const VEHICLE_BAY_KEYWORDS = /\bAPPARATUS\b|\bGARAGE\b|\bVEHICLE\b|\bBAY\b|\bDRIVE.?THROUGH\b/i;
export const MEP_KEYWORDS = /\bMECH(ANICAL)?\b|\bELEC(TRICAL)?\b|\bIDF\b|\bMDF\b|\bTELECOM\b|\bSERVER\b|\bIT\s*ROOM\b|\bJAN(ITOR)?\b|\bSPRINKLER\b|PUMP\s*ROOM|\bUTILITY\b|\bFAN\s*ROOM\b|\bBOILER\b|\bHVAC\b/i;
// Expanded to include primary assembly spaces across all building types:
// GYM / GYMNASIUM (education, residential amenity), CAFETERIA (education),
// SANCTUARY / NAVE (assembly/church), THEATER/THEATRE (assembly/hotel),
// BALLROOM / BANQUET (hotel/commercial), COURTROOM (government),
// LECTURE HALL (education/commercial), MULTIPURPOSE (universal),
// FELLOWSHIP HALL (church/assembly).
export const ASSEMBLY_KEYWORDS = /\bTRAINING\b|\bMEETING\b|\bCONFERENCE\b|\bAUDITORIUM\b|\bCHAPEL\b|\bCOMMUNITY\b|\bEOC\b|\bBANQUET\b|\bDINING\b|\bASSEMBL|\bGYMNASIUM\b|\bGYM\b|\bCAFETERIA\b|\bSANCTUARY\b|\bNAVE\b|\bTHEAT(?:ER|RE)\b|\bBALLROOM\b|\bCOURTROOM\b|\bLECTURE\s*HALL\b|\bMULTIPURPOSE\b|\bFELLOWSHIP\b|\bHEARING\s*ROOM\b|\bCOUNCIL\s*CHAMBER\b|\bARENAF?\b/i;
export const VARIABLE_USE_KEYWORDS = /\bTRAINING\b|\bEOC\b|\bCOMMUNITY\b|MULTI.?PURPOSE|FLEX\s*ROOM|MULTI\s*USE|\bCONVERTIBLE\b/i;
export const PUBLIC_FACING_KEYWORDS = /\bLOBBY\b|\bPUBLIC\b|\bRECEPTION\b|\bWAITING\b|\bFRONT\b/i;
// Matches residential unit names.  Primary form: starts with "UNIT", "APT", or "SUITE".
// Secondary form: "UNIT" appears as a complete word anywhere before a digit — catches
// garbled / OCR-mirrored names like "HTRON_A UNIT 2A" where the prefix is scrambled
// but "UNIT <number>" is still present.  "Storage Unit" or "Training Unit" (no digit
// immediately after) do NOT match the secondary form and are safe from false positives.
export const RESIDENTIAL_UNIT_KEYWORDS = /^UNIT\b|^APT\b|^SUITE\b|\bUNIT\s+\d/i;

// Room name is ONLY a number + optional single-letter suffix (e.g. "106A", "110C", "104B", "201").
// No descriptive word is present — this is a raw door-schedule code.
export const DOOR_SCHEDULE_ENTRY_PATTERN = /^[0-9]+[A-Za-z]?$/;

// "UNIT " followed by a number AND a letter suffix (e.g. "UNIT 106A") looks like a door-schedule
// type code, NOT a residential apartment unit name.  A trailing letter is the discriminator:
// "UNIT 101" (no letter) is a normal apartment unit; "UNIT 106A" / "UNIT 5A" are door codes.
export const UNIT_DOOR_CODE_PATTERN = /^UNIT\s+[0-9]+[A-Za-z]+$/i;
export const DORM_KEYWORDS = /\bDORM(ITORY)?\b|\bBUNK\b|\bSLEEP(ING)?\b/i;
export const MEZZANINE_KEYWORDS = /\bMEZZ(ANINE)?\b/i;
export const LOBBY_ENTRY_KEYWORDS = /\bLOBBY\b|\bENTRY\b|\bENTRANCE\b/i;
export const DIRECTORY_LOCATION_KEYWORDS = /\bLOBBY\b|\bRECEPTION\b|\bFOYER\b|\bATRIUM\b/i;
export const MENS_RESTROOM_KEYWORDS = /\bMEN'?S\b|\bMALE\b/i;
export const WOMENS_RESTROOM_KEYWORDS = /\bWOMEN'?S\b|\bFEMALE\b/i;
export const AUDITORIUM_KEYWORDS = /\bAUDITORIUM\b/i;

// Common areas in residential buildings that legitimately receive Room ID signs.
// All other rooms in residential buildings (non-unit, non-common) get no Room ID.
export const RESIDENTIAL_COMMON_AREA_KEYWORDS = /\bLOBBY\b|\bMAIL.?ROOM\b|\bMAILROOM\b|\bLAUNDRY\b|\bFITNESS\b|\bGYM\b|\bGYMNASIUM\b|\bLEASING\b|\bPACKAGE\b|\bCOMMUNITY\b|\bCLUB.?ROOM\b|\bCLUBROOM\b|\bBUSINESS.?CENTER\b|\bPOOL\b|\bCONCIERGE\b|\bRECEPTION\b|\bLOUNGE\b|\bTHEATER\b|\bTHEATRE\b|\bCONFERENCE\b|\bCOURTYARD\b|\bROOFTOP\b|\bBICYCLE\b|\bBIKE\b|\bPARCEL\b/i;

// ---------------------------------------------------------------------------
// Universal garbage filter — room names from PDF schedule rows / keynotes
// ---------------------------------------------------------------------------

/**
 * Patterns that identify rows extracted from door schedules, finish schedules,
 * occupant-load tables, keynotes, legends, or other non-room schedule artifacts.
 * Rooms matching any of these patterns are excluded from all sign assignment.
 */
export const SCHEDULE_ROW_PATTERNS: RegExp[] = [
  /occupant.?load/i,
  /load.?table/i,
  /fixture.?table/i,
  /door.?schedule/i,
  /finish.?schedule/i,
  /^keynote/i,
  /^general.?note/i,
  /^note:/i,
  /^legend/i,
  /^abbreviation/i,
  /^detail\s/i,
  /^section\s[a-z]/i,
  /^bc\s/i,
  // Scale bar text — appears near graphic scale bars; never a real room name.
  // Includes reversed/garbled OCR variants from mirrored or rotated PDF pages.
  /^FEET\s*SCALE$/i,
  /^INCH\s*SCALE$/i,
  /^FEET$/i,
  /^SCALE$/i,
  /^TEEF/i,   // "FEET" reversed
  /^ELACS/i,  // "SCALE" reversed
  /^HCNI/i,   // "INCH" reversed
];

/** Returns true if the room name looks like a schedule/table row rather than an actual room. */
export function isJunkRoomName(name: string): boolean {
  return SCHEDULE_ROW_PATTERNS.some((p) => p.test(name));
}

export function classifyRoom(roomName: string): Partial<RoomRecord> {
  const name = roomName.toUpperCase();
  const trimmed = roomName.trim();
  const hasStairKeyword = STAIR_KEYWORDS.test(name);
  const isTrailingStairNoise = STAIR_NOISE_TRAILING.test(name);
  const isMiddleStairNoise = STAIR_NOISE_MIDDLE.test(name);
  // A door-schedule entry: name is purely a number ± one letter (e.g. "106A", "201").
  // No descriptive word present — skip sign assignment for these.
  const isDoorScheduleEntry = DOOR_SCHEDULE_ENTRY_PATTERN.test(trimmed);
  // "UNIT 106A" style: "UNIT " followed by a number ± letter is a door-code, not a residential unit.
  const isUnitDoorCode = UNIT_DOOR_CODE_PATTERN.test(trimmed);
  return {
    isDoorScheduleEntry,
    isRestroom: RESTROOM_KEYWORDS.test(name),
    isStair: hasStairKeyword && !isTrailingStairNoise && !isMiddleStairNoise,
    isElevator: ELEVATOR_KEYWORDS.test(name),
    isVestibule: VESTIBULE_KEYWORDS.test(name),
    isCorridorOrHall: CORRIDOR_KEYWORDS.test(name),
    isVehicleBay: VEHICLE_BAY_KEYWORDS.test(name),
    isMepUnoccupied: MEP_KEYWORDS.test(name),
    isVariableUse: VARIABLE_USE_KEYWORDS.test(name),
    isPublicFacing: PUBLIC_FACING_KEYWORDS.test(name),
    isAssembly: ASSEMBLY_KEYWORDS.test(name),
    // Exclude door-schedule codes and "UNIT NNN[L]" patterns from residential detection.
    isResidentialUnit: !isDoorScheduleEntry && !isUnitDoorCode && RESIDENTIAL_UNIT_KEYWORDS.test(name),
  };
}

// ---------------------------------------------------------------------------
// Stair room-number patterns — per building type (Fix 1)
// ---------------------------------------------------------------------------
// Some PDFs use room number codes (SA01, SB02) rather than descriptive names to
// identify stair cores.  classifyRoom() won't detect these as stairs since the
// room NAME is the number code itself. These patterns let the pipeline/rules engine
// supplement isStair detection by checking the roomNumber field.

export const STAIR_ROOM_NUMBER_PATTERNS: Record<string, RegExp[]> = {
  education:   [/^S[ABCDEFGH]\d{2,3}$/i],                         // SA01, SB02
  healthcare:  [/^S[ABCDE]\d{2}$/i, /^ST\d{2,3}$/i],              // SA01, ST01
  commercial:  [/^S\d{1,2}$/i, /^STAIR-?\d+$/i],                  // S1, STAIR-1
  government:  [/^S\d{1,2}$/i, /^STAIR[A-Z]$/i],                  // S1, STAIRA
  hotel:       [/^S\d{1,2}$/i, /^STAIR-?\d+$/i],                  // S1, STAIR-1
  residential: [/^S\d{1,2}$/i, /^STAIR-?\d+$/i],                  // S1, STAIR-1
  assembly:    [/^S\d{1,2}$/i, /^[A-Z]{1,2}-S\d+$/i],             // S1, AB-S1
  unknown:     [],                                                  // name-based only
};

/**
 * Returns true when the given room number matches a building-type-specific stair
 * room-number pattern, even if the room name does not contain "STAIR".
 * Call this to supplement classifyRoom()'s `isStair` flag.
 */
export function classifyRoomNumberAsStair(roomNumber: string, buildingType: string): boolean {
  const num = roomNumber.trim();
  if (!num) return false;
  const normalized = normalizeBuildingType(buildingType);
  const patterns =
    STAIR_ROOM_NUMBER_PATTERNS[normalized] ??
    STAIR_ROOM_NUMBER_PATTERNS[buildingType] ??
    [];
  return patterns.some((p) => p.test(num));
}

// ---------------------------------------------------------------------------
// Rule application helpers
// ---------------------------------------------------------------------------

function sign(
  signType: string,
  qty: number,
  ruleRef: string,
  confidence: number,
  notes?: string,
): SignAssignment {
  const adaDim = ADA_SIGN_DIMENSIONS[signType];
  return {
    signType,
    qty,
    ruleRef,
    confidence,
    color: SIGN_COLORS[signType] ?? DEFAULT_SIGN_COLOR,
    status: confidence >= 0.7 ? "auto" : "needs_review",
    source: "rules_engine",
    adaRequired: ADA_REQUIRED_SIGN_TYPES.has(signType),
    ...(adaDim ? { dimensions: adaDim, dimSource: "ada_suggested" } : {}),
    ...(notes ? { notes } : {}),
  };
}

// ---------------------------------------------------------------------------
// Core rule evaluators
// ---------------------------------------------------------------------------

// R3 — Multi-entry large rooms: rooms that typically have ≥3 man-doors.
// Without actual door-counting from floor plan images, we use name-based heuristics
// to identify likely multi-entry rooms and flag them for review (confidence < 0.7).
// True door counts require a Claude vision pass on each floor plan page.
//
// Original set: apparatus bays, gymnasiums, auditoriums, arenas, stadiums, cafeterias, chapels.
// Expanded set adds common large assembly spaces found in hotels, convention facilities,
// performing-arts venues, and multi-use civic buildings that also require multiple egress doors:
//   BALLROOM         – hotel/event ballrooms with perimeter exits
//   THEATER/THEATRE  – performing-arts spaces with multiple house exits
//   CONVENTION       – convention centers; keyword covers "Convention Center/Hall/Room"
//   BANQUET          – banquet halls; keyword covers "Banquet Hall/Room"
//   MULTIPURPOSE     – multipurpose/multi-purpose rooms sized for assembly use
//   AMPHITHEATER/RE  – open or indoor amphitheaters with multiple egress doors
//   LECTURE HALL     – large lecture halls commonly found in academic buildings
//   EXHIBITION       – exhibition halls and exhibition centers with multiple egress doors
//   SPORTS COMPLEX   – large indoor/outdoor sports complexes requiring multiple entries
//   ASSEMBLY HALL    – civic/institutional assembly halls sized for public gatherings
//   PERFORMANCE HALL – performing-arts performance halls with multiple house exits
//   CONFERENCE       – conference centers/halls; keyword covers "Conference Center/Hall/Room"
export const MULTI_ENTRY_ROOM_KEYWORDS =
  /\bAPPARATUS\b|\bGYMNASIUM\b|\bAUDITORIUM\b|\bARENA\b|\bSTADIUM\b|\bCAFETERIA\b|\bCHAPEL\b|\bBALLROOM\b|\bTHEAT(?:ER|RE)\b|\bCONVENTION\b|\bBANQUET\b|\bMULTIPURPOSE\b|\bAMPHITHEAT(?:ER|RE)\b|\bLECTURE\s+HALL\b|\bEXHIBITION\b|\bSPORTS\s+COMPLEX\b|\bASSEMBLY\s+HALL\b|\bPERFORMANCE\s+HALL\b|\bCONFERENCE\b/i;

/**
 * Human-readable display names for each built-in multi-entry keyword pattern.
 * Must be kept in sync with MULTI_ENTRY_ROOM_KEYWORDS above.
 * Exposed via the API config endpoint so admin UIs always reflect the live list.
 */
export const BUILT_IN_MULTI_ENTRY_KEYWORD_NAMES: string[] = [
  "Apparatus",
  "Gymnasium",
  "Auditorium",
  "Arena",
  "Stadium",
  "Cafeteria",
  "Chapel",
  "Ballroom",
  "Theater",
  "Convention",
  "Banquet",
  "Multipurpose",
  "Amphitheater",
  "Lecture Hall",
  "Exhibition",
  "Sports Complex",
  "Assembly Hall",
  "Performance Hall",
  "Conference",
];

/**
 * Build a regex that matches the built-in multi-entry keywords plus any
 * custom keywords configured by the tenant admin. Custom keywords are treated
 * as literal strings (escaped) wrapped in word boundaries for consistency.
 */
export function buildMultiEntryRegex(customKeywords?: string[]): RegExp {
  if (!customKeywords || customKeywords.length === 0) return MULTI_ENTRY_ROOM_KEYWORDS;
  const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const wordChar = /\w/;
  const customParts = customKeywords
    .map((kw) => kw.trim())
    .filter(Boolean)
    .map((kw) => {
      const escaped = escapeRegex(kw);
      const prefix = wordChar.test(kw[0]) ? "\\b" : "";
      const suffix = wordChar.test(kw[kw.length - 1]) ? "\\b" : "";
      return `${prefix}${escaped}${suffix}`;
    });
  if (customParts.length === 0) return MULTI_ENTRY_ROOM_KEYWORDS;
  const combined = MULTI_ENTRY_ROOM_KEYWORDS.source + "|" + customParts.join("|");
  return new RegExp(combined, "i");
}

function estimateMultiEntryQty(room: RoomRecord, multiEntryRegex: RegExp = MULTI_ENTRY_ROOM_KEYWORDS): number {
  // Heuristic: apparatus bays, gyms, auditoriums, theatres etc. typically have ≥3 entry
  // doors by design — code-minimum egress for assembly-sized spaces.  When the room
  // name matches a known multi-entry keyword, qty=3 is the safe default regardless of
  // whether occupant-load data was extracted from the drawings.
  if (multiEntryRegex.test(room.roomName)) return 3;
  return 1;
}

/**
 * R3: Resolve the sign quantity for a multi-entry room.
 *
 * Priority:
 *   1. User-set publicDoorCount > 1  → use exact count (high confidence)
 *   2. publicDoorCount === 1         → qty 1, R3 does not fire
 *   3. publicDoorCount null/0        → fall back to keyword heuristic
 */
function resolveR3Qty(room: RoomRecord, multiEntryRegex: RegExp = MULTI_ENTRY_ROOM_KEYWORDS): number {
  const explicit = room.publicDoorCount ?? 0;
  if (explicit > 0) return explicit;            // user-set value (1 = single door, >1 = R3)
  return estimateMultiEntryQty(room, multiEntryRegex); // keyword-based fallback
}

// Building types that legitimately use Unit ID plaques (R16).
// Any building auto-detected or configured as one of these may produce Unit ID signs.
// Non-residential buildings (library, school, office, etc.) are never in this set.
// NOTE: this set is also used by the outer canonical filter to guard Unit ID signs
// that arrive via training corrections targeting non-residential buildings.
export const UNIT_SIGN_BUILDING_TYPES = new Set([
  "residential", "multifamily", "hotel", "senior_living", "dormitory",
]);

// Building types subject to the residential common-area Room ID scope restriction.
const RESIDENTIAL_SCOPE_TYPES = new Set(["residential", "multifamily", "senior_living", "dormitory"]);

// Secondary residential-unit detection by room number.
// Room numbers in the form "NNN[L]" or "NN[L]" (2–4 digits + single capital letter)
// encode the unit number and building identifier in multi-building residential projects
// (e.g. "101A" = building A, unit 101; "2B" = building B, unit 2).  These rooms ARE
// residential units even when the garbled/reversed OCR name couldn't be parsed by
// classifyRoom().  Only fires for building types that legitimately use unit numbering.
// Shared by applyRoomIdRules (per-room scope check) and the residential-dominance
// counter in applyRules so both agree on what counts as a unit.
export function isResidentialUnitByNumber(roomNumber: string, buildingType: string): boolean {
  const trimmed = roomNumber.trim();
  return (
    // "101A", "5B" — unit number + building-letter suffix (unit-numbered types only).
    (UNIT_SIGN_BUILDING_TYPES.has(buildingType) && /^\d{2,4}[A-Z]$/.test(trimmed.toUpperCase())) ||
    // Plain 3-4 digit unit numbers (e.g. NOVO Riverside 203, 205, 207) in residential.
    (buildingType === "residential" && /^\d{3,4}$/.test(trimmed))
  );
}

function applyRoomIdRules(
  room: RoomRecord,
  traits: BuildingTraits,
  buildingType: string,
  multiEntryRegex: RegExp = MULTI_ENTRY_ROOM_KEYWORDS,
  residentialScopeActive: boolean = false,
): SignAssignment[] {
  const signs: SignAssignment[] = [];

  // R4 — Corridor exclusion
  if (room.isCorridorOrHall) return signs;

  // Secondary residential-unit detection by room number (see isResidentialUnitByNumber).
  const isResUnit =
    room.isResidentialUnit || isResidentialUnitByNumber(room.roomNumber, buildingType);

  // RESIDENTIAL SCOPE — Room ID only for common areas or MEP rooms.
  // Unit rooms are handled below (R16). Non-unit, non-common, non-MEP rooms get no Room ID.
  // MEP rooms are always allowed through regardless of building type (mepPolicy decides later).
  // Data-driven activation: `residentialScopeActive` is true only when the building is a
  // residential type AND its rooms are actually unit-dominated (computed once in applyRules).
  // When units don't dominate — a mislabeled building or one where unit detection broadly
  // failed — this stands down so legitimate rooms fall through to the normal Room ID rules
  // instead of being silently dropped.
  if (residentialScopeActive && !isResUnit) {
    if (!RESIDENTIAL_COMMON_AREA_KEYWORDS.test(room.roomName) && !room.isMepUnoccupied) return signs;
  }

  // R5 — Vehicle bay exclusion, with R3 override check.
  // Vehicle bays normally get no Room ID (R5), UNLESS the room has ≥3 man-doors (R3).
  // Apparatus bays in fire stations are the canonical R3 override case.
  if (room.isVehicleBay) {
    const r3Qty = resolveR3Qty(room, multiEntryRegex);
    if (r3Qty >= 3) {
      // R3 overrides R5: assign Room ID qty = door count, flag for review
      signs.push(sign("Room ID", r3Qty, "R3", 0.60));
    }
    return signs;
  }

  // R6 — Unoccupied MEP policy
  if (room.isMepUnoccupied) {
    if (traits.mepPolicy === "all") {
      // all: every MEP room with a door gets Room ID — fall through
    } else if (traits.mepPolicy === "occupied_only") {
      if ((room.occupantLoad ?? 0) === 0) return signs;
    } else {
      // minimal: MEP rooms excluded unless explicitly in scope
      return signs;
    }
  }

  // Skip pure stair / elevator rooms (get stair/elevator signs instead via R11/R12)
  if (room.isStair || room.isElevator) return signs;

  // R7 — Dorm / sleeping rooms get plain Room ID (not w/insert, not variable-use)
  const isDorm = DORM_KEYWORDS.test(room.roomName);

  // R3 — multi-entry rooms get one sign per public-facing door.
  // Fires when:
  //   a) publicDoorCount is explicitly set and > 1, OR
  //   b) the room name matches a multi-entry keyword (gym/auditorium/cafeteria)
  //      and the heuristic returns > 1.
  if (!isDorm && !room.isVariableUse) {
    const qty = resolveR3Qty(room, multiEntryRegex);
    if (qty > 1) {
      signs.push(sign("Room ID", qty, "R3", room.publicDoorCount ? 0.95 : 0.60));
      return signs;
    }
  }

  // R2 — Variable use → insert version
  if (room.isVariableUse && !isDorm && traits.hasAssemblyRules) {
    // qty = 2 if dual+ function (slash in name or assembly keywords suggest dual purpose)
    const dualFunction = /\//.test(room.roomName) || ASSEMBLY_KEYWORDS.test(room.roomName);
    const qty = dualFunction ? 2 : 1;
    signs.push(sign("Room ID w/insert", qty, "R2", 0.80));
    return signs;
  }

  // R16 — Residential unit Room ID (ADA §703 — every dwelling unit door gets a sign).
  // Fires when the room is a residential unit (by name or by room-number pattern) in a
  // building type that uses unit numbering.  Guard prevents non-residential buildings
  // that happen to contain "UNIT" names (e.g. library study carrels) from misfiring.
  if (isResUnit && traits.hasUnitNumbers && UNIT_SIGN_BUILDING_TYPES.has(buildingType)) {
    signs.push(sign("Room ID", 1, "R16", 0.85));
    return signs;
  }

  // R1 — Default Room ID (all remaining occupied rooms)
  signs.push(sign("Room ID", 1, "R1", 0.85));
  return signs;
}

function applyRestroomRule(room: RoomRecord): SignAssignment[] {
  // Corridors and halls never receive Restroom signs even if a keyword like
  // "BOYS" or "GIRLS" appears in the name (e.g. "GIRLS PASSAGE").
  if (!room.isRestroom || room.isCorridorOrHall) return [];
  const isWomens = WOMENS_RESTROOM_KEYWORDS.test(room.roomName);
  const isMens = !isWomens && MENS_RESTROOM_KEYWORDS.test(room.roomName);
  if (isWomens) return [sign("Restroom(Women)", 1, "R8", 0.9)];
  if (isMens) return [sign("Restroom(Men)", 1, "R8", 0.9)];
  return [sign("Restroom", 1, "R8", 0.9)];
}

function applyExitRule(room: RoomRecord, traits: BuildingTraits): SignAssignment[] {
  const signs: SignAssignment[] = [];
  // MEP / unoccupied rooms (mechanical, electrical, IDF, etc.) never receive Exit signs.
  // isMepUnoccupied takes priority over all other Exit rule conditions.
  if (room.isMepUnoccupied) return signs;
  if (!traits.hasAssemblyRules && !room.isVestibule && !room.isPublicFacing) return signs;

  // Vestibule leading to exterior
  if (room.isVestibule) {
    signs.push(sign("Exit", 1, "R9", 0.8));
    // BB4 — Exit door tactile sign (ADA) at every exterior-entry vestibule
    signs.push(sign("Exit(Tactile)", 1, "R9", 0.8));
    return signs;
  }
  // Public lobby with exit door
  if (room.isPublicFacing && room.isCorridorOrHall === false) {
    signs.push(sign("Exit", 1, "R9", 0.75));
    return signs;
  }
  // Assembly room — exits based on occupant load
  if (room.isAssembly && (room.occupantLoad ?? 0) >= 50) {
    signs.push(sign("Exit", 2, "R9", 0.8));
    return signs;
  }
  return signs;
}

// Hard check keywords for Max Occupancy / ADA Occupancy sign.
// The room name must contain at least one of these before capacity signs are assigned.
const CAPACITY_ASSEMBLY_KEYWORDS = [
  "assembly", "auditorium", "cafeteria", "gymnasium", "gym",
  "theater", "theatre", "chapel", "conference", "meeting",
  "ballroom", "banquet", "lecture", "multipurpose", "multi-purpose",
  "classroom", "training room", "community room", "community",
  "event space", "flex room", "activity room", "recreation room",
];

function applyCapacityRule(room: RoomRecord, traits: BuildingTraits): SignAssignment[] {
  if (!traits.hasAssemblyRules) return [];
  if (!room.isAssembly) return [];

  // Hard check: room name must contain an assembly keyword — prevents broad isAssembly
  // matches (e.g. rooms flagged via occupancy group alone) from generating capacity signs.
  const roomNameNorm = room.roomName.toLowerCase();
  if (!CAPACITY_ASSEMBLY_KEYWORDS.some(k => roomNameNorm.includes(k))) return [];

  const occGroup = (room.occupancyGroup ?? "").toUpperCase();
  const isOccupancyA = /^A-?[23]/.test(occGroup);
  const highOccupancy = (room.occupantLoad ?? 0) >= 50;

  if (!isOccupancyA && !highOccupancy) return [];

  // Fix 5: Assembly rooms that qualify for Max Occupancy ALWAYS get BOTH:
  //   • Room ID w/insert (posted at the door — holds current-use label)
  //   • Max Occupancy  (posted inside the room at the primary entrance — ada_required=false)
  // Variable use + assembly = 2 inserts (one per use configuration).
  const qty = room.isVariableUse ? 2 : 1;
  return [
    sign("Room ID w/insert", qty, "R2", 0.80),
    sign("Max Occupancy",    qty, "R10", 0.8),
  ];
}


export function applyStairRules(
  stairRooms: RoomRecord[],
  levels: string[],
  traits: BuildingTraits,
  buildingType = "commercial",
): SignAssignment[] {
  if (stairRooms.length === 0) return [];

  const floorCount = Math.max(levels.filter((l) => l.trim()).length, 1);

  // Deduplicate by room number only (case-insensitive) to identify unique stair cores.
  // Each stair core serves ALL floors in the building per IBC stair identification requirements.
  // Using roomNumber (not level) avoids under-counting when PDFs only include the stair on one
  // floor's plan — the sign still goes on every floor the stair serves.
  const seenNumbers = new Set<string>();
  const uniqueStairs = stairRooms.filter((r) => {
    // Use a normalized key: prefer roomNumber but fall back to first 30 chars of roomName.
    const key = (r.roomNumber.trim() || r.roomName.slice(0, 30)).toUpperCase();
    if (seenNumbers.has(key)) return false;
    seenNumbers.add(key);
    return true;
  });

  const signs: SignAssignment[] = [];

  // Stair content variant note (stored in notes field for purchasing/fabrication reference).
  const stairVariant = STAIR_SIGN_VARIANT[buildingType] ?? STAIR_SIGN_VARIANT[normalizeBuildingType(buildingType)] ?? "STAIR [X]";

  for (const _room of uniqueStairs) {
    // R11: One Stair(Corridor) + One Stair(Landing) per floor served.
    // qty = floorCount so the total count is correct without emitting N separate rows.
    signs.push(sign("Stair(Corridor)", floorCount, "R11", 0.80, stairVariant));
    signs.push(sign("Stair(Landing)",  floorCount, "R11", 0.85, stairVariant));

    // BB4 — ADA Exit(Tactile) at each stair door on each floor.
    signs.push(sign("Exit(Tactile)", floorCount, "R11", 0.80));

    // AA2/AA3 — Floor directory board: one per stair (not per floor), at the landing.
    if (traits.hasDirectory) {
      signs.push(sign("Office Directory", 1, "R14", 0.75));
    }

    // Fix 6 — Area of Rescue (R16): required at every stair landing in government and assembly
    // buildings (IBC 1007 — Areas of Rescue Assistance).
    if (traits.requiresAreaOfRescue) {
      signs.push(sign("Area of Rescue", floorCount, "R16", 0.85));
    }
  }

  return signs;
}

// Stair sign content note by building type (stored in `notes` for fabrication reference).
// Purchasers/fabricators use this to determine the correct message panel content.
const STAIR_SIGN_VARIANT: Record<string, string> = {
  education:   "STAIR [X] — ROOF ACCESS: SEE PLANS",
  healthcare:  "STAIR [X] — SMOKE COMPARTMENT: SEE PLANS",
  government:  "STAIR [X] — AREA OF RESCUE ASSISTANCE AVAILABLE",
  assembly:    "STAIR [X] — AREA OF RESCUE ASSISTANCE AVAILABLE",
  commercial:  "STAIR [X]",
  hotel:       "STAIR [X]",
  residential: "STAIR [X]",
  unknown:     "STAIR [X]",
};

export function applyElevatorRules(
  elevatorRooms: RoomRecord[],
  levels: string[],
  traits: BuildingTraits,
): SignAssignment[] {
  if (elevatorRooms.length === 0) return [];

  // Group by room number to identify unique elevator cabs (same logic as stairs)
  const elevsByNumber = new Map<string, RoomRecord[]>();
  for (const elev of elevatorRooms) {
    const key = elev.roomNumber.toUpperCase();
    if (!elevsByNumber.has(key)) elevsByNumber.set(key, []);
    elevsByNumber.get(key)!.push(elev);
  }
  const uniqueElevCount = elevsByNumber.size;

  if (traits.elevatorMode === "per_building") {
    // One Elevator ID sign per elevator cab (ADA 216.4), reported as a single
    // aggregate row whose qty is the unique-cab count. Stamp the first cab's
    // room so the row links to a real elevator room (it survives dedup on its
    // own since there is only one such row).
    const firstInstance = elevsByNumber.values().next().value?.[0];
    return [{
      ...sign("Elevator", uniqueElevCount, "R12", 0.85),
      ...(firstInstance ? { roomId: firstInstance.id, floorLabel: firstInstance.level } : {}),
    }];
  } else {
    // per_level: one Elevator ID sign per elevator (grouped by number) with
    // qty = levels served. Each row is stamped with its source elevator room so
    // distinct elevator cabs (e.g. AE-1 vs BE-1, or per-floor hoistway numbers
    // like AE-1/AE-2/AE-3) keep separate dedup keys instead of collapsing into
    // one. Without this stamp, every per-level Elevator row shares the empty
    // `||ELEVATOR||` key and the final per-room dedup drops all but one.
    const totalSigns: SignAssignment[] = [];
    for (const [, elevInstances] of elevsByNumber) {
      const levelsServed = [...new Set(elevInstances.map((e) => e.level))];
      const rep = elevInstances[0];
      totalSigns.push({
        ...sign("Elevator", levelsServed.length, "R12", 0.80),
        roomId: rep.id,
        floorLabel: levelsServed.length === 1 ? rep.level : "",
      });
    }
    return totalSigns;
  }
}

// Keyword pattern for primary exit-cluster rooms (EXIT, STAIR, ELEVATOR, LOBBY).
// Evacuation Maps are placed near these locations only — never one per ordinary room.
const EXIT_CLUSTER_KEYWORDS =
  /\bEXIT\b|\bSTAIR(S|WELL|WAY|CASE|CORE|SHAFT)?\b|\bELEV(ATOR)?\b|\bLIFT\b|\bLOBBY\b|\bENTRY\b|\bENTRANCE\b/i;

// Education buildings use a stricter placement rule: Evac Maps only go at
// main corridors and lobbies (not at every exit stair or elevator cluster).
const EVAC_EDUCATION_PLACEMENT_KEYWORDS =
  /\bCORR(IDOR)?\b|\bHALL(WAY)?\b|\bHALL\b|\bLOBBY\b|\bFOYER\b|\bENTRY\b|\bENTRANCE\b/i;

// Residential / unit-based building types that follow the room-count cap formula.
const RESIDENTIAL_EVAC_TYPES = new Set([
  "residential", "multifamily", "senior_living", "dormitory",
]);

// Education building types — canonical + legacy aliases used in classifyRoom / detectBuildingType.
const EDUCATION_EVAC_TYPES = new Set([
  "education", "school", "university", "college", "daycare", "library",
]);

/**
 * Total Evacuation Maps for the entire building.
 *
 * Residential:  capped by one map per 20 rooms (orientations), max 2 per floor.
 * Education:    max 2 per floor, hard cap of 4 total (schools rarely need more).
 * All others:   1 per floor up to 5 floors; 2 per floor from 6 floors onward.
 */
export function getEvacMapCount(
  floors: number,
  buildingType: string,
  roomCount: number,
): number {
  // Residential / unit-based buildings: 1 per floor, capped by room-count orientation formula.
  // Rationale: residents orient by their unit neighbourhood, not the whole building.
  if (RESIDENTIAL_EVAC_TYPES.has(buildingType)) {
    return Math.min(floors * 1, Math.ceil(roomCount / 20));
  }
  // Education: 2 per floor (one per wing), hard cap of 4 total across the building.
  if (EDUCATION_EVAC_TYPES.has(buildingType)) {
    return Math.min(floors * 2, 4);
  }
  // All other types: use the per-floor cap from the lookup table (Fix 4).
  const perFloor = evacMapsPerFloorCap(floors, buildingType);
  return floors * perFloor;
}

/**
 * Max evacuation maps per floor by building type (Fix 4).
 * Values reflect placement at decision points only (corridors, lobbies, smoke compartments).
 *
 *  Healthcare:  4 per floor — one per smoke compartment (typically 4 per floor in hospitals)
 *  Education:   2 per floor — one per wing (schools typically have 2 wings)
 *  Commercial:  2 per floor — one per main corridor segment
 *  Government:  2 per floor — one per main corridor segment
 *  Assembly:    2 per floor — one per main entry area
 *  Hotel:       1 per floor — one at elevator lobby
 *  Residential: 1 per floor — one at elevator/stair lobby
 *  Unknown:     2 per floor (conservative default)
 */
const EVAC_MAP_FLOOR_CAPS: Record<string, number> = {
  // Canonical 8 types
  education:   2,
  healthcare:  4,
  commercial:  2,
  government:  2,
  hotel:       1,
  residential: 1,
  assembly:    2,
  unknown:     2,
  // Legacy aliases
  school:       2,
  university:   2,
  college:      2,
  daycare:      2,
  library:      2,
  hospital:     4,
  clinic:       4,
  medical:      4,
  dental:       4,
  nursing_home: 4,
  office:       2,
  retail:       2,
  restaurant:   2,
  airport:      2,
  transit:      2,
  warehouse:    2,
  industrial:   2,
  mixed_use:    2,
  mixed:        2,
  municipal:    2,
  federal:      2,
  courthouse:   2,
  police:       2,
  fire_station: 2,
  military:     2,
  motel:        1,
  resort:       1,
  inn:          1,
  multifamily:  1,
  apartment:    1,
  condo:        1,
  senior_living:1,
  dormitory:    1,
  affordable_housing: 1,
  church:       2,
  theater:      2,
  theatre:      2,
  arena:        2,
  stadium:      2,
  convention:   2,
  museum:       2,
  gym_venue:    2,
};

/**
 * Per-floor cap for evacuation maps (Fix 4).
 * Uses the building-type lookup table; falls back to 1 for unknown legacy types.
 */
export function evacMapsPerFloorCap(floorCount: number, buildingType: string): number {
  const cap = EVAC_MAP_FLOOR_CAPS[buildingType] ?? EVAC_MAP_FLOOR_CAPS[normalizeBuildingType(buildingType)];
  return cap ?? (floorCount >= 6 ? 2 : 1); // fallback for completely unknown types
}

export function applyEvacMapRules(
  rooms: RoomRecord[],
  levels: string[],
  elevatorLobbies: RoomRecord[],
  buildingType = "commercial",
): SignAssignment[] {
  const signs: SignAssignment[] = [];
  const floorCount = Math.max(levels.filter((l) => l.trim()).length, 1);
  const roomCount = rooms.length;

  // Single-floor small building (< 10 rooms): 0 maps — owner posts their own.
  if (floorCount < 2 && roomCount < 10) {
    console.log(
      `Evacuation Map: assigned 0 maps across ${floorCount} floors (${buildingType} rule — single-floor small building)`,
    );
    return signs;
  }

  // Trigger: building has 2+ floors OR large floor plate (20+ rooms).
  if (floorCount < 2 && roomCount < 20) {
    console.log(
      `Evacuation Map: assigned 0 maps across ${floorCount} floors (${buildingType} rule — building too small)`,
    );
    return signs;
  }

  // Total building cap.
  const totalCap = getEvacMapCount(floorCount, buildingType, roomCount);

  // De-duplicate by floor: only one map per qualifying floor.
  // Education buildings: restrict placement to main corridors and lobbies only
  // (not every exit stair or elevator shaft — schools have too many of those).
  // All other building types: use the standard exit-cluster filter (stair, elevator, lobby, entry).
  //
  // Data-driven activation: the education-only-corridor restriction is enforced only when
  // the building actually has corridor/lobby anchors extracted.  If none were found (the
  // restriction's assumption doesn't hold for this building's data), fall back to the
  // standard exit-cluster filter so the building still receives evac maps rather than zero.
  const isEducation = EDUCATION_EVAC_TYPES.has(buildingType);
  const educationAnchorCount = isEducation
    ? rooms.filter(
        (r) => EVAC_EDUCATION_PLACEMENT_KEYWORDS.test(r.roomName) || r.isCorridorOrHall,
      ).length
    : 0;
  const useEducationPlacement = isEducation && educationAnchorCount > 0;
  if (isEducation && !useEducationPlacement) {
    console.log(
      `[evac-placement] '${buildingType}' building has no corridor/lobby anchors — falling back to standard exit-cluster placement`,
    );
  }
  const floorsWithCluster = new Set(
    (useEducationPlacement ? rooms : [...elevatorLobbies, ...rooms])
      .filter((r) =>
        useEducationPlacement
          ? EVAC_EDUCATION_PLACEMENT_KEYWORDS.test(r.roomName) || r.isCorridorOrHall
          : EXIT_CLUSTER_KEYWORDS.test(r.roomName),
      )
      .map((r) => r.level ?? ""),
  );

  let assigned = 0;
  for (const _floor of floorsWithCluster) {
    if (assigned >= totalCap) break;
    signs.push(sign("Evacuation Map", 1, "R13", 0.85));
    assigned++;
  }

  console.log(
    `Evacuation Map: assigned ${assigned} maps across ${floorCount} floors (${buildingType} rule)`,
  );
  return signs;
}

/**
 * R14 — Office Directory.
 *
 * `directoryEligible` must be pre-computed by the caller (once per run, not per room)
 * to avoid re-scanning every room on every call.  It encodes:
 *   • The building type supports a directory (traits.hasDirectory)
 *   • AND the building has enough distinct tenants/suites to justify one:
 *       - 3+ rooms whose names begin with "SUITE" (explicit multi-tenant indicator), OR
 *       - more than 30 occupied rooms AND at least one lobby/entry room
 *
 * A single-tenant space (airport lounge, standalone clinic, hotel lobby) that
 * happens to have a LOBBY room will NOT fire here unless the suite/room-count
 * thresholds are met.
 */
function applyOfficeDirectoryRule(room: RoomRecord, directoryEligible: boolean): SignAssignment[] {
  if (!directoryEligible) return [];
  // Fix 1: Office Directory only at true lobby/reception rooms (not corridors or compound names)
  const isDirectoryLocation =
    /\bLOBBY\b/i.test(room.roomName) &&
    !/CORRIDOR|HALL|VEST|OFFICE|JAN/i.test(room.roomName);
  if (!isDirectoryLocation) return [];
  const signs: SignAssignment[] = [sign("Office Directory", 1, "R14", 0.75)];
  // AA1 / BB5 — Building Directory + Entry sign only at the main public lobby (pure LOBBY name)
  // Fix 3: exclude compound lobby names like "VESTIBULE JAN LOBBY" or "LOBBY OFFICE"
  const isMainLobby =
    /^LOBBY$/i.test(room.roomName.trim()) ||
    (room.isPublicFacing && /^LOBBY\b/i.test(room.roomName.trim()) && !/VEST|OFFICE|JAN/i.test(room.roomName));
  if (isMainLobby) {
    signs.push(sign("Building ID", 1, "R14", 0.75));
    signs.push(sign("Accessible Entrance", 1, "R14", 0.75));
  }
  return signs;
}

function applyMezzanineRule(room: RoomRecord): boolean {
  return MEZZANINE_KEYWORDS.test(room.level) && room.isMepUnoccupied;
}

// ---------------------------------------------------------------------------
// Main pipeline entry point
// ---------------------------------------------------------------------------

export interface RuleEngineInput {
  rooms: RoomRecord[];
  buildingType: string;
  ruleOverrides?: Array<{
    ruleRef: string;
    overrideType: string;
    condition: Record<string, unknown>;
    action: Record<string, unknown>;
  }>;
  /** Custom room-name keywords that trigger multi-entry detection (R3). Merged with the built-in list. */
  customMultiEntryKeywords?: string[];
  /**
   * Sign type definitions extracted from an embedded signage-notes sheet (A0.x).
   * When present, types not found in this list are suppressed (Exit, Evacuation Map, Directory, etc.).
   * When absent the standard building-trait rules apply unchanged.
   */
  signTypeDefinitions?: Array<{ typeCode: string; description: string }>;
  /**
   * Alias map: canonical sign type → project-specific label.
   * E.g. { "Room ID": "Type A" } when the embedded schedule maps Type A → Room Identification.
   * Applied after all other rules so the output labels match the sign schedule.
   */
  signTypeAlias?: Record<string, string>;
}

export interface RuleEngineOutput {
  results: RoomResult[];
  detectedBuildingType: string;
  traits: BuildingTraits;
  levels: string[];
  // Aggregate signs for non-room entities
  stairSigns: SignAssignment[];
  elevatorSigns: SignAssignment[];
  evacMapSigns: SignAssignment[];
  /**
   * Formula-derived exit signs (Fix 3): generated from stair_count × floor_count plus minimum
   * exterior exit doors.  These represent exit door signs at stair entrances and exterior doors.
   * Separate from per-room Exit signs (vestibule, lobby) which remain in `results`.
   */
  exitSigns: SignAssignment[];
  /** Types suppressed because they were not found in the embedded sign schedule. */
  suppressionLog: string[];
}

// ---------------------------------------------------------------------------
// Fix 3 — Formula-based exit signs (R9)
// ---------------------------------------------------------------------------
// Minimum exterior exit door counts by building type (conservative estimate).
// Actual count must be verified against the plans — these are code minimums.
const MIN_EXTERIOR_EXIT_DOORS: Record<string, number> = {
  education:   4,  // min 2 per wing × 2 wings
  healthcare:  4,  // exterior exit + smoke barrier exits (verify on plans)
  commercial:  4,  // min 2 per floor × 2 stair towers
  government:  4,  // same as commercial + secure zone exit doors
  hotel:       4,  // min stair exits + lobby exit
  residential: 2,  // min 2 per building (IBC 1006.2)
  assembly:    6,  // IBC 1006.3 Group A — min 3 exterior exits per assembly space
  unknown:     4,
};

/**
 * applyFormulaExitSigns — R9 (Fix 3)
 *
 * Exit signs derived from structural egress geometry, not room names:
 *   • One Exit sign per stair × per floor (at each stair door)
 *   • Minimum exterior exit doors per building type (verify count on plans)
 *
 * These supplement the existing per-room exit signs (vestibule/lobby logic).
 * Displayed separately in the Review tab under "Egress".
 */
export function applyFormulaExitSigns(
  stairCount: number,
  floorCount: number,
  buildingType: string,
): SignAssignment[] {
  if (stairCount === 0 && floorCount === 0) return [];

  const normalized = normalizeBuildingType(buildingType);
  const minExterior =
    MIN_EXTERIOR_EXIT_DOORS[normalized] ??
    MIN_EXTERIOR_EXIT_DOORS[buildingType] ??
    MIN_EXTERIOR_EXIT_DOORS["unknown"];

  const signs: SignAssignment[] = [];

  // Stair exit doors: one Exit sign per stair per floor
  const stairExitCount = stairCount * floorCount;
  if (stairExitCount > 0) {
    signs.push(sign("Exit", stairExitCount, "R9", 0.80, "Stair exit door — one per stair per floor"));
  }

  // Minimum exterior exit doors (verify on architectural plans)
  signs.push(
    sign("Exit", minExterior, "R9", 0.65, "Exterior exit doors — verify count on plans"),
  );

  return signs;
}

// ---------------------------------------------------------------------------
// FIX 2 helper — derive which canonical sign types to suppress based on
// the embedded schedule's type definitions.  Returns null when no schedule
// is present (fall back to standard rules for all types).
// ---------------------------------------------------------------------------

/** Maps a canonical sign type to the keywords we look for in schedule descriptions. */
const SCHEDULE_SUPPRESSABLE: Array<{ signTypes: string[]; keywords: RegExp }> = [
  { signTypes: ["Exit", "Exit(Tactile)"],                         keywords: /\bexit\b/i },
  { signTypes: ["Evacuation Map"],                                 keywords: /evac(uation)?|emergency.?\s*map/i },
  { signTypes: ["Office Directory", "Building ID"],                keywords: /\bdirectory\b/i },
];

function buildScheduleSuppressedTypes(
  defs?: Array<{ typeCode: string; description: string }>,
): Set<string> | null {
  if (!defs || defs.length === 0) return null;
  const suppressed = new Set<string>();
  for (const { signTypes, keywords } of SCHEDULE_SUPPRESSABLE) {
    const inSchedule = defs.some(
      (d) => keywords.test(d.description) || keywords.test(d.typeCode),
    );
    if (!inSchedule) {
      for (const t of signTypes) suppressed.add(t);
    }
  }
  return suppressed.size > 0 ? suppressed : null;
}


export function applyRules(input: RuleEngineInput): RuleEngineOutput {
  const {
    rooms,
    buildingType,
    ruleOverrides = [],
    customMultiEntryKeywords,
    signTypeDefinitions,
    signTypeAlias = {},
  } = input;

  // ── Step 8: Structured logging ──────────────────────────────────────────
  console.log(`[rules] Building type: ${buildingType}`);
  console.log(`[rules] Rule matrix: ${buildingType}`);

  // FIX 2: build suppressed-type set from embedded schedule (null = no schedule = no suppression)
  const schedSuppressed = buildScheduleSuppressedTypes(signTypeDefinitions);
  const suppressionLog: string[] = [];  // collect per-run (not per-room) for caller logging
  const removedByCanonical = new Set<string>(); // types removed by the ADA canonical filter

  const traits = BUILDING_TRAITS[buildingType] ?? BUILDING_TRAITS["commercial"];
  const levels = [...new Set(rooms.map((r) => r.level))].sort();

  // Build merged multi-entry regex (built-in keywords + tenant custom keywords)
  const multiEntryRegex = buildMultiEntryRegex(customMultiEntryKeywords);

  // Fix 1: supplement isStair detection with room-number pattern matching
  const stairRooms = rooms.filter(
    (r) => r.isStair || classifyRoomNumberAsStair(r.roomNumber, buildingType),
  );
  const elevatorRooms = rooms.filter((r) => r.isElevator);
  const elevatorLobbies = rooms.filter(
    (r) => r.isPublicFacing && ELEVATOR_KEYWORDS.test(r.roomName),
  );

  // ── Office Directory eligibility (computed once, not per room) ──────────────
  // Only fire R14 in genuinely multi-tenant buildings.
  // Thresholds:
  //   • 3+ rooms beginning with "SUITE" (explicit multi-tenant signal), OR
  //   • More than 30 occupied non-MEP rooms AND at least one lobby/entry room.
  // Single-tenant spaces (airport lounges, standalone clinics) that happen to
  // have a LOBBY do NOT qualify unless one of these thresholds is met.
  const suiteCount = rooms.filter((r) => /^SUITE\b/i.test(r.roomName.trim())).length;
  const occupiedRoomCount = rooms.filter(
    (r) => !r.isMepUnoccupied && !r.isDoorScheduleEntry,
  ).length;
  const hasLobbyEntry = rooms.some((r) => LOBBY_ENTRY_KEYWORDS.test(r.roomName));
  const directoryEligible =
    traits.hasDirectory &&
    (suiteCount >= 3 || (occupiedRoomCount > 30 && hasLobbyEntry));

  // ── UNIT/APT dominance (computed once) ──────────────────────────────────────
  // When UNIT/APT-named rooms make up ≥30% of the set (the same threshold
  // detectBuildingType uses to classify a building as residential) AND number ≥5
  // in absolute terms, they are real dwelling units (e.g. a dormitory or
  // student-housing set mislabeled as "education"), not stray airport-gate /
  // door-schedule artifacts.  In that case the non-residential UNIT/APT
  // suppression below must stand down so the units fall through to the normal
  // Room-ID rules.  The ≥5 floor keeps a handful of stray UNIT labels in a small
  // commercial set from tripping the guard.
  const unitAptCount = rooms.filter((r) => /^UNIT\b|^APT\b/i.test(r.roomName.trim())).length;
  const unitDominant = unitAptCount >= 5 && unitAptCount / rooms.length >= 0.3;

  // ── Residential-unit dominance (computed once) ──────────────────────────────
  // The residential Room ID scope restriction in applyRoomIdRules keeps signs only
  // for units, common areas, and MEP rooms.  Apply it only when the building's data
  // confirms it is genuinely unit-organized: residential units (by name flag or unit
  // numbering) make up ≥30% of the set AND number ≥5 — the same threshold
  // detectBuildingType uses to classify a building as residential.  This prevents a
  // mislabeled or mixed-use "residential" building, or one where unit detection broadly
  // failed, from having its non-unit rooms silently dropped (cf. the dorm-mislabel bug).
  const resUnitCount = rooms.filter(
    (r) => r.isResidentialUnit || isResidentialUnitByNumber(r.roomNumber, buildingType),
  ).length;
  const residentialUnitsDominant = resUnitCount >= 5 && resUnitCount / rooms.length >= 0.3;
  const residentialScopeActive =
    RESIDENTIAL_SCOPE_TYPES.has(buildingType) && residentialUnitsDominant;
  if (RESIDENTIAL_SCOPE_TYPES.has(buildingType) && !residentialUnitsDominant) {
    console.log(
      `[residential-scope] Stood down for '${buildingType}' building — only ${resUnitCount}/${rooms.length} rooms look like units (need ≥5 and ≥30%); keeping non-unit Room IDs`,
    );
  }

  const results: RoomResult[] = [];

  let junkFiltered = 0;
  for (const room of rooms) {
    // Door-schedule entries (e.g. "106A", "UNIT 106A") carry no sign assignment.
    if (room.isDoorScheduleEntry) {
      results.push({ room, signs: [] });
      continue;
    }

    // Universal garbage filter — skip PDF schedule rows / keynote fragments
    if (isJunkRoomName(room.roomName)) {
      junkFiltered++;
      console.log(`[rules] Garbage-filtered: '${room.roomName}'`);
      results.push({ room, signs: [] });
      continue;
    }

    // R15 — Mezzanine exclusion
    if (applyMezzanineRule(room)) {
      results.push({ room, signs: [] });
      continue;
    }

    // In non-residential buildings, rooms named "UNIT NNN" or "APT NNN" are
    // likely airport gate codes, storage-unit numbers, or misclassified door
    // schedule codes — NOT residential apartment doors.  Suppress them entirely
    // (no sign assignment) since neither Unit ID nor Room ID is appropriate.
    //
    // "Suite NNN" rooms are deliberately excluded from this suppression — they
    // are legitimate office suites that should still receive a Room ID sign.
    // The distinction: ^UNIT / ^APT → ambiguous in non-residential context,
    // ^SUITE → unambiguous multi-tenant office identifier.
    const isUnitOrAptRoom = /^UNIT\b|^APT\b/i.test(room.roomName.trim());
    // Compute once per room — used by both the UNIT/APT early-skip and Guard 2 below.
    const normalizedBt = normalizeBuildingType(buildingType);
    const unitIdAllowed =
      UNIT_SIGN_BUILDING_TYPES.has(buildingType) ||
      UNIT_SIGN_BUILDING_TYPES.has(normalizedBt);
    // Stand down when UNIT/APT names dominate the set — they are real dwelling
    // units (dorm/student housing), not non-residential artifacts.
    if (isUnitOrAptRoom && !unitIdAllowed && !unitDominant) {
      console.log(
        `[canonical-guard] Suppressed '${room.roomName}' in '${buildingType}' building — UNIT/APT prefix is non-residential context`,
      );
      results.push({ room, signs: [] });
      continue;
    }

    const roomSigns: SignAssignment[] = [];

    // Room ID rules (R1-R7)
    roomSigns.push(
      ...applyRoomIdRules(room, traits, buildingType, multiEntryRegex, residentialScopeActive),
    );

    // R8 — Restroom
    roomSigns.push(...applyRestroomRule(room));

    // R9 — Exit
    roomSigns.push(...applyExitRule(room, traits));

    // R10 — Capacity (assembly rooms with occupant load ≥ 50 only)
    roomSigns.push(...applyCapacityRule(room, traits));

    // R14 — Office Directory
    roomSigns.push(...applyOfficeDirectoryRule(room, directoryEligible));

    // Fix 5 dedup: if applyCapacityRule returned "Room ID w/insert", remove any plain
    // "Room ID" that applyRoomIdRules added — keep only the richer insert version.
    const hasInsert = roomSigns.some((s) => s.signType === "Room ID w/insert");
    const dedupedRoomSigns = hasInsert
      ? roomSigns.filter((s) => s.signType !== "Room ID")
      : roomSigns;
    // Also dedup duplicate "Room ID w/insert" rows (variable-use rooms that also match
    // assembly criteria can produce two — keep only the first).
    const seenTypes = new Set<string>();
    const uniqueRoomSigns = dedupedRoomSigns.filter((s) => {
      if (s.signType === "Room ID w/insert") {
        if (seenTypes.has(s.signType)) return false;
        seenTypes.add(s.signType);
      }
      return true;
    });

    // Apply tenant rule overrides
    let finalSigns = applyRuleOverrides(room, uniqueRoomSigns, ruleOverrides);

    // ── Step A: suppress types not present in embedded sign schedule ─────────
    // Runs before the canonical guard so the guard sees the final content set.
    if (schedSuppressed) {
      const beforeCount = finalSigns.length;
      finalSigns = finalSigns.filter((s) => !s.signType || !schedSuppressed.has(s.signType));
      if (finalSigns.length < beforeCount) {
        for (const s of roomSigns) {
          if (s.signType && schedSuppressed.has(s.signType) && !suppressionLog.includes(s.signType)) {
            suppressionLog.push(s.signType);
          }
        }
      }
    }

    // ── Step B: Definitive canonical guard — ABSOLUTE LAST CONTENT GATE ──────
    // Runs AFTER all sources: rules engine, training corrections, schedule
    // suppression, AI vision assignments (which arrive via ruleOverrides).
    // Any sign whose type is not in the 16-type ADA canonical set — from ANY
    // source — is dropped here and logged.  No non-canonical sign may pass.
    // normalizedBt / unitIdAllowed are computed once per room above.
    finalSigns = finalSigns.filter((s) => {
      // Guard 1: type must be in the ADA canonical set
      if (!ADA_CANONICAL_SIGN_TYPES.has(s.signType)) {
        removedByCanonical.add(s.signType);
        console.warn(
          `[canonical-guard] Dropped '${s.signType}' for '${room.roomName}' — not in ADA canonical list`,
        );
        return false;
      }
      // Guard 2: Unit ID is only valid for residential-class or hotel buildings.
      // Catches training corrections / AI vision that assign Unit ID to a
      // commercial or education building.
      if (s.signType === "Unit ID" && !unitIdAllowed) {
        removedByCanonical.add(s.signType);
        console.log(
          `[canonical-guard] Dropped Unit ID for '${room.roomName}' — building type '${buildingType}' is not in residential group`,
        );
        return false;
      }
      // Guard 3: Max Occupancy is only valid for assembly rooms (IBC 1004).
      // Catches any source that adds Max Occupancy to a storage room, corridor, etc.
      if (s.signType === "Max Occupancy" && !room.isAssembly) {
        removedByCanonical.add(s.signType);
        console.log(
          `[canonical-guard] Dropped Max Occupancy for '${room.roomName}' — not an assembly room`,
        );
        return false;
      }
      return true;
    });

    // ── Step C: apply sign type alias (display transform — after content gate) ─
    // E.g. "Room ID" → "Type A" per the project's embedded sign schedule.
    // Alias runs AFTER the canonical guard so the guard always checks canonical names.
    if (Object.keys(signTypeAlias).length > 0) {
      finalSigns = finalSigns.map((s) => ({
        ...s,
        signType: signTypeAlias[s.signType] ?? s.signType,
      }));
    }

    results.push({ room, signs: finalSigns });
  }

  // Aggregate stair/elevator/evac signs
  let stairSigns = applyStairRules(stairRooms, levels, traits, buildingType);
  let elevatorSigns = applyElevatorRules(elevatorRooms, levels, traits);
  let evacMapSigns = applyEvacMapRules(rooms, levels, elevatorLobbies, buildingType);

  // Fix 3 — Formula-based exit signs (computed here; filtered after applyFiltersToAggregate is defined)
  const floorCount = Math.max(levels.filter((l) => l.trim()).length, 1);
  let exitSigns = applyFormulaExitSigns(stairRooms.length, floorCount, buildingType);

  // ── Canonical guard for aggregate signs (stair/elevator/evac) ──────────────
  // Same three-step order as per-room: schedule suppression → canonical guard
  // → sign type alias.  Guard 2/3 (Unit ID, Max Occupancy) are not needed for
  // aggregate signs since those types are never generated by stair/elevator/evac rules.
  const applyFiltersToAggregate = (signs: SignAssignment[]): SignAssignment[] => {
    // Step A: schedule suppression first
    let out = [...signs];
    if (schedSuppressed) {
      out = out.filter((s) => !s.signType || !schedSuppressed.has(s.signType));
      for (const s of signs) {
        if (s.signType && schedSuppressed.has(s.signType) && !suppressionLog.includes(s.signType)) {
          suppressionLog.push(s.signType);
        }
      }
    }
    // Step B: canonical guard — absolute last content gate
    out = out.filter((s) => {
      if (ADA_CANONICAL_SIGN_TYPES.has(s.signType)) return true;
      removedByCanonical.add(s.signType);
      console.warn(
        `[canonical-guard] Dropped aggregate '${s.signType}' — not in ADA canonical list`,
      );
      return false;
    });
    // Step C: sign type alias (display transform)
    if (Object.keys(signTypeAlias).length > 0) {
      out = out.map((s) => ({ ...s, signType: signTypeAlias[s.signType] ?? s.signType }));
    }
    return out;
  };
  stairSigns = applyFiltersToAggregate(stairSigns);
  elevatorSigns = applyFiltersToAggregate(elevatorSigns);
  evacMapSigns = applyFiltersToAggregate(evacMapSigns);
  exitSigns = applyFiltersToAggregate(exitSigns);

  if (removedByCanonical.size > 0) {
    console.warn(
      `[canonical-guard] Removed non-canonical types this run: ${[...removedByCanonical].join(", ")}`,
    );
  }

  // ── Structured summary log ──────────────────────────────────────────────
  const totalAssigned = results.reduce((sum, r) => sum + r.signs.length, 0);
  console.log(
    `[rules] Summary — buildingType=${buildingType}` +
    ` rooms=${rooms.length}` +
    ` junkFiltered=${junkFiltered}` +
    ` signsAssigned=${totalAssigned + stairSigns.length + elevatorSigns.length + evacMapSigns.length}` +
    ` stairSigns=${stairSigns.length}` +
    ` elevatorSigns=${elevatorSigns.length}` +
    ` evacMaps=${evacMapSigns.length}`,
  );

  return {
    results,
    detectedBuildingType: buildingType,
    traits,
    levels,
    stairSigns,
    elevatorSigns,
    evacMapSigns,
    exitSigns,
    suppressionLog,
  };
}

// ---------------------------------------------------------------------------
// Rule override application
// ---------------------------------------------------------------------------

function applyRuleOverrides(
  room: RoomRecord,
  signs: SignAssignment[],
  overrides: RuleEngineInput["ruleOverrides"],
): SignAssignment[] {
  if (!overrides || overrides.length === 0) return signs;

  type MatchedOverride = {
    override: NonNullable<RuleEngineInput["ruleOverrides"]>[number];
    signType: string;
    qty: number;
    confidence: number;
    originalIdx: number;
  };

  const matched: MatchedOverride[] = [];

  for (let i = 0; i < overrides.length; i++) {
    const override = overrides[i];
    const condition = override.condition as Record<string, unknown>;
    const action    = override.action    as Record<string, unknown>;

    const signType   = String(action.sign_type ?? action.signType ?? "");
    const qty        = Number(action.qty ?? 1);
    const confidence = parseFloat(String(condition.confidence ?? action.confidence ?? "0.85"));

    // Derive a human-readable label for the diagnostic log
    const patternLabel =
      condition.roomNamePattern !== undefined ? String(condition.roomNamePattern) :
      condition.room_name_contains           ? `contains:${condition.room_name_contains}` :
      "(no-pattern)";

    // Check condition match
    let matches = true;
    if (condition.room_name_contains) {
      const p = String(condition.room_name_contains).toUpperCase();
      if (!room.roomName.toUpperCase().includes(p)) matches = false;
    }
    if (condition.is_restroom !== undefined) {
      if (room.isRestroom !== Boolean(condition.is_restroom)) matches = false;
    }
    if (condition.is_corridor !== undefined) {
      if (room.isCorridorOrHall !== Boolean(condition.is_corridor)) matches = false;
    }
    if (condition.is_residential_unit !== undefined) {
      if (room.isResidentialUnit !== Boolean(condition.is_residential_unit)) matches = false;
    }
    if (condition.is_vehicle_bay !== undefined) {
      if (room.isVehicleBay !== Boolean(condition.is_vehicle_bay)) matches = false;
    }
    if (condition.is_mep_unoccupied !== undefined) {
      if (room.isMepUnoccupied !== Boolean(condition.is_mep_unoccupied)) matches = false;
    }
    if (condition.occupancy_group !== undefined) {
      const condGroup = String(condition.occupancy_group).toUpperCase();
      const roomGroup = (room.occupancyGroup ?? "").toUpperCase();
      if (roomGroup !== condGroup) matches = false;
    }
    if (condition.room_number_equals !== undefined) {
      const condNumber = String(condition.room_number_equals).toUpperCase();
      if (room.roomNumber.toUpperCase() !== condNumber) matches = false;
    }
    if (condition.roomNamePattern !== undefined) {
      const p       = String(condition.roomNamePattern).toLowerCase().trim();
      const roomName = room.roomName.toLowerCase().trim();

      // Guard: empty pattern would match every room via `includes("")` — treat as no match.
      if (p.length === 0) {
        matches = false;
      }
      // 1. Exact match
      else if (roomName === p) {
        // matches = true already
      }
      // 2. Substring match — pattern inside roomName (min 3 chars to avoid over-matching).
      //    Note: we do NOT do the reverse (pattern.includes(roomName)) because a short
      //    roomName like "A" or "IT" would then match any long pattern containing that word.
      else if (p.length >= 3 && roomName.includes(p)) {
        // matches = true already
      }
      // 3. Word-order independent match — all meaningful words in pattern exist in room name
      else {
        const patternWords = p.split(/\s+/).filter(w => w.length > 2);
        // Guard: if every word is ≤2 chars, patternWords is empty and .every() would
        // vacuously return true, matching every room. Treat that as no match instead.
        if (patternWords.length === 0) {
          matches = false;
        } else {
          const allWordsMatch = patternWords.every(word => roomName.includes(word));
          if (!allWordsMatch) matches = false;
        }
      }
    }

    // ── Diagnostic log: one line per override checked ──────────────────────
    console.log(
      `[override-diag] pattern='${patternLabel}' room='${room.roomName}' ` +
      `match=${matches} signType=${signType || "(none)"}`,
    );

    if (!matches) continue;

    matched.push({ override, signType, qty, confidence, originalIdx: i });
  }

  // ── Warn if suspiciously many overrides fired ───────────────────────────
  if (matched.length > 3) {
    console.warn(
      `[override-diag] WARNING: '${room.roomName}' matched ${matched.length} overrides — ` +
      `possible pattern leak. Overrides: ` +
      matched.map(m => `${m.signType || "(none)"}(${m.override.overrideType})`).join(", "),
    );
  }

  // ── Hard cap: max 2 sign-adding overrides per room ──────────────────────
  // "exclude" and "modify_qty" never add rows — they are always applied uncapped.
  const ADDING_TYPES = new Set(["add", "sign_type"]);
  const addingMatched  = matched.filter(m =>  ADDING_TYPES.has(m.override.overrideType));
  const droppedIdxs = new Set<number>();

  if (addingMatched.length > 2) {
    const sorted  = [...addingMatched].sort((a, b) => b.confidence - a.confidence);
    const dropped = sorted.slice(2);
    for (const d of dropped) droppedIdxs.add(d.originalIdx);
    console.warn(
      `[override-diag] Hard cap: keeping top 2 of ${addingMatched.length} adding overrides ` +
      `for '${room.roomName}'. Dropped: ` +
      dropped.map(d => `${d.signType}(conf=${d.confidence})`).join(", "),
    );
  }

  // ── Apply matched overrides in original order, skipping capped ones ─────
  let result = [...signs];
  for (const { override, signType, qty, confidence, originalIdx } of matched) {
    if (droppedIdxs.has(originalIdx)) continue;

    if (override.overrideType === "add" && signType) {
      // Inject the sign — the outer canonical filter (after applyRuleOverrides returns)
      // is the definitive last step that drops any non-canonical types, including
      // non-canonical adds and Max Occupancy on non-assembly rooms.
      result.push(sign(signType, qty, override.ruleRef, confidence));
    } else if (override.overrideType === "exclude" && signType) {
      result = result.filter((s) => s.signType !== signType);
    } else if (override.overrideType === "modify_qty" && signType) {
      result = result.map((s) =>
        s.signType === signType ? { ...s, qty } : s,
      );
    } else if (override.overrideType === "sign_type" && signType) {
      // Skip training corrections that assign non-canonical types
      if (!ADA_CANONICAL_SIGN_TYPES.has(signType)) {
        console.warn(
          `[override-diag] Skipping 'sign_type' correction — '${signType}' is not an ADA-canonical type ` +
          `(room='${room.roomName}')`,
        );
        continue;
      }
      // Skip Max Occupancy correction for non-assembly rooms
      if (signType === "Max Occupancy" && !room.isAssembly) {
        console.warn(
          `[override-diag] Skipping 'Max Occupancy' correction for non-assembly room '${room.roomName}'`,
        );
        continue;
      }
      result = [sign(signType, qty, override.ruleRef, confidence)];
      break; // Training correction takes priority — stop processing further overrides
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Validation checks (11 checks)
// ---------------------------------------------------------------------------

export interface ValidationCheck {
  checkName: string;
  status: "pass" | "warning" | "fail";
  details: string;
}

export function runValidationChecks(output: RuleEngineOutput): ValidationCheck[] {
  const checks: ValidationCheck[] = [];
  const { results } = output;
  const allSigns = results.flatMap((r) => r.signs);

  // 1. Every occupied room has at least one sign
  const noSignRooms = results.filter(
    (r) =>
      r.signs.length === 0 &&
      !r.room.isStair &&
      !r.room.isElevator &&
      !r.room.isCorridorOrHall &&
      !r.room.isMepUnoccupied &&
      !applyMezzanineRule(r.room),
  );
  checks.push({
    checkName: "occupied_rooms_have_signs",
    status: noSignRooms.length === 0 ? "pass" : "warning",
    details:
      noSignRooms.length === 0
        ? "All occupied rooms have at least one sign."
        : `${noSignRooms.length} occupied rooms have no signs: ${noSignRooms.slice(0, 5).map((r) => r.room.roomNumber).join(", ")}`,
  });

  // 2. No duplicate sign types per room (except Multi-entry R3)
  const dupRooms = results.filter(
    (r) => new Set(r.signs.map((s) => s.signType)).size < r.signs.length && !r.room.isVestibule,
  );
  checks.push({
    checkName: "no_duplicate_signs_per_room",
    status: dupRooms.length === 0 ? "pass" : "warning",
    details:
      dupRooms.length === 0
        ? "No duplicate sign types per room."
        : `${dupRooms.length} rooms have duplicate sign types.`,
  });

  // 3. At least one exit sign
  const exitCount = allSigns.filter((s) => s.signType === "Exit").length + output.evacMapSigns.filter((s) => s.signType === "Exit").length;
  checks.push({
    checkName: "exit_signs_present",
    status: exitCount > 0 ? "pass" : "warning",
    details: exitCount > 0 ? `${exitCount} Exit sign(s) assigned.` : "No Exit signs assigned — verify egress doors.",
  });

  // 4. Restroom signs present if restrooms exist
  const restroomRooms = results.filter((r) => r.room.isRestroom);
  const restroomSigns = allSigns.filter((s) => s.signType === "Restroom");
  checks.push({
    checkName: "restroom_signs_match_restrooms",
    status: restroomRooms.length === restroomSigns.length ? "pass" : "warning",
    details:
      restroomRooms.length === restroomSigns.length
        ? `${restroomSigns.length} Restroom sign(s) match ${restroomRooms.length} restroom(s).`
        : `${restroomRooms.length} restrooms but ${restroomSigns.length} Restroom signs — review.`,
  });

  // 5. Stair signs present if stairs exist
  const stairRoomCount = results.filter((r) => r.room.isStair).length;
  const stairSignCount = output.stairSigns.length;
  checks.push({
    checkName: "stair_signs_present",
    status: stairRoomCount === 0 || stairSignCount > 0 ? "pass" : "warning",
    details:
      stairRoomCount === 0
        ? "No stairs detected."
        : stairSignCount > 0
          ? `${stairSignCount} stair sign(s) for ${stairRoomCount} stair(s).`
          : "Stairs detected but no stair signs assigned.",
  });

  // 6. Elevator signs present if elevators exist
  const elevRoomCount = results.filter((r) => r.room.isElevator).length;
  const elevSignCount = output.elevatorSigns.length;
  checks.push({
    checkName: "elevator_signs_present",
    status: elevRoomCount === 0 || elevSignCount > 0 ? "pass" : "warning",
    details:
      elevRoomCount === 0
        ? "No elevators detected."
        : elevSignCount > 0
          ? `${elevSignCount} elevator sign(s) for ${elevRoomCount} elevator(s).`
          : "Elevators detected but no elevator signs assigned.",
  });

  // 7. No rooms with confidence < 0.5 flagged
  const lowConfidenceSigns = allSigns.filter((s) => s.confidence < 0.5);
  checks.push({
    checkName: "low_confidence_signs",
    status: lowConfidenceSigns.length === 0 ? "pass" : "warning",
    details:
      lowConfidenceSigns.length === 0
        ? "All signs have confidence >= 0.5."
        : `${lowConfidenceSigns.length} sign(s) have low confidence (<0.5) — review required.`,
  });

  // 8. Building type detected (not defaulted)
  checks.push({
    checkName: "building_type_detected",
    status: output.detectedBuildingType !== "commercial" ? "pass" : "warning",
    details:
      output.detectedBuildingType !== "commercial"
        ? `Building type detected: ${output.detectedBuildingType}.`
        : "Building type defaulted to 'commercial' — verify and update if needed.",
  });

  // 9. Multi-level coverage
  const levelsWithRooms = [...new Set(results.map((r) => r.room.level))].length;
  checks.push({
    checkName: "multi_level_coverage",
    status: levelsWithRooms > 0 ? "pass" : "fail",
    details:
      levelsWithRooms > 0
        ? `Signs assigned across ${levelsWithRooms} level(s).`
        : "No rooms found — PDF extraction may have failed.",
  });

  // 10. Evac maps present in multi-story buildings
  const evacCount = output.evacMapSigns.reduce((sum, s) => sum + s.qty, 0);
  checks.push({
    checkName: "evac_maps_present",
    status: levelsWithRooms < 2 || evacCount > 0 ? "pass" : "warning",
    details:
      levelsWithRooms < 2
        ? "Single-level building — evac maps optional."
        : evacCount > 0
          ? `${evacCount} Evacuation Map(s) assigned.`
          : "Multi-level building detected but no Evacuation Maps assigned — check lobby/elevator lobbies.",
  });

  // 11. Unoccupied rooms with non-zero occupant load
  const unoccupiedWithLoad = results.filter(
    (r) => r.room.isMepUnoccupied && (r.room.occupantLoad ?? 0) > 0,
  );
  checks.push({
    checkName: "unoccupied_rooms_with_occupant_load",
    status: unoccupiedWithLoad.length === 0 ? "pass" : "warning",
    details:
      unoccupiedWithLoad.length === 0
        ? "No MEP-unoccupied rooms carry a non-zero occupant load."
        : `${unoccupiedWithLoad.length} room(s) marked unoccupied but have an occupant load — verify source data: ${unoccupiedWithLoad.slice(0, 5).map((r) => r.room.roomNumber).join(", ")}`,
  });

  return checks;
}
