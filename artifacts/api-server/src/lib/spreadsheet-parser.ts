import * as XLSX from "xlsx";

export interface TakeoffRow {
  signType: string;
  roomNumber: string;
  roomName: string;
  level: string;
  qty: number;
  ruleRef: string;
}

// Column name aliases for the room-number identifier field.
export const ROOM_NUM_COL_NAMES = [
  "room #", "room#", "room number",
  "door #", "door#", "door number",
  "unit #", "unit#", "unit number",
  "space #", "space#",
  "rm #", "rm#",
];

// Column name aliases for the room-name / sign-text field.
export const ROOM_NAME_COL_NAMES = [
  "room name", "room",
  "text on sign", "sign text",
  "space name", "space",
  "description", "name",
];

// Columns that carry room metadata rather than sign-type quantities.
export const ROOM_META_COL_NAMES = new Set([
  ...ROOM_NUM_COL_NAMES,
  ...ROOM_NAME_COL_NAMES,
  "bldg", "building", "level", "floor", "suite",
  "notes", "note", "project", "address",
]);

export function isRoomMetaCol(col: string): boolean {
  return ROOM_META_COL_NAMES.has(col.trim().toLowerCase());
}

// Strip trailing spec codes like "AA1", "BB2A", "SS1A", "DD1" that appear
// at the end of wide-format sign-type column headers.
export function stripSignCode(col: string): string {
  return col.replace(/\s+[A-Z]{1,3}\d+[A-Z]?\s*$/, "").trim() || col.trim();
}

// Interpret a cell value as truthy (sign is required) or falsy (sign absent).
export function isTruthyCell(val: string): { truthy: boolean; qty: number } {
  const s = val.trim().toUpperCase();
  if (!s || s === "0" || s === "N" || s === "NO" || s === "-") return { truthy: false, qty: 0 };
  if (s === "X" || s === "YES" || s === "Y" || s === "TRUE" || s === "✓") return { truthy: true, qty: 1 };
  const n = parseFloat(s);
  if (!isNaN(n)) return { truthy: n > 0, qty: n > 0 ? Math.max(1, Math.round(n)) : 0 };
  return { truthy: true, qty: 1 };
}

/**
 * Parse a takeoff spreadsheet buffer into a flat list of TakeoffRows.
 *
 * Supports two formats across one or more sheets:
 *
 * **Tall format** (Sign Takeoff IQ export):
 * ```
 * Sign Type | Room # | Room Name | Level
 * Restroom  | 101    | Restroom  | 1
 * ```
 *
 * **Wide format** (estimator/spec format — one column per sign type):
 * ```
 * Room # | Room      | Restroom BB7A | Room ID BB2B | ...
 * 101    | RESTROOM  | 1             |              |
 * 102    | CONF RM   |               | 1            |
 * ```
 *
 * Custom column name variants are supported:
 * - Room number: "Room #", "Door #", "Unit #", "Space #", "Rm #"
 * - Room name: "Room Name", "Room", "Text on Sign", "Sign Text", "Space Name"
 *
 * Multi-sheet workbooks are fully supported — all sheets are parsed and
 * combined. When more than one sheet is present the sheet name is prepended
 * to each room number as a namespace ("Station 3:101").
 */
export function parseTakeoffSpreadsheet(buffer: Buffer, _fileName: string): TakeoffRow[] {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  if (workbook.SheetNames.length === 0) return [];

  const multiSheet = workbook.SheetNames.length > 1;
  const allRows: TakeoffRow[] = [];
  let parsedSheetCount = 0;

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    let sheetRows: TakeoffRow[];
    try {
      sheetRows = parseSheet(sheet);
    } catch {
      // This sheet doesn't match any supported format (e.g. an exterior sign
      // list or summary tab with no room column) — skip it and continue.
      continue;
    }
    parsedSheetCount++;

    if (multiSheet) {
      // Prefix room numbers with sheet name so they stay distinct across sheets.
      for (const row of sheetRows) {
        allRows.push({
          ...row,
          roomNumber: row.roomNumber
            ? `${sheetName}:${row.roomNumber}`
            : row.roomNumber,
        });
      }
    } else {
      allRows.push(...sheetRows);
    }
  }

  // If every sheet was skipped (none matched a supported format) surface the
  // error from a fresh parse of the first sheet so the caller gets a useful
  // diagnostic message rather than a silent empty result.
  if (parsedSheetCount === 0 && workbook.SheetNames.length > 0) {
    parseSheet(workbook.Sheets[workbook.SheetNames[0]]); // will throw
  }

  return allRows;
}

// ---------------------------------------------------------------------------
// Internal: parse a single worksheet into TakeoffRows.
// ---------------------------------------------------------------------------
function parseSheet(sheet: XLSX.WorkSheet): TakeoffRow[] {
  // Read as raw arrays first so we can locate the actual header row.
  // Real-world Excel files often have blank rows, a logo, or a title above
  // the column headers, causing the first row to parse as all __EMPTY columns.
  const rawRows = XLSX.utils.sheet_to_json<string[]>(sheet, {
    header: 1,
    defval: "",
    raw: false,
  });

  // ── Pass 1: find the header row and determine format ──────────────────────
  let headerRowIndex = -1;
  let isTallFormat = false;
  let isWideFormat = false;

  for (let i = 0; i < rawRows.length; i++) {
    const cells = rawRows[i].map((c) => String(c ?? "").trim().toLowerCase());

    // Tall format: explicit "Sign Type" and any room-name alias
    const hasTallSignType = cells.includes("sign type");
    const hasTallRoomName = ROOM_NAME_COL_NAMES.some(n => cells.includes(n));
    if (hasTallSignType && hasTallRoomName) {
      headerRowIndex = i;
      isTallFormat = true;
      break;
    }

    // Wide format: has a room-name column (room number is optional) + at least
    // one column that isn't room metadata (i.e. a sign-type column).
    // Room number column is optional — some files only have a room name.
    const hasRoomName = ROOM_NAME_COL_NAMES.some(n => cells.includes(n));
    const hasSignCols = cells.some(c => c !== "" && !isRoomMetaCol(c));
    if (hasRoomName && hasSignCols) {
      headerRowIndex = i;
      isWideFormat = true;
      break;
    }
  }

  if (headerRowIndex === -1) {
    const firstNonEmpty = rawRows.find((r) => r.some((c) => String(c ?? "").trim() !== ""));
    const sample = firstNonEmpty ? firstNonEmpty.filter(Boolean).join(", ") : "(all blank)";
    throw new Error(
      "Spreadsheet must have 'Sign Type' and 'Room Name' columns (tall format), " +
      "or a room-name column (Room Name, Text on Sign, Room, etc.) with one column " +
      "per sign type (wide format). Room number column is optional. " +
      `Could not find a matching header in any row. First non-empty row contained: ${sample}`
    );
  }

  // ── Pass 2: re-parse from the header row with named columns ───────────────
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(sheet, {
    defval: "",
    raw: false,
    range: headerRowIndex,
  });

  if (rows.length === 0) return [];

  const firstRow = rows[0];

  function findCol(names: string[]): string | undefined {
    for (const name of names) {
      const matched = Object.keys(firstRow).find(k => k.trim().toLowerCase() === name);
      if (matched) return matched;
    }
    return undefined;
  }

  // ── Tall format ───────────────────────────────────────────────────────────
  if (isTallFormat) {
    const signTypeCol = findCol(["sign type"]);
    const roomNameCol = findCol(ROOM_NAME_COL_NAMES);
    if (!signTypeCol || !roomNameCol) {
      throw new Error(
        "Spreadsheet must have 'Sign Type' and 'Room Name' columns. " +
        `Found columns: ${Object.keys(firstRow).join(", ")}`
      );
    }

    const roomNumCol = findCol(ROOM_NUM_COL_NAMES);
    const levelCol = findCol(["level", "floor"]);
    const qtyCol = findCol(["qty", "quantity"]);
    const ruleRefCol = findCol(["rule ref", "rule_ref", "ruleref"]);

    const result: TakeoffRow[] = [];
    for (const row of rows) {
      const signType = String(row[signTypeCol] || "").trim();
      const roomName = String(row[roomNameCol] || "").trim();
      if (!signType || !roomName) continue;

      result.push({
        signType,
        roomNumber: roomNumCol ? String(row[roomNumCol] || "").trim() : "",
        roomName,
        level: levelCol ? String(row[levelCol] || "").trim() : "",
        qty: qtyCol ? (parseInt(String(row[qtyCol] || "1")) || 1) : 1,
        ruleRef: ruleRefCol ? String(row[ruleRefCol] || "").trim() : "",
      });
    }
    return result;
  }

  // ── Wide format ───────────────────────────────────────────────────────────
  if (isWideFormat) {
    const allCols = Object.keys(firstRow);
    const roomNumCol = findCol(ROOM_NUM_COL_NAMES);   // optional
    const roomNameCol = findCol(ROOM_NAME_COL_NAMES); // required
    const levelCol = findCol(["level", "floor", "bldg", "building"]);

    // Sign type columns = every column that is NOT the identified room-num/
    // room-name/level column and is NOT a known non-sign metadata header.
    // We use an explicit small exclusion list here (rather than the broad
    // isRoomMetaCol set) so that sign column headers containing words like
    // "name", "space", or "description" are never accidentally dropped.
    const WIDE_META_EXCLUDE = new Set([
      "level", "floor", "bldg", "building", "suite",
      "notes", "note", "qty", "quantity", "total", "comments",
      "project", "address",
    ]);
    const reservedCols = new Set([roomNumCol, roomNameCol, levelCol].filter(Boolean) as string[]);
    const signTypeCols = allCols.filter(col => {
      if (!col.trim()) return false;
      if (reservedCols.has(col)) return false;
      return !WIDE_META_EXCLUDE.has(col.trim().toLowerCase());
    });

    // Section-header pattern — matches floor/level labels and ordinals
    // (e.g. "GROUND FLOOR", "LEVEL 1", "BASEMENT", "1st Floor", "2nd Floor")
    const SECTION_HEADER_RE = /ground|floor|level|basement|mezzanine|roof|\d+(st|nd|rd|th)/i;

    const result: TakeoffRow[] = [];
    let currentLevel = "";

    for (const row of rows) {
      // Detect section header rows: only the first meaningful column has a
      // value and it looks like a floor/level label.  Capture as level context
      // for subsequent rows and skip as a data row.
      const allValues = allCols.map(c => String(row[c] || "").trim());
      const nonEmptyCount = allValues.filter(Boolean).length;
      const firstValue = allValues[0] ?? "";
      if (nonEmptyCount === 1 && SECTION_HEADER_RE.test(firstValue)) {
        currentLevel = firstValue;
        continue;
      }

      const roomNumber = roomNumCol ? String(row[roomNumCol] || "").trim() : "";
      const roomName = roomNameCol ? String(row[roomNameCol] || "").trim() : "";
      if (!roomName && !roomNumber) continue;

      // Prefer an explicit level column; fall back to the last section header.
      const level = levelCol
        ? (String(row[levelCol] || "").trim() || currentLevel)
        : currentLevel;

      for (const col of signTypeCols) {
        const cellVal = String(row[col] || "").trim();
        const { truthy, qty } = isTruthyCell(cellVal);
        if (!truthy) continue;

        const signType = stripSignCode(col);
        if (!signType) continue;

        result.push({
          signType,
          roomNumber,
          roomName: roomName || roomNumber,
          level,
          qty,
          ruleRef: "",
        });
      }
    }
    return result;
  }

  return [];
}
