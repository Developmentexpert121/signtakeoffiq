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
}

// Standard ADA/ADAAG suggested dimensions per sign type.
// Used when no dimension is found in the plans or schedule.
// Values are width × height in inches.
export const ADA_SIGN_DIMENSIONS: Record<string, string> = {
  "Room ID":              "6 × 8",
  "Room ID w/insert":     "6 × 8",
  "Unit/Room #":          "6 × 8",
  "Restroom(Women)":      "6 × 8",
  "Restroom(Men)":        "6 × 8",
  "Restroom(Unisex)":     "6 × 8",
  "Restroom":             "6 × 8",
  "Exit(Tactile)":        "6 × 8",
  "Exit":                 "6 × 12",
  "Stair(Corridor)":      "6 × 8",
  "Stair(Landing)":       "6 × 8",
  "Directory(Floor)":     "18 × 24",
  "Directory(Building)":  "18 × 24",
  "Evac Map":             "18 × 24",
  "In case of fire":      "6 × 8",
  "Entry(Building)":      "6 × 8",
  "Regulatory(NoSmoking)":"6 × 8",
};

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
}

export const BUILDING_TRAITS: Record<string, BuildingTraits> = {
  residential: {
    hasUnitNumbers: true,
    mepPolicy: "all",
    hasAssemblyRules: false,
    hasDirectory: false,
    elevatorMode: "per_level",
    stairMode: "combined",
  },
  commercial: {
    hasUnitNumbers: false,
    mepPolicy: "occupied_only",
    hasAssemblyRules: true,
    hasDirectory: true,
    elevatorMode: "per_building",
    stairMode: "separate",
  },
  school: {
    hasUnitNumbers: false,
    mepPolicy: "minimal",
    hasAssemblyRules: true,
    hasDirectory: false,
    elevatorMode: "per_building",
    stairMode: "separate",
  },
  hospital: {
    hasUnitNumbers: false,
    mepPolicy: "minimal",
    hasAssemblyRules: true,
    hasDirectory: false,
    elevatorMode: "per_level",
    stairMode: "separate",
  },
  hotel: {
    hasUnitNumbers: true,
    mepPolicy: "all",
    hasAssemblyRules: true,
    hasDirectory: false,
    elevatorMode: "per_level",
    stairMode: "separate",
  },
  retail: {
    hasUnitNumbers: false,
    mepPolicy: "all",
    hasAssemblyRules: true,
    hasDirectory: false,
    elevatorMode: "per_building",
    stairMode: "separate",
  },
  warehouse: {
    hasUnitNumbers: false,
    mepPolicy: "all",
    hasAssemblyRules: false,
    hasDirectory: false,
    elevatorMode: "per_building",
    stairMode: "combined",
  },
  lab: {
    hasUnitNumbers: false,
    mepPolicy: "occupied_only",
    hasAssemblyRules: false,
    hasDirectory: true,
    elevatorMode: "per_building",
    stairMode: "separate",
  },
  bank: {
    hasUnitNumbers: false,
    mepPolicy: "occupied_only",
    hasAssemblyRules: false,
    hasDirectory: true,
    elevatorMode: "per_building",
    stairMode: "separate",
  },
  government: {
    hasUnitNumbers: false,
    mepPolicy: "occupied_only",
    hasAssemblyRules: true,
    hasDirectory: true,
    elevatorMode: "per_building",
    stairMode: "separate",
  },
  church: {
    hasUnitNumbers: false,
    mepPolicy: "occupied_only",
    hasAssemblyRules: true,
    hasDirectory: false,
    elevatorMode: "per_building",
    stairMode: "separate",
  },
  "senior_living": {
    hasUnitNumbers: true,
    mepPolicy: "all",
    hasAssemblyRules: true,
    hasDirectory: false,
    elevatorMode: "per_level",
    stairMode: "combined",
  },
  mixed: {
    hasUnitNumbers: false,
    mepPolicy: "occupied_only",
    hasAssemblyRules: true,
    hasDirectory: true,
    elevatorMode: "per_building",
    stairMode: "separate",
  },
};


// ---------------------------------------------------------------------------
// Building type detection
// ---------------------------------------------------------------------------

export function detectBuildingType(
  rooms: Pick<RoomRecord, "roomName" | "roomNumber">[],
  projectMetadata: { buildingType?: string; name?: string } = {},
  customMappings: Record<string, string> = {},
  standardMappings: Record<string, string> = {},
): string {
  // 1. Explicit override
  if (projectMetadata.buildingType) {
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

  const names = rooms.map((r) => r.roomName.toUpperCase());
  const total = names.length;

  // 2. >30% "UNIT xxx" → Residential
  const unitCount = names.filter((n) => /^UNIT\s+\S/.test(n)).length;
  if (total > 0 && unitCount / total > 0.3) return "residential";

  // 3. Hotel signatures
  const hasRoom = names.some((n) => /^ROOM\s+\d/.test(n));
  const hasLobby = names.some((n) => /\bLOBBY\b/.test(n));
  const hasFrontDesk = names.some((n) => n.includes("FRONT DESK") || n.includes("CHECK-IN") || /\bRECEPTION\b/.test(n));
  if (hasRoom && hasLobby && hasFrontDesk) return "hotel";

  // 4. Hospital
  if (names.some((n) => /\bPATIENT\b|\bNURSE\b|\bEXAM ROOM\b|\bICU\b|\bOPERATING\b|\bER\b|\bEMERGENCY DEPT\b|\bSURGERY\b/.test(n))) return "hospital";

  // 5. School
  if (names.some((n) => /\bCLASSROOM\b|\bGYMNASIUM\b|\bGYM\b|\bCAFETERIA\b|\bPRINCIPAL\b|\bLIBRARY\b|\bMEDIA CENTER\b/.test(n))) return "school";

  // 6. Church
  if (names.some((n) => /\bNAVE\b|\bSANCTUARY\b|\bALTAR\b|\bPARISH\b|\bNARTHEX\b|\bCHANCEL\b/.test(n))) return "church";

  // 7. Lab
  if (names.some((n) => /\bCLEAN ROOM\b|\bFUME HOOD\b|BSL-|\bLABORATORY\b|\bLAB\b/.test(n))) return "lab";

  // 8. Bank
  if (names.some((n) => /\bVAULT\b|\bTELLER\b|\bSAFE DEPOSIT\b|\bCOUNTING ROOM\b/.test(n))) return "bank";

  // 9. Warehouse/Factory
  if (names.some((n) => /\bASSEMBLY LINE\b|\bLOADING DOCK\b|\bSHIPPING\b|\bRECEIVING\b|\bWAREHOUSE\b|\bFACTORY\b/.test(n))) return "warehouse";

  // 10. Retail
  if (names.some((n) => /\bMERCHANDISE\b|\bFITTING ROOM\b|\bPOS\b|\bSTOCK ROOM\b|\bRETAIL\b|\bSHOWROOM\b/.test(n))) return "retail";

  // 11. Senior living
  if (names.some((n) => /\bMEMORY CARE\b|\bASSISTED LIVING\b|\bSKILLED NURSING\b|\bRESIDENT ROOM\b/.test(n))) return "senior_living";

  // 12. Government
  if (names.some((n) => /\bCOUNCIL CHAMBER\b|\bCOURT ROOM\b|\bCOURT CLERK\b|\bPOLICE\b|\bFIRE STATION\b|\bAPPARATUS\b/.test(n))) return "government";

  // Default: Commercial
  return "commercial";
}

// ---------------------------------------------------------------------------
// Room classification helpers
// ---------------------------------------------------------------------------

export const RESTROOM_KEYWORDS = /\bTOILET\b|\bRESTROOM\b|\bBATHROOM\b|\bLAVATORY\b|\bSHOWER\b|SHOWER.?LOCKER|\bLOCKER\b|\bMEN'?S\b|\bMENS\b|\bWOMEN'?S\b|\bWOMEN\b|\bMALE\b|\bFEMALE\b|\bGENDER\b|\bUNISEX\b|ADA RESTROOM/i;
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
export const CORRIDOR_KEYWORDS = /\bCORR(IDOR)?\b|\bHALL(WAY)?\b|\bHALL\b|\bPASSAGE\b|\bGALLERY\b/i;
export const VEHICLE_BAY_KEYWORDS = /\bAPPARATUS\b|\bGARAGE\b|\bVEHICLE\b|\bBAY\b|\bDRIVE.?THROUGH\b/i;
export const MEP_KEYWORDS = /\bMECH(ANICAL)?\b|\bELEC(TRICAL)?\b|\bIDF\b|\bMDF\b|\bTELECOM\b|\bSERVER\b|\bIT\s*ROOM\b|\bJAN(ITOR)?\b|\bSPRINKLER\b|PUMP\s*ROOM|\bUTILITY\b/i;
export const ASSEMBLY_KEYWORDS = /\bTRAINING\b|\bMEETING\b|\bCONFERENCE\b|\bAUDITORIUM\b|\bCHAPEL\b|\bCOMMUNITY\b|\bEOC\b|\bBANQUET\b|\bDINING\b|\bASSEMBL/i;
export const VARIABLE_USE_KEYWORDS = /\bTRAINING\b|\bEOC\b|\bCOMMUNITY\b|MULTI.?PURPOSE|FLEX\s*ROOM|MULTI\s*USE|\bCONVERTIBLE\b/i;
export const PUBLIC_FACING_KEYWORDS = /\bLOBBY\b|\bPUBLIC\b|\bRECEPTION\b|\bWAITING\b|\bFRONT\b/i;
// Must START with "UNIT", "APT", or "SUITE" as a complete word.
// Purely numeric names like "113" or "108" do NOT match.
// Mid- or trailing occurrences ("Office Suite", "Storage Unit", "101 Unit") also do NOT match.
export const RESIDENTIAL_UNIT_KEYWORDS = /^UNIT\b|^APT\b|^SUITE\b/i;
export const DORM_KEYWORDS = /\bDORM(ITORY)?\b|\bBUNK\b|\bSLEEP(ING)?\b/i;
export const MEZZANINE_KEYWORDS = /\bMEZZ(ANINE)?\b/i;
export const LOBBY_ENTRY_KEYWORDS = /\bLOBBY\b|\bENTRY\b|\bENTRANCE\b/i;
export const DIRECTORY_LOCATION_KEYWORDS = /\bLOBBY\b|\bRECEPTION\b|\bFOYER\b|\bATRIUM\b/i;
export const MENS_RESTROOM_KEYWORDS = /\bMEN'?S\b|\bMALE\b/i;
export const WOMENS_RESTROOM_KEYWORDS = /\bWOMEN'?S\b|\bFEMALE\b/i;
export const AUDITORIUM_KEYWORDS = /\bAUDITORIUM\b/i;

export function classifyRoom(roomName: string): Partial<RoomRecord> {
  const name = roomName.toUpperCase();
  const hasStairKeyword = STAIR_KEYWORDS.test(name);
  const isTrailingStairNoise = STAIR_NOISE_TRAILING.test(name);
  const isMiddleStairNoise = STAIR_NOISE_MIDDLE.test(name);
  return {
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
    isResidentialUnit: RESIDENTIAL_UNIT_KEYWORDS.test(name),
  };
}

// ---------------------------------------------------------------------------
// Rule application helpers
// ---------------------------------------------------------------------------

function sign(
  signType: string,
  qty: number,
  ruleRef: string,
  confidence: number,
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
    ...(adaDim ? { dimensions: adaDim, dimSource: "ada_suggested" } : {}),
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

function applyRoomIdRules(room: RoomRecord, traits: BuildingTraits, multiEntryRegex: RegExp = MULTI_ENTRY_ROOM_KEYWORDS): SignAssignment[] {
  const signs: SignAssignment[] = [];

  // R4 — Corridor exclusion
  if (room.isCorridorOrHall) return signs;

  // R5 — Vehicle bay exclusion, with R3 override check.
  // Vehicle bays normally get no Room ID (R5), UNLESS the room has ≥3 man-doors (R3).
  // Apparatus bays in fire stations are the canonical R3 override case.
  if (room.isVehicleBay) {
    const multiEntryQty = estimateMultiEntryQty(room, multiEntryRegex);
    if (multiEntryQty >= 3) {
      // R3 overrides R5: assign Room ID qty = door count (estimated), flag for review
      signs.push(sign("Room ID", multiEntryQty, "R3", 0.60));
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

  // R3 check for non-vehicle large rooms (gyms, auditoriums, cafeterias)
  if (!isDorm && !room.isVariableUse && multiEntryRegex.test(room.roomName)) {
    const qty = estimateMultiEntryQty(room, multiEntryRegex);
    if (qty > 1) {
      signs.push(sign("Room ID", qty, "R3", 0.60));
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

  // R16 — Residential unit plaque (separate column from Room ID)
  if (room.isResidentialUnit && traits.hasUnitNumbers) {
    signs.push(sign("Unit/Room #", 1, "R16", 0.85));
    return signs;
  }

  // R1 — Default Room ID (all remaining occupied rooms)
  signs.push(sign("Room ID", 1, "R1", 0.85));
  return signs;
}

function applyRestroomRule(room: RoomRecord): SignAssignment[] {
  if (!room.isRestroom) return [];
  const isWomens = WOMENS_RESTROOM_KEYWORDS.test(room.roomName);
  const isMens = !isWomens && MENS_RESTROOM_KEYWORDS.test(room.roomName);
  if (isWomens) return [sign("Restroom(Women)", 1, "R8", 0.9)];
  if (isMens) return [sign("Restroom(Men)", 1, "R8", 0.9)];
  return [sign("Restroom", 1, "R8", 0.9)];
}

function applyExitRule(room: RoomRecord, traits: BuildingTraits): SignAssignment[] {
  const signs: SignAssignment[] = [];
  if (!traits.hasAssemblyRules && !room.isVestibule && !room.isPublicFacing) return signs;

  // Vestibule leading to exterior
  if (room.isVestibule) {
    signs.push(sign("Exit", 1, "R9", 0.8));
    // BB4 — Exit door tactile sign (ADA) at every exterior-entry vestibule
    signs.push(sign("Exit(Tactile)", 1, "R9", 0.8));
    // DD1 — No Smoking regulatory sign at exterior entry vestibules
    signs.push(sign("Regulatory(NoSmoking)", 1, "R9", 0.75));
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

function applyCapacityRule(room: RoomRecord, traits: BuildingTraits): SignAssignment[] {
  if (!traits.hasAssemblyRules) return [];
  if (!room.isAssembly) return [];

  const occGroup = (room.occupancyGroup ?? "").toUpperCase();
  const isOccupancyA = /^A-?[23]/.test(occGroup);
  const highOccupancy = (room.occupantLoad ?? 0) >= 50;

  if (!isOccupancyA && !highOccupancy) return [];

  // Variable use + assembly = 2 capacity inserts
  const qty = room.isVariableUse ? 2 : 1;
  return [sign("Max Occupancy", qty, "R10", 0.8)];
}

// R10-A — Auditorium-specific signs: Max Occupancy (BB2D), Emergency Egress (BB2E),
// and LED Programmable (LED) for auditorium rooms when building has assembly rules.
// Triggered by room name without requiring occupant load data.
function applyAuditoriumRules(room: RoomRecord, traits: BuildingTraits): SignAssignment[] {
  if (!traits.hasAssemblyRules) return [];
  if (!AUDITORIUM_KEYWORDS.test(room.roomName)) return [];
  return [
    sign("Occupancy(MaxCapacity)", 2, "R10", 0.8),  // BB2D
    sign("Egress(Emergency)", 2, "R10", 0.8),         // BB2E
    sign("LED(Programmable)", 2, "R10", 0.75),         // LED
  ];
}

export function applyStairRules(
  stairRooms: RoomRecord[],
  _levels: string[],
  traits: BuildingTraits,
): SignAssignment[] {
  if (stairRooms.length === 0) return [];

  // Deduplicate: same room number + level + corridor-type should only produce one sign row.
  // Duplicates arise when the same stair room is extracted from multiple overlapping sheets.
  const seen = new Set<string>();
  const unique = stairRooms.filter((r) => {
    const key = `${r.roomNumber.toUpperCase()}|${r.level}|${r.isCorridorOrHall}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const signs: SignAssignment[] = [];

  for (const room of unique) {
    // BB4 — Exit door tactile sign (ADA) at every stair room
    signs.push(sign("Exit(Tactile)", 1, "R11", 0.80));

    if (room.isCorridorOrHall) {
      // Stair corridor entry — the door from the hallway side into the stair core.
      // No Directory(Floor) here: the board mounts inside the stair at the landing, not the door.
      signs.push(sign("Stair(Corridor)", 1, "R11", 0.80));
    } else {
      // Stair landing — inside the stair shaft at each floor level.
      signs.push(sign("Stair(Landing)", 1, "R11", 0.85));
      // AA2/AA3 — Floor directory at stair landing only (Fix 2: NOT at corridor entry)
      if (traits.hasDirectory) {
        signs.push(sign("Directory(Floor)", 1, "R14", 0.75));
      }
    }
  }

  return signs;
}

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
    // One "In Case of Fire" plaque per elevator (at main floor call buttons)
    return [sign("In case of fire", uniqueElevCount, "R12", 0.85)];
  } else {
    // per_level: one Elevator ID sign per elevator per level it serves
    const totalSigns: SignAssignment[] = [];
    for (const [, elevInstances] of elevsByNumber) {
      const levelsServed = [...new Set(elevInstances.map((e) => e.level))];
      totalSigns.push(sign("In case of fire", levelsServed.length, "R12", 0.80));
    }
    return totalSigns;
  }
}

export function applyEvacMapRules(
  rooms: RoomRecord[],
  levels: string[],
  elevatorLobbies: RoomRecord[],
): SignAssignment[] {
  const signs: SignAssignment[] = [];

  // One evac map per elevator lobby per floor
  for (const _lobby of elevatorLobbies) {
    signs.push(sign("Evac Map", 1, "R13", 0.85));
  }

  // One evac map per main public lobby
  const publicLobbies = rooms.filter(
    (r) => r.isPublicFacing && LOBBY_ENTRY_KEYWORDS.test(r.roomName),
  );
  for (const _lobby of publicLobbies) {
    signs.push(sign("Evac Map", 1, "R13", 0.85));
  }

  return signs;
}

function applyOfficeDirectoryRule(room: RoomRecord, traits: BuildingTraits): SignAssignment[] {
  if (!traits.hasDirectory) return [];
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
    signs.push(sign("Directory(Building)", 1, "R14", 0.75));
    signs.push(sign("Entry(Building)", 1, "R14", 0.75));
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
}

export function applyRules(input: RuleEngineInput): RuleEngineOutput {
  const { rooms, buildingType, ruleOverrides = [], customMultiEntryKeywords } = input;

  const traits = BUILDING_TRAITS[buildingType] ?? BUILDING_TRAITS["commercial"];
  const levels = [...new Set(rooms.map((r) => r.level))].sort();

  // Build merged multi-entry regex (built-in keywords + tenant custom keywords)
  const multiEntryRegex = buildMultiEntryRegex(customMultiEntryKeywords);

  const stairRooms = rooms.filter((r) => r.isStair);
  const elevatorRooms = rooms.filter((r) => r.isElevator);
  const elevatorLobbies = rooms.filter(
    (r) => r.isPublicFacing && ELEVATOR_KEYWORDS.test(r.roomName),
  );

  const results: RoomResult[] = [];

  for (const room of rooms) {
    // R15 — Mezzanine exclusion
    if (applyMezzanineRule(room)) {
      results.push({ room, signs: [] });
      continue;
    }

    const roomSigns: SignAssignment[] = [];

    // Room ID rules (R1-R7)
    roomSigns.push(...applyRoomIdRules(room, traits, multiEntryRegex));

    // R8 — Restroom
    roomSigns.push(...applyRestroomRule(room));

    // R9 — Exit
    roomSigns.push(...applyExitRule(room, traits));

    // R10 — Capacity
    roomSigns.push(...applyCapacityRule(room, traits));

    // R10-A — Auditorium-specific signs (BB2D, BB2E, LED) — triggered by AUDITORIUM keyword
    roomSigns.push(...applyAuditoriumRules(room, traits));

    // R14 — Office Directory
    roomSigns.push(...applyOfficeDirectoryRule(room, traits));

    // Apply tenant rule overrides
    const finalSigns = applyRuleOverrides(room, roomSigns, ruleOverrides);

    results.push({ room, signs: finalSigns });
  }

  // Aggregate stair/elevator/evac signs
  const stairSigns = applyStairRules(stairRooms, levels, traits);
  const elevatorSigns = applyElevatorRules(elevatorRooms, levels, traits);
  const evacMapSigns = applyEvacMapRules(rooms, levels, elevatorLobbies);

  return { results, detectedBuildingType: buildingType, traits, levels, stairSigns, elevatorSigns, evacMapSigns };
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

  let result = [...signs];

  for (const override of overrides) {
    const condition = override.condition as Record<string, unknown>;

    // Check condition match
    let matches = true;
    if (condition.room_name_contains) {
      const pattern = String(condition.room_name_contains).toUpperCase();
      if (!room.roomName.toUpperCase().includes(pattern)) matches = false;
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
      const pattern = String(condition.roomNamePattern).toLowerCase().trim();
      const roomName = room.roomName.toLowerCase().trim();

      // 1. Exact match
      if (roomName === pattern) {
        // matches = true already
      }
      // 2. Substring match (either direction)
      else if (roomName.includes(pattern) || pattern.includes(roomName)) {
        // matches = true already
      }
      // 3. Word-order independent match — all words in pattern exist in room name
      else {
        const patternWords = pattern.split(/\s+/).filter(w => w.length > 2);
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

    if (!matches) continue;

    const action = override.action as Record<string, unknown>;
    const signType = String(action.sign_type ?? action.signType ?? "");
    const qty = Number(action.qty ?? 1);

    if (override.overrideType === "add" && signType) {
      result.push(sign(signType, qty, override.ruleRef, 0.7));
    } else if (override.overrideType === "exclude" && signType) {
      result = result.filter((s) => s.signType !== signType);
    } else if (override.overrideType === "modify_qty" && signType) {
      result = result.map((s) =>
        s.signType === signType ? { ...s, qty } : s,
      );
    } else if (override.overrideType === "sign_type" && signType) {
      result = [sign(signType, qty, override.ruleRef, parseFloat(String(override.condition?.confidence ?? "0.85")))];
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
          ? `${evacCount} Evac Map(s) assigned.`
          : "Multi-level building detected but no Evac Maps assigned — check lobby/elevator lobbies.",
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
