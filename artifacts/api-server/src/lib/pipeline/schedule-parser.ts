import type { SignScheduleEntry } from "./types";

const SCHEDULE_TYPE_MAP: Record<string, string> = {
  BB2A: "Room ID",
  BB2B: "Room ID w/insert",
  BB2C: "Conference",
  BB2D: "Occupancy(MaxCapacity)",
  BB2E: "Egress(Emergency)",
  BB3: "Stair(Landing)",
  BB4: "Exit(Tactile)",
  BB5: "Entry(Building)",
  BB7A: "Restroom(Men)",
  BB7B: "Restroom(Women)",
  SS1A: "Stair ID",
  AA1: "Directory(Building)",
  AA2: "Directory(Floor)",
  AA3: "Directory(Floor)",
  DD1: "Regulatory(NoSmoking)",
  LED: "LED(Programmable)",
  BB6: "Evac Map",
};

export interface ScheduleRow {
  signIdentifier: string;
  roomNumber: string;
  roomName: string;
  signType: string;
  verbage: string;
  detailRef: string;
}

/**
 * Returns true if a sheet should receive an AI vision scan in Step 3.
 *
 * Positive whitelist (scan these):
 *   A-1XX, A-2XX, A-3XX  — floor plans with rooms and doors
 *   A-7XX                 — sign schedule sheets
 *
 * Everything else is text-extraction-only. Additionally, any sheet whose
 * title contains the listed keywords is skipped even if its ID would
 * otherwise qualify (except A-7XX sign-schedule sheets, which are exempt
 * from the SCHEDULE keyword block).
 */
/**
 * Pass 1 of the two-pass sheet classifier.
 *
 * Returns false for sheets that can NEVER be overhead floor plans regardless
 * of their visual content — i.e. structural/MEP discipline prefixes and title
 * keywords that describe a geometrically different drawing type.
 *
 * Everything else returns true and proceeds to Pass 2: the AI vision model
 * sets isPlanView=true/false in the response JSON to make the final call.
 * This means sheets with titles like "FOR FINISH SCHEDULE" or
 * "POWER, COMMUNICATION & LAMP LIGHTING PLAN" are not pre-blocked; the model
 * inspects the actual image and decides.
 */

export function mapScheduleSignType(rawType: string): string {
  const normalized = rawType.trim().toUpperCase().replace(/\s+/g, "");
  return SCHEDULE_TYPE_MAP[normalized] ?? rawType.trim();
}

/**
 * Returns true when a sign type is a project-specific type code (e.g. "Type A",
 * "Type B.1", "Type D").  These values are the canonical names for their project —
 * they must NEVER be translated, filtered, or replaced with generic sign names.
 */

export function isTypeCodeSignType(signType: string | null | undefined): boolean {
  if (!signType) return false;
  return /^Type\s+[A-Z0-9][A-Z0-9.]*$/i.test(signType.trim());
}

export interface ColumnGroup {
  signCol: number;
  roomNumCol: number;
  roomNameCol: number;
  verbageCol: number;
  typeCol: number;
  detailCol: number;
}

export function findColumnGroups(headerRow: string[]): ColumnGroup[] {
  const normalized = headerRow.map((c) => c.trim().toUpperCase().replace(/[\n\r]+/g, " "));
  const groups: ColumnGroup[] = [];

  // Find ALL "SIGN" column positions in the header (handles dual-column layouts)
  const signCols: number[] = [];
  for (let i = 0; i < normalized.length; i++) {
    const c = normalized[i];
    if (c === "SIGN" || c.startsWith("SIGN ") || c === "SIGN NO" || c === "SIGN NO.") {
      signCols.push(i);
    }
  }

  for (const signCol of signCols) {
    // Search in the range from this SIGN col to the next SIGN col (or end)
    const nextSignCol = signCols.find((s) => s > signCol) ?? normalized.length;
    const range = normalized.slice(signCol, nextSignCol);

    const localIdx = (pred: (c: string) => boolean) => {
      const i = range.findIndex(pred);
      return i >= 0 ? signCol + i : -1;
    };

    const roomNumCol = localIdx((c) => /ROOM.*(NUMBER|NUM|NO\.?$)/.test(c))
      !== -1 ? localIdx((c) => /ROOM.*(NUMBER|NUM|NO\.?$)/.test(c))
      : localIdx((c) => c.startsWith("ROOM") && !c.includes("NAME"));
    const roomNameCol = localIdx((c) => c.includes("ROOM NAME") || c === "ROOM NAME");
    const verbageCol = localIdx((c) => /VERB(A|I)GE|MESSAGE/.test(c));
    const typeCol = localIdx((c) => c === "TYPE" || c === "SIGN TYPE" || c === "TYPE NO" || c === "TYPE NO.");
    const detailCol = localIdx((c) => c.includes("DETAIL"));

    if (typeCol >= 0) {
      groups.push({ signCol, roomNumCol, roomNameCol, verbageCol, typeCol, detailCol });
    }
  }

  return groups;
}

export function parseScheduleTableRows(tables: string[][][]): ScheduleRow[] {
  const rows: ScheduleRow[] = [];

  for (const table of tables) {
    let columnGroups: ColumnGroup[] = [];
    let dataStartIdx = 0;

    // Find header row (first row containing a "SIGN" cell within first 5 rows)
    for (let i = 0; i < Math.min(5, table.length); i++) {
      const groups = findColumnGroups(table[i]);
      if (groups.length > 0) {
        columnGroups = groups;
        dataStartIdx = i + 1;
        break;
      }
    }

    if (columnGroups.length === 0) continue;

    for (let i = dataStartIdx; i < table.length; i++) {
      const row = table[i];

      for (const g of columnGroups) {
        const signId = row[g.signCol]?.trim() ?? "";
        // Skip blank rows and repeated headers
        if (!signId || /^SIGN$/i.test(signId)) continue;

        const rawType = row[g.typeCol]?.trim() ?? "";
        if (!rawType) continue;

        rows.push({
          signIdentifier: signId,
          roomNumber: g.roomNumCol >= 0 ? (row[g.roomNumCol]?.trim() ?? "") : "",
          roomName: g.roomNameCol >= 0 ? (row[g.roomNameCol]?.trim() ?? "") : "",
          signType: mapScheduleSignType(rawType),
          verbage: g.verbageCol >= 0 ? (row[g.verbageCol]?.trim() ?? "") : "",
          detailRef: g.detailCol >= 0 ? (row[g.detailCol]?.trim() ?? "") : "",
        });
      }
    }
  }

  return rows;
}

function normalizeAggregateHeader(cell: string | null | undefined): string {
  return (cell ?? "")
    .replace(/[\n\r]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function parsePositiveAggregateCount(cell: string | null | undefined): number | null {
  const text = (cell ?? "").trim();
  if (!/^\d[\d,\s]*$/.test(text)) return null;

  const value = parseInt(text.replace(/[,\s]/g, ""), 10);
  return Number.isInteger(value) && value > 0 ? value : null;
}

export function parseAggregateCountTable(tables: string[][][], sheetId: string): SignScheduleEntry[] {
  const entries: SignScheduleEntry[] = [];

  for (const table of tables) {
    let headerIdx = -1;
    let typeCol = -1;
    let countCol = -1;
    let typeMarkCol = -1;

    for (let i = 0; i < Math.min(5, table.length); i++) {
      const header = (table[i] ?? []).map(normalizeAggregateHeader);
      const hasRoomCol = header.some((h) =>
        h === "ROOM" ||
        h === "ROOM #" ||
        h === "ROOM NO" ||
        h === "ROOM NUMBER" ||
        h === "ROOM NAME",
      );
      if (hasRoomCol) continue;

      const candidateTypeCol = header.findIndex((h) =>
        h === "SIGNAGE TYPE" ||
        h === "SIGN TYPE" ||
        h === "TYPE" ||
        h === "DESCRIPTION",
      );
      const candidateCountCol = header.findIndex((h) =>
        h === "COUNT" ||
        h === "QTY" ||
        h === "QUANTITY" ||
        h === "TOTAL",
      );

      if (candidateTypeCol >= 0 && candidateCountCol >= 0) {
        headerIdx = i;
        typeCol = candidateTypeCol;
        countCol = candidateCountCol;
        typeMarkCol = header.findIndex((h) =>
          h === "TYPE MARK" ||
          h === "MARK" ||
          h === "TYPE CODE" ||
          h === "CODE",
        );
        break;
      }
    }

    if (headerIdx < 0) continue;

    for (let i = headerIdx + 1; i < table.length; i++) {
      const row = table[i] ?? [];
      const signType = (row[typeCol] ?? "").trim();
      if (!signType || /\bGRAND\s+TOTAL\b|\bTOTAL\b/i.test(signType)) continue;

      const quantity = parsePositiveAggregateCount(row[countCol]);
      if (quantity === null) continue;

      const typeMark = typeMarkCol >= 0 ? (row[typeMarkCol]?.trim() ?? "") : "";
      entries.push({
        roomNumber: "",
        roomName: "",
        signType,
        typeMark: typeMark || null,
        quantity,
        size: "",
        message: "",
        notes: "",
        source: "text",
        sheetId,
        substrate: null,
        finishMethod: null,
        brailleSpec: null,
        mountingHeight: null,
        manufacturer: null,
      });
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Step 3a bridge helper
// ---------------------------------------------------------------------------

/**
 * Minimal shape of a sign schedule entry required by the Step 3a bridge.
 * The full SignScheduleEntry interface is local to processJob, so this
 * exported type keeps the bridge testable without exposing internals.
 */
