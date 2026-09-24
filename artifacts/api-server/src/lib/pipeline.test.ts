import { describe, expect, it } from "vitest";
import {
  ROOM_NUMBER_RE,
  expandSynonyms,
  extractRoomsFromWords,
  isJunkRoomName,
  MIN_ROOMS_PER_SHEET_FOR_VISION,
  shouldRunVisionScan,
  getExclusionReason,
  shouldApplyRoomNumberAllowlist,
  unitNamesDominant,
} from "./pipeline";
import {
  applyRules,
  classifyRoom,
  detectBuildingType,
  type RoomRecord,
  type RuleEngineOutput,
} from "./rules-engine";
import type { SidecarWord } from "./sidecar-client";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWord(text: string, x0: number, y0: number): SidecarWord {
  return { text, x0, y0, x1: x0 + 20, y1: y0 + 10, page: 1 };
}

// ---------------------------------------------------------------------------
// ROOM_NUMBER_RE
// ---------------------------------------------------------------------------

describe("ROOM_NUMBER_RE – valid room numbers", () => {
  const valid = [
    // 3-digit residential units
    "101",
    "202",
    "999",
    "101A",
    "202B",
    // government 4-digit rooms (floors 1000-1499)
    "1001",
    "1100",
    "1119",
    "1234",
    "1399",
    "1001Z",
    "1101A",
    // government 4-digit rooms (floors 2000-2499)
    "2001",
    "2102",
    "2113",
    "2499",
    "2102A",
    // government rooms with decimal sub-suffix
    "1101.1",
    "1113.1",
    "1123.1",
    "2102.5",
    // service rooms
    "BP1-101",
    "A1-103",
    "SP1-201",
    "EP1-102",
    // alpha-prefix rooms
    "A101",
    "B202",
    "A101B",
    "Z999A",
  ];

  for (const token of valid) {
    it(`accepts "${token}"`, () => {
      expect(ROOM_NUMBER_RE.test(token)).toBe(true);
    });
  }
});

describe("ROOM_NUMBER_RE – invalid room numbers", () => {
  const invalid = [
    // too short
    "10",
    "12",
    "99",
    // too long
    "12345",
    "10001",
    // building numbers (floor prefix outside 1xxx/2xxx range)
    "7087",
    "3000",
    "5001",
    "1500",
    "2500",
    // plain words
    "OFFICE",
    "MECH",
    "A",
    "AB",
    // bad digit patterns
    "1A",
    "10A",
    "AB123",
    "A10B",
    "1234AB",
    "",
    // lowercase (regex is case-sensitive)
    "101a",
    "a101",
  ];

  for (const token of invalid) {
    it(`rejects "${token}"`, () => {
      expect(ROOM_NUMBER_RE.test(token)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// expandSynonyms
// ---------------------------------------------------------------------------

describe("expandSynonyms – single-word abbreviations", () => {
  it("expands CONF to CONFERENCE", () => {
    expect(expandSynonyms("CONF")).toBe("CONFERENCE");
  });

  it("expands MRR to MENS RESTROOM", () => {
    expect(expandSynonyms("MRR")).toBe("MENS RESTROOM");
  });

  it("expands WRR to WOMENS RESTROOM", () => {
    expect(expandSynonyms("WRR")).toBe("WOMENS RESTROOM");
  });

  it("expands VEST to VESTIBULE", () => {
    expect(expandSynonyms("VEST")).toBe("VESTIBULE");
  });

  it("expands CORR to CORRIDOR", () => {
    expect(expandSynonyms("CORR")).toBe("CORRIDOR");
  });

  it("expands STOR to STORAGE", () => {
    expect(expandSynonyms("STOR")).toBe("STORAGE");
  });

  it("expands MECH to MECHANICAL", () => {
    expect(expandSynonyms("MECH")).toBe("MECHANICAL");
  });

  it("expands ELEC to ELECTRICAL", () => {
    expect(expandSynonyms("ELEC")).toBe("ELECTRICAL");
  });

  it("expands HALL to HALLWAY", () => {
    expect(expandSynonyms("HALL")).toBe("HALLWAY");
  });

  it("expands RR to RESTROOM", () => {
    expect(expandSynonyms("RR")).toBe("RESTROOM");
  });

  it("expands TLT to TOILET", () => {
    expect(expandSynonyms("TLT")).toBe("TOILET");
  });

  it("expands TOIL to TOILET", () => {
    expect(expandSynonyms("TOIL")).toBe("TOILET");
  });

  it("expands REST to RESTROOM", () => {
    expect(expandSynonyms("REST")).toBe("RESTROOM");
  });
});

describe("expandSynonyms – multi-word inputs", () => {
  it("expands only the abbreviated word in a phrase", () => {
    expect(expandSynonyms("CONF ROOM")).toBe("CONFERENCE ROOM");
  });

  it("expands both words when both are abbreviations", () => {
    expect(expandSynonyms("MECH STOR")).toBe("MECHANICAL STORAGE");
  });

  it("leaves unknown words unchanged", () => {
    expect(expandSynonyms("BREAK ROOM")).toBe("BREAK ROOM");
  });

  it("is case-insensitive (lower-case input)", () => {
    expect(expandSynonyms("conf")).toBe("CONFERENCE");
  });

  it("is case-insensitive (mixed-case input)", () => {
    expect(expandSynonyms("Conf Room")).toBe("CONFERENCE ROOM");
  });

  it("full canonical name passes through unchanged", () => {
    expect(expandSynonyms("CONFERENCE")).toBe("CONFERENCE");
  });

  it("handles multiple spaces gracefully", () => {
    expect(expandSynonyms("CONF  ROOM")).toBe("CONFERENCE ROOM");
  });
});

// ---------------------------------------------------------------------------
// extractRoomsFromWords – basic extraction
// ---------------------------------------------------------------------------

describe("extractRoomsFromWords – room number detection", () => {
  const PAGE_W = 1000;
  const PAGE_H = 800;

  it("returns an empty array when there are no words", () => {
    expect(extractRoomsFromWords([], PAGE_W, PAGE_H)).toHaveLength(0);
  });

  it("returns an empty array when no word matches the room-number regex", () => {
    const words = [makeWord("OFFICE", 100, 100), makeWord("LOBBY", 200, 100)];
    expect(extractRoomsFromWords(words, PAGE_W, PAGE_H)).toHaveLength(0);
  });

  it("extracts a single room from a matching number", () => {
    const words = [makeWord("101", 100, 100)];
    const rooms = extractRoomsFromWords(words, PAGE_W, PAGE_H);
    expect(rooms).toHaveLength(1);
    expect(rooms[0].roomNumber).toBe("101");
  });

  it("extracts multiple distinct room numbers", () => {
    const words = [
      makeWord("101", 100, 100),
      makeWord("102", 400, 100),
      makeWord("103", 700, 100),
    ];
    const rooms = extractRoomsFromWords(words, PAGE_W, PAGE_H);
    expect(rooms).toHaveLength(3);
    const numbers = rooms.map((r) => r.roomNumber).sort();
    expect(numbers).toEqual(["101", "102", "103"]);
  });

  it("uses 'UNIT <number>' as the name for 3-digit (residential) room numbers with no nearby label", () => {
    const words = [makeWord("205", 500, 400)];
    const rooms = extractRoomsFromWords(words, PAGE_W, PAGE_H);
    expect(rooms[0].roomName).toBe("UNIT 205");
  });
});

// ---------------------------------------------------------------------------
// extractRoomsFromWords – proximity window
// ---------------------------------------------------------------------------

describe("extractRoomsFromWords – proximity window (tight cluster or same-line-close)", () => {
  const PAGE_W = 1000;
  const PAGE_H = 800;

  it("includes a label word within the proximity window", () => {
    const words = [
      makeWord("301", 100, 200),
      makeWord("CONFERENCE", 150, 205),
    ];
    const rooms = extractRoomsFromWords(words, PAGE_W, PAGE_H);
    expect(rooms[0].roomName).toBe("CONFERENCE");
  });

  it("assembles multi-word label sorted left-to-right by x", () => {
    const words = [
      makeWord("302", 200, 300),
      makeWord("ROOM", 260, 302),
      makeWord("CONFERENCE", 130, 302),
    ];
    const rooms = extractRoomsFromWords(words, PAGE_W, PAGE_H);
    expect(rooms[0].roomName).toBe("CONFERENCE ROOM");
  });

  it("pairs a nearby name cluster within 60 pts even when dy=41 (new line-based algorithm)", () => {
    const words = [
      makeWord("401", 100, 200),
      makeWord("STORAGE", 130, 241), // bbox edge-to-edge ~32 pts < 60 → paired by new algorithm
    ];
    const rooms = extractRoomsFromWords(words, PAGE_W, PAGE_H);
    // New clustering finds STORAGE as the nearest name cluster within 60 pts
    expect(rooms[0].roomName).toBe("STORAGE");
  });

  it("excludes a label word whose dx is too wide for any zone", () => {
    const words = [
      makeWord("402", 100, 200),
      makeWord("STORAGE", 420, 200), // dx=320 > 200 (same-line max) and dy=0 < 15 but dx>200 → excluded
    ];
    const rooms = extractRoomsFromWords(words, PAGE_W, PAGE_H);
    // 402 is a 3-digit residential unit number → falls back to "UNIT NNN" when no label found
    expect(rooms[0].roomName).toBe("UNIT 402");
  });

  it("includes a label word within the tight-cluster zone (dy<40, dx<80)", () => {
    const words = [
      makeWord("403", 100, 200),
      makeWord("MECH", 150, 234), // dy=34 < 40, dx=50 < 80 → tight cluster → included
    ];
    const rooms = extractRoomsFromWords(words, PAGE_W, PAGE_H);
    expect(rooms[0].roomName).toBe("MECHANICAL");
  });

  it("excludes IGNORE_WORDS from the assembled room name", () => {
    const words = [
      makeWord("501", 100, 100),
      makeWord("THE", 140, 102),
      makeWord("OFFICE", 180, 102),
    ];
    const rooms = extractRoomsFromWords(words, PAGE_W, PAGE_H);
    expect(rooms[0].roomName).toBe("OFFICE");
  });

  it("skips a nearby word that is itself a valid room number", () => {
    const words = [
      makeWord("601", 100, 100),
      makeWord("602", 160, 102),
      makeWord("LOBBY", 220, 102),
    ];
    const rooms = extractRoomsFromWords(words, PAGE_W, PAGE_H);
    expect(rooms.find((r) => r.roomNumber === "601")!.roomName).toBe("LOBBY");
  });
});

// ---------------------------------------------------------------------------
// extractRoomsFromWords – synonym expansion via nearby words
// ---------------------------------------------------------------------------

describe("extractRoomsFromWords – synonym expansion of nearby labels", () => {
  const PAGE_W = 1000;
  const PAGE_H = 800;

  it("expands CONF in the nearby label to CONFERENCE", () => {
    const words = [
      makeWord("701", 100, 100),
      makeWord("CONF", 150, 102),
    ];
    const rooms = extractRoomsFromWords(words, PAGE_W, PAGE_H);
    expect(rooms[0].roomName).toBe("CONFERENCE");
  });

  it("expands MRR in the nearby label to MENS RESTROOM", () => {
    const words = [
      makeWord("702", 100, 100),
      makeWord("MRR", 150, 102),
    ];
    const rooms = extractRoomsFromWords(words, PAGE_W, PAGE_H);
    expect(rooms[0].roomName).toBe("MENS RESTROOM");
  });

  it("expands STOR in the nearby label to STORAGE", () => {
    const words = [
      makeWord("703", 100, 100),
      makeWord("STOR", 150, 102),
    ];
    const rooms = extractRoomsFromWords(words, PAGE_W, PAGE_H);
    expect(rooms[0].roomName).toBe("STORAGE");
  });
});

// ---------------------------------------------------------------------------
// extractRoomsFromWords – coordinate normalisation
// ---------------------------------------------------------------------------

describe("extractRoomsFromWords – coordinate normalisation", () => {
  it("normalises x coordinate to 0–100000 range (centroid of label bbox)", () => {
    // makeWord("801", 500, 400) => x0=500, x1=520 → centerX=510
    // normX = round(510/1000*100000) = 51000
    const words = [makeWord("801", 500, 400)];
    const rooms = extractRoomsFromWords(words, 1000, 800);
    expect(rooms[0].x).toBe(51000);
  });

  it("normalises y coordinate to 0–100000 range with bbox-height nudge", () => {
    // makeWord("802", 500, 400) => y0=400, y1=410 → centerY=405, bboxH=10
    // nudge = 10*0.35=3.5, ry=408.5 → normY = round(408.5/800*100000) = 51063
    const words = [makeWord("802", 500, 400)];
    const rooms = extractRoomsFromWords(words, 1000, 800);
    expect(rooms[0].y).toBe(51063);
  });

  it("stores the original pageWidth and pageHeight on each room", () => {
    const words = [makeWord("803", 100, 100)];
    const rooms = extractRoomsFromWords(words, 1200, 900);
    expect(rooms[0].pageWidth).toBe(1200);
    expect(rooms[0].pageHeight).toBe(900);
  });
});

// ---------------------------------------------------------------------------
// MIN_ROOMS_PER_SHEET_FOR_VISION – threshold value
// ---------------------------------------------------------------------------

describe("MIN_ROOMS_PER_SHEET_FOR_VISION", () => {
  it("has the expected threshold value of 3", () => {
    expect(MIN_ROOMS_PER_SHEET_FOR_VISION).toBe(3);
  });

  it("triggers vision when extracted room count is below the threshold (0 rooms)", () => {
    const rooms = extractRoomsFromWords([], 1000, 800);
    expect(rooms.length < MIN_ROOMS_PER_SHEET_FOR_VISION).toBe(true);
  });

  it("triggers vision when extracted room count is below the threshold (2 rooms)", () => {
    const words = [makeWord("101", 100, 100), makeWord("102", 400, 100)];
    const rooms = extractRoomsFromWords(words, 1000, 800);
    expect(rooms.length < MIN_ROOMS_PER_SHEET_FOR_VISION).toBe(true);
  });

  it("skips vision when extracted room count meets the threshold (3 rooms)", () => {
    const words = [
      makeWord("101", 100, 100),
      makeWord("102", 400, 100),
      makeWord("103", 700, 100),
    ];
    const rooms = extractRoomsFromWords(words, 1000, 800);
    expect(rooms.length >= MIN_ROOMS_PER_SHEET_FOR_VISION).toBe(true);
  });

  it("skips vision when extracted room count exceeds the threshold (5 rooms)", () => {
    const words = [
      makeWord("101", 100, 100),
      makeWord("102", 400, 100),
      makeWord("103", 700, 100),
      makeWord("104", 100, 400),
      makeWord("105", 400, 400),
    ];
    const rooms = extractRoomsFromWords(words, 1000, 800);
    expect(rooms.length >= MIN_ROOMS_PER_SHEET_FOR_VISION).toBe(true);
  });
});

// ===========================================================================
// FULL PIPELINE INTEGRATION TESTS
// Simulates: extracted rooms → classifyRoom → applyRules → verify sign totals
// ===========================================================================

// ---------------------------------------------------------------------------
// Pipeline helpers
// ---------------------------------------------------------------------------

let _pipelineId = 0;
function nextPipelineId() {
  return `pipe-room-${++_pipelineId}`;
}

/**
 * Simulates Step 8 of the pipeline: converts raw { roomNumber, roomName, level }
 * objects into fully-classified RoomRecord instances, mirroring what the real
 * pipeline does after extractRoomsFromWords + expandSynonyms.
 */
function buildRoomRecords(
  rawRooms: Array<{
    roomNumber: string;
    roomName: string;
    level?: string;
    occupantLoad?: number;
    occupancyGroup?: string;
  }>,
): RoomRecord[] {
  return rawRooms.map((r) => {
    const expanded = expandSynonyms(r.roomName);
    const cls = classifyRoom(expanded);
    return {
      id: nextPipelineId(),
      roomNumber: r.roomNumber,
      roomName: expanded,
      level: r.level ?? "1",
      occupantLoad: r.occupantLoad ?? null,
      occupancyGroup: r.occupancyGroup ?? null,
      isResidentialUnit: cls.isResidentialUnit ?? false,
      isRestroom: cls.isRestroom ?? false,
      isStair: cls.isStair ?? false,
      isElevator: cls.isElevator ?? false,
      isVestibule: cls.isVestibule ?? false,
      isCorridorOrHall: cls.isCorridorOrHall ?? false,
      isVehicleBay: cls.isVehicleBay ?? false,
      isMepUnoccupied: cls.isMepUnoccupied ?? false,
      isVariableUse: cls.isVariableUse ?? false,
      isPublicFacing: cls.isPublicFacing ?? false,
      isAssembly: cls.isAssembly ?? false,
      sheetId: null,
    };
  });
}

/** Count total qty of a sign type across all pipeline output (room + aggregate). */
function countRestroomSigns(output: RuleEngineOutput): number {
  return ["Restroom", "Restroom(Men)", "Restroom(Women)"].reduce(
    (sum, t) => sum + countSigns(output, t),
    0,
  );
}

function countSigns(output: RuleEngineOutput, signType: string): number {
  const fromRooms = output.results.reduce(
    (sum, r) =>
      sum + r.signs.filter((s) => s.signType === signType).reduce((q, s) => q + s.qty, 0),
    0,
  );
  const fromStairs = output.stairSigns
    .filter((s) => s.signType === signType)
    .reduce((q, s) => q + s.qty, 0);
  const fromElevators = output.elevatorSigns
    .filter((s) => s.signType === signType)
    .reduce((q, s) => q + s.qty, 0);
  const fromEvacMaps = output.evacMapSigns
    .filter((s) => s.signType === signType)
    .reduce((q, s) => q + s.qty, 0);
  return fromRooms + fromStairs + fromElevators + fromEvacMaps;
}

/** Sum all sign quantities across the entire output. */
function totalSignQty(output: RuleEngineOutput): number {
  const roomTotal = output.results.reduce(
    (sum, r) => sum + r.signs.reduce((q, s) => q + s.qty, 0),
    0,
  );
  const stairTotal = output.stairSigns.reduce((q, s) => q + s.qty, 0);
  const elevTotal = output.elevatorSigns.reduce((q, s) => q + s.qty, 0);
  const evacTotal = output.evacMapSigns.reduce((q, s) => q + s.qty, 0);
  return roomTotal + stairTotal + elevTotal + evacTotal;
}

// ---------------------------------------------------------------------------
// Commercial — full pipeline
// ---------------------------------------------------------------------------

describe("Pipeline integration — commercial building", () => {
  const rawRooms = [
    { roomNumber: "100", roomName: "Lobby", level: "1" },
    { roomNumber: "101", roomName: "Office", level: "1" },
    { roomNumber: "102", roomName: "Conference Room", level: "1", occupantLoad: 60 },
    { roomNumber: "103", roomName: "MRR", level: "1" },
    { roomNumber: "104", roomName: "WRR", level: "1" },
    { roomNumber: "105", roomName: "ELEC", level: "1", occupantLoad: 0 },
    { roomNumber: "106", roomName: "Entry Vestibule", level: "1" },
    { roomNumber: "107", roomName: "Training Room", level: "1", occupantLoad: 30 },
    { roomNumber: "108", roomName: "CORR", level: "1" },
    { roomNumber: "201", roomName: "Office", level: "2" },
    { roomNumber: "S1", roomName: "Stair 1", level: "1" },
    { roomNumber: "S1", roomName: "Stair 1", level: "2" },
    { roomNumber: "E1", roomName: "Elevator", level: "1" },
    { roomNumber: "E1", roomName: "Elevator", level: "2" },
  ];

  const rooms = buildRoomRecords(rawRooms);
  const buildingType = detectBuildingType(rawRooms);
  const output = applyRules({ rooms, buildingType });

  it("detects building type as commercial", () => {
    expect(buildingType).toBe("commercial");
  });

  it("produces at least one Room ID sign", () => {
    expect(countSigns(output, "Room ID")).toBeGreaterThan(0);
  });

  it("MRR and WRR abbreviations each produce a Restroom sign (total = 2)", () => {
    expect(countRestroomSigns(output)).toBe(2);
  });

  it("vestibule produces an Exit sign", () => {
    const vestResult = output.results.find((r) => r.room.roomNumber === "106");
    expect(vestResult?.signs.some((s) => s.signType === "Exit")).toBe(true);
  });

  it("conference room with occupant load ≥50 produces Max Occupancy", () => {
    expect(countSigns(output, "Max Occupancy")).toBeGreaterThanOrEqual(1);
  });

  it("training room gets Room ID w/insert (R2, variable use)", () => {
    const trainResult = output.results.find((r) => r.room.roomNumber === "107");
    expect(trainResult?.signs.some((s) => s.signType === "Room ID w/insert")).toBe(true);
  });

  it("ELEC with no occupant load is excluded from Room ID (MEP occupied_only)", () => {
    const elecResult = output.results.find((r) => r.room.roomNumber === "105");
    expect(elecResult?.signs.filter((s) => s.signType === "Room ID")).toHaveLength(0);
  });

  it("CORR abbreviation expands and is excluded from Room ID (R4 corridor rule)", () => {
    const corrResult = output.results.find((r) => r.room.roomNumber === "108");
    expect(corrResult?.signs.filter((s) => s.signType === "Room ID")).toHaveLength(0);
  });

  it("produces Stair(Corridor) and Stair(Landing) for Stair 1 across all served floors (Fix 1)", () => {
    // R11 now always emits both sign types per unique stair core. qty = floorCount.
    // S1 appears on levels "1" and "2" → 1 unique stair core, 2 floors served.
    const corridorSigns = output.stairSigns.filter((s) => s.signType === "Stair(Corridor)");
    const landingSigns = output.stairSigns.filter((s) => s.signType === "Stair(Landing)");
    expect(corridorSigns.length).toBe(1);
    expect(corridorSigns[0].qty).toBe(2);
    expect(landingSigns.length).toBe(1);
    expect(landingSigns[0].qty).toBe(2);
  });

  it("produces one Elevator sign per unique elevator (per_building mode)", () => {
    expect(countSigns(output, "Elevator")).toBe(1);
  });

  it("total sign qty is within a plausible range for the input size", () => {
    const total = totalSignQty(output);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThan(rawRooms.length * 6);
  });
});

// ---------------------------------------------------------------------------
// Residential — full pipeline
// ---------------------------------------------------------------------------

describe("Pipeline integration — residential building", () => {
  const rawRooms = [
    { roomNumber: "100", roomName: "Lobby", level: "1" },
    { roomNumber: "101", roomName: "Unit 101", level: "1" },
    { roomNumber: "102", roomName: "Unit 102", level: "1" },
    { roomNumber: "103", roomName: "Unit 103", level: "2" },
    { roomNumber: "104", roomName: "Unit 104", level: "2" },
    { roomNumber: "105", roomName: "MECH", level: "B", occupantLoad: 0 },
    { roomNumber: "106", roomName: "ELEC", level: "B", occupantLoad: 0 },
    { roomNumber: "S1", roomName: "Stair 1", level: "1" },
    { roomNumber: "S1", roomName: "Stair 1", level: "2" },
    { roomNumber: "E1", roomName: "Elevator", level: "1" },
    { roomNumber: "E1", roomName: "Elevator", level: "2" },
  ];

  const rooms = buildRoomRecords(rawRooms);
  const buildingType = detectBuildingType(rawRooms);
  const output = applyRules({ rooms, buildingType });

  it("detects building type as residential", () => {
    expect(buildingType).toBe("residential");
  });

  it("assigns Room ID (via R16) to residential units", () => {
    // R16 was changed: residential units now receive "Room ID" (not "Unit ID").
    const unitCount = output.results
      .filter((r) => r.room.isResidentialUnit)
      .flatMap((r) => r.signs)
      .filter((s) => s.signType === "Room ID" && s.ruleRef === "R16").length;
    expect(unitCount).toBe(4);
  });

  it("does not assign Unit ID to residential units (R16 emits Room ID)", () => {
    const unitIds = output.results
      .filter((r) => r.room.isResidentialUnit)
      .flatMap((r) => r.signs)
      .filter((s) => s.signType === "Unit ID");
    expect(unitIds).toHaveLength(0);
  });

  it("MECH and ELEC rooms get Room ID (all MEP policy for residential)", () => {
    const mepRoomIds = output.results
      .filter((r) => r.room.isMepUnoccupied)
      .flatMap((r) => r.signs)
      .filter((s) => s.signType === "Room ID");
    expect(mepRoomIds.length).toBeGreaterThanOrEqual(2);
  });

  it("elevator produces per_level Elevator signs", () => {
    expect(countSigns(output, "Elevator")).toBeGreaterThanOrEqual(1);
  });

  it("total sign qty is positive", () => {
    expect(totalSignQty(output)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// School — full pipeline
// ---------------------------------------------------------------------------

describe("Pipeline integration — school building", () => {
  const rawRooms = [
    { roomNumber: "100", roomName: "Lobby", level: "1" },
    { roomNumber: "101", roomName: "Classroom 101", level: "1" },
    { roomNumber: "102", roomName: "Classroom 102", level: "1" },
    { roomNumber: "103", roomName: "Principal Office", level: "1" },
    { roomNumber: "104", roomName: "MRR", level: "1" },
    { roomNumber: "105", roomName: "WRR", level: "1" },
    { roomNumber: "106", roomName: "Auditorium", level: "1", occupantLoad: 200, occupancyGroup: "A-3" },
    { roomNumber: "107", roomName: "MECH", level: "B", occupantLoad: 0 },
    { roomNumber: "108", roomName: "Media Center", level: "1" },
    { roomNumber: "S1", roomName: "Stair 1", level: "1" },
    { roomNumber: "S1", roomName: "Stair 1", level: "2" },
  ];

  const rooms = buildRoomRecords(rawRooms);
  const buildingType = detectBuildingType(rawRooms);
  const output = applyRules({ rooms, buildingType });

  it("detects building type as education (canonical)", () => {
    expect(buildingType).toBe("education");
  });

  it("classrooms, principal office, and media center all get Room ID", () => {
    const classroomIds = output.results
      .filter((r) => ["101", "102", "103", "108"].includes(r.room.roomNumber))
      .every((r) => r.signs.some((s) => s.signType === "Room ID"));
    expect(classroomIds).toBe(true);
  });

  it("MRR and WRR each get a Restroom sign (total = 2)", () => {
    expect(countRestroomSigns(output)).toBe(2);
  });

  it("auditorium with high occupant load gets Room ID w/insert (R2, Fix 5) and Max Occupancy", () => {
    // Fix 5: applyCapacityRule now also returns Room ID w/insert when Max Occupancy fires.
    // The dedup step removes any plain Room ID, leaving Room ID w/insert + Max Occupancy.
    const audResult = output.results.find((r) => r.room.roomNumber === "106");
    expect(audResult?.signs.some((s) => s.signType === "Room ID w/insert")).toBe(true);
    expect(audResult?.signs.some((s) => s.signType === "Max Occupancy")).toBe(true);
  });

  it("auditorium with occupancy group A-3 gets Max Occupancy", () => {
    expect(countSigns(output, "Max Occupancy")).toBeGreaterThanOrEqual(1);
  });

  it("MECH room gets Room ID (all MEP policy for education)", () => {
    const mechResult = output.results.find((r) => r.room.roomNumber === "107");
    expect(mechResult?.signs.some((s) => s.signType === "Room ID")).toBe(true);
  });

  it("total sign qty is positive", () => {
    expect(totalSignQty(output)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Hospital — full pipeline
// ---------------------------------------------------------------------------

describe("Pipeline integration — hospital building", () => {
  const rawRooms = [
    { roomNumber: "100", roomName: "Lobby", level: "1" },
    { roomNumber: "101", roomName: "Patient Room", level: "2" },
    { roomNumber: "102", roomName: "Patient Room", level: "2" },
    { roomNumber: "103", roomName: "Nurse Station", level: "2" },
    { roomNumber: "104", roomName: "ICU", level: "3" },
    { roomNumber: "105", roomName: "Operating Room", level: "3" },
    { roomNumber: "106", roomName: "MRR", level: "2" },
    { roomNumber: "107", roomName: "MECH", level: "B", occupantLoad: 0 },
    { roomNumber: "S1", roomName: "Stair 1", level: "1" },
    { roomNumber: "S1", roomName: "Stair 1", level: "2" },
    { roomNumber: "E1", roomName: "Elevator", level: "1" },
    { roomNumber: "E1", roomName: "Elevator", level: "2" },
    { roomNumber: "E1", roomName: "Elevator", level: "3" },
  ];

  const rooms = buildRoomRecords(rawRooms);
  const buildingType = detectBuildingType(rawRooms);
  const output = applyRules({ rooms, buildingType });

  it("detects building type as healthcare (canonical)", () => {
    expect(buildingType).toBe("healthcare");
  });

  it("patient rooms, nurse station, ICU, and OR all get Room ID", () => {
    const clinicalIds = output.results
      .filter((r) => ["101", "102", "103", "104", "105"].includes(r.room.roomNumber))
      .every((r) => r.signs.some((s) => s.signType === "Room ID"));
    expect(clinicalIds).toBe(true);
  });

  it("Restroom sign is produced", () => {
    expect(countRestroomSigns(output)).toBeGreaterThanOrEqual(1);
  });

  it("elevator signs are produced in per_level mode (multiple per elevator)", () => {
    expect(output.elevatorSigns.length).toBeGreaterThanOrEqual(1);
    const totalFireSigns = countSigns(output, "Elevator");
    expect(totalFireSigns).toBeGreaterThanOrEqual(1);
  });

  it("total sign qty is positive and sane", () => {
    expect(totalSignQty(output)).toBeGreaterThan(0);
    expect(totalSignQty(output)).toBeLessThan(rawRooms.length * 6);
  });
});

// ---------------------------------------------------------------------------
// Hotel — full pipeline
// ---------------------------------------------------------------------------

describe("Pipeline integration — hotel building", () => {
  const rawRooms = [
    { roomNumber: "100", roomName: "Lobby", level: "1" },
    { roomNumber: "FD1", roomName: "Front Desk", level: "1" },
    { roomNumber: "101", roomName: "Room 101", level: "1" },
    { roomNumber: "102", roomName: "Room 102", level: "1" },
    { roomNumber: "201", roomName: "Room 201", level: "2" },
    { roomNumber: "202", roomName: "Room 202", level: "2" },
    { roomNumber: "103", roomName: "Conference Room", level: "1", occupantLoad: 80 },
    { roomNumber: "104", roomName: "MRR", level: "1" },
    { roomNumber: "S1", roomName: "Stair 1", level: "1" },
    { roomNumber: "S1", roomName: "Stair 1", level: "2" },
    { roomNumber: "E1", roomName: "Elevator", level: "1" },
    { roomNumber: "E1", roomName: "Elevator", level: "2" },
  ];

  const rooms = buildRoomRecords(rawRooms);
  const buildingType = detectBuildingType(rawRooms);
  const output = applyRules({ rooms, buildingType });

  it("detects building type as hotel", () => {
    expect(buildingType).toBe("hotel");
  });

  it("hotel rooms (Room xxx pattern without Unit prefix) get plain Room ID", () => {
    const hotelRoomIds = output.results
      .filter((r) => /^Room \d/.test(r.room.roomName))
      .every((r) => r.signs.some((s) => s.signType === "Room ID"));
    expect(hotelRoomIds).toBe(true);
  });

  it("Restroom sign produced for MRR", () => {
    expect(countRestroomSigns(output)).toBeGreaterThanOrEqual(1);
  });

  it("conference room with occupant load ≥50 gets Max Occupancy and Exit (qty=2)", () => {
    expect(countSigns(output, "Max Occupancy")).toBeGreaterThanOrEqual(1);
    const confResult = output.results.find((r) => r.room.roomNumber === "103");
    const exitSign = confResult?.signs.find((s) => s.signType === "Exit");
    expect(exitSign?.qty).toBe(2);
  });

  it("total sign qty is positive", () => {
    expect(totalSignQty(output)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Warehouse — full pipeline
// ---------------------------------------------------------------------------

describe("Pipeline integration — warehouse building", () => {
  const rawRooms = [
    { roomNumber: "100", roomName: "Loading Dock", level: "1" },
    { roomNumber: "101", roomName: "Receiving", level: "1" },
    { roomNumber: "102", roomName: "Warehouse Storage", level: "1" },
    { roomNumber: "103", roomName: "Office", level: "1" },
    { roomNumber: "104", roomName: "Break Room", level: "1", occupantLoad: 30 },
    { roomNumber: "105", roomName: "MRR", level: "1" },
    { roomNumber: "106", roomName: "MECH", level: "B" },
    { roomNumber: "S1", roomName: "Stair 1", level: "1" },
  ];

  const rooms = buildRoomRecords(rawRooms);
  const buildingType = detectBuildingType(rawRooms);
  const output = applyRules({ rooms, buildingType });

  it("detects building type as warehouse", () => {
    expect(buildingType).toBe("warehouse");
  });

  it("office and break room get Room ID", () => {
    const officeResult = output.results.find((r) => r.room.roomNumber === "103");
    const breakResult = output.results.find((r) => r.room.roomNumber === "104");
    expect(officeResult?.signs.some((s) => s.signType === "Room ID")).toBe(true);
    expect(breakResult?.signs.some((s) => s.signType === "Room ID")).toBe(true);
  });

  it("MECH gets Room ID (all MEP policy in warehouse)", () => {
    const mechResult = output.results.find((r) => r.room.roomNumber === "106");
    expect(mechResult?.signs.some((s) => s.signType === "Room ID")).toBe(true);
  });

  it("does NOT produce Max Occupancy (no assembly rules in warehouse)", () => {
    expect(countSigns(output, "Max Occupancy")).toBe(0);
  });

  it("does NOT produce Exit signs for regular warehouse rooms", () => {
    expect(countSigns(output, "Exit")).toBe(0);
  });

  it("Restroom sign produced for MRR", () => {
    expect(countRestroomSigns(output)).toBeGreaterThanOrEqual(1);
  });

  it("total sign qty is positive", () => {
    expect(totalSignQty(output)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Government (fire station) — full pipeline
// ---------------------------------------------------------------------------

describe("Pipeline integration — government building (fire station)", () => {
  const rawRooms = [
    { roomNumber: "100", roomName: "Apparatus Bay", level: "1" },
    { roomNumber: "101", roomName: "Office", level: "1" },
    { roomNumber: "102", roomName: "Bunk Room", level: "2" },
    { roomNumber: "103", roomName: "Council Chamber", level: "1", occupantLoad: 100, occupancyGroup: "A-2" },
    { roomNumber: "104", roomName: "MRR", level: "1" },
    { roomNumber: "105", roomName: "CORR", level: "1" },
    { roomNumber: "106", roomName: "Lobby", level: "1" },
    { roomNumber: "107", roomName: "Conference Room", level: "1", occupantLoad: 75, occupancyGroup: "A-2" },
    { roomNumber: "S1", roomName: "Stair 1", level: "1" },
    { roomNumber: "S1", roomName: "Stair 1", level: "2" },
  ];

  const rooms = buildRoomRecords(rawRooms);
  const buildingType = detectBuildingType(rawRooms);
  const output = applyRules({ rooms, buildingType });

  it("detects building type as government", () => {
    expect(buildingType).toBe("government");
  });

  it("apparatus bay gets R3 Room ID with qty=3 and needs_review", () => {
    const bayResult = output.results.find((r) => r.room.roomNumber === "100");
    const r3Sign = bayResult?.signs.find((s) => s.ruleRef === "R3");
    expect(r3Sign).toBeDefined();
    expect(r3Sign!.qty).toBe(3);
    expect(r3Sign!.status).toBe("needs_review");
  });

  it("CORR expanded corridor is excluded from Room ID (R4)", () => {
    const corrResult = output.results.find((r) => r.room.roomNumber === "105");
    expect(corrResult?.signs.filter((s) => s.signType === "Room ID")).toHaveLength(0);
  });

  it("Restroom sign produced", () => {
    expect(countRestroomSigns(output)).toBeGreaterThanOrEqual(1);
  });

  it("conference room with occupancy group A-2 gets Max Occupancy", () => {
    expect(countSigns(output, "Max Occupancy")).toBeGreaterThanOrEqual(1);
  });

  it("lobby gets Office Directory (hasDirectory=true in government)", () => {
    expect(countSigns(output, "Office Directory")).toBeGreaterThanOrEqual(1);
  });

  it("total sign qty is positive", () => {
    expect(totalSignQty(output)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Church — full pipeline
// ---------------------------------------------------------------------------

describe("Pipeline integration — church building", () => {
  const rawRooms = [
    { roomNumber: "100", roomName: "Sanctuary", level: "1", occupantLoad: 300 },
    { roomNumber: "101", roomName: "Nave", level: "1" },
    { roomNumber: "102", roomName: "Chapel", level: "1", occupantLoad: 80, occupancyGroup: "A-3" },
    { roomNumber: "103", roomName: "Office", level: "1" },
    { roomNumber: "104", roomName: "MRR", level: "1" },
    { roomNumber: "105", roomName: "WRR", level: "1" },
    { roomNumber: "S1", roomName: "Stair 1", level: "1" },
  ];

  const rooms = buildRoomRecords(rawRooms);
  const buildingType = detectBuildingType(rawRooms);
  const output = applyRules({ rooms, buildingType });

  it("detects building type as assembly (canonical)", () => {
    expect(buildingType).toBe("assembly");
  });

  it("office gets Room ID", () => {
    const officeResult = output.results.find((r) => r.room.roomNumber === "103");
    expect(officeResult?.signs.some((s) => s.signType === "Room ID")).toBe(true);
  });

  it("MRR and WRR each produce a Restroom sign (total = 2)", () => {
    expect(countRestroomSigns(output)).toBe(2);
  });

  it("high-occupancy assembly rooms get Max Occupancy", () => {
    expect(countSigns(output, "Max Occupancy")).toBeGreaterThanOrEqual(1);
  });

  it("total sign qty is positive", () => {
    expect(totalSignQty(output)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Senior-living — full pipeline
// ---------------------------------------------------------------------------

describe("Pipeline integration — senior-living building", () => {
  const rawRooms = [
    { roomNumber: "100", roomName: "Memory Care Suite", level: "1" },
    { roomNumber: "101", roomName: "Assisted Living Room", level: "1" },
    { roomNumber: "102", roomName: "Resident Room", level: "1" },
    { roomNumber: "103", roomName: "Community Room", level: "1", occupantLoad: 60 },
    { roomNumber: "104", roomName: "Lobby", level: "1" },
    { roomNumber: "105", roomName: "MRR", level: "1" },
    { roomNumber: "106", roomName: "MECH", level: "B" },
    { roomNumber: "S1", roomName: "Stair 1", level: "1" },
    { roomNumber: "E1", roomName: "Elevator", level: "1" },
    { roomNumber: "E1", roomName: "Elevator", level: "2" },
  ];

  const rooms = buildRoomRecords(rawRooms);
  const buildingType = detectBuildingType(rawRooms);
  const output = applyRules({ rooms, buildingType });

  it("detects building type as senior-living", () => {
    expect(buildingType).toBe("senior_living");
  });

  it("Restroom sign produced for MRR", () => {
    expect(countRestroomSigns(output)).toBeGreaterThanOrEqual(1);
  });

  it("MECH gets Room ID (all MEP policy for senior-living)", () => {
    const mechResult = output.results.find((r) => r.room.roomNumber === "106");
    expect(mechResult?.signs.some((s) => s.signType === "Room ID")).toBe(true);
  });

  it("elevator signs produced in per_level mode", () => {
    expect(output.elevatorSigns.length).toBeGreaterThanOrEqual(1);
  });

  it("total sign qty is positive", () => {
    expect(totalSignQty(output)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Lab — full pipeline
// ---------------------------------------------------------------------------

describe("Pipeline integration — lab building", () => {
  const rawRooms = [
    { roomNumber: "101", roomName: "Laboratory A", level: "1" },
    { roomNumber: "102", roomName: "Fume Hood Room", level: "1" },
    { roomNumber: "103", roomName: "Office", level: "1" },
    { roomNumber: "104", roomName: "IT Room", level: "B", occupantLoad: 0 },
    { roomNumber: "105", roomName: "MRR", level: "1" },
    { roomNumber: "106", roomName: "Lobby", level: "1" },
    { roomNumber: "S1", roomName: "Stair 1", level: "1" },
    { roomNumber: "E1", roomName: "Elevator", level: "1" },
  ];

  const rooms = buildRoomRecords(rawRooms);
  const buildingType = detectBuildingType(rawRooms);
  const output = applyRules({ rooms, buildingType });

  it("detects building type as lab", () => {
    expect(buildingType).toBe("lab");
  });

  it("lab rooms and office get Room ID", () => {
    const labRooms = output.results
      .filter((r) => ["101", "102", "103"].includes(r.room.roomNumber))
      .every((r) => r.signs.some((s) => s.signType === "Room ID"));
    expect(labRooms).toBe(true);
  });

  it("unoccupied IT room is excluded from Room ID (occupied_only MEP policy)", () => {
    const itResult = output.results.find((r) => r.room.roomNumber === "104");
    expect(itResult?.signs.filter((s) => s.signType === "Room ID")).toHaveLength(0);
  });

  it("lobby gets Office Directory (hasDirectory=true in lab)", () => {
    expect(countSigns(output, "Office Directory")).toBeGreaterThanOrEqual(1);
  });

  it("total sign qty is positive", () => {
    expect(totalSignQty(output)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Bank — full pipeline
// ---------------------------------------------------------------------------

describe("Pipeline integration — bank building", () => {
  const rawRooms = [
    { roomNumber: "100", roomName: "Vault", level: "1" },
    { roomNumber: "101", roomName: "Safe Deposit Room", level: "1" },
    { roomNumber: "102", roomName: "Cash Counter", level: "1" },
    { roomNumber: "103", roomName: "Office", level: "1" },
    { roomNumber: "104", roomName: "MRR", level: "1" },
    { roomNumber: "105", roomName: "Lobby", level: "1" },
    { roomNumber: "106", roomName: "ELEC", level: "B", occupantLoad: 0 },
    { roomNumber: "S1", roomName: "Stair 1", level: "1" },
  ];

  const rooms = buildRoomRecords(rawRooms);
  const buildingType = detectBuildingType(rawRooms);
  const output = applyRules({ rooms, buildingType });

  it("detects building type as bank", () => {
    expect(buildingType).toBe("bank");
  });

  it("vault, safe deposit room, cash counter, and office get Room ID", () => {
    const bankRooms = output.results
      .filter((r) => ["100", "101", "102", "103"].includes(r.room.roomNumber))
      .every((r) => r.signs.some((s) => s.signType === "Room ID"));
    expect(bankRooms).toBe(true);
  });

  it("unoccupied ELEC room is excluded from Room ID (occupied_only MEP policy)", () => {
    const elecResult = output.results.find((r) => r.room.roomNumber === "106");
    expect(elecResult?.signs.filter((s) => s.signType === "Room ID")).toHaveLength(0);
  });

  it("lobby gets Office Directory (hasDirectory=true in bank)", () => {
    expect(countSigns(output, "Office Directory")).toBeGreaterThanOrEqual(1);
  });

  it("Restroom sign produced", () => {
    expect(countRestroomSigns(output)).toBeGreaterThanOrEqual(1);
  });

  it("total sign qty is positive", () => {
    expect(totalSignQty(output)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Retail — full pipeline
// ---------------------------------------------------------------------------

describe("Pipeline integration — retail building", () => {
  const rawRooms = [
    { roomNumber: "100", roomName: "Merchandise Display", level: "1" },
    { roomNumber: "101", roomName: "Fitting Room", level: "1" },
    { roomNumber: "102", roomName: "Stock Room", level: "1" },
    { roomNumber: "103", roomName: "Office", level: "1" },
    { roomNumber: "104", roomName: "MRR", level: "1" },
    { roomNumber: "105", roomName: "WRR", level: "1" },
    { roomNumber: "106", roomName: "MECH", level: "B" },
    { roomNumber: "S1", roomName: "Stair 1", level: "1" },
  ];

  const rooms = buildRoomRecords(rawRooms);
  const buildingType = detectBuildingType(rawRooms);
  const output = applyRules({ rooms, buildingType });

  it("detects building type as retail", () => {
    expect(buildingType).toBe("retail");
  });

  it("occupied rooms get Room ID", () => {
    expect(countSigns(output, "Room ID")).toBeGreaterThan(0);
  });

  it("MECH gets Room ID (all MEP policy for retail)", () => {
    const mechResult = output.results.find((r) => r.room.roomNumber === "106");
    expect(mechResult?.signs.some((s) => s.signType === "Room ID")).toBe(true);
  });

  it("MRR and WRR each produce a Restroom sign (total = 2)", () => {
    expect(countRestroomSigns(output)).toBe(2);
  });

  it("total sign qty is positive", () => {
    expect(totalSignQty(output)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: extractRoomsFromWords → expandSynonyms → classifyRoom → applyRules
// ---------------------------------------------------------------------------

describe("Pipeline integration — end-to-end word extraction through sign output", () => {
  it("abbreviated room names in raw words produce correct sign types after full pipeline", () => {
    // Use different y-positions (100px apart) so word proximity (dy < 30) is not cross-contaminated
    const rawWords: SidecarWord[] = [
      { text: "101", x0: 100, y0: 100, x1: 150, y1: 112, page: 1 },
      { text: "MRR", x0: 160, y0: 100, x1: 200, y1: 112, page: 1 },
      { text: "102", x0: 100, y0: 200, x1: 150, y1: 212, page: 1 },
      { text: "MECH", x0: 160, y0: 200, x1: 220, y1: 212, page: 1 },
      { text: "103", x0: 100, y0: 300, x1: 150, y1: 312, page: 1 },
      { text: "OFFICE", x0: 160, y0: 300, x1: 240, y1: 312, page: 1 },
      { text: "104", x0: 100, y0: 400, x1: 150, y1: 412, page: 1 },
      { text: "VEST", x0: 160, y0: 400, x1: 220, y1: 412, page: 1 },
    ];

    const extracted = extractRoomsFromWords(rawWords, 1000, 800);
    expect(extracted).toHaveLength(4);

    const roomRecords: RoomRecord[] = extracted.map((r) => {
      const cls = classifyRoom(r.roomName);
      return {
        id: nextPipelineId(),
        roomNumber: r.roomNumber,
        roomName: r.roomName,
        level: "1",
        occupantLoad: null,
        occupancyGroup: null,
        isResidentialUnit: cls.isResidentialUnit ?? false,
        isRestroom: cls.isRestroom ?? false,
        isStair: cls.isStair ?? false,
        isElevator: cls.isElevator ?? false,
        isVestibule: cls.isVestibule ?? false,
        isCorridorOrHall: cls.isCorridorOrHall ?? false,
        isVehicleBay: cls.isVehicleBay ?? false,
        isMepUnoccupied: cls.isMepUnoccupied ?? false,
        isVariableUse: cls.isVariableUse ?? false,
        isPublicFacing: cls.isPublicFacing ?? false,
        isAssembly: cls.isAssembly ?? false,
        sheetId: null,
      };
    });

    const output = applyRules({ rooms: roomRecords, buildingType: "commercial" });

    const restroomSigns = output.results
      .filter((r) => r.room.isRestroom)
      .flatMap((r) => r.signs)
      .filter((s) => ["Restroom", "Restroom(Men)", "Restroom(Women)"].includes(s.signType));
    expect(restroomSigns.length).toBeGreaterThanOrEqual(1);

    const officeResult = output.results.find((r) => r.room.roomNumber === "103");
    expect(officeResult?.signs.some((s) => s.signType === "Room ID")).toBe(true);

    const vestResult = output.results.find((r) => r.room.roomNumber === "104");
    expect(vestResult?.signs.some((s) => s.signType === "Exit")).toBe(true);

    const mechResult = output.results.find((r) => r.room.roomNumber === "102");
    expect(mechResult?.signs.filter((s) => s.signType === "Room ID")).toHaveLength(0);
  });

  it("multi-level floor plan produces the correct number of stair signs and evac maps", () => {
    const rawRooms = [
      { roomNumber: "100", roomName: "Lobby", level: "1" },
      { roomNumber: "101", roomName: "Office", level: "1" },
      { roomNumber: "201", roomName: "Office", level: "2" },
      { roomNumber: "301", roomName: "Office", level: "3" },
      { roomNumber: "S1", roomName: "Stair 1", level: "1" },
      { roomNumber: "S1", roomName: "Stair 1", level: "2" },
      { roomNumber: "S1", roomName: "Stair 1", level: "3" },
      { roomNumber: "S2", roomName: "Stair 2", level: "1" },
      { roomNumber: "S2", roomName: "Stair 2", level: "2" },
      { roomNumber: "S2", roomName: "Stair 2", level: "3" },
    ];

    const rooms = buildRoomRecords(rawRooms);
    const output = applyRules({ rooms, buildingType: "commercial" });

    // Fix 1: 2 unique stair cores × both sign types, qty=floorCount (3) each.
    // Each stair produces 1 Stair(Corridor) row (qty=3) + 1 Stair(Landing) row (qty=3).
    const corridorSigns = output.stairSigns.filter((s) => s.signType === "Stair(Corridor)");
    const landingSigns = output.stairSigns.filter((s) => s.signType === "Stair(Landing)");
    expect(corridorSigns.length).toBe(2); // 1 row per stair core
    const totalLandingQty = landingSigns.reduce((sum, s) => sum + s.qty, 0);
    expect(totalLandingQty).toBe(6); // 2 stair cores × 3 floors each

    // The public lobby should produce an evac map
    expect(output.evacMapSigns.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// AI vision synonym expansion integration
// ---------------------------------------------------------------------------

describe("AI vision path — expandSynonyms applied before classification", () => {
  it("CONF abbreviation expands to CONFERENCE and is classified as assembly/variable-use", () => {
    const rooms = buildRoomRecords([{ roomNumber: "101", roomName: "CONF" }]);
    expect(rooms).toHaveLength(1);
    const room = rooms[0];
    expect(room.roomName).toBe("CONFERENCE");
    expect(room.isAssembly || room.isVariableUse).toBe(true);
  });

  it("STOR abbreviation expands to STORAGE and is treated as a regular room", () => {
    const rooms = buildRoomRecords([{ roomNumber: "102", roomName: "STOR" }]);
    const room = rooms[0];
    expect(room.roomName).toBe("STORAGE");
    expect(room.isRestroom).toBe(false);
    expect(room.isAssembly).toBe(false);
  });

  it("MECH abbreviation expands to MECHANICAL and is classified as MEP/unoccupied", () => {
    const rooms = buildRoomRecords([{ roomNumber: "103", roomName: "MECH" }]);
    const room = rooms[0];
    expect(room.roomName).toBe("MECHANICAL");
    expect(room.isMepUnoccupied).toBe(true);
  });
});

// ===========================================================================
// shouldRunVisionScan — sheet classifier
// ===========================================================================

// ---------------------------------------------------------------------------
// Hard-excluded sheet IDs
// ---------------------------------------------------------------------------

describe("shouldRunVisionScan — hard-excluded sheet IDs", () => {
  const HARD_BLOCK_CASES = [
    "A-001", "A001",
    "A-002", "A002",
    "A-003", "A003",
  ];

  for (const id of HARD_BLOCK_CASES) {
    it(`blocks sheet ID "${id}" (any title)`, () => {
      expect(shouldRunVisionScan(id, "Cover Sheet")).toBe(false);
    });

    it(`blocks sheet ID "${id}" with null title`, () => {
      expect(shouldRunVisionScan(id, null)).toBe(false);
    });

    it(`blocks lowercase form of "${id}"`, () => {
      expect(shouldRunVisionScan(id.toLowerCase(), null)).toBe(false);
    });

    it(`blocks "${id}" with leading/trailing whitespace`, () => {
      expect(shouldRunVisionScan(`  ${id}  `, null)).toBe(false);
    });
  }

  it("does NOT block A-004 (outside hard-block list)", () => {
    expect(shouldRunVisionScan("A-004", "Floor Plan")).toBe(true);
  });

  it("does NOT block A-100 (valid architectural floor-plan sheet)", () => {
    expect(shouldRunVisionScan("A-100", "Floor Plan Level 1")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Hard-excluded discipline prefixes
// ---------------------------------------------------------------------------

describe("shouldRunVisionScan — discipline prefix exclusions", () => {
  const PREFIX_CASES: Array<[string, string]> = [
    ["S-101", "Structural Framing Plan"],
    ["S-001", "Foundation Plan"],
    ["M-101", "Mechanical Floor Plan"],
    ["M-501", "HVAC Plan"],
    ["E-101", "Electrical Floor Plan"],
    ["E-201", "Power Plan"],
    ["P-101", "Plumbing Plan"],
    ["P-201", "Plumbing Fixture Schedule"],
    ["C-101", "Civil Grading Plan"],
    ["C-001", "Site Plan"],
    ["FP-101", "Fire Protection Plan"],
    ["FP-201", "Sprinkler Plan"],
  ];

  for (const [id, title] of PREFIX_CASES) {
    it(`blocks "${id}" — "${title}"`, () => {
      expect(shouldRunVisionScan(id, title)).toBe(false);
    });
  }

  it("does NOT block A-101 (architectural prefix, not excluded)", () => {
    expect(shouldRunVisionScan("A-101", "Floor Plan")).toBe(true);
  });

  it("does NOT block L-101 (landscape prefix, not in exclusion list)", () => {
    expect(shouldRunVisionScan("L-101", "Landscape Plan")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Hard-excluded title keywords
// ---------------------------------------------------------------------------

describe("shouldRunVisionScan — title keyword exclusions (ALWAYS_EXCLUDE)", () => {
  const TITLE_CASES: Array<[string, string]> = [
    ["A-101", "North Elevation"],
    ["A-102", "Building Section A"],
    ["A-103", "Egress Plan"],
    ["A-104", "Accessory Legend"],
    ["A-105", "Light Fixture Schedule"],
    ["A-107", "Bathroom Finish Schedule"],
    ["A-108", "Drawing Index"],
    ["A-109", "Symbol Legend"],
    ["A-110", "Abbreviations List"],
    ["A-111", "Specifications Section 1"],
    ["A-112", "Code Analysis Summary"],
    ["A-113", "Life Safety Notes"],
    ["A-114", "Plumbing Fixture Schedule"],
    // Conditional (EXCLUDE_UNLESS_PLAN) — blocked because no "PLAN" in title
    ["A-118", "General Notes"],
    ["A-119", "Door Schedule"],
    ["A-120", "Window Schedule"],
  ];

  for (const [id, title] of TITLE_CASES) {
    it(`blocks "${id}" with title "${title}"`, () => {
      expect(shouldRunVisionScan(id, title)).toBe(false);
    });

    it(`blocks "${id}" when title keyword is lowercase ("${title.toLowerCase()}")`, () => {
      expect(shouldRunVisionScan(id, title.toLowerCase())).toBe(false);
    });
  }

  it("does NOT block 'Floor Plan Level 1' (no excluded keyword)", () => {
    expect(shouldRunVisionScan("A-201", "Floor Plan Level 1")).toBe(true);
  });

  it("blocks 'Furniture Plan' (FURNITURE PLAN added to ALWAYS_EXCLUDE)", () => {
    expect(shouldRunVisionScan("A-202", "Furniture Plan")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FINISH SCHEDULE sheets: no longer blocked by shouldRunVisionScan.
// classifySheetStep2 routes them to room_schedule instead.
// ---------------------------------------------------------------------------

describe("shouldRunVisionScan — FINISH SCHEDULE no longer pre-blocked", () => {
  it("passes 'Finish Schedule' — now handled by room_schedule classifier, not pre-blocked", () => {
    expect(shouldRunVisionScan("A-130", "Finish Schedule")).toBe(true);
  });

  it("passes 'Interior Finish Schedule' — routes to room_schedule in classifier", () => {
    expect(shouldRunVisionScan("A-131", "Interior Finish Schedule")).toBe(true);
  });

  it("allows 'For Finish Schedule Plan' (PLAN present)", () => {
    expect(shouldRunVisionScan("A-132", "For Finish Schedule Plan")).toBe(true);
  });

  it("allows 'Finish Schedule Floor Plan' (PLAN present)", () => {
    expect(shouldRunVisionScan("A-133", "Finish Schedule Floor Plan")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Passing sheets (shouldRunVisionScan returns true)
// ---------------------------------------------------------------------------

describe("shouldRunVisionScan — sheets that should pass", () => {
  const PASS_CASES: Array<[string, string | null]> = [
    ["A-100", "Floor Plan Level 1"],
    ["A-101", "First Floor Plan"],
    // "Furniture Plan" → now hard-excluded (FURNITURE PLAN keyword added)
    // "Power, Communication & Lamp Lighting Plan" → now hard-excluded (LIGHTING PLAN keyword)
    ["A-401", null],
    ["A1-100", "Floor Plan"],
    ["A-004", "General Floor Plan"],
  ];

  for (const [id, title] of PASS_CASES) {
    it(`passes "${id}" — ${title === null ? "null title" : `"${title}"`}`, () => {
      expect(shouldRunVisionScan(id, title)).toBe(true);
    });
  }
});

// ===========================================================================
// getExclusionReason — human-readable reason string
// ===========================================================================

describe("getExclusionReason — hard-excluded sheet IDs", () => {
  const HARD_BLOCK_IDS = ["A-001", "A001", "A-002", "A002", "A-003", "A003"];

  for (const id of HARD_BLOCK_IDS) {
    it(`returns an administrative-sheet reason for "${id}"`, () => {
      const reason = getExclusionReason(id, null);
      expect(reason).not.toBeNull();
      expect(reason).toMatch(/administrative sheet id/i);
    });
  }
});

describe("getExclusionReason — discipline prefix exclusions", () => {
  it("returns a prefix reason for S-101 (structural)", () => {
    const reason = getExclusionReason("S-101", "Structural Framing");
    expect(reason).toMatch(/non-architectural discipline prefix/i);
    expect(reason).toContain("S-");
  });

  it("returns a prefix reason for E-201 (electrical)", () => {
    const reason = getExclusionReason("E-201", "Electrical Plan");
    expect(reason).toMatch(/non-architectural discipline prefix/i);
    expect(reason).toContain("E-");
  });

  it("returns a prefix reason for FP-101 (fire protection)", () => {
    const reason = getExclusionReason("FP-101", "Sprinkler Plan");
    expect(reason).toMatch(/non-architectural discipline prefix/i);
    expect(reason).toContain("FP-");
  });
});

describe("getExclusionReason — title keyword exclusions", () => {
  it("returns a hard-exclude keyword reason for ELEVATION", () => {
    const reason = getExclusionReason("A-101", "North Elevation");
    expect(reason).toMatch(/hard-exclude keyword/i);
    expect(reason).toContain("ELEVATION");
  });

  it("returns a hard-exclude reason for 'Reflected Ceiling Plan' (REFLECTED CEILING keyword)", () => {
    // REFLECTED CEILING is in ALWAYS_EXCLUDE_TITLE — always blocked before vision scan.
    const reason = getExclusionReason("A-115", "Reflected Ceiling Plan");
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/REFLECTED CEILING/i);
  });

  it("returns null for 'Roof Plan Level 3' (not hard-excluded, model decides)", () => {
    // ROOF PLAN was removed from ALWAYS_EXCLUDE — the vision model decides.
    const reason = getExclusionReason("A-116", "Roof Plan Level 3");
    expect(reason).toBeNull();
  });

  it("returns a conditional-exclude reason for 'Door Schedule' (EXCLUDE_UNLESS_PLAN)", () => {
    const reason = getExclusionReason("A-119", "Door Schedule");
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/DOOR SCHEDULE/i);
    expect(reason).toMatch(/without.*PLAN/i);
  });

  it("returns a hard-exclude keyword reason for DRAWING INDEX", () => {
    const reason = getExclusionReason("A-108", "Drawing Index");
    expect(reason).toMatch(/hard-exclude keyword/i);
    expect(reason).toContain("DRAWING INDEX");
  });
});

describe("getExclusionReason — FINISH SCHEDULE no longer conditionally excluded", () => {
  it("returns null for 'Finish Schedule' — FINISH SCHEDULE removed from EXCLUDE_UNLESS_PLAN (now room_schedule)", () => {
    const reason = getExclusionReason("A-130", "Finish Schedule");
    expect(reason).toBeNull();
  });

  it("returns null for 'Finish Schedule Floor Plan' (PLAN present)", () => {
    expect(getExclusionReason("A-131", "Finish Schedule Floor Plan")).toBeNull();
  });
});

describe("getExclusionReason — passing sheets return null", () => {
  it("returns null for a standard floor plan sheet", () => {
    expect(getExclusionReason("A-100", "Floor Plan Level 1")).toBeNull();
  });

  it("returns a hard-exclude reason for a furniture plan sheet (FURNITURE PLAN keyword)", () => {
    const reason = getExclusionReason("A-200", "Furniture Plan");
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/FURNITURE PLAN/i);
  });

  it("returns null for a sheet with null title", () => {
    expect(getExclusionReason("A-401", null)).toBeNull();
  });

  it("returns null for A-004 (outside hard-block list)", () => {
    expect(getExclusionReason("A-004", "Floor Plan")).toBeNull();
  });
});

describe("getExclusionReason — consistency with shouldRunVisionScan", () => {
  const TEST_CASES: Array<[string, string | null]> = [
    ["A-001", null],
    ["A001", "Cover Sheet"],
    ["A-002", "Index"],
    ["A003", null],
    ["S-101", "Structural Plan"],
    ["M-201", "HVAC Plan"],
    ["E-101", "Electrical Plan"],
    ["P-101", "Plumbing Plan"],
    ["C-101", "Civil Plan"],
    ["FP-101", "Fire Protection"],
    ["A-101", "North Elevation"],
    ["A-102", "Building Section"],
    ["A-103", "Egress Plan"],
    ["A-115", "Reflected Ceiling Plan"],
    ["A-116", "Roof Plan"],
    ["A-130", "Finish Schedule"],
    ["A-100", "Floor Plan Level 1"],
    ["A-200", "Furniture Plan"],
    ["A-401", null],
    ["A-004", "General Floor Plan"],
    ["A-132", "Finish Schedule Floor Plan"],
  ];

  for (const [id, title] of TEST_CASES) {
    it(`shouldRunVisionScan and getExclusionReason agree on "${id}" / ${title === null ? "null" : `"${title}"`}`, () => {
      const passes = shouldRunVisionScan(id, title);
      const reason = getExclusionReason(id, title);
      if (passes) {
        expect(reason).toBeNull();
      } else {
        expect(reason).not.toBeNull();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// isJunkRoomName — FIX 2: Schedule row pattern filter
// ---------------------------------------------------------------------------

describe("isJunkRoomName — FIX 2: schedule/table row patterns", () => {
  it("rejects schedule header rows that are never real room names", () => {
    const junkNames = [
      "Occupant Load",
      "Occupant Load Table",
      "Load Table",
      "Fixture Table",
      "Door Schedule",
      "Finish Schedule",
      "Plumbing Schedule",
      "Hardware Set",
      "Keynote 1",
      "Keynote Legend",
      "General Note",
      "General Notes",
      "Note: See Sheet A2",
      "Legend",
      "Abbreviations",
      "Abbreviation List",
      "Symbol",
      "Symbol Legend",
    ];
    for (const name of junkNames) {
      expect(isJunkRoomName(name), `"${name}" should be junk`).toBe(true);
    }
  });

  it("does NOT reject real room names that contain schedule-adjacent words", () => {
    // "LOAD" alone in a room name is fine (e.g. loading dock context)
    // These should all pass through as valid room names
    const validNames = [
      "Break Room",
      "Loading Area",
      "Conference Room",
      "Lobby",
      "Office 101",
      "Storage",
      "Men's Restroom",
      "Suite 200",
    ];
    for (const name of validNames) {
      expect(isJunkRoomName(name), `"${name}" should NOT be junk`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// shouldApplyRoomNumberAllowlist — data-driven allowlist guard
// ---------------------------------------------------------------------------

describe("shouldApplyRoomNumberAllowlist", () => {
  it("applies the education allowlist when W/E-wing numbering dominates", () => {
    const rooms = [
      { roomNumber: "W101" }, { roomNumber: "W102" }, { roomNumber: "E201" },
      { roomNumber: "E202" }, { roomNumber: "WC100" }, { roomNumber: "SA01" },
    ];
    expect(shouldApplyRoomNumberAllowlist(rooms, "education")).toBe(true);
  });

  it("skips the education allowlist for a dorm with plain-numeric room numbers", () => {
    // The bug: a dormitory mislabeled 'education' uses 101/201/305 numbering, none
    // of which match the W/E allowlist — applying it would delete every room.
    const rooms = [
      { roomNumber: "101" }, { roomNumber: "201" }, { roomNumber: "305" },
      { roomNumber: "309" }, { roomNumber: "405" }, { roomNumber: "501" },
    ];
    expect(shouldApplyRoomNumberAllowlist(rooms, "education")).toBe(false);
  });

  it("skips when fewer than 5 numbered rooms (insufficient evidence)", () => {
    const rooms = [{ roomNumber: "W101" }, { roomNumber: "W102" }, { roomNumber: "E201" }];
    expect(shouldApplyRoomNumberAllowlist(rooms, "education")).toBe(false);
  });

  it("ignores empty room numbers and schedule-sourced rooms when judging the scheme", () => {
    const rooms = [
      { roomNumber: "W101" }, { roomNumber: "W102" }, { roomNumber: "E201" },
      { roomNumber: "E202" }, { roomNumber: "W203" },
      { roomNumber: "" }, { roomNumber: "" },                 // named-only rooms — ignored
      { roomNumber: "999", coordSource: "schedule" },         // authoritative — ignored
    ];
    expect(shouldApplyRoomNumberAllowlist(rooms, "education")).toBe(true);
  });

  it("returns false for building types with no configured allowlist", () => {
    const rooms = Array.from({ length: 10 }, (_, i) => ({ roomNumber: `${100 + i}` }));
    expect(shouldApplyRoomNumberAllowlist(rooms, "commercial")).toBe(false);
    expect(shouldApplyRoomNumberAllowlist(rooms, null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// unitNamesDominant — UNIT/APT dominance guard
// ---------------------------------------------------------------------------

describe("unitNamesDominant", () => {
  it("is true when ≥5 UNIT/APT rooms make up ≥30% of the set (real dwelling units)", () => {
    const rooms = [
      ...Array.from({ length: 6 }, (_, i) => ({ roomName: `Unit 30${i}` })),
      { roomName: "Study" }, { roomName: "Electrical" },
    ];
    expect(unitNamesDominant(rooms)).toBe(true);
  });

  it("is false when UNIT rooms are a small minority", () => {
    const rooms = [
      { roomName: "Unit 101" }, { roomName: "Unit 102" },
      ...Array.from({ length: 20 }, (_, i) => ({ roomName: `Office ${i}` })),
    ];
    expect(unitNamesDominant(rooms)).toBe(false);
  });

  it("is false with fewer than 5 UNIT rooms even at 100% share (stray gate codes)", () => {
    const rooms = [{ roomName: "Unit 101" }, { roomName: "Apt 2B" }];
    expect(unitNamesDominant(rooms)).toBe(false);
  });
});
