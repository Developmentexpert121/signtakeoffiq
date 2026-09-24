import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import {
  parseTakeoffSpreadsheet,
  stripSignCode,
  isTruthyCell,
  isRoomMetaCol,
} from "./spreadsheet-parser";

// ---------------------------------------------------------------------------
// Helper: build an in-memory XLSX buffer from a 2-D array of rows
// ---------------------------------------------------------------------------
function makeXlsx(rows: (string | number)[][]): Buffer {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}

// Helper: build a multi-sheet XLSX buffer
function makeXlsxMultiSheet(sheets: { name: string; rows: (string | number)[][] }[]): Buffer {
  const wb = XLSX.utils.book_new();
  for (const { name, rows } of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}

// ---------------------------------------------------------------------------
// stripSignCode
// ---------------------------------------------------------------------------
describe("stripSignCode", () => {
  it("strips 2-letter + digit codes (AA1, BB3, DD1)", () => {
    expect(stripSignCode("Directory AA1")).toBe("Directory");
    expect(stripSignCode("Stairwell BB3")).toBe("Stairwell");
    expect(stripSignCode("Regulatory DD1")).toBe("Regulatory");
  });

  it("strips 2-letter + digit + letter codes (BB2A, SS1A)", () => {
    expect(stripSignCode("Room ID BB2B")).toBe("Room ID");
    expect(stripSignCode("Stair ID SS1A")).toBe("Stair ID");
    expect(stripSignCode("Permanent Room ID BB2A")).toBe("Permanent Room ID");
  });

  it("does NOT strip all-letter suffixes (LED, ADA, ID)", () => {
    expect(stripSignCode("Programmable LED")).toBe("Programmable LED");
    expect(stripSignCode("Room ID")).toBe("Room ID");
  });

  it("returns the original value when nothing to strip", () => {
    expect(stripSignCode("Restroom")).toBe("Restroom");
  });
});

// ---------------------------------------------------------------------------
// isTruthyCell
// ---------------------------------------------------------------------------
describe("isTruthyCell", () => {
  it("treats empty / zero / N / dash as falsy", () => {
    expect(isTruthyCell("").truthy).toBe(false);
    expect(isTruthyCell("0").truthy).toBe(false);
    expect(isTruthyCell("N").truthy).toBe(false);
    expect(isTruthyCell("NO").truthy).toBe(false);
    expect(isTruthyCell("-").truthy).toBe(false);
  });

  it("treats X / YES / Y / TRUE as truthy with qty=1", () => {
    expect(isTruthyCell("X")).toEqual({ truthy: true, qty: 1 });
    expect(isTruthyCell("YES")).toEqual({ truthy: true, qty: 1 });
    expect(isTruthyCell("y")).toEqual({ truthy: true, qty: 1 });
    expect(isTruthyCell("true")).toEqual({ truthy: true, qty: 1 });
  });

  it("treats positive numbers as truthy with correct qty", () => {
    expect(isTruthyCell("1")).toEqual({ truthy: true, qty: 1 });
    expect(isTruthyCell("3")).toEqual({ truthy: true, qty: 3 });
    expect(isTruthyCell("2.7")).toEqual({ truthy: true, qty: 3 });
  });

  it("treats 0 numeric as falsy", () => {
    expect(isTruthyCell("0.0").truthy).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isRoomMetaCol
// ---------------------------------------------------------------------------
describe("isRoomMetaCol", () => {
  it("recognises standard room-metadata column names", () => {
    expect(isRoomMetaCol("Room #")).toBe(true);
    expect(isRoomMetaCol("Room")).toBe(true);
    expect(isRoomMetaCol("Bldg")).toBe(true);
    expect(isRoomMetaCol("NOTES")).toBe(true);
    expect(isRoomMetaCol("Level")).toBe(true);
  });

  it("does NOT treat sign-type columns as metadata", () => {
    expect(isRoomMetaCol("Directory AA1")).toBe(false);
    expect(isRoomMetaCol("Restroom BB7A")).toBe(false);
    expect(isRoomMetaCol("Programmable LED")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseTakeoffSpreadsheet — tall format (Sign Type | Room # | Room Name)
// ---------------------------------------------------------------------------
describe("parseTakeoffSpreadsheet – tall format", () => {
  it("parses a basic tall-format sheet", () => {
    const buf = makeXlsx([
      ["Sign Type", "Room #", "Room Name", "Level"],
      ["Restroom", "101", "WOMEN'S RESTROOM", "1"],
      ["Room ID", "102", "CONFERENCE RM", "1"],
    ]);
    const rows = parseTakeoffSpreadsheet(buf, "test.xlsx");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ signType: "Restroom", roomNumber: "101", roomName: "WOMEN'S RESTROOM", level: "1" });
    expect(rows[1]).toMatchObject({ signType: "Room ID", roomNumber: "102", roomName: "CONFERENCE RM" });
  });

  it("skips rows where Sign Type or Room Name is blank", () => {
    const buf = makeXlsx([
      ["Sign Type", "Room #", "Room Name"],
      ["", "103", "LOBBY"],
      ["Room ID", "104", ""],
      ["Exit", "105", "STAIR A"],
    ]);
    const rows = parseTakeoffSpreadsheet(buf, "test.xlsx");
    expect(rows).toHaveLength(1);
    expect(rows[0].signType).toBe("Exit");
  });

  it("finds headers even when blank rows appear before them", () => {
    const buf = makeXlsx([
      ["", "", ""],
      ["My Project Logo", "", ""],
      ["Sign Type", "Room #", "Room Name", "Level"],
      ["Restroom", "200", "MEN'S RESTROOM", "2"],
    ]);
    const rows = parseTakeoffSpreadsheet(buf, "test.xlsx");
    expect(rows).toHaveLength(1);
    expect(rows[0].roomName).toBe("MEN'S RESTROOM");
  });

  it("throws a descriptive error when neither format is found", () => {
    const buf = makeXlsx([
      ["Foo", "Bar", "Baz"],
      ["1", "2", "3"],
    ]);
    expect(() => parseTakeoffSpreadsheet(buf, "bad.xlsx")).toThrow(
      /Could not find a matching header/i
    );
  });
});

// ---------------------------------------------------------------------------
// parseTakeoffSpreadsheet — wide format (Room # | Room | SignType1 | SignType2)
// ---------------------------------------------------------------------------
describe("parseTakeoffSpreadsheet – wide format (SOF-style)", () => {
  it("parses a basic wide-format sheet and unpivots correctly", () => {
    const buf = makeXlsx([
      ["Room #", "Room", "Restroom BB7A", "Room ID BB2B", "NOTES"],
      ["101", "WOMEN'S RESTROOM", "1", "", ""],
      ["102", "CONFERENCE RM", "", "1", ""],
      ["103", "LOBBY", "0", "1", ""],
    ]);
    const rows = parseTakeoffSpreadsheet(buf, "wide.xlsx");
    // 101 → Restroom; 102 → Room ID; 103 → Room ID (0 skipped)
    expect(rows).toHaveLength(3);
    const [r1, r2, r3] = rows;
    expect(r1).toMatchObject({ signType: "Restroom", roomNumber: "101", roomName: "WOMEN'S RESTROOM" });
    expect(r2).toMatchObject({ signType: "Room ID", roomNumber: "102", roomName: "CONFERENCE RM" });
    expect(r3).toMatchObject({ signType: "Room ID", roomNumber: "103", roomName: "LOBBY" });
  });

  it("accepts X and truthy strings as quantity 1", () => {
    const buf = makeXlsx([
      ["Room #", "Room", "Exit Tactile BB4", "Emergency Egress BB2E"],
      ["201", "EXIT CORRIDOR", "X", "YES"],
    ]);
    const rows = parseTakeoffSpreadsheet(buf, "wide.xlsx");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ signType: "Exit Tactile", qty: 1 });
    expect(rows[1]).toMatchObject({ signType: "Emergency Egress", qty: 1 });
  });

  it("strips sign codes from column headers", () => {
    const buf = makeXlsx([
      ["Room #", "Room", "Floor Directory AA2", "Stair ID SS1A", "Programmable LED"],
      ["301", "LOBBY", "1", "1", "1"],
    ]);
    const rows = parseTakeoffSpreadsheet(buf, "wide.xlsx");
    const types = rows.map(r => r.signType);
    expect(types).toContain("Floor Directory");
    expect(types).toContain("Stair ID");
    expect(types).toContain("Programmable LED");
  });

  it("skips rows where both Room # and Room are blank", () => {
    const buf = makeXlsx([
      ["Room #", "Room", "Restroom BB7A"],
      ["", "", "1"],
      ["101", "RESTROOM", "1"],
    ]);
    const rows = parseTakeoffSpreadsheet(buf, "wide.xlsx");
    expect(rows).toHaveLength(1);
    expect(rows[0].roomNumber).toBe("101");
  });

  it("handles cells with numeric quantities > 1", () => {
    const buf = makeXlsx([
      ["Room #", "Room", "Room ID BB2B"],
      ["401", "MULTI-TENANT SUITE", "3"],
    ]);
    const rows = parseTakeoffSpreadsheet(buf, "wide.xlsx");
    expect(rows).toHaveLength(1);
    expect(rows[0].qty).toBe(3);
  });

  it("finds the header row when blank rows appear above it", () => {
    const buf = makeXlsx([
      ["", "", ""],
      ["PROJECT TITLE", "", ""],
      ["Room #", "Room", "Bldg", "Directory AA1", "Restroom BB7A"],
      ["S1", "LOBBY", "Building A", "1", ""],
      ["S2", "RESTROOM", "Building A", "", "1"],
    ]);
    const rows = parseTakeoffSpreadsheet(buf, "sof.xlsx");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ signType: "Directory", roomNumber: "S1", roomName: "LOBBY" });
    expect(rows[1]).toMatchObject({ signType: "Restroom", roomNumber: "S2", roomName: "RESTROOM" });
  });

  it("uses Bldg column as the level when no Level column exists", () => {
    const buf = makeXlsx([
      ["Room #", "Room", "Bldg", "Room ID BB2B"],
      ["101", "OFFICE", "Level 1", "1"],
    ]);
    const rows = parseTakeoffSpreadsheet(buf, "sof.xlsx");
    expect(rows[0].level).toBe("Level 1");
  });
});

// ---------------------------------------------------------------------------
// parseTakeoffSpreadsheet — custom column name aliases (Door #, Text on Sign)
// ---------------------------------------------------------------------------
describe("parseTakeoffSpreadsheet – custom column name aliases", () => {
  it("accepts 'Door #' as the room-number column and 'Text on Sign' as room-name", () => {
    const buf = makeXlsx([
      ["Door #", "Text on Sign", "Room ID", "Restroom"],
      ["101", "OFFICE", "1", ""],
      ["102", "WOMEN'S RESTROOM", "", "1"],
    ]);
    const rows = parseTakeoffSpreadsheet(buf, "chelmsford.xlsx");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ signType: "Room ID", roomNumber: "101", roomName: "OFFICE" });
    expect(rows[1]).toMatchObject({ signType: "Restroom", roomNumber: "102", roomName: "WOMEN'S RESTROOM" });
  });

  it("accepts 'Unit #' as the room-number column", () => {
    const buf = makeXlsx([
      ["Unit #", "Room Name", "Room ID"],
      ["A1", "LOBBY", "1"],
    ]);
    const rows = parseTakeoffSpreadsheet(buf, "units.xlsx");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ roomNumber: "A1", roomName: "LOBBY", signType: "Room ID" });
  });

  it("accepts 'Space #' as the room-number column", () => {
    const buf = makeXlsx([
      ["Space #", "Space Name", "Directory"],
      ["S1", "MAIN LOBBY", "1"],
    ]);
    const rows = parseTakeoffSpreadsheet(buf, "spaces.xlsx");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ roomNumber: "S1", roomName: "MAIN LOBBY", signType: "Directory" });
  });

  it("accepts 'Sign Text' as the room-name column", () => {
    const buf = makeXlsx([
      ["Room #", "Sign Text", "Room ID"],
      ["201", "CONFERENCE ROOM", "1"],
    ]);
    const rows = parseTakeoffSpreadsheet(buf, "signtext.xlsx");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ roomNumber: "201", roomName: "CONFERENCE ROOM" });
  });

  it("finds header on row 2 when row 1 is a blank title row (Door # variant)", () => {
    const buf = makeXlsx([
      ["Chelmsford Fire Department — Sign Schedule"],
      ["Door #", "Text on Sign", "Room ID", "Restroom"],
      ["101", "APPARATUS BAY", "1", ""],
    ]);
    const rows = parseTakeoffSpreadsheet(buf, "chelmsford.xlsx");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ signType: "Room ID", roomNumber: "101", roomName: "APPARATUS BAY" });
  });

  it("treats 'Door #' and 'Text on Sign' as metadata cols (not sign types)", () => {
    expect(isRoomMetaCol("Door #")).toBe(true);
    expect(isRoomMetaCol("Text on Sign")).toBe(true);
    expect(isRoomMetaCol("Sign Text")).toBe(true);
    expect(isRoomMetaCol("Space Name")).toBe(true);
    expect(isRoomMetaCol("Unit #")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseTakeoffSpreadsheet — room number column optional (name-only wide format)
// ---------------------------------------------------------------------------
describe("parseTakeoffSpreadsheet – room number column optional", () => {
  it("parses wide format with only a Room column (no room number)", () => {
    const buf = makeXlsx([
      ["Room", "Room ID", "Restroom"],
      ["LOBBY", "1", ""],
      ["WOMEN'S RESTROOM", "", "1"],
    ]);
    const rows = parseTakeoffSpreadsheet(buf, "colborne.xlsx");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ signType: "Room ID", roomName: "LOBBY", roomNumber: "" });
    expect(rows[1]).toMatchObject({ signType: "Restroom", roomName: "WOMEN'S RESTROOM", roomNumber: "" });
  });

  it("parses wide format with a Room column and sign-type columns containing 1.0 values", () => {
    const buf = makeXlsx([
      ["Room", "Room ID", "Stair ID"],
      ["WATER METER RM", "1", ""],
      ["STAIR A", "", "1"],
    ]);
    const rows = parseTakeoffSpreadsheet(buf, "colborne.xlsx");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ signType: "Room ID", roomName: "WATER METER RM" });
    expect(rows[1]).toMatchObject({ signType: "Stair ID", roomName: "STAIR A" });
  });

  it("skips rows where room name is blank when there is no room number column", () => {
    const buf = makeXlsx([
      ["Room", "Room ID"],
      ["", "1"],
      ["LOBBY", "1"],
    ]);
    const rows = parseTakeoffSpreadsheet(buf, "colborne.xlsx");
    expect(rows).toHaveLength(1);
    expect(rows[0].roomName).toBe("LOBBY");
  });
});

// ---------------------------------------------------------------------------
// parseTakeoffSpreadsheet — section header rows (floor labels as level context)
// ---------------------------------------------------------------------------
describe("parseTakeoffSpreadsheet – section header rows", () => {
  it("skips section header rows and uses them as level context for subsequent rooms", () => {
    const buf = makeXlsx([
      ["Room", "Room ID", "Restroom"],
      ["GROUND FLOOR", "", ""],
      ["LOBBY", "1", ""],
      ["LEVEL 1", "", ""],
      ["OFFICE", "1", ""],
      ["BASEMENT", "", ""],
      ["STORAGE", "1", ""],
    ]);
    const rows = parseTakeoffSpreadsheet(buf, "colborne.xlsx");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ roomName: "LOBBY", level: "GROUND FLOOR" });
    expect(rows[1]).toMatchObject({ roomName: "OFFICE", level: "LEVEL 1" });
    expect(rows[2]).toMatchObject({ roomName: "STORAGE", level: "BASEMENT" });
  });

  it("does NOT treat a row with multiple filled columns as a section header", () => {
    const buf = makeXlsx([
      ["Room", "Room ID", "Restroom"],
      ["GROUND FLOOR", "1", ""],
    ]);
    const rows = parseTakeoffSpreadsheet(buf, "colborne.xlsx");
    expect(rows).toHaveLength(1);
    expect(rows[0].roomName).toBe("GROUND FLOOR");
  });

  it("explicit Level column takes precedence over section header context", () => {
    const buf = makeXlsx([
      ["Room", "Level", "Room ID"],
      ["GROUND FLOOR", "", ""],
      ["LOBBY", "L1", "1"],
    ]);
    const rows = parseTakeoffSpreadsheet(buf, "colborne.xlsx");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ roomName: "LOBBY", level: "L1" });
  });

  it("recognises ordinal floor labels as section headers (1st Floor, 2nd Floor)", () => {
    const buf = makeXlsx([
      ["Room", "Room ID", "Restroom"],
      ["1st Floor", "", ""],
      ["LOBBY", "1", ""],
      ["2nd Floor", "", ""],
      ["CONFERENCE RM", "1", ""],
    ]);
    const rows = parseTakeoffSpreadsheet(buf, "colborne.xlsx");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ roomName: "LOBBY", level: "1st Floor" });
    expect(rows[1]).toMatchObject({ roomName: "CONFERENCE RM", level: "2nd Floor" });
  });

  it("sign type columns with / or - in header name are included correctly", () => {
    const buf = makeXlsx([
      ["Room", "Room ID/ Roof Occupancy", "Stair ID- Enclosure"],
      ["LOBBY", "1", ""],
      ["STAIR #1", "", "1"],
    ]);
    const rows = parseTakeoffSpreadsheet(buf, "colborne.xlsx");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ signType: "Room ID/ Roof Occupancy", roomName: "LOBBY" });
    expect(rows[1]).toMatchObject({ signType: "Stair ID- Enclosure", roomName: "STAIR #1" });
  });
});

// ---------------------------------------------------------------------------
// parseTakeoffSpreadsheet — multi-sheet workbooks
// ---------------------------------------------------------------------------
describe("parseTakeoffSpreadsheet – multi-sheet workbooks", () => {
  it("combines rows from all sheets and prefixes room numbers with sheet name", () => {
    const buf = makeXlsxMultiSheet([
      {
        name: "Station 3",
        rows: [
          ["Door #", "Text on Sign", "Room ID", "Restroom"],
          ["101", "APPARATUS BAY", "1", ""],
          ["102", "RESTROOM", "", "1"],
        ],
      },
      {
        name: "Station 5",
        rows: [
          ["Door #", "Text on Sign", "Room ID", "Restroom"],
          ["101", "OFFICE", "1", ""],
          ["103", "WOMEN'S RESTROOM", "", "1"],
        ],
      },
    ]);
    const rows = parseTakeoffSpreadsheet(buf, "chelmsford.xlsx");
    expect(rows).toHaveLength(4);

    const roomNumbers = rows.map(r => r.roomNumber);
    expect(roomNumbers).toContain("Station 3:101");
    expect(roomNumbers).toContain("Station 3:102");
    expect(roomNumbers).toContain("Station 5:101");
    expect(roomNumbers).toContain("Station 5:103");
  });

  it("does NOT prefix room numbers for a single-sheet workbook", () => {
    const buf = makeXlsx([
      ["Room #", "Room", "Room ID"],
      ["101", "LOBBY", "1"],
    ]);
    const rows = parseTakeoffSpreadsheet(buf, "single.xlsx");
    expect(rows[0].roomNumber).toBe("101");
  });

  it("skips sheets that don't match any supported format instead of throwing", () => {
    // Mimics a workbook with an interior-signs sheet (parseable) and an
    // exterior-signs summary sheet (no room column — unparseable).
    const buf = makeXlsxMultiSheet([
      {
        name: "Interior Signs",
        rows: [
          ["Room #", "Room", "Stair (Landing)", "Egress Map"],
          ["1.1", "STAIR 1", "1", ""],
          ["101", "LOBBY", "", "1"],
        ],
      },
      {
        name: "Siteext signs",
        rows: [
          ["EXTERIOR SIGNS", "", "", ""],
          ["Sign Type", "Size", "Text", "Qty."],
          ["ILLUMINATED SIGN", "6H", "WALKLING COURT", "1"],
        ],
      },
    ]);
    // Should parse Interior Signs successfully and silently skip Siteext signs
    const rows = parseTakeoffSpreadsheet(buf, "walkling.xlsx");
    expect(rows.length).toBeGreaterThan(0);
    const sheetNames = rows.map(r => r.roomNumber.split(":")[0]);
    expect(sheetNames.every(n => n === "Interior Signs")).toBe(true);
  });

  it("combines sheets with different sign-type columns", () => {
    const buf = makeXlsxMultiSheet([
      {
        name: "Floor 1",
        rows: [
          ["Room #", "Room Name", "Room ID"],
          ["101", "LOBBY", "1"],
        ],
      },
      {
        name: "Floor 2",
        rows: [
          ["Room #", "Room Name", "Restroom"],
          ["201", "WOMEN'S RESTROOM", "1"],
        ],
      },
    ]);
    const rows = parseTakeoffSpreadsheet(buf, "floors.xlsx");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ roomNumber: "Floor 1:101", signType: "Room ID" });
    expect(rows[1]).toMatchObject({ roomNumber: "Floor 2:201", signType: "Restroom" });
  });
});
