/**
 * Egress Sign Generator
 *
 * Core principle: Stair signs, Exit signs, and Evacuation Maps are RULE-GENERATED
 * from job metadata — NOT extracted from PDF room labels. Room extraction only
 * handles Room ID signs.
 *
 * This module runs after room extraction completes and generates:
 *  - Stair (Corridor) + Stair (Landing) per stair per floor       [R11]
 *  - Area of Rescue per stair per floor (govt/assembly only)      [R16]
 *  - Exit signs per stair per floor + exterior minimum            [R9]
 *  - Evacuation Maps at decision-point rooms, capped per floor    [R13]
 *  - Max Occupancy for assembly rooms                             [R10]
 */

import type { BuildingTypeProfile } from "@workspace/db";
import { newId } from "./ids";

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

export interface RoomSummary {
  id: string;
  roomNumber: string;
  roomName: string;
  level: string;
  isAssembly: boolean;
  isCorridorOrHall: boolean;
  isMepUnoccupied: boolean;
  isStair: boolean;
}

export interface EgressSignRow {
  id: string;
  jobId: string;
  tenantId: string;
  roomId: string | null;
  sheetId: string | null;
  signType: string;
  qty: number;
  ruleRef: string;
  color: string | null;
  confidence: string;
  status: string;
  source: string;
  dimensions: string | null;
  dimSource: string | null;
  adaRequired: boolean | null;
  notes: string | null;
  floorLabel: string | null;
  roomNumber: string | null;
  roomName: string | null;
}

interface EgressInput {
  jobId: string;
  tenantId: string;
  buildingType: string;
  /** All rooms extracted for this job */
  rooms: RoomSummary[];
  /** First floor-plan sheet ID to attach aggregate signs to */
  sheetId: string | null;
  /** Profile row from building_type_profiles */
  profile: BuildingTypeProfile;
}

// --------------------------------------------------------------------------
// ADA-required sign types (Part C)
// --------------------------------------------------------------------------

export const ADA_EGRESS_SIGN_TYPES = new Set<string>([
  "Room ID",
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

// Min exterior exit doors by building type
const MIN_EXTERIOR_EXITS: Record<string, number> = {
  education:   4,
  healthcare:  4,
  commercial:  2,
  government:  3,
  hotel:       2,
  residential: 2,
  assembly:    4,
  unknown:     2,
};

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function makeRow(
  input: EgressInput,
  overrides: Partial<EgressSignRow> & { signType: string; ruleRef: string },
): EgressSignRow {
  return {
    id: newId("sign"),
    jobId: input.jobId,
    tenantId: input.tenantId,
    roomId: null,
    sheetId: input.sheetId,
    qty: 1,
    color: null,
    confidence: "0.85",
    status: "extracted",
    source: "rules_engine",
    dimensions: null,
    dimSource: null,
    adaRequired: ADA_EGRESS_SIGN_TYPES.has(overrides.signType) ? true : false,
    notes: null,
    floorLabel: null,
    roomNumber: null,
    roomName: null,
    ...overrides,
  };
}

function stairLabel(index: number, total: number): string {
  return total <= 6 ? String.fromCharCode(64 + index) : String(index);
}

/**
 * Detect distinct stair cores from extracted rooms.
 * Returns an array of stair identifiers (e.g. ["A", "B", "C"]).
 * Uses Math.max(detected, profile.stairCountDefault) so we never under-count.
 * Falls back to profile.stairCountDefault generic labels when no stair rooms found.
 */
function detectStairCores(rooms: RoomSummary[], profile: BuildingTypeProfile): {
  cores: string[];
  isEstimated: boolean;
} {
  const patterns = (profile.stairNamePatterns as string[] | null) ?? [];
  const upperPatterns = patterns.map((p) => p.toUpperCase());
  const profileDefault = profile.stairCountDefault ?? 2;

  const stairRooms = rooms.filter((r) => {
    if (r.isStair) return true;
    const upper = r.roomName.toUpperCase().trim();
    const numUpper = r.roomNumber.toUpperCase().trim();
    if (upperPatterns.some((p) => upper === p || upper.startsWith(p + " "))) return true;
    // room-number patterns: SA01, SB02, S1, S2
    if (/^S[A-F]\d{1,2}[A-Z]?$/i.test(r.roomNumber)) return true;
    if (/^S\d{1,2}[A-Z]?$/i.test(r.roomNumber)) return true;
    // STAIR-A, STAIR-1, STAIR A, STAIRA (room number)
    if (/^STAIR[-\s]?[A-Z0-9]/i.test(numUpper)) return true;
    // Room name: STAIR A, STAIRWAY B, STAIRWELL C, STAIR 1, or just STAIR
    if (/STAIR(WAY|WELL)?(\s|$)/i.test(upper)) return true;
    return false;
  });

  if (stairRooms.length === 0) {
    const count = profileDefault;
    return {
      cores: Array.from({ length: count }, (_, i) => stairLabel(i + 1, count)),
      isEstimated: true,
    };
  }

  // Build unique core keys from room number prefix or room name
  const coreSet = new Set<string>();
  for (const r of stairRooms) {
    const numUpper = r.roomNumber.toUpperCase().trim();
    const nameUpper = r.roomName.toUpperCase().trim();

    // Extract core letter from "SA01" → "A", "SB02" → "B"
    const letterMatch = numUpper.match(/^S([A-F])\d/);
    if (letterMatch) { coreSet.add(letterMatch[1]); continue; }

    // Extract digit from "S1", "S2" → "1", "2"
    const digitMatch = numUpper.match(/^S(\d{1,2})$/);
    if (digitMatch) { coreSet.add(digitMatch[1]); continue; }

    // STAIR-A → "A", STAIR-1 → "1", STAIR A → "A"
    const stairNumMatch = numUpper.match(/^STAIR[-\s]?([A-Z0-9]+)/);
    if (stairNumMatch) { coreSet.add(stairNumMatch[1]); continue; }

    // Try to extract identifier from room name: "STAIR A" → "A", "STAIRWAY B" → "B", "STAIR 1" → "1"
    const nameMatch = nameUpper.match(/STAIR(?:WAY|WELL)?\s+([A-Z\d]+)/);
    if (nameMatch) { coreSet.add(nameMatch[1]); continue; }

    // If room name is exactly "STAIR" with no identifier, use room number as key
    if (/^STAIR(WAY|WELL)?$/.test(nameUpper)) {
      const fallbackKey = numUpper.replace(/\d+$/, "").trim() || numUpper;
      coreSet.add(fallbackKey || `STAIR-${coreSet.size + 1}`);
      continue;
    }

    // Fallback: use room number prefix
    const prefix = numUpper.replace(/\d+$/, "").trim() || numUpper;
    coreSet.add(prefix);
  }

  const detectedCores = Array.from(coreSet).sort();

  // Use Math.max(detected, profileDefault) — never under-count stairs.
  // If detected < default, pad with additional letter labels.
  if (detectedCores.length >= profileDefault) {
    return { cores: detectedCores, isEstimated: false };
  }

  // Pad up to profileDefault using letter labels not already taken
  const existing = new Set(detectedCores);
  const padded = [...detectedCores];
  let idx = 1;
  while (padded.length < profileDefault) {
    const label = stairLabel(idx, profileDefault);
    if (!existing.has(label)) {
      padded.push(label);
      existing.add(label);
    }
    idx++;
    if (idx > 26) break; // safety
  }
  // isEstimated=true when we had to pad beyond what was detected
  return { cores: padded.sort(), isEstimated: true };
}

/**
 * Get distinct floor levels for this job, sorted by number then alpha.
 * Normalises common variants ("LEVEL 1", "L1", "1ST FLOOR", "1") so they
 * all map to the same key and don't inflate the floor count.
 *
 * Guards:
 *  1. Only count levels that contain a numeric component — excludes
 *     "UNSPECIFIED FLOOR", "EXTERIOR", "ROOF", "BASEMENT" (no number), and
 *     any other non-floor strings that would corrupt the floor count.
 *  2. Skip rooms whose roomNumber matches egress-generator patterns
 *     (STAIR-*, EXIT-*, EVAC-*, AOR-*). In normal operation these rows only
 *     exist in the signs table, not the rooms table, but the filter guards
 *     against contamination from prior runs or pipeline bugs.
 */
function getFloors(rooms: RoomSummary[]): string[] {
  // Regex matching room numbers that the egress generator itself produces.
  // These must never contribute to floor detection — only real extracted rooms should.
  const EGRESS_ROOM_NUM_PATTERN = /^(STAIR-|EXIT-STAIR-|EXIT-EXT-|EVAC-L|AOR-STAIR-)/i;

  // Map from canonical numeric key → preferred display label
  const canonical = new Map<string, string>();

  for (const r of rooms) {
    // FIX 3: Skip egress-generated room numbers (defense against contamination)
    if (r.roomNumber && EGRESS_ROOM_NUM_PATTERN.test(r.roomNumber.trim())) continue;

    if (!r.level || !r.level.trim()) continue;
    const raw = r.level.trim();

    // Require a numeric component — excludes "UNSPECIFIED FLOOR", "EXTERIOR",
    // "ROOF", "BASEMENT" (no number), and garbled labels without floor numbers.
    const numMatch = raw.match(/(\d+)/);
    if (!numMatch) continue; // skip — not a real floor label

    const key = numMatch[1];
    // Prefer the most descriptive label for a given floor number
    // ("LEVEL 1" beats "1"; keep whichever was seen first).
    if (!canonical.has(key)) canonical.set(key, raw);
  }

  if (canonical.size === 0) return ["LEVEL 1"];

  const keys = Array.from(canonical.keys());
  keys.sort((a, b) => {
    const na = parseInt(a, 10);
    const nb = parseInt(b, 10);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return a.localeCompare(b);
  });

  return keys.map((k) => canonical.get(k)!);
}

// --------------------------------------------------------------------------
// Main export
// --------------------------------------------------------------------------

/**
 * Generate all egress signs from job metadata and extracted rooms.
 *
 * Returns an array of EgressSignRow objects ready to be bulk-inserted.
 * The caller is responsible for deduplication with any existing sign rows.
 */
export function generateEgressSigns(input: EgressInput): EgressSignRow[] {
  const { buildingType, rooms, profile } = input;
  const rows: EgressSignRow[] = [];

  const floors = getFloors(rooms);
  const floorCount = floors.length;
  const { cores, isEstimated } = detectStairCores(rooms, profile);

  // Diagnostic: log detected floors and stair cores before any inserts
  const rawLevels = Array.from(new Set(rooms.map(r => r.level).filter(Boolean)));
  console.log(
    `[EGRESS] floors detected: [${floors.join(", ")}] | ` +
    `raw room levels: [${rawLevels.join(", ")}] | ` +
    `stair cores: [${cores.join(", ")}] | ` +
    `building: ${input.buildingType}`,
  );
  if (floors.some(f => !f || f.trim() === "")) {
    console.error("[EGRESS] WARNING: blank entry in floors array!", floors);
  }

  const estimatedNote = isEstimated
    ? "Estimated — verify stair count on plans"
    : "Detected from plan extraction";

  // Helper: resolve floor label and validate it is non-blank.
  // Uses the loop index (fi, 0-based) so room_number always gets a clean integer
  // (floorIndex = fi+1) while the display label (floorLabel) keeps the job's
  // native format ("LEVEL 1", "Floor 2", etc.).
  function resolveFloor(fi: number): { floorIndex: number; floorLabel: string } {
    const floorIndex = fi + 1;
    let floorLabel = floors[fi] ?? `LEVEL ${floorIndex}`;
    if (!floorLabel || floorLabel.trim() === "") {
      console.error(`[EGRESS-INSERT] ⚠️ Blank floor! floorIndex=${floorIndex} jobId=${input.jobId}`);
      floorLabel = `LEVEL ${floorIndex}`;
    }
    return { floorIndex, floorLabel };
  }

  // ── STEP 2: Stair signs ────────────────────────────────────────────────
  // R11: Stair (Corridor) + Stair (Landing) per stair per floor
  for (const core of cores) {
    for (let fi = 0; fi < floors.length; fi++) {
      const { floorIndex, floorLabel } = resolveFloor(fi);
      console.log(`[EGRESS-INSERT] signType=Stair (Corridor)/(Landing) core=${core} floorIndex=${floorIndex} floorLabel="${floorLabel}" type=${typeof floorLabel}`);
      rows.push(
        makeRow(input, {
          signType: "Stair (Corridor)",
          ruleRef: "R11",
          confidence: isEstimated ? "0.70" : "1.00",
          adaRequired: true,
          notes: `Stair ${core} — ${estimatedNote}`,
          floorLabel,
          roomId: null,
          roomNumber: `STAIR-${core}-L${floorIndex}`,
          roomName: `Stair ${core}`,
        }),
      );
      rows.push(
        makeRow(input, {
          signType: "Stair (Landing)",
          ruleRef: "R11",
          confidence: isEstimated ? "0.70" : "1.00",
          adaRequired: true,
          notes: `Stair ${core} — ${estimatedNote}`,
          floorLabel,
          roomId: null,
          roomNumber: `STAIR-${core}-L${floorIndex}`,
          roomName: `Stair ${core}`,
        }),
      );
    }

    // Area of Rescue — Government and Assembly only (R16)
    if (profile.requiresAreaOfRescue) {
      for (let fi = 0; fi < floors.length; fi++) {
        const { floorIndex, floorLabel } = resolveFloor(fi);
        console.log(`[EGRESS-INSERT] signType=Area of Rescue core=${core} floorIndex=${floorIndex} floorLabel="${floorLabel}" type=${typeof floorLabel}`);
        rows.push(
          makeRow(input, {
            signType: "Area of Rescue",
            ruleRef: "R16",
            qty: 2,
            confidence: "0.85",
            adaRequired: true,
            notes: `Stair ${core} — Area of Rescue ID + Instruction signs`,
            floorLabel,
            roomId: null,
            roomNumber: `AOR-STAIR-${core}-L${floorIndex}`,
            roomName: `Area of Rescue — Stair ${core}`,
          }),
        );
      }
    }
  }

  // ── STEP 3: Exit signs ─────────────────────────────────────────────────
  // R9: Exit at every stair door on every floor
  for (const core of cores) {
    for (let fi = 0; fi < floors.length; fi++) {
      const { floorIndex, floorLabel } = resolveFloor(fi);
      console.log(`[EGRESS-INSERT] signType=Exit core=${core} floorIndex=${floorIndex} floorLabel="${floorLabel}" type=${typeof floorLabel}`);
      rows.push(
        makeRow(input, {
          signType: "Exit",
          ruleRef: "R9",
          confidence: "0.90",
          adaRequired: false,
          notes: `Exit at Stair ${core} — illuminated exit sign at stair entry door`,
          floorLabel,
          roomId: null,
          roomNumber: `EXIT-STAIR-${core}-L${floorIndex}`,
          roomName: `Exit at Stair ${core}`,
        }),
      );
    }
  }

  // Exterior exit doors (ground floor only — IBC minimum)
  const minExteriorExits = MIN_EXTERIOR_EXITS[buildingType] ?? 2;
  for (let e = 1; e <= minExteriorExits; e++) {
    rows.push(
      makeRow(input, {
        signType: "Exit",
        ruleRef: "R9",
        confidence: "0.70",
        adaRequired: false,
        notes: `Exterior exit door ${e} — verify count on plans`,
        floorLabel: floors[0] ?? "1",
        roomId: null,
        roomNumber: `EXIT-EXT-${e}`,
        roomName: `Exterior Exit Door ${e}`,
      }),
    );
  }

  // ── STEP 4: Evacuation Maps ────────────────────────────────────────────
  // R13: Place at decision-point rooms (corridors/lobbies), capped per floor
  const maxPerFloor = profile.evacMapMaxPerFloor ?? 2;

  // Single-floor very small buildings — skip evac maps
  const totalRooms = rooms.filter((r) => !r.isMepUnoccupied).length;
  if (floorCount === 1 && totalRooms < 10) {
    // No evac maps
  } else {
    const corridorLexicon = (profile.corridorLexicon as string[] | null) ?? [];
    const upperCorridorLex = corridorLexicon.map((s) => s.toUpperCase());

    // Default decision-point rooms if lexicon is empty
    const defaultDecisionPoints = [
      "CORRIDOR", "MAIN CORRIDOR", "LOBBY", "MAIN LOBBY",
      "GYM LOBBY", "MUSIC LOBBY", "ELEVATOR LOBBY", "CAFETERIA", "GYMNASIUM",
    ];
    const decisionPointNames = upperCorridorLex.length > 0 ? upperCorridorLex : defaultDecisionPoints;

    // Group candidate rooms by floor
    const candidatesByFloor = new Map<string, RoomSummary[]>();
    for (const r of rooms) {
      const upperName = r.roomName.toUpperCase().trim();
      const isCandidate = r.isCorridorOrHall ||
        decisionPointNames.some((dp) => upperName === dp || upperName.startsWith(dp));
      if (!isCandidate) continue;
      const fl = r.level || floors[0] || "1";
      const arr = candidatesByFloor.get(fl) ?? [];
      arr.push(r);
      candidatesByFloor.set(fl, arr);
    }

    for (let fi = 0; fi < floors.length; fi++) {
      const { floorIndex, floorLabel } = resolveFloor(fi);
      const candidates = candidatesByFloor.get(floorLabel) ?? [];
      let placed = 0;

      for (const candidate of candidates) {
        if (placed >= maxPerFloor) break;
        console.log(`[EGRESS-INSERT] signType=Evacuation Map (candidate) floorIndex=${floorIndex} floorLabel="${floorLabel}" type=${typeof floorLabel}`);
        rows.push(
          makeRow(input, {
            signType: "Evacuation Map",
            ruleRef: "R13",
            confidence: "0.85",
            adaRequired: false,
            notes: "Decision-point corridor / lobby",
            floorLabel,
            roomId: candidate.id,
          }),
        );
        placed++;
      }

      // Fallback: if no corridor/lobby found, place 1 evac map per floor.
      // room_number uses integer floorIndex — "EVAC-L1", "EVAC-L2", etc.
      // (never "EVAC-LLEVEL 1" from string concat)
      if (placed === 0) {
        console.log(`[EGRESS-INSERT] signType=Evacuation Map (fallback) floorIndex=${floorIndex} floorLabel="${floorLabel}" type=${typeof floorLabel}`);
        rows.push(
          makeRow(input, {
            signType: "Evacuation Map",
            ruleRef: "R13",
            confidence: "0.60",
            adaRequired: false,
            notes: "Location estimated — verify on plans",
            floorLabel,
            roomId: null,
            roomNumber: `EVAC-L${floorIndex}`,
            roomName: `Evacuation Map — Floor ${floorLabel}`,
          }),
        );
      }
    }
  }

  // ── STEP 5: Max Occupancy for assembly rooms ───────────────────────────
  // R10: Assembly rooms get a Max Occupancy sign
  const assemblyRooms = rooms.filter((r) => r.isAssembly && !r.isMepUnoccupied);
  const seenAssemblyRooms = new Set<string>();

  for (const room of assemblyRooms) {
    if (seenAssemblyRooms.has(room.id)) continue;
    seenAssemblyRooms.add(room.id);
    rows.push(
      makeRow(input, {
        signType: "Max Occupancy",
        ruleRef: "R10",
        confidence: "0.85",
        adaRequired: false,
        notes: "Post inside room at primary entrance",
        floorLabel: room.level,
        roomId: room.id,
      }),
    );
  }

  return rows;
}

/**
 * Summary metadata for verification panel display.
 */
export function getEgressSummary(
  rows: EgressSignRow[],
  buildingType: string,
  profile: BuildingTypeProfile,
): {
  stairCount: number;
  floorCount: number;
  stairCorridor: number;
  stairLanding: number;
  exitSigns: number;
  evacMaps: number;
  areaOfRescue: number;
  maxOccupancy: number;
  exitMinimum: number;
  evacMapCap: number;
} {
  const count = (type: string) => rows.filter((r) => r.signType === type).length;
  const floorLabels = new Set(rows.map((r) => r.floorLabel).filter(Boolean));
  const stairCorridor = count("Stair (Corridor)");
  const floorCount = floorLabels.size || 1;
  const stairCount = floorCount > 0 ? Math.round(stairCorridor / Math.max(floorCount, 1)) : 0;
  const minExterior = MIN_EXTERIOR_EXITS[buildingType] ?? 2;

  return {
    stairCount,
    floorCount,
    stairCorridor,
    stairLanding: count("Stair (Landing)"),
    exitSigns: count("Exit"),
    evacMaps: count("Evacuation Map"),
    areaOfRescue: count("Area of Rescue"),
    maxOccupancy: count("Max Occupancy"),
    exitMinimum: stairCount * floorCount + minExterior,
    evacMapCap: profile.evacMapMaxPerFloor ?? 2,
  };
}
