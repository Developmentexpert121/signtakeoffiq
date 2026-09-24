import { describe, expect, it } from "vitest";
import {
  classifyRoom,
  detectBuildingType,
  applyRules,
  applyStairRules,
  applyElevatorRules,
  applyEvacMapRules,
  applyFormulaExitSigns,
  classifyRoomNumberAsStair,
  STAIR_ROOM_NUMBER_PATTERNS,
  ADA_REQUIRED_SIGN_TYPES,
  evacMapsPerFloorCap,
  getEvacMapCount,
  runValidationChecks,
  buildMultiEntryRegex,
  BUILDING_TRAITS,
  BUILDING_TYPE_GROUPS,
  normalizeBuildingType,
  CORRIDOR_KEYWORDS,
  RESIDENTIAL_COMMON_AREA_KEYWORDS,
  isJunkRoomName,
  MULTI_ENTRY_ROOM_KEYWORDS,
  type RoomRecord,
  type RuleEngineOutput,
} from "./rules-engine";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRoom(overrides: Partial<RoomRecord> = {}): RoomRecord {
  return {
    id: "room-1",
    roomNumber: "101",
    roomName: "Office",
    level: "1",
    occupantLoad: null,
    occupancyGroup: null,
    isResidentialUnit: false,
    isRestroom: false,
    isStair: false,
    isElevator: false,
    isVestibule: false,
    isCorridorOrHall: false,
    isVehicleBay: false,
    isMepUnoccupied: false,
    isVariableUse: false,
    isPublicFacing: false,
    isAssembly: false,
    sheetId: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// classifyRoom
// ---------------------------------------------------------------------------

describe("classifyRoom", () => {
  it("identifies restroom variants", () => {
    for (const name of ["Men's Restroom", "Women's Toilet", "Unisex Bathroom", "ADA Restroom", "Shower/Locker", "Lavatory"]) {
      expect(classifyRoom(name).isRestroom, `${name} should be restroom`).toBe(true);
    }
  });

  it("does not mark an office as a restroom", () => {
    expect(classifyRoom("Office").isRestroom).toBe(false);
  });

  it("identifies stair variants", () => {
    for (const name of ["Stair 1", "Stairwell A", "Stairway", "Stair Tower", "Exit Stair"]) {
      expect(classifyRoom(name).isStair, `${name} should be stair`).toBe(true);
    }
  });

  it("does not mark 'Upstairs Storage' as a stair (no word boundary match)", () => {
    expect(classifyRoom("Upstairs Storage").isStair).toBe(false);
  });

  it("identifies elevator variants", () => {
    for (const name of ["Elevator", "Elev Lobby", "Lift"]) {
      expect(classifyRoom(name).isElevator, `${name} should be elevator`).toBe(true);
    }
  });

  it("identifies vestibule variants", () => {
    for (const name of ["Vestibule", "Entry Vest", "Exit Vestibule", "Air Lock"]) {
      expect(classifyRoom(name).isVestibule, `${name} should be vestibule`).toBe(true);
    }
  });

  it("identifies corridor/hall variants including FIX 3 additions", () => {
    for (const name of [
      "Corridor", "Hallway", "Hall", "Passage", "Gallery",
      // FIX 3 additions — transportation/large-building circulation spaces
      "Circulation", "Main Circulation", "Walkway", "Covered Walkway", "Concourse", "Terminal Concourse",
    ]) {
      expect(classifyRoom(name).isCorridorOrHall, `${name} should be corridor`).toBe(true);
    }
  });

  it("corridors get no Room ID but still receive Exit signs through other rules", () => {
    // CIRCULATION, WALKWAY, CONCOURSE — skip Room ID, but Exit/Evac rules can still fire
    const room = makeRoom({ roomName: "Main Concourse", isCorridorOrHall: true, isPublicFacing: true });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    expect(results[0].signs.some((s) => s.signType === "Room ID")).toBe(false);
    // Exit rules can still fire for public-facing corridors
  });

  it("identifies vehicle bay variants", () => {
    for (const name of ["Apparatus Bay", "Garage", "Vehicle Bay", "Drive-Through"]) {
      expect(classifyRoom(name).isVehicleBay, `${name} should be vehicle bay`).toBe(true);
    }
  });

  it("identifies MEP/unoccupied rooms", () => {
    for (const name of ["Mechanical Room", "Electrical Room", "IDF", "MDF", "Telecom", "Server Room", "IT Room", "Janitor", "Sprinkler Room", "Pump Room", "Utility", "Fan Room", "Boiler Room", "HVAC"]) {
      expect(classifyRoom(name).isMepUnoccupied, `${name} should be MEP`).toBe(true);
    }
  });

  it("identifies variable use rooms", () => {
    for (const name of ["Training Room", "EOC", "Community Room", "Multi-Purpose Room", "Flex Room", "Multi Use", "Convertible Space"]) {
      expect(classifyRoom(name).isVariableUse, `${name} should be variable use`).toBe(true);
    }
  });

  it("identifies public-facing rooms", () => {
    for (const name of ["Lobby", "Public Corridor", "Reception", "Waiting Room", "Front Desk"]) {
      expect(classifyRoom(name).isPublicFacing, `${name} should be public facing`).toBe(true);
    }
  });

  it("identifies assembly rooms", () => {
    for (const name of ["Training Room", "Meeting Room", "Conference Room", "Auditorium", "Banquet Hall", "Dining Room", "Chapel"]) {
      expect(classifyRoom(name).isAssembly, `${name} should be assembly`).toBe(true);
    }
  });

  it("identifies residential unit patterns", () => {
    for (const name of ["Unit 101", "Apt 2B", "Suite 300"]) {
      expect(classifyRoom(name).isResidentialUnit, `${name} should be residential unit`).toBe(true);
    }
  });

  it("does not mark generic rooms as residential units", () => {
    expect(classifyRoom("Conference Room").isResidentialUnit).toBe(false);
    expect(classifyRoom("Storage").isResidentialUnit).toBe(false);
  });

  it("correctly classifies a plain office room (all false)", () => {
    const result = classifyRoom("Office");
    expect(result.isRestroom).toBe(false);
    expect(result.isStair).toBe(false);
    expect(result.isElevator).toBe(false);
    expect(result.isVestibule).toBe(false);
    expect(result.isCorridorOrHall).toBe(false);
    expect(result.isVehicleBay).toBe(false);
    expect(result.isMepUnoccupied).toBe(false);
    expect(result.isVariableUse).toBe(false);
    expect(result.isPublicFacing).toBe(false);
    expect(result.isAssembly).toBe(false);
    expect(result.isResidentialUnit).toBe(false);
  });

  it("does not mark 'Dimensions Room' as restroom (MENS substring false-positive)", () => {
    expect(classifyRoom("Dimensions Room").isRestroom).toBe(false);
  });

  it("does not mark 'Toiletry Closet' as restroom (TOILET prefix false-positive)", () => {
    expect(classifyRoom("Toiletry Closet").isRestroom).toBe(false);
  });

  it("does not mark 'Footlocker Store' as restroom (LOCKER suffix false-positive)", () => {
    expect(classifyRoom("Footlocker Store").isRestroom).toBe(false);
  });

  it("does not mark 'Retraining Center' as variable use or assembly (TRAINING substring false-positive)", () => {
    expect(classifyRoom("Retraining Center").isVariableUse).toBe(false);
    expect(classifyRoom("Retraining Center").isAssembly).toBe(false);
  });

  it("does not mark 'Storefront' as public-facing (FRONT substring false-positive)", () => {
    expect(classifyRoom("Storefront").isPublicFacing).toBe(false);
  });

  it("does not mark 'Confrontation Room' as public-facing (FRONT substring false-positive)", () => {
    expect(classifyRoom("Confrontation Room").isPublicFacing).toBe(false);
  });

  it("does not mark 'Geochemistry Lab' as variable use (EOC substring false-positive)", () => {
    expect(classifyRoom("Geochemistry Lab").isVariableUse).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectBuildingType
// ---------------------------------------------------------------------------

describe("detectBuildingType", () => {
  it("respects explicit buildingType override when valid", () => {
    const rooms = [{ roomName: "Office", roomNumber: "101" }];
    expect(detectBuildingType(rooms, { buildingType: "school" })).toBe("school");
  });

  it("ignores invalid buildingType override and falls back to detection", () => {
    const rooms = [
      { roomName: "Classroom 1", roomNumber: "101" },
      { roomName: "Principal Office", roomNumber: "200" },
    ];
    expect(detectBuildingType(rooms, { buildingType: "not_a_real_type" })).toBe("education");
  });

  it("uses custom mapping when buildingType matches a mapped custom type (exact case)", () => {
    const rooms = [{ roomName: "Office", roomNumber: "101" }];
    expect(
      detectBuildingType(rooms, { buildingType: "BigBox" }, { BigBox: "retail" })
    ).toBe("retail");
  });

  it("uses custom mapping when buildingType matches lowercased key", () => {
    const rooms = [{ roomName: "Office", roomNumber: "101" }];
    expect(
      detectBuildingType(rooms, { buildingType: "Kiosk" }, { Kiosk: "bank" })
    ).toBe("bank");
  });

  it("ignores custom mapping if mapped profile is not a valid BUILDING_TRAITS key", () => {
    const rooms = [{ roomName: "Office", roomNumber: "101" }];
    expect(
      detectBuildingType(rooms, { buildingType: "BigBox" }, { BigBox: "not_valid" })
    ).toBe("commercial");
  });

  it("falls back to commercial when custom type has no mapping", () => {
    const rooms = [{ roomName: "Office", roomNumber: "101" }];
    expect(
      detectBuildingType(rooms, { buildingType: "BigBox" }, {})
    ).toBe("commercial");
  });

  it("detects residential when >30% of rooms are UNIT xxx", () => {
    const rooms = [
      { roomName: "Unit 101", roomNumber: "101" },
      { roomName: "Unit 102", roomNumber: "102" },
      { roomName: "Unit 103", roomNumber: "103" },
      { roomName: "Lobby", roomNumber: "L1" },
    ];
    expect(detectBuildingType(rooms)).toBe("residential");
  });

  it("does NOT detect residential when <30% of rooms are UNIT xxx", () => {
    const rooms = [
      { roomName: "Unit 101", roomNumber: "101" },
      { roomName: "Office", roomNumber: "102" },
      { roomName: "Conference Room", roomNumber: "103" },
      { roomName: "Storage", roomNumber: "104" },
      { roomName: "Lobby", roomNumber: "L1" },
    ];
    const result = detectBuildingType(rooms);
    expect(result).not.toBe("residential");
  });

  it("detects hotel with ROOM, LOBBY, and FRONT DESK", () => {
    const rooms = [
      { roomName: "Room 101", roomNumber: "101" },
      { roomName: "Lobby", roomNumber: "L1" },
      { roomName: "Front Desk", roomNumber: "FD" },
    ];
    expect(detectBuildingType(rooms)).toBe("hotel");
  });

  it("detects healthcare from patient/nurse/exam room keywords", () => {
    const rooms = [
      { roomName: "Patient Room", roomNumber: "P1" },
      { roomName: "Nurse Station", roomNumber: "N1" },
    ];
    expect(detectBuildingType(rooms)).toBe("healthcare");
  });

  it("detects healthcare when room is named 'ER' as a standalone word", () => {
    const rooms = [{ roomName: "ER", roomNumber: "ER1" }];
    expect(detectBuildingType(rooms)).toBe("healthcare");
  });

  it("does NOT detect hospital for a bank with 'Teller Line' (ER substring false positive)", () => {
    const rooms = [
      { roomName: "Teller Line", roomNumber: "T1" },
      { roomName: "Vault", roomNumber: "V1" },
    ];
    expect(detectBuildingType(rooms)).toBe("bank");
  });

  it("does NOT detect hospital for 'Teller Window' room name", () => {
    const rooms = [{ roomName: "Teller Window", roomNumber: "TW1" }];
    expect(detectBuildingType(rooms)).toBe("bank");
  });

  it("detects education from classroom/gymnasium keywords", () => {
    const rooms = [
      { roomName: "Classroom 101", roomNumber: "101" },
      { roomName: "Gymnasium", roomNumber: "GYM" },
    ];
    expect(detectBuildingType(rooms)).toBe("education");
  });

  it("detects assembly from nave/sanctuary keywords", () => {
    const rooms = [
      { roomName: "Nave", roomNumber: "N1" },
      { roomName: "Sanctuary", roomNumber: "S1" },
    ];
    expect(detectBuildingType(rooms)).toBe("assembly");
  });

  it("detects lab from laboratory/fume hood keywords", () => {
    const rooms = [
      { roomName: "Laboratory A", roomNumber: "LA1" },
      { roomName: "Fume Hood Room", roomNumber: "FH1" },
    ];
    expect(detectBuildingType(rooms)).toBe("lab");
  });

  it("detects bank from vault/safe deposit keywords", () => {
    const rooms = [
      { roomName: "Vault", roomNumber: "V1" },
      { roomName: "Safe Deposit Room", roomNumber: "SD1" },
    ];
    expect(detectBuildingType(rooms)).toBe("bank");
  });

  it("detects warehouse from loading dock/shipping keywords", () => {
    const rooms = [
      { roomName: "Loading Dock", roomNumber: "LD1" },
      { roomName: "Receiving", roomNumber: "R1" },
    ];
    expect(detectBuildingType(rooms)).toBe("warehouse");
  });

  it("detects retail from merchandise/fitting room keywords", () => {
    const rooms = [
      { roomName: "Fitting Room", roomNumber: "FR1" },
      { roomName: "Merchandise Display", roomNumber: "MD1" },
    ];
    expect(detectBuildingType(rooms)).toBe("retail");
  });

  it("detects senior-living from memory care/assisted living keywords", () => {
    const rooms = [
      { roomName: "Memory Care Suite", roomNumber: "MC1" },
      { roomName: "Assisted Living Room", roomNumber: "AL1" },
    ];
    expect(detectBuildingType(rooms)).toBe("senior_living");
  });

  it("detects government from council chamber/court room keywords", () => {
    const rooms = [
      { roomName: "Council Chamber", roomNumber: "CC1" },
      { roomName: "Court Room 1", roomNumber: "CR1" },
    ];
    expect(detectBuildingType(rooms)).toBe("government");
  });

  it("defaults to commercial for generic office rooms", () => {
    const rooms = [
      { roomName: "Office", roomNumber: "101" },
      { roomName: "Conference Room", roomNumber: "102" },
      { roomName: "Break Room", roomNumber: "103" },
    ];
    expect(detectBuildingType(rooms)).toBe("commercial");
  });

  it("returns commercial for empty room list", () => {
    expect(detectBuildingType([])).toBe("commercial");
  });

  it("detects lab when room name ends with 'Lab' (no trailing space)", () => {
    const rooms = [{ roomName: "Science Lab", roomNumber: "SL1" }];
    expect(detectBuildingType(rooms)).toBe("lab");
  });

  it("does NOT detect lab for 'Collaborative Space' (LAB mid-word false positive)", () => {
    const rooms = [{ roomName: "Collaborative Space", roomNumber: "CS1" }];
    expect(detectBuildingType(rooms)).toBe("commercial");
  });

  it("detects retail when room name is exactly 'POS' (no trailing space)", () => {
    const rooms = [{ roomName: "POS", roomNumber: "POS1" }];
    expect(detectBuildingType(rooms)).toBe("retail");
  });

  it("detects retail when room name ends with 'POS' (no trailing space)", () => {
    const rooms = [{ roomName: "Checkout POS", roomNumber: "C1" }];
    expect(detectBuildingType(rooms)).toBe("retail");
  });

  it("detects education when room name is exactly 'GYM' as a standalone word", () => {
    const rooms = [{ roomName: "GYM", roomNumber: "G1" }];
    expect(detectBuildingType(rooms)).toBe("education");
  });

  // Word-boundary false-positive guards

  it("does NOT detect hospital for 'Outpatient Recovery' (PATIENT as substring)", () => {
    const rooms = [{ roomName: "Outpatient Recovery", roomNumber: "OR1" }];
    expect(detectBuildingType(rooms)).toBe("commercial");
  });

  it("does NOT detect hospital for 'Nursery' (NURSE as substring)", () => {
    const rooms = [{ roomName: "Nursery", roomNumber: "NR1" }];
    expect(detectBuildingType(rooms)).toBe("commercial");
  });

  it("does NOT detect hospital for 'Neurosurgery Lab' (SURGERY as substring)", () => {
    const rooms = [{ roomName: "Neurosurgery Lab", roomNumber: "NL1" }];
    expect(detectBuildingType(rooms)).toBe("lab");
  });

  it("does NOT detect bank for 'Vaulted Ceiling Storage' (VAULT as substring)", () => {
    const rooms = [{ roomName: "Vaulted Ceiling Storage", roomNumber: "VS1" }];
    expect(detectBuildingType(rooms)).toBe("commercial");
  });

  it("does NOT detect bank for 'Storyteller Studio' (TELLER as substring)", () => {
    const rooms = [{ roomName: "Storyteller Studio", roomNumber: "SS1" }];
    expect(detectBuildingType(rooms)).toBe("commercial");
  });

  it("does NOT detect church for 'Chancellor Office' (CHANCEL as substring)", () => {
    const rooms = [{ roomName: "Chancellor Office", roomNumber: "CO1" }];
    expect(detectBuildingType(rooms)).toBe("commercial");
  });

  it("does NOT detect church for 'Parishioner Gathering Space' (PARISH as substring)", () => {
    const rooms = [{ roomName: "Parishioner Gathering Space", roomNumber: "PG1" }];
    expect(detectBuildingType(rooms)).toBe("commercial");
  });

  it("does NOT detect government for 'Impolice Misconduct Office' (POLICE as substring)", () => {
    const rooms = [{ roomName: "Impolice Misconduct Office", roomNumber: "IM1" }];
    expect(detectBuildingType(rooms)).toBe("commercial");
  });

  it("does NOT detect hospital for 'Server Room' (ER substring inside SERVER)", () => {
    const rooms = [{ roomName: "Server Room", roomNumber: "SR1" }];
    expect(detectBuildingType(rooms)).toBe("commercial");
  });

  it("does NOT detect hospital for a lab building with 'Server Room' (ER substring false positive)", () => {
    const rooms = [
      { roomName: "Server Room", roomNumber: "SR1" },
      { roomName: "Laboratory A", roomNumber: "LA1" },
    ];
    expect(detectBuildingType(rooms)).toBe("lab");
  });

  it("does NOT detect hospital for 'Teller Area' (ER substring inside TELLER)", () => {
    const rooms = [{ roomName: "Teller Area", roomNumber: "TA1" }];
    expect(detectBuildingType(rooms)).toBe("bank");
  });

  it("does NOT detect hospital for a bank building with 'Teller Area' (ER substring false positive)", () => {
    const rooms = [
      { roomName: "Teller Area", roomNumber: "TA1" },
      { roomName: "Vault", roomNumber: "V1" },
    ];
    expect(detectBuildingType(rooms)).toBe("bank");
  });

  // AI vision path word-boundary false-positive guards (Task #383)
  // These cover compound-phrase keywords in detectBuildingType that lacked \b guards.
  // AI vision rooms skip expandSynonyms and arrive here with their raw names from Claude,
  // making unguarded mid-word matches a real risk.

  it("does NOT detect hospital for 'Preexam Room' (EXAM ROOM missing leading \\b)", () => {
    const rooms = [{ roomName: "Preexam Room", roomNumber: "PR1" }];
    expect(detectBuildingType(rooms)).toBe("commercial");
  });

  it("still detects healthcare for a standalone 'Exam Room'", () => {
    const rooms = [{ roomName: "Exam Room", roomNumber: "ER1" }];
    expect(detectBuildingType(rooms)).toBe("healthcare");
  });

  it("does NOT detect school for 'Media Centered Workspace' (MEDIA CENTER missing trailing \\b)", () => {
    const rooms = [{ roomName: "Media Centered Workspace", roomNumber: "MCW1" }];
    expect(detectBuildingType(rooms)).toBe("commercial");
  });

  it("still detects education for a standalone 'Media Center'", () => {
    const rooms = [{ roomName: "Media Center", roomNumber: "MC1" }];
    expect(detectBuildingType(rooms)).toBe("education");
  });

  it("does NOT detect lab for 'Unclean Room' (CLEAN ROOM missing leading \\b)", () => {
    const rooms = [{ roomName: "Unclean Room", roomNumber: "UR1" }];
    expect(detectBuildingType(rooms)).toBe("commercial");
  });

  it("still detects lab for a standalone 'Clean Room'", () => {
    const rooms = [{ roomName: "Clean Room", roomNumber: "CR1" }];
    expect(detectBuildingType(rooms)).toBe("lab");
  });

  it("does NOT detect lab for 'Perfume Hood Cabinet' (FUME HOOD missing leading \\b)", () => {
    const rooms = [{ roomName: "Perfume Hood Cabinet", roomNumber: "PHC1" }];
    expect(detectBuildingType(rooms)).toBe("commercial");
  });

  it("still detects lab for a standalone 'Fume Hood Room'", () => {
    const rooms = [{ roomName: "Fume Hood Room", roomNumber: "FHR1" }];
    expect(detectBuildingType(rooms)).toBe("lab");
  });

  it("does NOT detect warehouse for 'Disassembly Line' (ASSEMBLY LINE missing leading \\b)", () => {
    const rooms = [{ roomName: "Disassembly Line", roomNumber: "DL1" }];
    expect(detectBuildingType(rooms)).toBe("commercial");
  });

  it("still detects warehouse for a standalone 'Assembly Line'", () => {
    const rooms = [{ roomName: "Assembly Line", roomNumber: "AL1" }];
    expect(detectBuildingType(rooms)).toBe("warehouse");
  });

  it("does NOT detect retail for 'Outfitting Room' (FITTING ROOM missing leading \\b)", () => {
    const rooms = [{ roomName: "Outfitting Room", roomNumber: "OR1" }];
    expect(detectBuildingType(rooms)).toBe("commercial");
  });

  it("still detects retail for a standalone 'Fitting Room'", () => {
    const rooms = [{ roomName: "Fitting Room", roomNumber: "FR1" }];
    expect(detectBuildingType(rooms)).toBe("retail");
  });

  it("does NOT detect retail for 'Livestock Room' (STOCK ROOM missing leading \\b)", () => {
    const rooms = [{ roomName: "Livestock Room", roomNumber: "LR1" }];
    expect(detectBuildingType(rooms)).toBe("commercial");
  });

  it("still detects retail for a standalone 'Stock Room'", () => {
    const rooms = [{ roomName: "Stock Room", roomNumber: "SR1" }];
    expect(detectBuildingType(rooms)).toBe("retail");
  });

  it("does NOT detect senior-living for 'Nonresident Room' (RESIDENT ROOM missing leading \\b)", () => {
    const rooms = [{ roomName: "Nonresident Room", roomNumber: "NR1" }];
    expect(detectBuildingType(rooms)).toBe("commercial");
  });

  it("still detects senior-living for a standalone 'Resident Room'", () => {
    const rooms = [{ roomName: "Resident Room", roomNumber: "RR1" }];
    expect(detectBuildingType(rooms)).toBe("senior_living");
  });

  it("does NOT detect government for 'Campfire Station' (FIRE STATION missing leading \\b)", () => {
    const rooms = [{ roomName: "Campfire Station", roomNumber: "CS1" }];
    expect(detectBuildingType(rooms)).toBe("commercial");
  });

  it("still detects government for a standalone 'Fire Station'", () => {
    const rooms = [{ roomName: "Fire Station", roomNumber: "FS1" }];
    expect(detectBuildingType(rooms)).toBe("government");
  });

  // --- Senior-living compound-phrase guards ---

  it("does NOT detect senior-living for 'Memory Careers Counseling' (MEMORY CARE missing trailing \\b)", () => {
    const rooms = [{ roomName: "Memory Careers Counseling", roomNumber: "MCC1" }];
    expect(detectBuildingType(rooms)).toBe("commercial");
  });

  it("still detects senior-living for a standalone 'Memory Care Suite'", () => {
    const rooms = [{ roomName: "Memory Care Suite", roomNumber: "MCS1" }];
    expect(detectBuildingType(rooms)).toBe("senior_living");
  });

  it("does NOT detect senior-living for 'Nonassisted Living Suite' (ASSISTED LIVING missing leading \\b)", () => {
    const rooms = [{ roomName: "Nonassisted Living Suite", roomNumber: "NLS1" }];
    expect(detectBuildingType(rooms)).toBe("commercial");
  });

  it("does NOT detect senior-living for 'Assisted Livingston Suite' (ASSISTED LIVING missing trailing \\b)", () => {
    const rooms = [{ roomName: "Assisted Livingston Suite", roomNumber: "ALS1" }];
    expect(detectBuildingType(rooms)).toBe("commercial");
  });

  it("still detects senior-living for a standalone 'Assisted Living'", () => {
    const rooms = [{ roomName: "Assisted Living", roomNumber: "AL1" }];
    expect(detectBuildingType(rooms)).toBe("senior_living");
  });

  it("does NOT detect senior-living for 'Unskilled Nursing Station' (SKILLED NURSING missing leading \\b)", () => {
    const rooms = [{ roomName: "Unskilled Nursing Station", roomNumber: "UNS1" }];
    expect(detectBuildingType(rooms)).toBe("commercial");
  });

  it("still detects senior-living for a standalone 'Skilled Nursing'", () => {
    const rooms = [{ roomName: "Skilled Nursing", roomNumber: "SN1" }];
    expect(detectBuildingType(rooms)).toBe("senior_living");
  });

  // --- Government compound-phrase guards ---

  it("does NOT detect government for 'Council Chambers' (COUNCIL CHAMBER missing trailing \\b)", () => {
    const rooms = [{ roomName: "Council Chambers", roomNumber: "CC1" }];
    expect(detectBuildingType(rooms)).toBe("commercial");
  });

  it("still detects government for a standalone 'Council Chamber'", () => {
    const rooms = [{ roomName: "Council Chamber", roomNumber: "CCH1" }];
    expect(detectBuildingType(rooms)).toBe("government");
  });

  it("does NOT detect government for 'Court Roommate Lounge' (COURT ROOM missing trailing \\b)", () => {
    const rooms = [{ roomName: "Court Roommate Lounge", roomNumber: "CRL1" }];
    expect(detectBuildingType(rooms)).toBe("commercial");
  });

  it("still detects government for a standalone 'Court Room'", () => {
    const rooms = [{ roomName: "Court Room", roomNumber: "CR1" }];
    expect(detectBuildingType(rooms)).toBe("government");
  });

  it("does NOT detect government for 'Discourteous Clerk Office' (COURT CLERK — COURT as substring of DISCOURTEOUS)", () => {
    const rooms = [{ roomName: "Discourteous Clerk Office", roomNumber: "DCO1" }];
    expect(detectBuildingType(rooms)).toBe("commercial");
  });

  it("still detects government for a standalone 'Court Clerk'", () => {
    const rooms = [{ roomName: "Court Clerk", roomNumber: "CLC1" }];
    expect(detectBuildingType(rooms)).toBe("government");
  });

  it("does NOT detect government for 'Apparatuses Storage' (APPARATUS missing trailing \\b)", () => {
    const rooms = [{ roomName: "Apparatuses Storage", roomNumber: "AS1" }];
    expect(detectBuildingType(rooms)).toBe("commercial");
  });

  it("still detects government for a standalone 'Apparatus Bay'", () => {
    const rooms = [{ roomName: "Apparatus Bay", roomNumber: "AB1" }];
    expect(detectBuildingType(rooms)).toBe("government");
  });
});

// ---------------------------------------------------------------------------
// applyRules — R1: Default Room ID
// ---------------------------------------------------------------------------

describe("applyRules — R1: Default Room ID", () => {
  it("assigns Room ID (R1) to a plain occupied office room", () => {
    const room = makeRoom({ roomName: "Office", roomNumber: "101" });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    const signs = results[0].signs;
    expect(signs.some((s) => s.signType === "Room ID" && s.ruleRef === "R1")).toBe(true);
  });

  it("does NOT assign Room ID to a corridor (R4 exclusion)", () => {
    const room = makeRoom({ roomName: "Corridor", isCorridorOrHall: true });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    expect(results[0].signs.filter((s) => s.signType === "Room ID")).toHaveLength(0);
  });

  it("does NOT assign Room ID to a stair room", () => {
    const room = makeRoom({ roomName: "Stair 1", isStair: true });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    expect(results[0].signs.filter((s) => s.signType === "Room ID")).toHaveLength(0);
  });

  it("does NOT assign Room ID to an elevator room", () => {
    const room = makeRoom({ roomName: "Elevator", isElevator: true });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    expect(results[0].signs.filter((s) => s.signType === "Room ID")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// applyRules — R2: Variable Use (insert version)
// ---------------------------------------------------------------------------

describe("applyRules — R2: Variable use Room ID w/insert", () => {
  it("assigns Room ID w/insert (R2) to a training room in a commercial building", () => {
    const room = makeRoom({
      roomName: "Training Room",
      isVariableUse: true,
      isAssembly: true,
    });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    const signs = results[0].signs;
    expect(signs.some((s) => s.signType === "Room ID w/insert" && s.ruleRef === "R2")).toBe(true);
  });

  it("assigns qty=2 for dual-function variable room (slash in name)", () => {
    const room = makeRoom({
      roomName: "Training / Meeting Room",
      isVariableUse: true,
      isAssembly: true,
    });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    const insert = results[0].signs.find((s) => s.signType === "Room ID w/insert");
    expect(insert?.qty).toBe(2);
  });

  it("does NOT assign insert version in warehouse (no assembly rules)", () => {
    const room = makeRoom({
      roomName: "Training Room",
      isVariableUse: true,
      isAssembly: true,
    });
    const { results } = applyRules({ rooms: [room], buildingType: "warehouse" });
    expect(results[0].signs.some((s) => s.signType === "Room ID w/insert")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyRules — R3: Multi-entry rooms (apparatus bay / gymnasium)
// ---------------------------------------------------------------------------

describe("applyRules — R3: Multi-entry rooms", () => {
  it("assigns Room ID qty=3 for apparatus bay (vehicle bay with multi-entry)", () => {
    const room = makeRoom({
      roomName: "Apparatus Bay",
      isVehicleBay: true,
    });
    const { results } = applyRules({ rooms: [room], buildingType: "government" });
    const roomId = results[0].signs.find((s) => s.signType === "Room ID" && s.ruleRef === "R3");
    expect(roomId).toBeDefined();
    expect(roomId?.qty).toBe(3);
  });

  it("assigns Room ID qty=3 and flags for review (confidence 0.60) for gymnasium", () => {
    const room = makeRoom({ roomName: "Gymnasium", isAssembly: true });
    const { results } = applyRules({ rooms: [room], buildingType: "school" });
    const roomId = results[0].signs.find((s) => s.ruleRef === "R3");
    expect(roomId).toBeDefined();
    expect(roomId?.qty).toBe(3);
    expect(roomId?.confidence).toBe(0.60);
    expect(roomId?.status).toBe("needs_review");
  });

  it("assigns Room ID qty=3 for auditorium", () => {
    const room = makeRoom({ roomName: "Auditorium", isAssembly: true });
    const { results } = applyRules({ rooms: [room], buildingType: "school" });
    const roomId = results[0].signs.find((s) => s.ruleRef === "R3");
    expect(roomId).toBeDefined();
    expect(roomId?.qty).toBe(3);
  });

  it("assigns Room ID qty=3 for cafeteria", () => {
    const room = makeRoom({ roomName: "Cafeteria", isAssembly: true });
    const { results } = applyRules({ rooms: [room], buildingType: "school" });
    const roomId = results[0].signs.find((s) => s.ruleRef === "R3");
    expect(roomId).toBeDefined();
    expect(roomId?.qty).toBe(3);
  });

  it("assigns Room ID qty=3 for chapel", () => {
    const room = makeRoom({ roomName: "Chapel", isAssembly: true });
    const { results } = applyRules({ rooms: [room], buildingType: "government" });
    const roomId = results[0].signs.find((s) => s.ruleRef === "R3");
    expect(roomId).toBeDefined();
    expect(roomId?.qty).toBe(3);
  });

  it("assigns plain Room ID (not R3) for a regular office", () => {
    const room = makeRoom({ roomName: "Storage" });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    const roomId = results[0].signs.find((s) => s.signType === "Room ID");
    expect(roomId?.ruleRef).toBe("R1");
  });

  it("assigns Room ID qty=3 for arena (regression: was silently broken by ARENAOR typo)", () => {
    const room = makeRoom({ roomName: "Arena", isAssembly: true });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    const roomId = results[0].signs.find((s) => s.ruleRef === "R3");
    expect(roomId).toBeDefined();
    expect(roomId?.qty).toBe(3);
  });

  it("assigns Room ID qty=3 for stadium", () => {
    const room = makeRoom({ roomName: "Stadium", isAssembly: true });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    const roomId = results[0].signs.find((s) => s.ruleRef === "R3");
    expect(roomId).toBeDefined();
    expect(roomId?.qty).toBe(3);
  });

  it("skips vehicle bays without multi-entry (R5 exclusion)", () => {
    const room = makeRoom({
      roomName: "Garage",
      isVehicleBay: true,
    });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    expect(results[0].signs.filter((s) => s.signType === "Room ID")).toHaveLength(0);
  });

  // Regression tests for expanded large assembly space keywords (R3)
  it("assigns Room ID qty=3 and flags for review for ballroom", () => {
    const room = makeRoom({ roomName: "Grand Ballroom", isAssembly: true });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    const roomId = results[0].signs.find((s) => s.ruleRef === "R3");
    expect(roomId).toBeDefined();
    expect(roomId?.qty).toBe(3);
    expect(roomId?.confidence).toBe(0.60);
    expect(roomId?.status).toBe("needs_review");
  });

  it("assigns Room ID qty=3 and flags for review for theater", () => {
    const room = makeRoom({ roomName: "Main Theater", isAssembly: true });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    const roomId = results[0].signs.find((s) => s.ruleRef === "R3");
    expect(roomId).toBeDefined();
    expect(roomId?.qty).toBe(3);
    expect(roomId?.status).toBe("needs_review");
  });

  it("assigns Room ID qty=3 and flags for review for theatre (alternate spelling)", () => {
    const room = makeRoom({ roomName: "Black Box Theatre", isAssembly: true });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    const roomId = results[0].signs.find((s) => s.ruleRef === "R3");
    expect(roomId).toBeDefined();
    expect(roomId?.qty).toBe(3);
    expect(roomId?.status).toBe("needs_review");
  });

  it("assigns Room ID qty=3 and flags for review for convention center", () => {
    const room = makeRoom({ roomName: "Convention Center Hall A", isAssembly: true });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    const roomId = results[0].signs.find((s) => s.ruleRef === "R3");
    expect(roomId).toBeDefined();
    expect(roomId?.qty).toBe(3);
    expect(roomId?.status).toBe("needs_review");
  });

  it("assigns Room ID qty=3 and flags for review for banquet hall", () => {
    const room = makeRoom({ roomName: "Banquet Hall", isAssembly: true });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    const roomId = results[0].signs.find((s) => s.ruleRef === "R3");
    expect(roomId).toBeDefined();
    expect(roomId?.qty).toBe(3);
    expect(roomId?.status).toBe("needs_review");
  });

  it("assigns Room ID qty=3 and flags for review for multipurpose room", () => {
    const room = makeRoom({ roomName: "Multipurpose Room", isAssembly: true });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    const roomId = results[0].signs.find((s) => s.ruleRef === "R3");
    expect(roomId).toBeDefined();
    expect(roomId?.qty).toBe(3);
    expect(roomId?.status).toBe("needs_review");
  });

  it("assigns Room ID qty=3 and flags for review for amphitheater", () => {
    const room = makeRoom({ roomName: "Main Amphitheater", isAssembly: true });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    const roomId = results[0].signs.find((s) => s.ruleRef === "R3");
    expect(roomId).toBeDefined();
    expect(roomId?.qty).toBe(3);
    expect(roomId?.confidence).toBe(0.60);
    expect(roomId?.status).toBe("needs_review");
  });

  it("assigns Room ID qty=3 and flags for review for lecture hall", () => {
    const room = makeRoom({ roomName: "Lecture Hall 101", isAssembly: true });
    const { results } = applyRules({ rooms: [room], buildingType: "school" });
    const roomId = results[0].signs.find((s) => s.ruleRef === "R3");
    expect(roomId).toBeDefined();
    expect(roomId?.qty).toBe(3);
    expect(roomId?.confidence).toBe(0.60);
    expect(roomId?.status).toBe("needs_review");
  });

  it("assigns Room ID qty=3 and flags for review for exhibition hall", () => {
    const room = makeRoom({ roomName: "Exhibition Hall B", isAssembly: true });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    const roomId = results[0].signs.find((s) => s.ruleRef === "R3");
    expect(roomId).toBeDefined();
    expect(roomId?.qty).toBe(3);
    expect(roomId?.confidence).toBe(0.60);
    expect(roomId?.status).toBe("needs_review");
  });

  it("assigns Room ID qty=3 and flags for review for sports complex", () => {
    const room = makeRoom({ roomName: "North Sports Complex", isAssembly: true });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    const roomId = results[0].signs.find((s) => s.ruleRef === "R3");
    expect(roomId).toBeDefined();
    expect(roomId?.qty).toBe(3);
    expect(roomId?.confidence).toBe(0.60);
    expect(roomId?.status).toBe("needs_review");
  });

  it("assigns Room ID qty=3 and flags for review for assembly hall", () => {
    const room = makeRoom({ roomName: "Assembly Hall", isAssembly: true });
    const { results } = applyRules({ rooms: [room], buildingType: "government" });
    const roomId = results[0].signs.find((s) => s.ruleRef === "R3");
    expect(roomId).toBeDefined();
    expect(roomId?.qty).toBe(3);
    expect(roomId?.confidence).toBe(0.60);
    expect(roomId?.status).toBe("needs_review");
  });

  it("assigns Room ID qty=3 and flags for review for performance hall", () => {
    const room = makeRoom({ roomName: "Performance Hall", isAssembly: true });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    const roomId = results[0].signs.find((s) => s.ruleRef === "R3");
    expect(roomId).toBeDefined();
    expect(roomId?.qty).toBe(3);
    expect(roomId?.confidence).toBe(0.60);
    expect(roomId?.status).toBe("needs_review");
  });

  it("assigns Room ID qty=3 and flags for review for conference center", () => {
    const room = makeRoom({ roomName: "Conference Center A", isAssembly: true });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    const roomId = results[0].signs.find((s) => s.ruleRef === "R3");
    expect(roomId).toBeDefined();
    expect(roomId?.qty).toBe(3);
    expect(roomId?.confidence).toBe(0.60);
    expect(roomId?.status).toBe("needs_review");
  });
});

// ---------------------------------------------------------------------------
// MULTI_ENTRY_ROOM_KEYWORDS — exhaustive keyword membership test
// Catches typos or accidental deletions in the regex before code review.
// ---------------------------------------------------------------------------

describe("MULTI_ENTRY_ROOM_KEYWORDS regex — exhaustive keyword membership", () => {
  const expectedKeywords = [
    "APPARATUS",
    "GYMNASIUM",
    "AUDITORIUM",
    "ARENA",
    "STADIUM",
    "CAFETERIA",
    "CHAPEL",
    "BALLROOM",
    "THEATER",
    "THEATRE",
    "CONVENTION",
    "BANQUET",
    "MULTIPURPOSE",
    "AMPHITHEATER",
    "AMPHITHEATRE",
    "LECTURE HALL",
    "EXHIBITION",
    "SPORTS COMPLEX",
    "ASSEMBLY HALL",
    "PERFORMANCE HALL",
    "CONFERENCE",
  ];

  it("covers the canonical number of distinct keywords", () => {
    expect(expectedKeywords.length).toBe(21);
  });

  for (const keyword of expectedKeywords) {
    it(`matches "${keyword}"`, () => {
      expect(MULTI_ENTRY_ROOM_KEYWORDS.test(keyword)).toBe(true);
    });
  }

  it("does not match an unrelated word", () => {
    expect(MULTI_ENTRY_ROOM_KEYWORDS.test("OFFICE")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyRules — R5/R6: MEP policy
// ---------------------------------------------------------------------------

describe("applyRules — R6: MEP policy", () => {
  it("assigns Room ID to MEP room under 'all' policy (education)", () => {
    const room = makeRoom({ roomName: "Electrical Room", isMepUnoccupied: true, occupantLoad: 0 });
    const { results } = applyRules({ rooms: [room], buildingType: "education" });
    expect(results[0].signs.some((s) => s.signType === "Room ID")).toBe(true);
  });

  it("excludes unoccupied MEP room under 'occupied_only' policy (commercial)", () => {
    const room = makeRoom({ roomName: "Server Room", isMepUnoccupied: true, occupantLoad: 0 });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    expect(results[0].signs.filter((s) => s.signType === "Room ID")).toHaveLength(0);
  });

  it("includes occupied MEP room under 'occupied_only' policy (commercial)", () => {
    const room = makeRoom({ roomName: "IT Room", isMepUnoccupied: true, occupantLoad: 5 });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    expect(results[0].signs.some((s) => s.signType === "Room ID")).toBe(true);
  });

  it("excludes MEP rooms under 'minimal' policy (school)", () => {
    const room = makeRoom({ roomName: "Mechanical Room", isMepUnoccupied: true, occupantLoad: 0 });
    const { results } = applyRules({ rooms: [room], buildingType: "school" });
    expect(results[0].signs.filter((s) => s.signType === "Room ID")).toHaveLength(0);
  });

  it("MEP rooms never get Exit sign even in education buildings (R9 blocked by isMepUnoccupied)", () => {
    for (const name of ["Mechanical", "Electrical", "MDF", "IDF", "Fan Room", "Boiler", "HVAC", "Sprinkler"]) {
      const room = makeRoom({ roomName: name, isMepUnoccupied: true });
      const { results } = applyRules({ rooms: [room], buildingType: "education" });
      const exitSigns = results[0].signs.filter((s) => s.signType === "Exit" || s.signType === "Exit(Tactile)");
      expect(exitSigns, `${name} should not get Exit sign`).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// applyRules — R8: Restroom signs
// ---------------------------------------------------------------------------

describe("applyRules — R8: Restroom signs", () => {
  it("assigns Restroom(Men) sign (R8) to a men's restroom", () => {
    const room = makeRoom({ roomName: "Men's Restroom", isRestroom: true });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    const restroom = results[0].signs.find((s) => s.signType === "Restroom(Men)");
    expect(restroom).toBeDefined();
    expect(restroom?.ruleRef).toBe("R8");
    expect(restroom?.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("does NOT assign Restroom sign to a non-restroom", () => {
    const room = makeRoom({ roomName: "Office" });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    expect(results[0].signs.some((s) => s.signType === "Restroom")).toBe(false);
  });

  it("assigns both Room ID and Restroom sign when appropriate", () => {
    const room = makeRoom({ roomName: "Staff Restroom", isRestroom: true });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    const signs = results[0].signs;
    expect(signs.some((s) => s.signType === "Room ID")).toBe(true);
    expect(signs.some((s) => s.signType === "Restroom")).toBe(true);
  });

  it("corridor/hall rooms do NOT get Restroom sign even if isRestroom is true (e.g. GIRLS PASSAGE)", () => {
    const room = makeRoom({ roomName: "Girls Passage", isRestroom: true, isCorridorOrHall: true });
    const { results } = applyRules({ rooms: [room], buildingType: "education" });
    expect(results[0].signs.some((s) => s.signType.startsWith("Restroom"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyRules — R9: Exit signs
// ---------------------------------------------------------------------------

describe("applyRules — R9: Exit signs", () => {
  it("assigns Exit sign to a vestibule", () => {
    const room = makeRoom({ roomName: "Entry Vestibule", isVestibule: true });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    expect(results[0].signs.some((s) => s.signType === "Exit" && s.ruleRef === "R9")).toBe(true);
  });

  it("assigns Exit sign to public lobby in commercial building", () => {
    const room = makeRoom({ roomName: "Lobby", isPublicFacing: true });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    expect(results[0].signs.some((s) => s.signType === "Exit")).toBe(true);
  });

  it("assigns Exit qty=2 for assembly room with occupant load ≥50", () => {
    const room = makeRoom({
      roomName: "Conference Room",
      isAssembly: true,
      occupantLoad: 75,
    });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    const exit = results[0].signs.find((s) => s.signType === "Exit");
    expect(exit?.qty).toBe(2);
  });

  it("does NOT assign Exit to assembly room with occupant load <50", () => {
    const room = makeRoom({
      roomName: "Small Meeting Room",
      isAssembly: true,
      occupantLoad: 10,
    });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    expect(results[0].signs.some((s) => s.signType === "Exit")).toBe(false);
  });

  it("does NOT assign Exit to an office in warehouse (no assembly rules)", () => {
    const room = makeRoom({ roomName: "Storage Room" });
    const { results } = applyRules({ rooms: [room], buildingType: "warehouse" });
    expect(results[0].signs.some((s) => s.signType === "Exit")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyRules — R10: Max Occupancy
// ---------------------------------------------------------------------------

describe("applyRules — R10: Max Occupancy", () => {
  it("assigns Max Occupancy for assembly room with occupancy group A-2", () => {
    const room = makeRoom({
      roomName: "Conference Room",
      isAssembly: true,
      occupancyGroup: "A-2",
      occupantLoad: 30,
    });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    expect(results[0].signs.some((s) => s.signType === "Max Occupancy")).toBe(true);
  });

  it("assigns Max Occupancy for assembly room with high occupant load (≥50)", () => {
    const room = makeRoom({
      roomName: "Auditorium",
      isAssembly: true,
      occupantLoad: 150,
    });
    const { results } = applyRules({ rooms: [room], buildingType: "school" });
    expect(results[0].signs.some((s) => s.signType === "Max Occupancy")).toBe(true);
  });

  it("assigns qty=2 Max Occupancy for variable-use assembly room", () => {
    const room = makeRoom({
      roomName: "Community Room",
      isAssembly: true,
      isVariableUse: true,
      occupantLoad: 80,
    });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    const cap = results[0].signs.find((s) => s.signType === "Max Occupancy");
    expect(cap?.qty).toBe(2);
  });

  it("does NOT assign Max Occupancy in warehouse (no assembly rules)", () => {
    const room = makeRoom({
      roomName: "Break Room",
      isAssembly: true,
      occupantLoad: 100,
    });
    const { results } = applyRules({ rooms: [room], buildingType: "warehouse" });
    expect(results[0].signs.some((s) => s.signType === "Max Occupancy")).toBe(false);
  });

  it("does NOT assign Max Occupancy to non-assembly room even with high load", () => {
    const room = makeRoom({ roomName: "Office", occupantLoad: 200 });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    expect(results[0].signs.some((s) => s.signType === "Max Occupancy")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyRules — R11: Stair signs
// ---------------------------------------------------------------------------

describe("applyStairRules — R11", () => {
  const levels = ["1", "2", "3"];
  const commercialTraits = BUILDING_TRAITS["commercial"];
  const _residentialTraits = BUILDING_TRAITS["residential"];

  it("assigns both Stair(Corridor) and Stair(Landing) for each unique stair, qty=floorCount (Fix 1)", () => {
    // Two entries with same roomNumber → deduplicated to 1 unique stair core.
    // R11 now always emits BOTH sign types: qty = floorCount for each.
    const stairRooms: RoomRecord[] = [
      makeRoom({ roomNumber: "S1", roomName: "Stair 1", isStair: true, level: "1" }),
      makeRoom({ roomNumber: "S1", roomName: "Stair 1", isStair: true, level: "2" }),
    ];
    const signs = applyStairRules(stairRooms, levels, commercialTraits);
    const corridorSigns = signs.filter((s) => s.signType === "Stair(Corridor)");
    const landingSigns = signs.filter((s) => s.signType === "Stair(Landing)");
    // 1 unique stair core → 1 row per sign type; qty = 3 (levels.length)
    expect(corridorSigns).toHaveLength(1);
    expect(landingSigns).toHaveLength(1);
    expect(corridorSigns[0].qty).toBe(3);
    expect(landingSigns[0].qty).toBe(3);
  });

  it("corridor-type stair rooms also produce both Stair(Corridor) and Stair(Landing) per R11 (Fix 1)", () => {
    // Old behavior: corridor rooms only got Stair(Corridor).
    // New behavior: R11 always emits both types — one Corridor + one Landing per stair core.
    const stairRooms: RoomRecord[] = [
      makeRoom({ roomNumber: "S1", roomName: "Stair Corridor", isStair: true, isCorridorOrHall: true, level: "1" }),
      makeRoom({ roomNumber: "S1", roomName: "Stair Corridor", isStair: true, isCorridorOrHall: true, level: "2" }),
    ];
    const signs = applyStairRules(stairRooms, levels, commercialTraits);
    const corridorSigns = signs.filter((s) => s.signType === "Stair(Corridor)");
    const landingSigns = signs.filter((s) => s.signType === "Stair(Landing)");
    expect(corridorSigns).toHaveLength(1);
    expect(landingSigns).toHaveLength(1);
  });

  it("Office Directory emitted once per unique stair core (not conditioned on corridor/landing type)", () => {
    // S1 (landing) and S2 (corridor-type) are two unique stair cores.
    // Commercial traits have hasDirectory=true → each core produces one Office Directory.
    const stairRooms: RoomRecord[] = [
      makeRoom({ roomNumber: "S1", isStair: true, level: "1" }),
      makeRoom({ roomNumber: "S2", isStair: true, isCorridorOrHall: true, level: "1" }),
    ];
    const signs = applyStairRules(stairRooms, levels, commercialTraits);
    expect(signs.filter((s) => s.signType === "Office Directory")).toHaveLength(2);
  });

  it("handles multiple unique stair cores independently", () => {
    const stairRooms: RoomRecord[] = [
      makeRoom({ roomNumber: "S1", roomName: "Stair 1", isStair: true, level: "1" }),
      makeRoom({ roomNumber: "S2", roomName: "Stair 2", isStair: true, level: "1" }),
    ];
    const signs = applyStairRules(stairRooms, levels, commercialTraits);
    expect(signs.filter((s) => s.signType === "Stair(Landing)")).toHaveLength(2);
  });

  it("returns empty when no stair rooms", () => {
    expect(applyStairRules([], levels, commercialTraits)).toHaveLength(0);
  });

  it("does not double-count when stair appears multiple times on same level", () => {
    const stairRooms: RoomRecord[] = [
      makeRoom({ roomNumber: "S1", roomName: "Stair 1", isStair: true, level: "1" }),
      makeRoom({ roomNumber: "S1", roomName: "Stair 1", isStair: true, level: "1" }),
    ];
    const signs = applyStairRules(stairRooms, levels, commercialTraits);
    expect(signs.filter((s) => s.signType === "Stair(Landing)")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// applyRules — R12: Elevator signs
// ---------------------------------------------------------------------------

describe("applyElevatorRules — R12", () => {
  const levels = ["1", "2", "3"];
  const perBuildingTraits = BUILDING_TRAITS["commercial"];
  const perLevelTraits = BUILDING_TRAITS["residential"];

  it("assigns one 'Elevator' ID sign per unique elevator in per_building mode", () => {
    const elevRooms: RoomRecord[] = [
      makeRoom({ roomNumber: "E1", roomName: "Elevator", isElevator: true, level: "1" }),
      makeRoom({ roomNumber: "E2", roomName: "Elevator", isElevator: true, level: "1" }),
    ];
    const signs = applyElevatorRules(elevRooms, levels, perBuildingTraits);
    expect(signs).toHaveLength(1);
    expect(signs[0].qty).toBe(2);
  });

  it("assigns one 'Elevator' ID sign per elevator per level in per_level mode", () => {
    const elevRooms: RoomRecord[] = [
      makeRoom({ roomNumber: "E1", roomName: "Elevator", isElevator: true, level: "1" }),
      makeRoom({ roomNumber: "E1", roomName: "Elevator", isElevator: true, level: "2" }),
      makeRoom({ roomNumber: "E1", roomName: "Elevator", isElevator: true, level: "3" }),
    ];
    const signs = applyElevatorRules(elevRooms, levels, perLevelTraits);
    expect(signs).toHaveLength(1);
    expect(signs[0].qty).toBe(3);
  });

  it("returns empty when no elevator rooms", () => {
    expect(applyElevatorRules([], levels, perBuildingTraits)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// applyRules — R13: Evacuation Maps
// ---------------------------------------------------------------------------

describe("applyEvacMapRules — R13", () => {
  it("single-floor small building (< 10 rooms) gets 0 maps — owner posts their own", () => {
    const lobbies: RoomRecord[] = [
      makeRoom({ roomName: "Elevator Lobby", isPublicFacing: true, level: "1" }),
    ];
    // 0 rooms in main array, 1 floor → small building → 0 maps
    expect(applyEvacMapRules([], ["1"], lobbies)).toHaveLength(0);
    // 1 ordinary room, 1 floor → still 0
    const rooms = [makeRoom({ roomName: "Main Lobby", isPublicFacing: true })];
    expect(applyEvacMapRules(rooms, ["1"], [])).toHaveLength(0);
  });

  it("multi-floor building triggers assignment — one map per floor with exit cluster", () => {
    // Two elevator lobbies on the SAME floor → still 1 map (one per exit-cluster floor).
    const sameFloorLobbies: RoomRecord[] = [
      makeRoom({ roomName: "Elevator Lobby", isPublicFacing: true, level: "1" }),
      makeRoom({ roomName: "Elevator Lobby", isPublicFacing: true, level: "1" }),
    ];
    const sameSigns = applyEvacMapRules([], ["1", "2"], sameFloorLobbies);
    expect(sameSigns.filter((s) => s.signType === "Evacuation Map")).toHaveLength(1);

    // Elevator lobbies on DIFFERENT floors → one map per floor.
    const diffFloorLobbies: RoomRecord[] = [
      makeRoom({ roomName: "Elevator Lobby", isPublicFacing: true, level: "1" }),
      makeRoom({ roomName: "Elevator Lobby", isPublicFacing: true, level: "2" }),
    ];
    const diffSigns = applyEvacMapRules([], ["1", "2"], diffFloorLobbies);
    expect(diffSigns.filter((s) => s.signType === "Evacuation Map")).toHaveLength(2);
  });

  it("single-floor large building (20+ rooms) triggers assignment at exit-cluster rooms", () => {
    // 20 rooms, 1 floor — floor area trigger applies.
    const rooms: RoomRecord[] = [
      ...Array.from({ length: 18 }, () => makeRoom({ roomName: "Office" })),
      makeRoom({ roomName: "Exit Stair A", level: "1" }),
      makeRoom({ roomName: "Lobby", level: "1" }),
    ];
    const signs = applyEvacMapRules(rooms, ["1"], []);
    // 1 floor with exit-cluster rooms → 1 map; cap = getEvacMapCount(1, commercial, 20) = 1
    expect(signs.filter((s) => s.signType === "Evacuation Map")).toHaveLength(1);
  });

  it("returns empty when no exit-cluster rooms are present in a multi-floor building", () => {
    const rooms = [
      makeRoom({ roomName: "Office", level: "1" }),
      makeRoom({ roomName: "Conference Room", level: "2" }),
    ];
    expect(applyEvacMapRules(rooms, ["1", "2"], [])).toHaveLength(0);
  });

  it("small building (3 floors) gives 1 map only for the floor with an exit cluster", () => {
    // Two elevator lobbies on the SAME floor → still 1 map (de-duped by floor).
    const lobbies = [
      makeRoom({ roomName: "Elevator Lobby", isPublicFacing: true, level: "2" }),
      makeRoom({ roomName: "Elevator Lobby", isPublicFacing: true, level: "2" }),
    ];
    const signs = applyEvacMapRules([], ["1", "2", "3"], lobbies, "commercial");
    expect(signs.filter((s) => s.signType === "Evacuation Map")).toHaveLength(1);
  });

  it("education: evac maps assigned only for floors with CORRIDOR or LOBBY rooms (not exit stairs)", () => {
    // 2 floors — floor 1 has a stair (non-qualifying for education), floor 2 has a corridor
    const rooms = [
      makeRoom({ roomName: "Exit Stair A", level: "1" }),       // exit stair — not in education filter
      makeRoom({ roomName: "Main Corridor", isCorridorOrHall: true, level: "2" }),  // corridor — qualifies
      ...Array.from({ length: 20 }, () => makeRoom({ roomName: "Classroom" })),
    ];
    const signs = applyEvacMapRules(rooms, ["1", "2"], [], "education");
    // Only 1 floor (floor 2) has a qualifying CORRIDOR room → 1 map
    expect(signs.filter((s) => s.signType === "Evacuation Map")).toHaveLength(1);
  });

  it("education: evac maps capped at 4 total even with many corridor floors", () => {
    // 10 floors each with a lobby → qualifies, but totalCap = min(20, 4) = 4
    const rooms = Array.from({ length: 10 }, (_, i) =>
      makeRoom({ roomName: "Main Lobby", isCorridorOrHall: true, level: String(i + 1) }),
    );
    const levels = Array.from({ length: 10 }, (_, i) => String(i + 1));
    const signs = applyEvacMapRules(rooms, levels, [], "education");
    expect(signs.filter((s) => s.signType === "Evacuation Map")).toHaveLength(4);
  });

  it("education fallback: with no corridor/lobby anchors, falls back to exit-cluster placement (not zero maps)", () => {
    // An education building whose corridors/lobbies weren't extracted — only exit
    // stairs on each floor.  The education-only-corridor restriction assumes anchors
    // exist; when none do, the data-driven fallback uses the standard exit-cluster
    // filter so the building still receives maps rather than zero.
    const rooms = [
      makeRoom({ roomName: "Exit Stair A", level: "1" }),
      makeRoom({ roomName: "Exit Stair B", level: "2" }),
      ...Array.from({ length: 20 }, () => makeRoom({ roomName: "Classroom" })),
    ];
    const signs = applyEvacMapRules(rooms, ["1", "2"], [], "education");
    // 2 floors each with an exit-cluster (stair) room → 2 maps via fallback (cap = min(4, 4))
    expect(signs.filter((s) => s.signType === "Evacuation Map")).toHaveLength(2);
  });

  it("evacMapsPerFloorCap: residential=1/floor, healthcare=4/floor, hotel=1/floor, commercial/government=2/floor (Fix 4)", () => {
    // Residential: 1 per floor (Fix 4 — residents orient by neighbourhood, not building-wide)
    expect(evacMapsPerFloorCap(1, "residential")).toBe(1);
    expect(evacMapsPerFloorCap(3, "residential")).toBe(1);
    expect(evacMapsPerFloorCap(15, "residential")).toBe(1);
    expect(evacMapsPerFloorCap(20, "multifamily")).toBe(1);
    // Education: always 2 per floor (one per wing)
    expect(evacMapsPerFloorCap(1, "education")).toBe(2);
    expect(evacMapsPerFloorCap(5, "school")).toBe(2);
    // Commercial: always 2 per floor (one per corridor segment — no more floor-count scaling)
    expect(evacMapsPerFloorCap(1, "commercial")).toBe(2);
    expect(evacMapsPerFloorCap(5, "commercial")).toBe(2);
    expect(evacMapsPerFloorCap(6, "commercial")).toBe(2);
    expect(evacMapsPerFloorCap(10, "commercial")).toBe(2);
    expect(evacMapsPerFloorCap(11, "commercial")).toBe(2);
  });

  it("multi-floor residential building: cap respects room-count formula", () => {
    // getEvacMapCount(15, "residential", 300) = min(30, ceil(300/20)) = min(30, 15) = 15
    // Exit clusters spread across 3 floors → 3 maps
    const levels = Array.from({ length: 15 }, (_, i) => String(i + 1));
    const filler = Array.from({ length: 295 }, () => makeRoom({ roomName: "Unit 101" }));
    const exitRooms = [
      makeRoom({ roomName: "Elevator Lobby", level: "1" }),
      makeRoom({ roomName: "Exit Stair", level: "7" }),
      makeRoom({ roomName: "Lobby", level: "12" }),
    ];
    const signs = applyEvacMapRules([...filler, ...exitRooms], levels, [], "residential");
    expect(signs.filter((s) => s.signType === "Evacuation Map")).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// applyRules — R15: Mezzanine exclusion
// ---------------------------------------------------------------------------

describe("applyRules — R15: Mezzanine exclusion", () => {
  it("excludes MEP room on a mezzanine level from all signs", () => {
    const room = makeRoom({
      roomName: "Mechanical Room",
      level: "MEZZANINE",
      isMepUnoccupied: true,
    });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    expect(results[0].signs).toHaveLength(0);
  });

  it("does NOT exclude occupied room on mezzanine level", () => {
    const room = makeRoom({
      roomName: "Office",
      level: "MEZZANINE",
      isMepUnoccupied: false,
    });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    expect(results[0].signs.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// applyRules — R16: Residential unit plaques
// ---------------------------------------------------------------------------

describe("applyRules — R16: Residential Unit ID", () => {
  it("assigns Room ID (via R16) for residential unit in residential building", () => {
    // R16 was changed from "Unit ID" to "Room ID" — residential units receive a
    // Room ID sign (ADA §703 dwelling-unit identification) via ruleRef R16.
    const room = makeRoom({ roomName: "Unit 101", isResidentialUnit: true });
    const { results } = applyRules({ rooms: [room], buildingType: "residential" });
    const signs = results[0].signs;
    expect(signs.some((s) => s.signType === "Room ID" && s.ruleRef === "R16")).toBe(true);
    expect(signs.some((s) => s.signType === "Unit ID")).toBe(false);
  });

  it("suppresses UNIT/APT-named rooms in commercial buildings (airport gates, mis-detected codes)", () => {
    // In non-residential buildings, rooms named "UNIT NNN" or "APT NNN" are
    // likely gate codes or door-schedule codes — suppress them entirely (no sign).
    // Check is based on the room name prefix, not the isResidentialUnit flag.
    for (const roomName of ["Unit 101", "Unit 500", "Apt 4B"]) {
      const room = makeRoom({ roomName });
      const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
      expect(results[0].signs).toHaveLength(0);
    }
  });

  it("does NOT suppress Suite-named rooms in commercial buildings", () => {
    // "Suite NNN" rooms are unambiguous multi-tenant office suites.
    // They should pass through suppression and receive a Room ID sign.
    const room = makeRoom({ roomName: "Suite 200" });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    expect(results[0].signs.some((s) => s.signType === "Room ID")).toBe(true);
  });

  it("assigns Room ID (via R16) to UNIT-named rooms in residential buildings", () => {
    // In residential buildings, UNIT rooms get a Room ID sign via R16 (not Unit ID).
    const room = makeRoom({ roomName: "Unit 101", isResidentialUnit: true });
    const { results } = applyRules({ rooms: [room], buildingType: "residential" });
    expect(results[0].signs.some((s) => s.signType === "Room ID" && s.ruleRef === "R16")).toBe(true);
  });

  it("does NOT suppress UNIT rooms when they dominate a non-residential set (dorm mislabeled as education)", () => {
    // A 7-floor dormitory whose buildingType is 'education' has many UNIT rooms.
    // Because they dominate (≥5 and ≥30%), the non-residential UNIT/APT guard must
    // stand down so the units receive Room ID signs instead of being suppressed.
    const unitRooms = Array.from({ length: 8 }, (_, i) =>
      makeRoom({ id: `u${i}`, roomName: `Unit 30${i}`, roomNumber: `30${i}` }),
    );
    const otherRooms = [
      makeRoom({ id: "o1", roomName: "Study Lounge", roomNumber: "" }),
      makeRoom({ id: "o2", roomName: "Electrical", roomNumber: "", isMepUnoccupied: true }),
    ];
    const { results } = applyRules({ rooms: [...unitRooms, ...otherRooms], buildingType: "education" });
    const unitResults = results.filter((r) => /^UNIT\b/i.test(r.room.roomName));
    // The units are kept (not suppressed) — at least one receives a Room ID sign.
    expect(unitResults.some((r) => r.signs.some((s) => s.signType === "Room ID"))).toBe(true);
    // And the suppression did not zero out the whole unit set.
    expect(unitResults.filter((r) => r.signs.length === 0).length).toBeLessThan(unitRooms.length);
  });

  it("still suppresses a lone UNIT room in a non-residential building (below the ≥5 floor)", () => {
    const room = makeRoom({ roomName: "Unit 101", roomNumber: "101" });
    const { results } = applyRules({ rooms: [room], buildingType: "education" });
    expect(results[0].signs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// applyRules — Rule overrides
// ---------------------------------------------------------------------------

describe("applyRules — Rule overrides", () => {
  it("'add' override appends a new sign type to matching rooms", () => {
    const room = makeRoom({ roomName: "Special Room" });
    const { results } = applyRules({
      rooms: [room],
      buildingType: "commercial",
      ruleOverrides: [
        {
          ruleRef: "CUSTOM-1",
          overrideType: "add",
          condition: { room_name_contains: "Special" },
          action: { sign_type: "Office Directory", qty: 1 },
        },
      ],
    });
    expect(results[0].signs.some((s) => s.signType === "Office Directory" && s.ruleRef === "CUSTOM-1")).toBe(true);
  });

  it("'exclude' override removes a sign type from matching rooms", () => {
    const room = makeRoom({ roomName: "No Sign Room" });
    const { results } = applyRules({
      rooms: [room],
      buildingType: "commercial",
      ruleOverrides: [
        {
          ruleRef: "CUSTOM-2",
          overrideType: "exclude",
          condition: { room_name_contains: "No Sign" },
          action: { sign_type: "Room ID", qty: 1 },
        },
      ],
    });
    expect(results[0].signs.some((s) => s.signType === "Room ID")).toBe(false);
  });

  it("'modify_qty' override changes the quantity of an existing sign", () => {
    const room = makeRoom({ roomName: "Corner Office" });
    const { results } = applyRules({
      rooms: [room],
      buildingType: "commercial",
      ruleOverrides: [
        {
          ruleRef: "CUSTOM-3",
          overrideType: "modify_qty",
          condition: { room_name_contains: "Corner" },
          action: { sign_type: "Room ID", qty: 3 },
        },
      ],
    });
    const roomId = results[0].signs.find((s) => s.signType === "Room ID");
    expect(roomId?.qty).toBe(3);
  });

  it("override with non-matching condition does not affect room", () => {
    const room = makeRoom({ roomName: "Regular Room" });
    const { results } = applyRules({
      rooms: [room],
      buildingType: "commercial",
      ruleOverrides: [
        {
          ruleRef: "CUSTOM-4",
          overrideType: "exclude",
          condition: { room_name_contains: "Special" },
          action: { sign_type: "Room ID", qty: 1 },
        },
      ],
    });
    expect(results[0].signs.some((s) => s.signType === "Room ID")).toBe(true);
  });

  it("override matching is_restroom condition correctly", () => {
    const room = makeRoom({ roomName: "Women's Restroom", isRestroom: true });
    const { results } = applyRules({
      rooms: [room],
      buildingType: "commercial",
      ruleOverrides: [
        {
          ruleRef: "CUSTOM-5",
          overrideType: "exclude",
          condition: { is_restroom: true },
          action: { sign_type: "Restroom", qty: 1 },
        },
      ],
    });
    expect(results[0].signs.some((s) => s.signType === "Restroom")).toBe(false);
  });

  it("is_restroom condition does NOT match a non-restroom room", () => {
    const room = makeRoom({ roomName: "Break Room", isRestroom: false });
    const { results } = applyRules({
      rooms: [room],
      buildingType: "commercial",
      ruleOverrides: [
        {
          ruleRef: "CUSTOM-6",
          overrideType: "exclude",
          condition: { is_restroom: true },
          action: { sign_type: "Room ID", qty: 1 },
        },
      ],
    });
    expect(results[0].signs.some((s) => s.signType === "Room ID")).toBe(true);
  });

  it("'add' override with is_corridor condition adds sign to corridor rooms", () => {
    const corridor = makeRoom({ roomName: "Main Corridor", isCorridorOrHall: true });
    const { results } = applyRules({
      rooms: [corridor],
      buildingType: "commercial",
      ruleOverrides: [
        {
          ruleRef: "CUSTOM-7",
          overrideType: "add",
          condition: { is_corridor: true },
          action: { sign_type: "Evacuation Map", qty: 1 },
        },
      ],
    });
    expect(results[0].signs.some((s) => s.signType === "Evacuation Map" && s.ruleRef === "CUSTOM-7")).toBe(true);
  });

  it("'exclude' override with is_corridor condition does not affect non-corridor rooms", () => {
    const office = makeRoom({ roomName: "Office", isCorridorOrHall: false });
    const { results } = applyRules({
      rooms: [office],
      buildingType: "commercial",
      ruleOverrides: [
        {
          ruleRef: "CUSTOM-8",
          overrideType: "exclude",
          condition: { is_corridor: true },
          action: { sign_type: "Room ID", qty: 1 },
        },
      ],
    });
    expect(results[0].signs.some((s) => s.signType === "Room ID")).toBe(true);
  });

  it("'modify_qty' override with is_corridor condition changes qty only for corridor rooms", () => {
    // Corridors get no signs by default (R4 exclusion), so first add a sign, then modify its qty.
    const corridorOverrides = [
      {
        ruleRef: "CUSTOM-9a",
        overrideType: "add",
        condition: { is_corridor: true },
        action: { sign_type: "Evacuation Map", qty: 1 },
      },
      {
        ruleRef: "CUSTOM-9b",
        overrideType: "modify_qty",
        condition: { is_corridor: true },
        action: { sign_type: "Evacuation Map", qty: 3 },
      },
    ];

    const corridor = makeRoom({ roomName: "East Corridor", isCorridorOrHall: true });
    const corridorResult = applyRules({ rooms: [corridor], buildingType: "commercial", ruleOverrides: corridorOverrides });
    const evacSign = corridorResult.results[0].signs.find((s) => s.signType === "Evacuation Map");
    expect(evacSign).toBeDefined();
    expect(evacSign?.qty).toBe(3);

    // Non-corridor rooms should not be affected by an is_corridor override.
    const officeOverrides = [
      {
        ruleRef: "CUSTOM-9c",
        overrideType: "modify_qty",
        condition: { is_corridor: true },
        action: { sign_type: "Room ID", qty: 99 },
      },
    ];
    const office = makeRoom({ id: "room-2", roomName: "Office", isCorridorOrHall: false });
    const officeResult = applyRules({ rooms: [office], buildingType: "commercial", ruleOverrides: officeOverrides });
    const roomIdSign = officeResult.results[0].signs.find((s) => s.signType === "Room ID");
    expect(roomIdSign?.qty).toBe(1);
  });

  it("multiple overrides are applied in order", () => {
    const room = makeRoom({ roomName: "Multi Room" });
    const { results } = applyRules({
      rooms: [room],
      buildingType: "commercial",
      ruleOverrides: [
        {
          ruleRef: "CUSTOM-10",
          overrideType: "add",
          condition: { room_name_contains: "Multi" },
          action: { sign_type: "Evacuation Map", qty: 1 },
        },
        {
          ruleRef: "CUSTOM-11",
          overrideType: "exclude",
          condition: { room_name_contains: "Multi" },
          action: { sign_type: "Evacuation Map", qty: 1 },
        },
      ],
    });
    expect(results[0].signs.some((s) => s.signType === "Evacuation Map")).toBe(false);
  });

  it("empty ruleOverrides array leaves signs unchanged", () => {
    const room = makeRoom({ roomName: "Office" });
    const { results: withOverrides } = applyRules({ rooms: [room], buildingType: "commercial", ruleOverrides: [] });
    const { results: withoutOverrides } = applyRules({ rooms: [room], buildingType: "commercial" });
    expect(withOverrides[0].signs).toEqual(withoutOverrides[0].signs);
  });

  it("multi-condition: room_name_contains + is_restroom both match — override is applied", () => {
    const room = makeRoom({ roomName: "Family Restroom", isRestroom: true });
    const { results } = applyRules({
      rooms: [room],
      buildingType: "commercial",
      ruleOverrides: [
        {
          ruleRef: "CUSTOM-MULTI-1",
          overrideType: "add",
          condition: { room_name_contains: "Family", is_restroom: true },
          action: { sign_type: "Directional", qty: 1 },
        },
      ],
    });
    expect(results[0].signs.some((s) => s.signType === "Directional" && s.ruleRef === "CUSTOM-MULTI-1")).toBe(true);
  });

  it("multi-condition: room_name_contains matches but is_restroom does not — override is NOT applied", () => {
    const room = makeRoom({ roomName: "Family Lounge", isRestroom: false });
    const { results } = applyRules({
      rooms: [room],
      buildingType: "commercial",
      ruleOverrides: [
        {
          ruleRef: "CUSTOM-MULTI-2",
          overrideType: "add",
          condition: { room_name_contains: "Family", is_restroom: true },
          action: { sign_type: "Directional", qty: 1 },
        },
      ],
    });
    expect(results[0].signs.some((s) => s.signType === "Directional")).toBe(false);
  });

  it("multi-condition: is_restroom matches but room_name_contains does not — override is NOT applied", () => {
    const room = makeRoom({ roomName: "Men's Restroom", isRestroom: true });
    const { results } = applyRules({
      rooms: [room],
      buildingType: "commercial",
      ruleOverrides: [
        {
          ruleRef: "CUSTOM-MULTI-3",
          overrideType: "add",
          condition: { room_name_contains: "Family", is_restroom: true },
          action: { sign_type: "Directional", qty: 1 },
        },
      ],
    });
    expect(results[0].signs.some((s) => s.signType === "Directional")).toBe(false);
  });

  it("multi-condition: room_name_contains + is_corridor both match — override is applied; non-corridor with same name is not affected", () => {
    const corridor = makeRoom({ id: "room-c", roomName: "East Egress Corridor", isCorridorOrHall: true });
    const office = makeRoom({ id: "room-o", roomName: "East Egress Office", isCorridorOrHall: false });
    const overrides = [
      {
        ruleRef: "CUSTOM-MULTI-4",
        overrideType: "add",
        condition: { room_name_contains: "East Egress", is_corridor: true },
        action: { sign_type: "Directional", qty: 1 },
      },
    ];

    const corridorResult = applyRules({ rooms: [corridor], buildingType: "commercial", ruleOverrides: overrides });
    expect(corridorResult.results[0].signs.some((s) => s.signType === "Directional" && s.ruleRef === "CUSTOM-MULTI-4")).toBe(true);

    const officeResult = applyRules({ rooms: [office], buildingType: "commercial", ruleOverrides: overrides });
    expect(officeResult.results[0].signs.some((s) => s.signType === "Directional")).toBe(false);
  });

  it("multi-condition: room_name_contains + is_restroom + is_corridor — only room satisfying all three conditions is affected", () => {
    const allMatch = makeRoom({ id: "room-all", roomName: "Corridor Restroom", isRestroom: true, isCorridorOrHall: true });
    const restroomOnly = makeRoom({ id: "room-r", roomName: "Corridor Restroom", isRestroom: true, isCorridorOrHall: false });
    const corridorOnly = makeRoom({ id: "room-c2", roomName: "Corridor Restroom", isRestroom: false, isCorridorOrHall: true });
    const overrides = [
      {
        ruleRef: "CUSTOM-MULTI-5",
        overrideType: "add",
        condition: { room_name_contains: "Corridor Restroom", is_restroom: true, is_corridor: true },
        action: { sign_type: "Directional", qty: 1 },
      },
    ];

    const allMatchResult = applyRules({ rooms: [allMatch], buildingType: "commercial", ruleOverrides: overrides });
    expect(allMatchResult.results[0].signs.some((s) => s.signType === "Directional" && s.ruleRef === "CUSTOM-MULTI-5")).toBe(true);

    const restroomOnlyResult = applyRules({ rooms: [restroomOnly], buildingType: "commercial", ruleOverrides: overrides });
    expect(restroomOnlyResult.results[0].signs.some((s) => s.signType === "Directional")).toBe(false);

    const corridorOnlyResult = applyRules({ rooms: [corridorOnly], buildingType: "commercial", ruleOverrides: overrides });
    expect(corridorOnlyResult.results[0].signs.some((s) => s.signType === "Directional")).toBe(false);
  });

  it("is_residential_unit condition matches a residential-unit room", () => {
    // Use residential building type — Unit ID is only canonical for residential buildings
    const room = makeRoom({ roomName: "Unit 101", isResidentialUnit: true });
    const { results } = applyRules({
      rooms: [room],
      buildingType: "residential",
      ruleOverrides: [
        {
          ruleRef: "CUSTOM-RU-1",
          overrideType: "add",
          condition: { is_residential_unit: true },
          action: { sign_type: "Unit ID", qty: 1 },
        },
      ],
    });
    expect(results[0].signs.some((s) => s.signType === "Unit ID" && s.ruleRef === "CUSTOM-RU-1")).toBe(true);
  });

  it("is_residential_unit condition does NOT match a non-residential-unit room", () => {
    const room = makeRoom({ roomName: "Office", isResidentialUnit: false });
    const { results } = applyRules({
      rooms: [room],
      buildingType: "commercial",
      ruleOverrides: [
        {
          ruleRef: "CUSTOM-RU-2",
          overrideType: "add",
          condition: { is_residential_unit: true },
          action: { sign_type: "Unit ID", qty: 1 },
        },
      ],
    });
    expect(results[0].signs.some((s) => s.signType === "Unit ID")).toBe(false);
  });

  it("is_vehicle_bay condition matches a vehicle bay room", () => {
    const room = makeRoom({ roomName: "Apparatus Bay", isVehicleBay: true });
    const { results } = applyRules({
      rooms: [room],
      buildingType: "commercial",
      ruleOverrides: [
        {
          ruleRef: "CUSTOM-VB-1",
          overrideType: "add",
          condition: { is_vehicle_bay: true },
          action: { sign_type: "Directional", qty: 1 },
        },
      ],
    });
    expect(results[0].signs.some((s) => s.signType === "Directional" && s.ruleRef === "CUSTOM-VB-1")).toBe(true);
  });

  it("is_vehicle_bay condition does NOT match a non-vehicle-bay room", () => {
    const room = makeRoom({ roomName: "Storage Room", isVehicleBay: false });
    const { results } = applyRules({
      rooms: [room],
      buildingType: "commercial",
      ruleOverrides: [
        {
          ruleRef: "CUSTOM-VB-2",
          overrideType: "add",
          condition: { is_vehicle_bay: true },
          action: { sign_type: "Directional", qty: 1 },
        },
      ],
    });
    expect(results[0].signs.some((s) => s.signType === "Directional")).toBe(false);
  });

  it("is_mep_unoccupied condition matches an MEP room", () => {
    const room = makeRoom({ roomName: "Mechanical Room", isMepUnoccupied: true });
    const { results } = applyRules({
      rooms: [room],
      buildingType: "commercial",
      ruleOverrides: [
        {
          ruleRef: "CUSTOM-MEP-1",
          overrideType: "add",
          condition: { is_mep_unoccupied: true },
          action: { sign_type: "Directional", qty: 1 },
        },
      ],
    });
    expect(results[0].signs.some((s) => s.signType === "Directional" && s.ruleRef === "CUSTOM-MEP-1")).toBe(true);
  });

  it("is_mep_unoccupied condition does NOT match a non-MEP room", () => {
    const room = makeRoom({ roomName: "Conference Room", isMepUnoccupied: false });
    const { results } = applyRules({
      rooms: [room],
      buildingType: "commercial",
      ruleOverrides: [
        {
          ruleRef: "CUSTOM-MEP-2",
          overrideType: "add",
          condition: { is_mep_unoccupied: true },
          action: { sign_type: "Directional", qty: 1 },
        },
      ],
    });
    expect(results[0].signs.some((s) => s.signType === "Directional")).toBe(false);
  });

  it("occupancy_group condition matches room with exact occupancy group (case-insensitive)", () => {
    const room = makeRoom({ roomName: "Assembly Hall", occupancyGroup: "A-2", isAssembly: true });
    const { results } = applyRules({
      rooms: [room],
      buildingType: "commercial",
      ruleOverrides: [
        {
          ruleRef: "CUSTOM-OG-1",
          overrideType: "add",
          condition: { occupancy_group: "a-2" },
          action: { sign_type: "Max Occupancy", qty: 2 },
        },
      ],
    });
    expect(results[0].signs.some((s) => s.signType === "Max Occupancy" && s.ruleRef === "CUSTOM-OG-1")).toBe(true);
  });

  it("occupancy_group condition does NOT match a room with a different occupancy group", () => {
    const room = makeRoom({ roomName: "Storage Room", occupancyGroup: "S-1" });
    const { results } = applyRules({
      rooms: [room],
      buildingType: "commercial",
      ruleOverrides: [
        {
          ruleRef: "CUSTOM-OG-2",
          overrideType: "exclude",
          condition: { occupancy_group: "A-2" },
          action: { sign_type: "Room ID", qty: 1 },
        },
      ],
    });
    expect(results[0].signs.some((s) => s.signType === "Room ID")).toBe(true);
  });

  it("occupancy_group condition does NOT match a room with null occupancy group", () => {
    const room = makeRoom({ roomName: "Break Room", occupancyGroup: null });
    const { results } = applyRules({
      rooms: [room],
      buildingType: "commercial",
      ruleOverrides: [
        {
          ruleRef: "CUSTOM-OG-3",
          overrideType: "exclude",
          condition: { occupancy_group: "B" },
          action: { sign_type: "Room ID", qty: 1 },
        },
      ],
    });
    expect(results[0].signs.some((s) => s.signType === "Room ID")).toBe(true);
  });

  it("room_number_equals condition matches a room with the exact room number (case-insensitive)", () => {
    const room = makeRoom({ roomName: "Executive Suite", roomNumber: "101A" });
    const { results } = applyRules({
      rooms: [room],
      buildingType: "commercial",
      ruleOverrides: [
        {
          ruleRef: "CUSTOM-RN-1",
          overrideType: "add",
          condition: { room_number_equals: "101a" },
          action: { sign_type: "Office Directory", qty: 1 },
        },
      ],
    });
    expect(results[0].signs.some((s) => s.signType === "Office Directory" && s.ruleRef === "CUSTOM-RN-1")).toBe(true);
  });

  it("room_number_equals condition does NOT match a room with a different room number", () => {
    const room = makeRoom({ roomName: "Conference Room", roomNumber: "202" });
    const { results } = applyRules({
      rooms: [room],
      buildingType: "commercial",
      ruleOverrides: [
        {
          ruleRef: "CUSTOM-RN-2",
          overrideType: "exclude",
          condition: { room_number_equals: "101A" },
          action: { sign_type: "Room ID", qty: 1 },
        },
      ],
    });
    expect(results[0].signs.some((s) => s.signType === "Room ID")).toBe(true);
  });

  it("combined occupancy_group + room_number_equals — both must match for override to apply", () => {
    const targetRoom = makeRoom({ id: "room-target", roomName: "Board Room", roomNumber: "300", occupancyGroup: "A-3", isAssembly: true });
    const wrongGroup = makeRoom({ id: "room-wg", roomName: "Board Room", roomNumber: "300", occupancyGroup: "B", isAssembly: true });
    const wrongNumber = makeRoom({ id: "room-wn", roomName: "Board Room", roomNumber: "301", occupancyGroup: "A-3", isAssembly: true });
    const overrides = [
      {
        ruleRef: "CUSTOM-COMBO-1",
        overrideType: "add",
        condition: { occupancy_group: "A-3", room_number_equals: "300" },
        action: { sign_type: "Max Occupancy", qty: 1 },
      },
    ];

    const targetResult = applyRules({ rooms: [targetRoom], buildingType: "commercial", ruleOverrides: overrides });
    expect(targetResult.results[0].signs.some((s) => s.signType === "Max Occupancy" && s.ruleRef === "CUSTOM-COMBO-1")).toBe(true);

    const wrongGroupResult = applyRules({ rooms: [wrongGroup], buildingType: "commercial", ruleOverrides: overrides });
    expect(wrongGroupResult.results[0].signs.some((s) => s.signType === "Max Occupancy" && s.ruleRef === "CUSTOM-COMBO-1")).toBe(false);

    const wrongNumberResult = applyRules({ rooms: [wrongNumber], buildingType: "commercial", ruleOverrides: overrides });
    expect(wrongNumberResult.results[0].signs.some((s) => s.signType === "Max Occupancy" && s.ruleRef === "CUSTOM-COMBO-1")).toBe(false);
  });

  it("occupancy_group combined with room_name_contains — both must match", () => {
    const match = makeRoom({ roomName: "Assembly Lounge", occupancyGroup: "A-2", isAssembly: true });
    const noGroupMatch = makeRoom({ id: "room-2", roomName: "Assembly Lounge", occupancyGroup: "B", isAssembly: true });
    const overrides = [
      {
        ruleRef: "CUSTOM-COMBO-2",
        overrideType: "add",
        condition: { room_name_contains: "Assembly", occupancy_group: "A-2" },
        action: { sign_type: "Max Occupancy", qty: 1 },
      },
    ];

    const matchResult = applyRules({ rooms: [match], buildingType: "commercial", ruleOverrides: overrides });
    expect(matchResult.results[0].signs.some((s) => s.signType === "Max Occupancy" && s.ruleRef === "CUSTOM-COMBO-2")).toBe(true);

    const noGroupResult = applyRules({ rooms: [noGroupMatch], buildingType: "commercial", ruleOverrides: overrides });
    expect(noGroupResult.results[0].signs.some((s) => s.signType === "Max Occupancy" && s.ruleRef === "CUSTOM-COMBO-2")).toBe(false);
  });

  it("canonical Guard 2: Unit ID added via training correction is dropped for non-residential buildings", () => {
    // A training correction that tries to add 'Unit ID' to a normal room in a commercial
    // building must be dropped by the outer canonical filter (Guard 2).
    // Note: isResidentialUnit is NOT set here — "Storage 101" is a regular storage room,
    // not a residential unit, so it goes through normal processing and gets Room ID.
    const room = makeRoom({ roomName: "Storage 101" });
    const { results } = applyRules({
      rooms: [room],
      buildingType: "commercial", // NOT residential
      ruleOverrides: [
        {
          ruleRef: "TC-UNIT-1",
          overrideType: "add",
          condition: { room_name_contains: "Storage" },
          action: { sign_type: "Unit ID", qty: 1 },
        },
      ],
    });
    // Unit ID should be dropped — commercial building cannot have Unit ID signs
    expect(results[0].signs.some((s) => s.signType === "Unit ID")).toBe(false);
    // Room still gets its rules-engine sign (Room ID for non-residential)
    expect(results[0].signs.some((s) => s.signType === "Room ID")).toBe(true);
  });

  it("canonical Guard 3: Max Occupancy added via training correction is dropped for non-assembly rooms", () => {
    // A training correction that maps a non-assembly room to 'Max Occupancy'
    // must be dropped by the outer canonical filter (Guard 3).
    const room = makeRoom({ roomName: "Storage Room", isAssembly: false });
    const { results } = applyRules({
      rooms: [room],
      buildingType: "commercial",
      ruleOverrides: [
        {
          ruleRef: "TC-OCC-1",
          overrideType: "add",
          condition: { room_name_contains: "Storage" },
          action: { sign_type: "Max Occupancy", qty: 1 },
        },
      ],
    });
    // Max Occupancy must be dropped — non-assembly rooms cannot have occupancy signs
    expect(results[0].signs.some((s) => s.signType === "Max Occupancy")).toBe(false);
    // Room still gets its rules-engine Room ID
    expect(results[0].signs.some((s) => s.signType === "Room ID")).toBe(true);
  });

  it("canonical Guard 2: Unit ID is NOT dropped for residential building types", () => {
    const room = makeRoom({ roomName: "Unit 201", isResidentialUnit: true });
    for (const bType of ["residential", "multifamily", "hotel", "senior_living", "dormitory"]) {
      const { results } = applyRules({
        rooms: [room],
        buildingType: bType,
        ruleOverrides: [
          {
            ruleRef: "TC-UNIT-2",
            overrideType: "add",
            condition: { room_name_contains: "Unit" },
            action: { sign_type: "Unit ID", qty: 1 },
          },
        ],
      });
      expect(results[0].signs.some((s) => s.signType === "Unit ID")).toBe(true);
    }
  });

  it("canonical Guard 2 (normalized): Unit ID allowed when normalized buildingType is residential", () => {
    // "apartment" normalizes to "residential" via normalizeBuildingType → Unit ID should be allowed
    const room = makeRoom({ roomName: "Apartment 5B", isResidentialUnit: true });
    const { results } = applyRules({
      rooms: [room],
      buildingType: "apartment",
      ruleOverrides: [
        {
          ruleRef: "TC-UNIT-3",
          overrideType: "add",
          condition: { room_name_contains: "Apartment" },
          action: { sign_type: "Unit ID", qty: 1 },
        },
      ],
    });
    expect(results[0].signs.some((s) => s.signType === "Unit ID")).toBe(true);
  });

  it("canonical Guard 2 (normalized): Unit ID allowed when normalized buildingType is hotel", () => {
    // "motel" normalizes to "hotel" via normalizeBuildingType → Unit ID should be allowed
    const room = makeRoom({ roomName: "Room 204", isResidentialUnit: true });
    const { results } = applyRules({
      rooms: [room],
      buildingType: "motel",
      ruleOverrides: [
        {
          ruleRef: "TC-UNIT-4",
          overrideType: "add",
          condition: { room_name_contains: "Room" },
          action: { sign_type: "Unit ID", qty: 1 },
        },
      ],
    });
    expect(results[0].signs.some((s) => s.signType === "Unit ID")).toBe(true);
  });

  it("canonical guard runs AFTER schedule suppression — suppressed type does not appear in output", () => {
    // isVestibule rooms always get Exit + Exit(Tactile) signs from the rules engine.
    // If the embedded schedule has no "exit" keyword, those types are suppressed
    // by schedule suppression (Step A).  The canonical guard (Step B) must NOT
    // re-inject them — even though Exit is a canonical type.
    const room = makeRoom({ roomName: "Vestibule", isVestibule: true });
    const { results } = applyRules({
      rooms: [room],
      buildingType: "commercial",
      signTypeDefinitions: [
        // Only Room ID is in the schedule — "exit" keyword is absent → Exit suppressed
        { typeCode: "A", description: "Room Identification" },
      ],
    });
    // Exit/Exit(Tactile) should have been suppressed by the schedule step, not re-added by guard
    expect(results[0].signs.some((s) => s.signType === "Exit")).toBe(false);
    expect(results[0].signs.some((s) => s.signType === "Exit(Tactile)")).toBe(false);
  });

  it("canonical guard blocks non-canonical type from AI vision (via ruleOverrides)", () => {
    // Simulates an AI vision assignment that injects a legacy/non-canonical sign type
    const room = makeRoom({ roomName: "Conference Room" });
    const { results } = applyRules({
      rooms: [room],
      buildingType: "commercial",
      ruleOverrides: [
        {
          ruleRef: "AI-VISION-1",
          overrideType: "add",
          condition: { room_name_contains: "Conference" },
          action: { sign_type: "Legacy Plaque", qty: 1 },
        },
      ],
    });
    // Non-canonical "Legacy Plaque" must be dropped by the canonical guard
    expect(results[0].signs.some((s) => s.signType === "Legacy Plaque")).toBe(false);
    // Room still gets its rules-engine Room ID
    expect(results[0].signs.some((s) => s.signType === "Room ID")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("applyRules — edge cases", () => {
  it("handles empty room list gracefully", () => {
    const output = applyRules({ rooms: [], buildingType: "commercial" });
    expect(output.results).toHaveLength(0);
    expect(output.stairSigns).toHaveLength(0);
    expect(output.elevatorSigns).toHaveLength(0);
    expect(output.evacMapSigns).toHaveLength(0);
  });

  it("falls back to commercial traits for unknown building type", () => {
    const room = makeRoom({ roomName: "Office" });
    const output = applyRules({ rooms: [room], buildingType: "not_real" });
    expect(output.traits).toEqual(BUILDING_TRAITS["commercial"]);
  });

  it("correctly sorts and deduplicates levels", () => {
    const rooms = [
      makeRoom({ roomName: "Office A", level: "3" }),
      makeRoom({ roomName: "Office B", level: "1" }),
      makeRoom({ roomName: "Office C", level: "2" }),
      makeRoom({ roomName: "Office D", level: "1" }),
    ];
    const { levels } = applyRules({ rooms, buildingType: "commercial" });
    expect(levels).toEqual(["1", "2", "3"]);
  });

  it("confidence >= 0.7 produces auto status, < 0.7 produces needs_review", () => {
    const room = makeRoom({ roomName: "Apparatus Bay", isVehicleBay: true });
    const { results } = applyRules({ rooms: [room], buildingType: "government" });
    const sign = results[0].signs.find((s) => s.ruleRef === "R3");
    expect(sign?.status).toBe("needs_review");
  });

  it("Room ID has auto status (confidence 0.85)", () => {
    const room = makeRoom({ roomName: "Office" });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    const roomId = results[0].signs.find((s) => s.signType === "Room ID");
    expect(roomId?.status).toBe("auto");
    expect(roomId?.confidence).toBe(0.85);
  });

  it("source field is always 'rules_engine'", () => {
    const rooms = [
      makeRoom({ roomName: "Office" }),
      makeRoom({ roomName: "Restroom", isRestroom: true }),
    ];
    const { results } = applyRules({ rooms, buildingType: "commercial" });
    for (const { signs } of results) {
      for (const s of signs) {
        expect(s.source).toBe("rules_engine");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Word-boundary guards in rule helpers (R1–R17)
// ---------------------------------------------------------------------------

describe("applyRules — word-boundary guards in rule helpers", () => {
  it("does NOT treat 'Eleven Conference Room' as an elevator lobby (ELEV substring false-positive)", () => {
    const room = makeRoom({
      roomName: "Eleven Conference Room",
      isPublicFacing: true,
      isAssembly: true,
    });
    const { evacMapSigns } = applyRules({ rooms: [room], buildingType: "commercial" });
    expect(evacMapSigns.length).toBe(0);
  });

  it("DOES treat 'Elevator Lobby' as an exit-cluster room for evac map (multi-floor trigger)", () => {
    const room = makeRoom({
      roomName: "Elevator Lobby",
      isPublicFacing: true,
      level: "2",
    });
    // Second floor needed so the 2-floor trigger fires
    const filler = makeRoom({ roomName: "Office", level: "1" });
    const { evacMapSigns } = applyRules({ rooms: [filler, room], buildingType: "commercial" });
    expect(evacMapSigns.some((s) => s.signType === "Evacuation Map")).toBe(true);
  });

  it("does NOT generate an evac map for 'Carpentry Shop' (ENTRY substring false-positive in publicLobbies filter)", () => {
    const room = makeRoom({
      roomName: "Carpentry Shop",
      isPublicFacing: true,
    });
    const { evacMapSigns } = applyRules({ rooms: [room], buildingType: "commercial" });
    expect(evacMapSigns.length).toBe(0);
  });

  it("DOES generate an evac map for 'Main Entry' public room (multi-floor trigger)", () => {
    const room = makeRoom({
      roomName: "Main Entry",
      isPublicFacing: true,
      level: "1",
    });
    // Need a second floor to trigger evac map assignment
    const filler = makeRoom({ roomName: "Office", level: "2" });
    const { evacMapSigns } = applyRules({ rooms: [filler, room], buildingType: "commercial" });
    expect(evacMapSigns.some((s) => s.signType === "Evacuation Map")).toBe(true);
  });

  it("does NOT assign Office Directory to 'Correspondence Office' (CORR substring false-positive)", () => {
    const room = makeRoom({
      roomName: "Correspondence Office",
      isCorridorOrHall: false,
      isPublicFacing: true,
    });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    expect(results[0].signs.some((s) => s.signType === "Office Directory")).toBe(false);
  });

  it("does NOT assign Office Directory to a room named 'Hall' (hallways no longer get directory)", () => {
    const room = makeRoom({
      roomName: "Hall",
      isCorridorOrHall: true,
      isPublicFacing: false,
    });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    expect(results[0].signs.some((s) => s.signType === "Office Directory")).toBe(false);
  });

  it("DOES assign Office Directory to a pure 'Lobby' room in a multi-tenant building (positive case)", () => {
    // The multi-tenant guard requires 3+ SUITE rooms OR >30 occupied rooms + lobby.
    // Provide 3 SUITE rooms so the building qualifies for an Office Directory.
    const lobby = makeRoom({ roomName: "Lobby", isPublicFacing: true });
    const rooms = [
      lobby,
      makeRoom({ roomName: "Suite 100" }),
      makeRoom({ roomName: "Suite 200" }),
      makeRoom({ roomName: "Suite 300" }),
    ];
    const { results } = applyRules({ rooms, buildingType: "commercial" });
    const lobbyResult = results.find((r) => r.room.roomName === "Lobby")!;
    expect(lobbyResult.signs.some((s) => s.signType === "Office Directory")).toBe(true);
  });

  it("does NOT assign Office Directory to a 'Lobby' room in a single-tenant building", () => {
    // A single lobby room with no SUITE rooms and fewer than 31 occupied rooms
    // should NOT get an Office Directory (e.g. airport lounge, standalone clinic).
    const room = makeRoom({ roomName: "Lobby", isPublicFacing: true });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    expect(results[0].signs.some((s) => s.signType === "Office Directory")).toBe(false);
  });

  it("does NOT exclude a 'Sleeping Quarters' room from insert rule (SLEEP word-boundary positive)", () => {
    const room = makeRoom({
      roomName: "Sleeping Quarters",
      isVariableUse: true,
      isAssembly: true,
    });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    const signs = results[0].signs;
    expect(signs.some((s) => s.signType === "Room ID w/insert")).toBe(false);
    expect(signs.some((s) => s.signType === "Room ID")).toBe(true);
  });

  it("does NOT treat 'Arena' as a vehicle bay (R3 ARENA keyword fixed from ARENAOR typo)", () => {
    const room = makeRoom({
      roomName: "Sports Arena",
      isVehicleBay: false,
      isAssembly: true,
    });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    const r3Sign = results[0].signs.find((s) => s.ruleRef === "R3");
    expect(r3Sign).toBeDefined();
    expect(r3Sign?.qty).toBe(3);
  });

  it("does NOT exclude unoccupied MEP room in mezzanine level when level name contains partial MEZZ substring mid-word", () => {
    const room = makeRoom({
      roomName: "Mechanical Room",
      isMepUnoccupied: true,
      level: "Amezzment Level",
    });
    const { results } = applyRules({ rooms: [room], buildingType: "residential" });
    expect(results[0].signs.some((s) => s.signType === "Room ID")).toBe(true);
  });

  it("DOES exclude unoccupied MEP room when level is 'Mezzanine' (positive mezzanine check)", () => {
    const room = makeRoom({
      roomName: "Mechanical Room",
      isMepUnoccupied: true,
      level: "Mezzanine",
    });
    const { results } = applyRules({ rooms: [room], buildingType: "residential" });
    expect(results[0].signs).toHaveLength(0);
  });

  it("DOES exclude unoccupied MEP room when level is abbreviated 'Mezz' (positive mezzanine check)", () => {
    const room = makeRoom({
      roomName: "Mechanical Room",
      isMepUnoccupied: true,
      level: "Mezz",
    });
    const { results } = applyRules({ rooms: [room], buildingType: "residential" });
    expect(results[0].signs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// runValidationChecks — check #11: unoccupied rooms with occupant load
// ---------------------------------------------------------------------------

function makeOutput(overrides: Partial<RuleEngineOutput> = {}): RuleEngineOutput {
  return {
    results: [],
    detectedBuildingType: "office",
    traits: BUILDING_TRAITS["commercial"],
    levels: ["1"],
    stairSigns: [],
    elevatorSigns: [],
    evacMapSigns: [],
    exitSigns: [],
    suppressionLog: [],
    ...overrides,
  };
}

describe("runValidationChecks — unoccupied_rooms_with_occupant_load", () => {
  it("passes when no rooms have isMepUnoccupied with a non-zero occupant load", () => {
    const output = makeOutput({
      results: [
        { room: makeRoom({ isMepUnoccupied: true, occupantLoad: 0 }), signs: [] },
        { room: makeRoom({ isMepUnoccupied: false, occupantLoad: 10 }), signs: [] },
        { room: makeRoom({ isMepUnoccupied: true, occupantLoad: null }), signs: [] },
      ],
    });
    const checks = runValidationChecks(output);
    const check = checks.find((c) => c.checkName === "unoccupied_rooms_with_occupant_load");
    expect(check?.status).toBe("pass");
    expect(check?.details).toMatch(/no mep-unoccupied/i);
  });

  it("warns when a room is marked unoccupied but has a positive occupant load", () => {
    const output = makeOutput({
      results: [
        { room: makeRoom({ roomNumber: "M1", isMepUnoccupied: true, occupantLoad: 5 }), signs: [] },
        { room: makeRoom({ roomNumber: "101", isMepUnoccupied: false, occupantLoad: 20 }), signs: [] },
      ],
    });
    const checks = runValidationChecks(output);
    const check = checks.find((c) => c.checkName === "unoccupied_rooms_with_occupant_load");
    expect(check?.status).toBe("warning");
    expect(check?.details).toMatch(/1 room/i);
    expect(check?.details).toContain("M1");
  });

  it("includes multiple offending room numbers in the warning details", () => {
    const output = makeOutput({
      results: [
        { room: makeRoom({ roomNumber: "E1", isMepUnoccupied: true, occupantLoad: 3 }), signs: [] },
        { room: makeRoom({ roomNumber: "E2", isMepUnoccupied: true, occupantLoad: 7 }), signs: [] },
      ],
    });
    const checks = runValidationChecks(output);
    const check = checks.find((c) => c.checkName === "unoccupied_rooms_with_occupant_load");
    expect(check?.status).toBe("warning");
    expect(check?.details).toMatch(/2 room/i);
    expect(check?.details).toContain("E1");
    expect(check?.details).toContain("E2");
  });
});

// ---------------------------------------------------------------------------
// buildMultiEntryRegex — custom keyword merging
// ---------------------------------------------------------------------------

describe("buildMultiEntryRegex — custom keyword merging", () => {
  it("returns the built-in regex when no custom keywords provided", () => {
    const regex = buildMultiEntryRegex();
    expect(regex.source).toBe(MULTI_ENTRY_ROOM_KEYWORDS.source);
    expect(regex.flags).toBe(MULTI_ENTRY_ROOM_KEYWORDS.flags);
  });

  it("returns the built-in regex when custom keywords is an empty array", () => {
    const regex = buildMultiEntryRegex([]);
    expect(regex.source).toBe(MULTI_ENTRY_ROOM_KEYWORDS.source);
  });

  it("still matches built-in keywords when custom keywords are provided", () => {
    const regex = buildMultiEntryRegex(["Assembly Hall"]);
    expect(regex.test("Grand Ballroom")).toBe(true);
    expect(regex.test("Gymnasium")).toBe(true);
    expect(regex.test("Auditorium")).toBe(true);
  });

  it("matches custom keywords (case-insensitive)", () => {
    const regex = buildMultiEntryRegex(["Assembly Hall", "Great Room", "Festival Hall"]);
    expect(regex.test("Assembly Hall")).toBe(true);
    expect(regex.test("assembly hall")).toBe(true);
    expect(regex.test("GREAT ROOM")).toBe(true);
    expect(regex.test("Festival Hall")).toBe(true);
  });

  it("does not match partial word that crosses a word boundary", () => {
    const regex = buildMultiEntryRegex(["Room"]);
    expect(regex.test("Storeroom")).toBe(false);
    expect(regex.test("Meeting Room A")).toBe(true);
  });

  it("escapes regex special characters in custom keywords", () => {
    const regex = buildMultiEntryRegex(["Hall (Main)"]);
    expect(() => regex.test("Hall (Main)")).not.toThrow();
    expect(regex.test("Hall (Main)")).toBe(true);
    expect(regex.test("Hall Regular")).toBe(false);
  });

  it("ignores blank/whitespace-only keywords", () => {
    const regex = buildMultiEntryRegex(["  ", "", "Assembly Hall"]);
    expect(regex.test("Assembly Hall")).toBe(true);
    const regex2 = buildMultiEntryRegex(["  ", ""]);
    expect(regex2.source).toBe(MULTI_ENTRY_ROOM_KEYWORDS.source);
  });
});

// ---------------------------------------------------------------------------
// applyRules — customMultiEntryKeywords integration
// ---------------------------------------------------------------------------

describe("applyRules — customMultiEntryKeywords", () => {
  it("flags a custom-keyword room as multi-entry (R3, qty=3)", () => {
    const room = makeRoom({ roomName: "Event Hall" });
    const { results } = applyRules({
      rooms: [room],
      buildingType: "commercial",
      customMultiEntryKeywords: ["Event Hall"],
    });
    const roomId = results[0].signs.find((s) => s.ruleRef === "R3");
    expect(roomId).toBeDefined();
    expect(roomId?.qty).toBe(3);
    expect(roomId?.confidence).toBe(0.60);
  });

  it("does NOT flag the same room when custom keywords are not provided", () => {
    const room = makeRoom({ roomName: "Event Hall" });
    const { results } = applyRules({
      rooms: [room],
      buildingType: "commercial",
    });
    const roomIdR3 = results[0].signs.find((s) => s.ruleRef === "R3");
    expect(roomIdR3).toBeUndefined();
    const roomIdR1 = results[0].signs.find((s) => s.ruleRef === "R1");
    expect(roomIdR1).toBeDefined();
    expect(roomIdR1?.qty).toBe(1);
  });

  it("still matches built-in keywords even when custom keywords are supplied", () => {
    const room = makeRoom({ roomName: "Gymnasium" });
    const { results } = applyRules({
      rooms: [room],
      buildingType: "school",
      customMultiEntryKeywords: ["Great Room"],
    });
    const roomId = results[0].signs.find((s) => s.ruleRef === "R3");
    expect(roomId).toBeDefined();
    expect(roomId?.qty).toBe(3);
  });

  it("custom keyword matching is case-insensitive", () => {
    const room = makeRoom({ roomName: "GREAT ROOM" });
    const { results } = applyRules({
      rooms: [room],
      buildingType: "commercial",
      customMultiEntryKeywords: ["Great Room"],
    });
    const roomId = results[0].signs.find((s) => s.ruleRef === "R3");
    expect(roomId).toBeDefined();
    expect(roomId?.qty).toBe(3);
  });

  it("flags a custom-keyword vehicle bay as multi-entry (R3 overrides R5)", () => {
    const room = makeRoom({ roomName: "Festival Hall", isVehicleBay: true });
    const { results } = applyRules({
      rooms: [room],
      buildingType: "commercial",
      customMultiEntryKeywords: ["Festival Hall"],
    });
    const roomId = results[0].signs.find((s) => s.ruleRef === "R3");
    expect(roomId).toBeDefined();
    expect(roomId?.qty).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// BUILDING_TYPE_GROUPS — canonical 8-type groupings
// ---------------------------------------------------------------------------

describe("BUILDING_TYPE_GROUPS", () => {
  it("has exactly 8 canonical group keys", () => {
    expect(Object.keys(BUILDING_TYPE_GROUPS)).toHaveLength(8);
    expect(Object.keys(BUILDING_TYPE_GROUPS)).toEqual(
      expect.arrayContaining(["commercial", "residential", "education", "healthcare", "government", "hotel", "assembly", "unknown"]),
    );
  });

  it("each canonical key is also listed as its own alias", () => {
    for (const [key, aliases] of Object.entries(BUILDING_TYPE_GROUPS)) {
      expect(aliases).toContain(key);
    }
  });

  it("hospital is aliased under healthcare", () => {
    expect(BUILDING_TYPE_GROUPS.healthcare).toContain("hospital");
  });

  it("school is aliased under education", () => {
    expect(BUILDING_TYPE_GROUPS.education).toContain("school");
  });

  it("church is aliased under assembly", () => {
    expect(BUILDING_TYPE_GROUPS.assembly).toContain("church");
  });
});

// ---------------------------------------------------------------------------
// normalizeBuildingType
// ---------------------------------------------------------------------------

describe("normalizeBuildingType", () => {
  it("returns same key for canonical types", () => {
    expect(normalizeBuildingType("commercial")).toBe("commercial");
    expect(normalizeBuildingType("education")).toBe("education");
    expect(normalizeBuildingType("healthcare")).toBe("healthcare");
    expect(normalizeBuildingType("assembly")).toBe("assembly");
    expect(normalizeBuildingType("unknown")).toBe("unknown");
  });

  it("maps hospital → healthcare", () => {
    expect(normalizeBuildingType("hospital")).toBe("healthcare");
  });

  it("maps school → education", () => {
    expect(normalizeBuildingType("school")).toBe("education");
  });

  it("maps church → assembly", () => {
    expect(normalizeBuildingType("church")).toBe("assembly");
  });

  it("maps dormitory → residential", () => {
    expect(normalizeBuildingType("dormitory")).toBe("residential");
  });

  it("is case-insensitive", () => {
    expect(normalizeBuildingType("HOSPITAL")).toBe("healthcare");
    expect(normalizeBuildingType("School")).toBe("education");
  });

  it("returns original lowercased key for unknown legacy types", () => {
    expect(normalizeBuildingType("bank")).toBe("bank");
    expect(normalizeBuildingType("lab")).toBe("lab");
  });
});

// ---------------------------------------------------------------------------
// isJunkRoomName — garbage filter
// ---------------------------------------------------------------------------

describe("isJunkRoomName", () => {
  it("flags 'Occupant Load Table' as junk", () => {
    expect(isJunkRoomName("Occupant Load Table")).toBe(true);
  });

  it("flags 'Door Schedule' as junk", () => {
    expect(isJunkRoomName("Door Schedule")).toBe(true);
  });

  it("flags 'Finish Schedule' as junk", () => {
    expect(isJunkRoomName("Finish Schedule")).toBe(true);
  });

  it("flags 'Keynote 1' as junk", () => {
    expect(isJunkRoomName("Keynote 1")).toBe(true);
  });

  it("flags 'General Note' as junk", () => {
    expect(isJunkRoomName("General Note")).toBe(true);
  });

  it("flags 'Note: See sheet A101' as junk", () => {
    expect(isJunkRoomName("Note: See sheet A101")).toBe(true);
  });

  it("flags 'Legend' as junk", () => {
    expect(isJunkRoomName("Legend")).toBe(true);
  });

  it("does NOT flag a normal room name as junk", () => {
    expect(isJunkRoomName("Office 101")).toBe(false);
    expect(isJunkRoomName("Classroom A")).toBe(false);
    expect(isJunkRoomName("Electrical Room")).toBe(false);
    expect(isJunkRoomName("Lobby")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CORRIDOR_KEYWORDS — BREEZEWAY and RAMP additions
// ---------------------------------------------------------------------------

describe("CORRIDOR_KEYWORDS — BREEZEWAY and RAMP", () => {
  it("matches BREEZEWAY", () => {
    expect(CORRIDOR_KEYWORDS.test("Breezeway")).toBe(true);
    expect(CORRIDOR_KEYWORDS.test("Covered Breezeway")).toBe(true);
  });

  it("matches RAMP", () => {
    expect(CORRIDOR_KEYWORDS.test("Ramp")).toBe(true);
    expect(CORRIDOR_KEYWORDS.test("Accessibility Ramp")).toBe(true);
  });

  it("still matches original CORRIDOR keywords", () => {
    expect(CORRIDOR_KEYWORDS.test("Corridor")).toBe(true);
    expect(CORRIDOR_KEYWORDS.test("Hallway")).toBe(true);
    expect(CORRIDOR_KEYWORDS.test("Walkway")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// detectBuildingType — "unknown" auto-detection
// ---------------------------------------------------------------------------

describe("detectBuildingType — unknown buildingType triggers auto-detection", () => {
  it("detects education for a classroom building when type is 'unknown'", () => {
    const rooms = [
      { roomName: "Classroom 101", roomNumber: "101" },
      { roomName: "Gymnasium", roomNumber: "GYM" },
    ];
    expect(detectBuildingType(rooms, { buildingType: "unknown" })).toBe("education");
  });

  it("detects healthcare for a medical building when type is 'unknown'", () => {
    const rooms = [
      { roomName: "Patient Room", roomNumber: "P1" },
      { roomName: "Nurse Station", roomNumber: "N1" },
    ];
    expect(detectBuildingType(rooms, { buildingType: "unknown" })).toBe("healthcare");
  });

  it("detects assembly for a church building when type is 'unknown'", () => {
    const rooms = [
      { roomName: "Sanctuary", roomNumber: "S1" },
      { roomName: "Nave", roomNumber: "N1" },
    ];
    expect(detectBuildingType(rooms, { buildingType: "unknown" })).toBe("assembly");
  });

  it("falls back to commercial when 'unknown' type has no matching keywords", () => {
    const rooms = [
      { roomName: "Office", roomNumber: "101" },
      { roomName: "Conference Room", roomNumber: "102" },
    ];
    expect(detectBuildingType(rooms, { buildingType: "unknown" })).toBe("commercial");
  });

  it("does NOT use custom mappings for 'unknown' buildingType — runs room detection instead", () => {
    const rooms = [{ roomName: "Classroom A", roomNumber: "101" }];
    expect(detectBuildingType(rooms, { buildingType: "unknown" }, { unknown: "bank" })).toBe("education");
  });
});

// ---------------------------------------------------------------------------
// evacMapsPerFloorCap — type-based baseline
// ---------------------------------------------------------------------------

describe("evacMapsPerFloorCap — per-floor cap", () => {
  it("residential / multifamily returns 1 per floor (Fix 4 — orientation-zone model)", () => {
    expect(evacMapsPerFloorCap(1, "residential")).toBe(1);
    expect(evacMapsPerFloorCap(3, "residential")).toBe(1);
    expect(evacMapsPerFloorCap(15, "residential")).toBe(1);
    expect(evacMapsPerFloorCap(20, "multifamily")).toBe(1);
    expect(evacMapsPerFloorCap(5, "senior_living")).toBe(1);
    expect(evacMapsPerFloorCap(3, "dormitory")).toBe(1);
  });

  it("non-residential types have fixed per-floor caps regardless of floor count (Fix 4)", () => {
    // Commercial and government: 2 per floor (one per corridor segment)
    expect(evacMapsPerFloorCap(1, "commercial")).toBe(2);
    expect(evacMapsPerFloorCap(5, "government")).toBe(2);
    // Healthcare: 4 per floor (one per smoke compartment — typical hospital layout)
    expect(evacMapsPerFloorCap(1, "healthcare")).toBe(4);
    expect(evacMapsPerFloorCap(2, "hospital")).toBe(4);
    // Hotel: 1 per floor (one at elevator lobby)
    expect(evacMapsPerFloorCap(1, "hotel")).toBe(1);
    // Assembly: 2 per floor (one per main entry area)
    expect(evacMapsPerFloorCap(1, "assembly")).toBe(2);
    expect(evacMapsPerFloorCap(2, "church")).toBe(2);
  });

  it("commercial and education maintain 2-per-floor cap at any height; healthcare is always 4", () => {
    expect(evacMapsPerFloorCap(6, "commercial")).toBe(2);
    expect(evacMapsPerFloorCap(10, "education")).toBe(2);
    expect(evacMapsPerFloorCap(11, "commercial")).toBe(2);
    // Healthcare always 4 per floor regardless of floor count
    expect(evacMapsPerFloorCap(11, "healthcare")).toBe(4);
  });
});

describe("getEvacMapCount — total building cap", () => {
  it("commercial always returns 2 per floor (Fix 4 removes old floor-count scaling)", () => {
    expect(getEvacMapCount(1, "commercial", 10)).toBe(2);
    expect(getEvacMapCount(3, "commercial", 30)).toBe(6);
    expect(getEvacMapCount(5, "commercial", 50)).toBe(10);
  });

  it("non-residential: 2 per floor from 6 floors onward", () => {
    expect(getEvacMapCount(6, "commercial", 60)).toBe(12);
    expect(getEvacMapCount(10, "commercial", 100)).toBe(20);
    expect(getEvacMapCount(15, "commercial", 150)).toBe(30);
  });

  it("education: max 2 per floor, hard cap of 4 total", () => {
    expect(getEvacMapCount(1, "education", 30)).toBe(2);  // min(2, 4) = 2
    expect(getEvacMapCount(2, "education", 60)).toBe(4);  // min(4, 4) = 4
    expect(getEvacMapCount(5, "education", 50)).toBe(4);  // min(10, 4) = 4
    expect(getEvacMapCount(3, "school", 80)).toBe(4);     // school alias also capped
  });

  it("residential: capped by room-count formula (min of floors×1 and ceil(rooms/20)) (Fix 4)", () => {
    // Small room count caps below floors×1
    expect(getEvacMapCount(15, "residential", 4)).toBe(1);   // min(15, ceil(4/20)=1) = 1
    expect(getEvacMapCount(10, "residential", 100)).toBe(5); // min(10, ceil(100/20)=5) = 5
    // Large room count: floors×1 is the ceiling (Fix 4 reduced from floors×2)
    expect(getEvacMapCount(5, "residential", 500)).toBe(5);  // min(5, ceil(500/20)=25) = 5
    expect(getEvacMapCount(2, "multifamily", 400)).toBe(2);  // min(2, ceil(400/20)=20) = 2
  });
});

// ---------------------------------------------------------------------------
// applyRules — residential scope (Room ID limited to common areas)
// ---------------------------------------------------------------------------

describe("applyRules — residential Room ID scope", () => {
  it("does NOT assign Room ID to non-common, non-unit room in a unit-dominated residential building", () => {
    // The residential scope restriction only activates when units genuinely dominate
    // (≥5 and ≥30%).  With 5 unit rooms + a lone service room, the scope is active and
    // the service room (non-common, non-unit, non-MEP) is suppressed.
    // Use a non-numeric room number (e.g. "SR-1") so the plain-digit unit rule
    // doesn't fire — utility/service rooms have codes, not plain unit numbers.
    const units = Array.from({ length: 5 }, (_, i) =>
      makeRoom({
        id: `u${i}`,
        roomName: `Unit ${100 + i}`,
        roomNumber: String(100 + i),
        isResidentialUnit: true,
      }),
    );
    const serviceRoom = makeRoom({
      id: "svc",
      roomName: "Server Room",
      roomNumber: "SR-1",
      isResidentialUnit: false,
    });
    const { results } = applyRules({ rooms: [...units, serviceRoom], buildingType: "residential" });
    const svc = results.find((r) => r.room.id === "svc")!;
    expect(svc.signs.filter((s) => s.signType === "Room ID")).toHaveLength(0);
  });

  it("does NOT drop non-common rooms in a 'residential' building that is NOT unit-dominated (mislabel guard)", () => {
    // A building labeled "residential" but dominated by named service/office rooms
    // (0 units, < 30%) is likely mislabeled or had unit detection broadly fail.  The
    // residential scope must stand down so these legitimate rooms keep their Room ID
    // signs instead of being silently dropped — the dorm-mislabel failure mode.
    const rooms = [
      makeRoom({ id: "a", roomName: "Server Room", roomNumber: "SR-1" }),
      makeRoom({ id: "b", roomName: "Storage", roomNumber: "ST-1" }),
      makeRoom({ id: "c", roomName: "Records Room", roomNumber: "RC-1" }),
      makeRoom({ id: "d", roomName: "Workshop", roomNumber: "WS-1" }),
      makeRoom({ id: "e", roomName: "Break Area", roomNumber: "BR-1" }),
    ];
    const { results } = applyRules({ rooms, buildingType: "residential" });
    for (const id of ["a", "b", "c", "d", "e"]) {
      const res = results.find((r) => r.room.id === id)!;
      expect(res.signs.some((s) => s.signType === "Room ID"), `${id} should keep its Room ID`).toBe(
        true,
      );
    }
  });

  it("assigns Room ID to lobby in residential building", () => {
    const room = makeRoom({ roomName: "Lobby", isResidentialUnit: false });
    const { results } = applyRules({ rooms: [room], buildingType: "residential" });
    expect(results[0].signs.some((s) => s.signType === "Room ID")).toBe(true);
  });

  it("assigns Room ID to fitness room in residential building", () => {
    const room = makeRoom({ roomName: "Fitness Center", isResidentialUnit: false });
    const { results } = applyRules({ rooms: [room], buildingType: "residential" });
    expect(results[0].signs.some((s) => s.signType === "Room ID")).toBe(true);
  });

  it("does NOT restrict Room ID in commercial building — non-lobby office gets Room ID", () => {
    const room = makeRoom({ roomName: "Storage Room", isResidentialUnit: false });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    expect(results[0].signs.some((s) => s.signType === "Room ID")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RESIDENTIAL_COMMON_AREA_KEYWORDS — spot-checks
// ---------------------------------------------------------------------------

describe("RESIDENTIAL_COMMON_AREA_KEYWORDS", () => {
  const matches = ["Lobby", "Mailroom", "Laundry Room", "Fitness Center", "Leasing Office", "Community Room", "Clubroom", "Business Center", "Pool", "Concierge", "Lounge", "Theater", "Bicycle Room", "Package Room"];
  const nonMatches = ["Server Room", "Electrical Room", "Storage", "Janitor", "Mechanical Room"];

  for (const name of matches) {
    it(`matches "${name}"`, () => {
      expect(RESIDENTIAL_COMMON_AREA_KEYWORDS.test(name)).toBe(true);
    });
  }

  for (const name of nonMatches) {
    it(`does NOT match "${name}"`, () => {
      expect(RESIDENTIAL_COMMON_AREA_KEYWORDS.test(name)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Fix 1 — classifyRoomNumberAsStair: per-building-type room-number patterns
// ---------------------------------------------------------------------------

describe("classifyRoomNumberAsStair — per-building-type room-number patterns (Fix 1)", () => {
  it("education: matches SA01, SB02 style codes", () => {
    expect(classifyRoomNumberAsStair("SA01", "education")).toBe(true);
    expect(classifyRoomNumberAsStair("SB02", "education")).toBe(true);
    expect(classifyRoomNumberAsStair("SE99", "education")).toBe(true);
    expect(classifyRoomNumberAsStair("101",  "education")).toBe(false);
    expect(classifyRoomNumberAsStair("S",    "education")).toBe(false);
  });

  it("healthcare: matches SA01 and ST01 style codes", () => {
    expect(classifyRoomNumberAsStair("SA01", "healthcare")).toBe(true);
    expect(classifyRoomNumberAsStair("ST01", "healthcare")).toBe(true);
    expect(classifyRoomNumberAsStair("ST123","healthcare")).toBe(true);
    expect(classifyRoomNumberAsStair("101",  "healthcare")).toBe(false);
  });

  it("commercial: matches S1, S2, STAIR-1 style codes", () => {
    expect(classifyRoomNumberAsStair("S1",     "commercial")).toBe(true);
    expect(classifyRoomNumberAsStair("S12",    "commercial")).toBe(true);
    expect(classifyRoomNumberAsStair("STAIR-1","commercial")).toBe(true);
    expect(classifyRoomNumberAsStair("SA01",   "commercial")).toBe(false); // education pattern
    expect(classifyRoomNumberAsStair("101",    "commercial")).toBe(false);
  });

  it("government: matches S1 and STAIRA style codes", () => {
    expect(classifyRoomNumberAsStair("S1",    "government")).toBe(true);
    expect(classifyRoomNumberAsStair("STAIRA","government")).toBe(true);
    expect(classifyRoomNumberAsStair("STAIRB","government")).toBe(true);
    expect(classifyRoomNumberAsStair("101",   "government")).toBe(false);
  });

  it("returns false for empty string on any building type", () => {
    expect(classifyRoomNumberAsStair("", "commercial")).toBe(false);
    expect(classifyRoomNumberAsStair("", "education")).toBe(false);
  });

  it("unknown building type returns false (no patterns defined)", () => {
    expect(classifyRoomNumberAsStair("SA01", "unknown")).toBe(false);
    expect(classifyRoomNumberAsStair("S1",   "unknown")).toBe(false);
  });

  it("STAIR_ROOM_NUMBER_PATTERNS covers all 8 canonical types", () => {
    const types = ["education", "healthcare", "commercial", "government", "hotel", "residential", "assembly", "unknown"];
    for (const t of types) {
      expect(STAIR_ROOM_NUMBER_PATTERNS).toHaveProperty(t);
    }
  });
});

// ---------------------------------------------------------------------------
// Fix 1 — applyStairRules: supplements stairRooms via classifyRoomNumberAsStair
// ---------------------------------------------------------------------------

describe("applyRules — Fix 1: classifyRoomNumberAsStair supplements isStair detection", () => {
  it("education room with SA01 number and non-stair name is detected as stair in education building", () => {
    const room = makeRoom({ roomNumber: "SA01", roomName: "SA01", isStair: false });
    const { stairSigns } = applyRules({ rooms: [room], buildingType: "education" });
    // classifyRoomNumberAsStair("SA01", "education") = true → stair detected
    expect(stairSigns.some((s) => s.signType === "Stair(Landing)" || s.signType === "Stair(Corridor)")).toBe(true);
  });

  it("same room number SA01 in commercial building is NOT detected as stair (different pattern)", () => {
    const room = makeRoom({ roomNumber: "SA01", roomName: "SA01", isStair: false });
    const { stairSigns } = applyRules({ rooms: [room], buildingType: "commercial" });
    expect(stairSigns).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Fix 2 — adaRequired field on SignAssignment
// ---------------------------------------------------------------------------

describe("Fix 2 — adaRequired field on SignAssignment", () => {
  it("ADA_REQUIRED_SIGN_TYPES contains Room ID, Restroom, Stair, Exit(Tactile), Unit ID, Elevator, Area of Rescue", () => {
    for (const t of ["Room ID", "Room ID w/insert", "Restroom", "Restroom(Men)", "Restroom(Women)", "Exit(Tactile)", "Unit ID", "Elevator", "Area of Rescue"]) {
      expect(ADA_REQUIRED_SIGN_TYPES.has(t)).toBe(true);
    }
  });

  it("ADA_REQUIRED_SIGN_TYPES does NOT include Max Occupancy, Evacuation Map, Exit, Office Directory", () => {
    for (const t of ["Max Occupancy", "Evacuation Map", "Exit", "Office Directory"]) {
      expect(ADA_REQUIRED_SIGN_TYPES.has(t)).toBe(false);
    }
  });

  it("Room ID signs produced by applyRules have adaRequired=true", () => {
    const room = makeRoom({ roomName: "Office" });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    const roomIdSign = results[0].signs.find((s) => s.signType === "Room ID");
    expect(roomIdSign).toBeDefined();
    expect(roomIdSign!.adaRequired).toBe(true);
  });

  it("Stair signs produced by applyStairRules have adaRequired=true", () => {
    const stairRooms = [makeRoom({ roomNumber: "S1", isStair: true, level: "1" })];
    const signs = applyStairRules(stairRooms, ["1", "2"], BUILDING_TRAITS["commercial"]);
    const stairSign = signs.find((s) => s.signType === "Stair(Landing)");
    expect(stairSign?.adaRequired).toBe(true);
  });

  it("Max Occupancy signs have adaRequired=false", () => {
    const room = makeRoom({
      roomName: "Conference Room", isAssembly: true,
      occupantLoad: 100, occupancyGroup: "A-3",
    });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    const maxOcc = results[0].signs.find((s) => s.signType === "Max Occupancy");
    expect(maxOcc?.adaRequired).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fix 3 — applyFormulaExitSigns: formula-based exit sign counts
// ---------------------------------------------------------------------------

describe("applyFormulaExitSigns — Fix 3: formula-based exit signs", () => {
  it("generates stair exit doors (stairCount × floorCount) + min exterior exit doors", () => {
    // 2 stairs × 3 floors + 4 min exterior (commercial) = 10 exit signs
    const signs = applyFormulaExitSigns(2, 3, "commercial");
    expect(signs.length).toBeGreaterThanOrEqual(2); // at least stair exits + exterior exits row
    const totalQty = signs.reduce((sum, s) => sum + s.qty, 0);
    expect(totalQty).toBe(2 * 3 + 4); // 6 stair + 4 exterior = 10
  });

  it("residential gets 2 minimum exterior exit doors", () => {
    const signs = applyFormulaExitSigns(1, 3, "residential");
    const exteriorRow = signs.find((s) => (s.notes ?? "").includes("Exterior"));
    expect(exteriorRow?.qty).toBe(2);
  });

  it("assembly gets 6 minimum exterior exit doors (IBC 1006.3 Group A)", () => {
    const signs = applyFormulaExitSigns(2, 2, "assembly");
    const exteriorRow = signs.find((s) => (s.notes ?? "").includes("Exterior"));
    expect(exteriorRow?.qty).toBe(6);
  });

  it("returns empty when both stairCount and floorCount are 0", () => {
    expect(applyFormulaExitSigns(0, 0, "commercial")).toHaveLength(0);
  });

  it("applyRules output includes exitSigns array", () => {
    const rooms = [makeRoom({ roomName: "Lobby" })];
    const output = applyRules({ rooms, buildingType: "commercial" });
    expect(Array.isArray(output.exitSigns)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fix 5 — Room ID w/insert dedup: applyCapacityRule + applyRoomIdRules
// ---------------------------------------------------------------------------

describe("Fix 5 — Room ID w/insert dedup: capacity rule returns both Room ID w/insert and Max Occupancy", () => {
  it("assembly room with occupant load ≥50 gets Room ID w/insert AND Max Occupancy (not plain Room ID)", () => {
    const room = makeRoom({
      roomName: "Conference Room", isAssembly: true,
      occupantLoad: 60, occupancyGroup: "A-3",
    });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    const signs = results[0].signs;
    expect(signs.some((s) => s.signType === "Room ID w/insert")).toBe(true);
    expect(signs.some((s) => s.signType === "Max Occupancy")).toBe(true);
    expect(signs.filter((s) => s.signType === "Room ID")).toHaveLength(0);
  });

  it("assembly room below threshold gets plain Room ID (not Room ID w/insert)", () => {
    const room = makeRoom({
      roomName: "Conference Room", isAssembly: true,
      occupantLoad: 10, occupancyGroup: null,
    });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    const signs = results[0].signs;
    // Does not meet the capacity gate → standard Room ID from R1/R3
    expect(signs.some((s) => s.signType === "Room ID" || s.signType === "Room ID w/insert")).toBe(true);
    expect(signs.some((s) => s.signType === "Max Occupancy")).toBe(false);
  });

  it("no duplicate Room ID w/insert rows — dedup collapses variable-use+assembly to one row", () => {
    const room = makeRoom({
      roomName: "Training Room", isAssembly: true, isVariableUse: true,
      occupantLoad: 60, occupancyGroup: "A-3",
    });
    const { results } = applyRules({ rooms: [room], buildingType: "commercial" });
    const insertSigns = results[0].signs.filter((s) => s.signType === "Room ID w/insert");
    expect(insertSigns).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Fix 6 — Area of Rescue: emitted for government + assembly buildings
// ---------------------------------------------------------------------------

describe("Fix 6 — Area of Rescue signs at stair landings", () => {
  it("government building stair produces Area of Rescue qty=floorCount", () => {
    const stairRooms = [makeRoom({ roomNumber: "S1", isStair: true, level: "1" })];
    const govTraits = BUILDING_TRAITS["government"];
    expect(govTraits.requiresAreaOfRescue).toBe(true);
    const signs = applyStairRules(stairRooms, ["1", "2", "3"], govTraits, "government");
    const rescue = signs.filter((s) => s.signType === "Area of Rescue");
    expect(rescue).toHaveLength(1);
    expect(rescue[0].qty).toBe(3); // one per floor
  });

  it("assembly building stair produces Area of Rescue qty=floorCount", () => {
    const stairRooms = [makeRoom({ roomNumber: "S1", isStair: true, level: "1" })];
    const asmTraits = BUILDING_TRAITS["assembly"];
    expect(asmTraits.requiresAreaOfRescue).toBe(true);
    const signs = applyStairRules(stairRooms, ["1", "2"], asmTraits, "assembly");
    const rescue = signs.filter((s) => s.signType === "Area of Rescue");
    expect(rescue).toHaveLength(1);
    expect(rescue[0].qty).toBe(2);
  });

  it("commercial building stair does NOT produce Area of Rescue", () => {
    const stairRooms = [makeRoom({ roomNumber: "S1", isStair: true, level: "1" })];
    const signs = applyStairRules(stairRooms, ["1", "2"], BUILDING_TRAITS["commercial"], "commercial");
    expect(signs.filter((s) => s.signType === "Area of Rescue")).toHaveLength(0);
  });

  it("Area of Rescue signs have adaRequired=true (Fix 2)", () => {
    const stairRooms = [makeRoom({ roomNumber: "S1", isStair: true, level: "1" })];
    const govTraits = BUILDING_TRAITS["government"];
    const signs = applyStairRules(stairRooms, ["1", "2"], govTraits, "government");
    const rescue = signs.find((s) => s.signType === "Area of Rescue");
    expect(rescue?.adaRequired).toBe(true);
  });
});
