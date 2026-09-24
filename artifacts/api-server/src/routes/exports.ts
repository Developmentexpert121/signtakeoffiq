import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { signsTable, roomsTable, jobsTable, jobFilesTable, jobSheetsTable, tenantPricingSettingsTable, specialtySignsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "../lib/tenantAuth";
import { getJobMaterialSpec } from "../lib/materialSpec";
import ExcelJS from "exceljs";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

const MARKER_COORD_SCALE = 1000;

const SIGN_TYPE_COLORS: Record<string, { hex: string; argb: string; r: number; g: number; b: number }> = {
  "exit": { hex: "#E53E3E", argb: "FFE53E3E", r: 0.898, g: 0.243, b: 0.243 },
  "exit sign": { hex: "#E53E3E", argb: "FFE53E3E", r: 0.898, g: 0.243, b: 0.243 },
  "ada": { hex: "#3182CE", argb: "FF3182CE", r: 0.192, g: 0.506, b: 0.808 },
  "room id": { hex: "#38A169", argb: "FF38A169", r: 0.220, g: 0.631, b: 0.412 },
  "room identification": { hex: "#38A169", argb: "FF38A169", r: 0.220, g: 0.631, b: 0.412 },
  "fire extinguisher": { hex: "#DD6B20", argb: "FFDD6B20", r: 0.867, g: 0.420, b: 0.125 },
  "occupancy": { hex: "#805AD5", argb: "FF805AD5", r: 0.502, g: 0.353, b: 0.835 },
  "stair": { hex: "#2B6CB0", argb: "FF2B6CB0", r: 0.169, g: 0.424, b: 0.690 },
  "elevator": { hex: "#2C7A7B", argb: "FF2C7A7B", r: 0.173, g: 0.478, b: 0.482 },
  "mens restroom": { hex: "#2B6CB0", argb: "FF2B6CB0", r: 0.169, g: 0.424, b: 0.690 },
  "womens restroom": { hex: "#B83280", argb: "FFB83280", r: 0.722, g: 0.196, b: 0.502 },
  "restroom": { hex: "#319795", argb: "FF319795", r: 0.196, g: 0.592, b: 0.584 },
  "electrical": { hex: "#F6E05E", argb: "FFF6E05E", r: 0.965, g: 0.878, b: 0.369 },
  "mechanical": { hex: "#68D391", argb: "FF68D391", r: 0.408, g: 0.827, b: 0.569 },
  "no smoking": { hex: "#FC8181", argb: "FFFC8181", r: 0.988, g: 0.506, b: 0.506 },
  "hazmat": { hex: "#F6AD55", argb: "FFF6AD55", r: 0.965, g: 0.678, b: 0.333 },
};

const PALETTE = [
  { hex: "#E53E3E", argb: "FFE53E3E", r: 0.898, g: 0.243, b: 0.243 },
  { hex: "#3182CE", argb: "FF3182CE", r: 0.192, g: 0.506, b: 0.808 },
  { hex: "#38A169", argb: "FF38A169", r: 0.220, g: 0.631, b: 0.412 },
  { hex: "#DD6B20", argb: "FFDD6B20", r: 0.867, g: 0.420, b: 0.125 },
  { hex: "#805AD5", argb: "FF805AD5", r: 0.502, g: 0.353, b: 0.835 },
  { hex: "#2C7A7B", argb: "FF2C7A7B", r: 0.173, g: 0.478, b: 0.482 },
  { hex: "#B83280", argb: "FFB83280", r: 0.722, g: 0.196, b: 0.502 },
  { hex: "#F6AD55", argb: "FFF6AD55", r: 0.965, g: 0.678, b: 0.333 },
  { hex: "#68D391", argb: "FF68D391", r: 0.408, g: 0.827, b: 0.569 },
  { hex: "#FC8181", argb: "FFFC8181", r: 0.988, g: 0.506, b: 0.506 },
];

function getColorForSignType(signType: string): { hex: string; argb: string; r: number; g: number; b: number } {
  const normalized = signType.toLowerCase().trim();
  if (SIGN_TYPE_COLORS[normalized]) return SIGN_TYPE_COLORS[normalized];
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = (hash * 31 + normalized.charCodeAt(i)) & 0xffffffff;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

// ── XLSX helpers ──────────────────────────────────────────────────────────────

type PricingMaterial = { id: string; name: string; bidPrice?: number | null; msrp?: number | null; unit?: string };
type PricingFinishing = { id: string; name: string; bidPrice?: number | null; unit?: string };
type PricingSignDefault = {
  signType: string;
  materialId?: string | null;
  finishingIds?: string[];
  width?: number;
  height?: number;
  minPrice?: number | null;
};

function normalizeSignType(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

const ADA_KEYS = new Set([
  "room_id", "room_identification", "restroom", "mens_restroom", "womens_restroom",
  "elevator", "stair", "stairway", "ada",
]);
function isAdaSignType(signType: string): boolean {
  const n = normalizeSignType(signType);
  return ADA_KEYS.has(n) || n.includes("ada");
}

/**
 * Wing-aware room sort key for buildings with W/E-prefix room numbering
 * (e.g. Fox Hill: W139 = West/Academic wing, E119 = East/Community wing).
 *
 * Sort order within a level:
 *   1. W-prefix rooms, ascending numerically  (W100, W101, … W200, …)
 *   2. E-prefix rooms, ascending numerically  (E100, E101, …)
 *   3. All other rooms, ascending numerically then alphabetically
 */
function wingRoomSortKey(roomNumber: string | null | undefined): string {
  if (!roomNumber) return "Z\xFF";
  const rn = roomNumber.toUpperCase().trim();
  const extractNum = (s: string, offset: number) => {
    const m = s.slice(offset).match(/^(\d+)/);
    return m ? m[1].padStart(8, "0") : s.slice(offset).padStart(8, "0");
  };
  if (/^W\d/i.test(rn)) return "A" + extractNum(rn, 1);
  if (/^E\d/i.test(rn)) return "B" + extractNum(rn, 1);
  const numMatch = rn.match(/^(\d+)/);
  if (numMatch) return "C" + numMatch[1].padStart(8, "0");
  return "D" + rn;
}

// ── MSRP defaults (fallback when no tenant pricing configured) ─────────────────
export interface MsrpEntry {
  materialName: string;
  materialRate: number;
  finishingName: string;
  finishingRate: number;
  width: number;
  height: number;
  minPrice: number;
  notes: string;
  flatPrice?: number;
}

export const MSRP_DEFAULTS: Record<string, MsrpEntry> = {
  "room_id":               { materialName: 'Rowmark 1/8"', materialRate: 0.53, finishingName: "Raised Copy + Braille", finishingRate: 0.73, width: 6,  height: 6,  minPrice: 20, notes: "" },
  "room_identification":   { materialName: 'Rowmark 1/8"', materialRate: 0.53, finishingName: "Raised Copy + Braille", finishingRate: 0.73, width: 6,  height: 6,  minPrice: 20, notes: "" },
  "restroom":              { materialName: 'Rowmark 1/8"', materialRate: 0.53, finishingName: "Raised Copy + Braille", finishingRate: 0.73, width: 6,  height: 8,  minPrice: 20, notes: "" },
  "mens_restroom":         { materialName: 'Rowmark 1/8"', materialRate: 0.53, finishingName: "Raised Copy + Braille", finishingRate: 0.73, width: 6,  height: 8,  minPrice: 20, notes: "" },
  "womens_restroom":       { materialName: 'Rowmark 1/8"', materialRate: 0.53, finishingName: "Raised Copy + Braille", finishingRate: 0.73, width: 6,  height: 8,  minPrice: 20, notes: "" },
  "exit":                  { materialName: 'P95 White 1/8"', materialRate: 0.50, finishingName: "Raised Copy + Braille", finishingRate: 0.73, width: 6, height: 8,  minPrice: 20, notes: "" },
  "exit_sign":             { materialName: 'P95 White 1/8"', materialRate: 0.50, finishingName: "Raised Copy + Braille", finishingRate: 0.73, width: 6, height: 8,  minPrice: 20, notes: "" },
  "exit_tactile":          { materialName: 'P95 White 1/8"', materialRate: 0.50, finishingName: "Raised Copy + Braille", finishingRate: 0.73, width: 6, height: 8,  minPrice: 20, notes: "" },
  "stair":                 { materialName: 'Rowmark 1/8"', materialRate: 0.53, finishingName: "Raised Copy + Braille", finishingRate: 0.73, width: 6,  height: 8,  minPrice: 20, notes: "" },
  "stair_corridor":        { materialName: 'Rowmark 1/8"', materialRate: 0.53, finishingName: "Raised Copy + Braille", finishingRate: 0.73, width: 6,  height: 8,  minPrice: 20, notes: "" },
  "stairway":              { materialName: 'Rowmark 1/8"', materialRate: 0.53, finishingName: "Raised Copy + Braille", finishingRate: 0.73, width: 6,  height: 8,  minPrice: 20, notes: "" },
  "stair_landing":         { materialName: 'Rowmark 1/8"', materialRate: 0.53, finishingName: "Raised Copy + Braille", finishingRate: 0.73, width: 6,  height: 12, minPrice: 20, notes: "" },
  "elevator":              { materialName: 'Rowmark 1/8"', materialRate: 0.53, finishingName: "Raised Copy + Braille", finishingRate: 0.73, width: 4,  height: 6,  minPrice: 20, notes: "" },
  "elevator_mach_rm":      { materialName: 'Rowmark 1/8"', materialRate: 0.53, finishingName: "Raised Copy + Braille", finishingRate: 0.73, width: 6,  height: 6,  minPrice: 20, notes: "" },
  "elevator_machine_room": { materialName: 'Rowmark 1/8"', materialRate: 0.53, finishingName: "Raised Copy + Braille", finishingRate: 0.73, width: 6,  height: 6,  minPrice: 20, notes: "" },
  "unit_id":               { materialName: 'Rowmark 1/8"', materialRate: 0.53, finishingName: "Raised Copy + Braille", finishingRate: 0.73, width: 4,  height: 6,  minPrice: 20, notes: "" },
  "max_occupancy":         { materialName: 'P95 White 1/8"', materialRate: 0.50, finishingName: "CMYK Flat Print", finishingRate: 0.39, width: 6,     height: 8,  minPrice: 20, notes: "" },
  "occupancy":             { materialName: 'P95 White 1/8"', materialRate: 0.50, finishingName: "CMYK Flat Print", finishingRate: 0.39, width: 6,     height: 8,  minPrice: 20, notes: "" },
  "accessible_entrance":   { materialName: 'P95 White 1/8"', materialRate: 0.50, finishingName: "Raised Copy + Braille", finishingRate: 0.73, width: 6, height: 8,  minPrice: 20, notes: "" },
  "accessible":            { materialName: 'P95 White 1/8"', materialRate: 0.50, finishingName: "Raised Copy + Braille", finishingRate: 0.73, width: 6, height: 8,  minPrice: 20, notes: "" },
  "evacuation_map":        { materialName: "Frame only",     materialRate: 0,    finishingName: "",                     finishingRate: 0,    width: 0,  height: 0,  minPrice: 45, notes: "Frame only", flatPrice: 45 },
};

const DEFAULT_MSRP: MsrpEntry = {
  materialName: 'Rowmark 1/8"', materialRate: 0.53,
  finishingName: "Raised Copy + Braille", finishingRate: 0.73,
  width: 6, height: 8, minPrice: 20, notes: "",
};

// ── Simple flat-price defaults for estimation (fallback when no tenant pricing) ─
export const DEFAULT_SIGN_PRICING: Record<string, number> = {
  "Typical Toilet Room Sign": 185,
  "Room Sign with Insert": 195,
  "Emergency Exit": 145,
  "Fire Extinguisher": 95,
  "Room Sign with No Storage": 185,
  "Occupancy Sign": 95,
  '24" Letter Signage': 450,
  "Typical Room Sign": 165,
  "Egress Map": 285,
  "Egress Stair Sign at Corridor": 165,
  "Typical Stair Sign at Landing": 195,
  "Sign at Elevator": 165,
  "Sign at Unit": 95,
  "Elevator Machine Room Sign": 145,
  "Sign at Corridor": 245,
  "Elevator Control Room Location Sign": 145,
  "default": 150,
};

export function getPriceForSignType(
  signType: string,
  overrides?: Record<string, number> | null,
): number {
  const merged = { ...DEFAULT_SIGN_PRICING, ...(overrides ?? {}) };
  const key = Object.keys(merged).find(k =>
    k !== "default" &&
    signType.toLowerCase().includes(k.toLowerCase())
  );
  return merged[key ?? "default"] ?? 150;
}

export function getSignPricingInfo(
  signType: string,
  size: string,
  pricing: { materials: PricingMaterial[]; finishings: PricingFinishing[]; signDefaults: PricingSignDefault[] } | null,
): MsrpEntry {
  const key = normalizeSignType(signType);
  if (pricing && pricing.materials.length > 0) {
    const sd = pricing.signDefaults.find(d => normalizeSignType(d.signType) === key);
    if (sd) {
      const mat = pricing.materials.find(m => m.id === sd.materialId);
      const fins = pricing.finishings.filter(f => (sd.finishingIds ?? []).includes(f.id));
      const matRate = mat ? Number(mat.bidPrice ?? mat.msrp ?? 0) : 0;
      const finRate = fins.reduce((s, f) => s + (f.unit === "sqin" || !f.unit ? Number(f.bidPrice ?? 0) : 0), 0);
      let w = sd.width ?? 6;
      let h = sd.height ?? 8;
      if (!sd.width && size) {
        const dm = size.match(/(\d+(?:\.\d+)?)\s*[×x\u00d7]\s*(\d+(?:\.\d+)?)/);
        if (dm) { w = parseFloat(dm[1]); h = parseFloat(dm[2]); }
      }
      return {
        materialName: mat?.name ?? "—",
        materialRate: matRate,
        finishingName: fins.length > 0 ? fins.map(f => f.name).join(", ") : "—",
        finishingRate: finRate,
        width: w, height: h,
        minPrice: Number(sd.minPrice ?? 0),
        notes: "",
      };
    }
  }
  const msrp = MSRP_DEFAULTS[key] ?? DEFAULT_MSRP;
  let w = msrp.width;
  let h = msrp.height;
  if (size) {
    const dm = size.match(/(\d+(?:\.\d+)?)\s*[×x\u00d7]\s*(\d+(?:\.\d+)?)/);
    if (dm) { w = parseFloat(dm[1]); h = parseFloat(dm[2]); }
  }
  return { ...msrp, width: w, height: h };
}

function floorSortKey(level: string | null | undefined): string {
  if (!level) return "zzz";
  const l = level.trim().toLowerCase();
  if (l === "b" || l === "basement" || l === "b1") return "000";
  if (l === "g" || l === "ground" || l === "ground floor") return "001";
  if (/^\d+$/.test(l)) return l.padStart(10, "0");
  return l;
}

function formatLevel(level: string | null | undefined): string {
  if (!level) return "Unspecified Floor";
  const l = level.trim();
  const low = l.toLowerCase();
  if (low === "g" || low === "ground" || low === "ground floor") return "Ground Floor";
  if (low === "b" || low === "basement" || low === "b1") return "Basement";
  if (/^\d+$/.test(l)) return `Level ${l}`;
  return l.toUpperCase();
}

function safeFileName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_\- ]/g, "").replace(/\s+/g, "_").replace(/^_+|_+$/g, "") || "Takeoff";
}

function solidFill(argb: string): ExcelJS.Fill {
  return { type: "pattern", pattern: "solid", fgColor: { argb } } as ExcelJS.Fill;
}

const C_AMBER     = "FFCC8400";
const C_WHITE     = "FFFFFFFF";
const C_DARK_HDR  = "FF1A365D";
const C_FLOOR_HDR = "FF4A5568";
const C_SUBTOTAL  = "FFDBEAFE";
const C_SUB_FONT  = "FF1E40AF";
const C_ALT_ROW   = "FFF7FAFC";
const C_BORDER      = "FFE2E8F0";
const C_YELLOW_EDIT  = "FFFFFBEB"; // editable cells (#FFFBEB)
const C_GRAY_REF     = "FFF3F4F6"; // read-only reference cells
const C_INSTALL_SUB  = "FFDCFCE7"; // light green (#DCFCE7) — install subtotal
const C_INSTALL_FONT = "FF14532D"; // dark green text for install subtotal
const FONT_NAME   = "Calibri";
const FONT_SZ     = 11;

function rowFont(row: ExcelJS.Row, bold = false, color = C_WHITE): void {
  row.font = { name: FONT_NAME, size: FONT_SZ, bold, color: { argb: color } };
}

function applyBorders(cell: ExcelJS.Cell): void {
  const b: ExcelJS.Border = { style: "thin", color: { argb: C_BORDER } };
  cell.border = { top: b, left: b, bottom: b, right: b };
}

// ── XLSX EXPORT ───────────────────────────────────────────────────────────────

router.get("/jobs/:jobId/export/xlsx", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const jobId = String(req.params.jobId);

  const [job] = await db.select().from(jobsTable)
    .where(and(eq(jobsTable.id, jobId), eq(jobsTable.tenantId, tenantId)));
  if (!job) { res.status(404).json({ error: "Job not found" }); return; }

  const [pricingRow] = await db.select().from(tenantPricingSettingsTable)
    .where(eq(tenantPricingSettingsTable.tenantId, tenantId));

  type InstallationSettings = { defaultPerSign?: number; note?: string; overrides?: Record<string, number> };
  const pricing = pricingRow ? {
    materials: (pricingRow.materials as PricingMaterial[]) ?? [],
    finishings: (pricingRow.finishings as PricingFinishing[]) ?? [],
    signDefaults: (pricingRow.signDefaults as PricingSignDefault[]) ?? [],
    installation: (pricingRow.installation as InstallationSettings | null) ?? null,
  } : null;
  const hasPricing = pricing != null && pricing.materials.length > 0;

  // Installation defaults (fallback when no tenant settings)
  const DEFAULT_INSTALL_PER_SIGN = 18.00;
  const installSettings: InstallationSettings = pricing?.installation ?? {};
  const installDefault = installSettings.defaultPerSign ?? DEFAULT_INSTALL_PER_SIGN;
  const installOverrides: Record<string, number> = installSettings.overrides ?? { "Elevator": 25.00, "Evacuation Map": 25.00 };

  function getInstallCost(signType: string): number {
    return installOverrides[signType] ?? installDefault;
  }

  const signsRaw = await db.select({
    sign: signsTable,
    roomNumber: roomsTable.roomNumber,
    roomName: roomsTable.roomName,
    level: roomsTable.level,
    roomReviewStatus: roomsTable.reviewStatus,
    roomSource: roomsTable.source,
  })
    .from(signsTable)
    .leftJoin(roomsTable, eq(signsTable.roomId, roomsTable.id))
    .where(and(
      eq(signsTable.jobId, jobId),
      eq(signsTable.tenantId, tenantId),
      eq(signsTable.isDeleted, false),
    ));

  const signs = signsRaw.filter(row =>
    row.sign.source !== "exterior" && row.roomReviewStatus !== "dismissed"
  );

  const jobMeta = await db.query.jobsTable.findFirst({
    where: eq(jobsTable.id, jobId),
    columns: { metadata: true },
  });
  type DictEntry = { typeCode?: string; typeName?: string; description?: string; size?: string; material?: string };
  const rawDict = (jobMeta?.metadata as Record<string, unknown> | null)?.projectSignDictionary as { signTypes?: DictEntry[] } | null | undefined;
  const signDictionary: DictEntry[] = rawDict?.signTypes ?? [];
  const dictByCode = new Map(
    signDictionary
      .filter(e => e.typeCode)
      .map(e => [e.typeCode!.toUpperCase(), e]),
  );

  const today = new Date().toISOString().split("T")[0];
  const totalQty = signs.reduce((s, r) => s + (r.sign.qty ?? 1), 0);
  const buildingType = job.buildingType ?? "";

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Sign Takeoff IQ";
  workbook.created = new Date();

  // ──────────────────────────────────────────────────
  // TAB 1  —  Takeoff
  // ──────────────────────────────────────────────────
  const ws1 = workbook.addWorksheet("Takeoff");
  ws1.columns = [
    { key: "floor",       width: 20 },
    { key: "roomNum",     width: 12 },
    { key: "roomName",    width: 24 },
    { key: "signType",    width: 22 },
    { key: "size",        width: 12 },
    { key: "qty",         width: 7  },
    { key: "ada",         width: 7  },
    { key: "notes",       width: 24 },
    { key: "description", width: 30 },
    { key: "material",    width: 20 },
    { key: "finish",      width: 20 },
    { key: "unitPrice",   width: 12 },
    { key: "extended",    width: 12 },
  ];
  const COLS = 13;

  // Row 1 — title (merged, amber)
  const titleParts = [`Project: ${job.name ?? "Untitled"}`];
  if (buildingType) titleParts.push(buildingType);
  titleParts.push(today);
  titleParts.push(`Total Signs: ${totalQty}`);
  const titleText = titleParts.join(" | ");

  const r1 = ws1.getRow(1);
  r1.height = 22;
  r1.getCell(1).value = titleText;
  ws1.mergeCells(1, 1, 1, COLS);
  r1.getCell(1).fill = solidFill(C_AMBER);
  r1.getCell(1).alignment = { horizontal: "left", vertical: "middle" };
  rowFont(r1, true, C_WHITE);

  // Row 2 — column headers (dark navy)
  const HDRS = ["Floor", "Room #", "Room Name", "Sign Type", "Size", "Qty", "ADA", "Notes", "Description", "Material", "Finish", "Unit Price", "Extended"];
  const r2 = ws1.getRow(2);
  r2.height = 18;
  HDRS.forEach((h, i) => {
    const cell = r2.getCell(i + 1);
    cell.value = h;
    cell.fill = solidFill(C_DARK_HDR);
    cell.font = { name: FONT_NAME, size: FONT_SZ, bold: true, color: { argb: C_WHITE } };
    cell.alignment = { horizontal: "center", vertical: "middle" };
    if (i + 1 === 12 || i + 1 === 13) cell.numFmt = '$#,##0.00';
  });

  ws1.views = [{ state: "frozen", ySplit: 2, xSplit: 0 }];

  // Normalise level strings before grouping so that variants like "Level 1",
  // "LEVEL 1", and "level 1" all collapse into the same section.
  // The canonical form (first seen for each key) is stored for display.
  function normalizeLevelKey(l: string | null | undefined): string {
    return (l ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  }
  const levelCanonical = new Map<string, string>(); // normalised key → first-seen display value

  // Group by floor.
  // For egress/rules_engine signs there is no joined room so row.level is null;
  // fall back to sign.floorLabel so stair and evac-map rows land on the correct
  // floor section instead of an empty "Unspecified Floor" bucket.
  const floorMap = new Map<string, typeof signs>();
  for (const row of signs) {
    const raw = row.level ?? row.sign.floorLabel ?? "";
    const key = normalizeLevelKey(raw);
    if (!floorMap.has(key)) {
      floorMap.set(key, []);
      levelCanonical.set(key, raw); // save first-seen value for display
    }
    floorMap.get(key)!.push(row);
  }
  const sortedFloors = [...floorMap.keys()].sort((a, b) =>
    floorSortKey(levelCanonical.get(a) ?? a).localeCompare(
      floorSortKey(levelCanonical.get(b) ?? b)
    )
  );

  let ri = 3;
  let grandQty = 0;
  let grandExtended = 0;

  for (const lvl of sortedFloors) {
    // Wing-aware sort: W-prefix rooms first (numerically), E-prefix second (numerically),
    // then all other rooms numerically/alphabetically.
    const floorSigns = [...floorMap.get(lvl)!].sort((a, b) => {
      // For schedule signs, roomNumber from the JOIN is null; fall back to the
      // first segment of the message field which carries the schedule room number.
      const roomA = a.roomNumber ?? a.sign.message?.split(" | ")[0]?.trim() ?? "";
      const roomB = b.roomNumber ?? b.sign.message?.split(" | ")[0]?.trim() ?? "";
      return wingRoomSortKey(roomA).localeCompare(wingRoomSortKey(roomB), undefined, { numeric: true });
    });
    const label = formatLevel(levelCanonical.get(lvl) ?? lvl);

    // Floor header row
    const flrRow = ws1.getRow(ri++);
    flrRow.height = 17;
    flrRow.getCell(1).value = `  ${label.toUpperCase()}`;
    ws1.mergeCells(ri - 1, 1, ri - 1, COLS);
    flrRow.getCell(1).fill = solidFill(C_FLOOR_HDR);
    flrRow.getCell(1).alignment = { horizontal: "left", vertical: "middle" };
    rowFont(flrRow, true, C_WHITE);

    let floorQty = 0;
    let floorExtended = 0;
    let alt = 0;
    for (const row of floorSigns) {
      const qty = row.sign.qty ?? 1;
      floorQty += qty;
      const signType = row.sign.signType ?? "";
      const dictEntry = dictByCode.get(signType.toUpperCase());
      const spec = getSignPricingInfo(signType, row.sign.dimensions ?? "", pricing);
      const matName = dictEntry?.material ?? spec.materialName;
      let wForPrice = spec.width;
      let hForPrice = spec.height;
      if (dictEntry?.size) {
        const sizeMatch = dictEntry.size.match(/(\d+(?:\.\d+)?)\s*[xX\u00d7]\s*(\d+(?:\.\d+)?)/);
        if (sizeMatch) {
          wForPrice = parseFloat(sizeMatch[1]);
          hForPrice = parseFloat(sizeMatch[2]);
        }
      }
      // If tenant pricing doesn't carry a flatPrice, fall back to MSRP_DEFAULTS
      // (catches evacuation_map = $45 flat when a stub tenant entry exists).
      const msrpFlatPrice = MSRP_DEFAULTS[normalizeSignType(signType)]?.flatPrice;
      const flatPrice = spec.flatPrice ?? msrpFlatPrice;
      const unitPrice = Math.round((
        flatPrice != null
          ? flatPrice
          : Math.max(
              spec.minPrice ?? 0,
              (spec.materialRate + spec.finishingRate) * wForPrice * hForPrice
            )
      ) * 100) / 100;
      const extended = Math.round(unitPrice * qty * 100) / 100;
      floorExtended += extended;

      const dr = ws1.getRow(ri++);
      dr.height = 15;
      const bg = alt++ % 2 === 0 ? C_WHITE : C_ALT_ROW;
      for (let c = 1; c <= COLS; c++) {
        dr.getCell(c).fill = solidFill(bg);
        dr.getCell(c).font = { name: FONT_NAME, size: FONT_SZ };
        dr.getCell(c).alignment = { vertical: "middle" };
      }
      dr.getCell(1).value = label;
      dr.getCell(2).value = row.roomNumber ?? row.sign.roomNumber ?? "";
      dr.getCell(3).value = row.roomName ?? row.sign.roomName ?? "";
      dr.getCell(4).value = signType;
      dr.getCell(5).value = row.sign.dimensions ?? "";
      dr.getCell(6).value = qty;
      dr.getCell(7).value = isAdaSignType(signType) ? "✓" : "—";
      dr.getCell(8).value = "";
      dr.getCell(9).value = dictEntry?.description ?? "";
      dr.getCell(10).value = matName;
      dr.getCell(11).value = spec.finishingName;
      dr.getCell(12).value = unitPrice;
      dr.getCell(13).value = extended;
      dr.getCell(6).alignment = { horizontal: "center", vertical: "middle" };
      dr.getCell(7).alignment = { horizontal: "center", vertical: "middle" };
      dr.getCell(12).numFmt = '$#,##0.00';
      dr.getCell(13).numFmt = '$#,##0.00';
    }
    grandQty += floorQty;
    grandExtended += floorExtended;

    // Subtotal row (light blue) — label in cols 1–11, extended sum in col 12
    const stRow = ws1.getRow(ri++);
    stRow.height = 16;
    stRow.getCell(1).value = `   ${label} Subtotal: ${floorQty} sign${floorQty !== 1 ? "s" : ""}`;
    ws1.mergeCells(ri - 1, 1, ri - 1, 12);
    stRow.getCell(1).fill = solidFill(C_SUBTOTAL);
    stRow.getCell(1).alignment = { horizontal: "left", vertical: "middle" };
    stRow.getCell(1).font = { name: FONT_NAME, size: FONT_SZ, bold: true, color: { argb: C_SUB_FONT } };
    const stExt = stRow.getCell(13);
    stExt.value = Math.round(floorExtended * 100) / 100;
    stExt.numFmt = '$#,##0.00';
    stExt.fill = solidFill(C_SUBTOTAL);
    stExt.font = { name: FONT_NAME, size: FONT_SZ, bold: true, color: { argb: C_SUB_FONT } };
    stExt.alignment = { horizontal: "right", vertical: "middle" };
  }

  // Grand Total row (amber) — label in cols 1–11, grand extended in col 12
  const gtRow = ws1.getRow(ri);
  gtRow.height = 18;
  gtRow.getCell(1).value = `GRAND TOTAL: ${grandQty} sign${grandQty !== 1 ? "s" : ""}`;
  ws1.mergeCells(ri, 1, ri, 12);
  gtRow.getCell(1).fill = solidFill(C_AMBER);
  gtRow.getCell(1).alignment = { horizontal: "left", vertical: "middle" };
  rowFont(gtRow, true, C_WHITE);
  const gtExt = gtRow.getCell(13);
  gtExt.value = Math.round(grandExtended * 100) / 100;
  gtExt.numFmt = '$#,##0.00';
  gtExt.fill = solidFill(C_AMBER);
  gtExt.font = { name: FONT_NAME, size: FONT_SZ, bold: true, color: { argb: C_WHITE } };
  gtExt.alignment = { horizontal: "right", vertical: "middle" };

  // ──────────────────────────────────────────────────
  // TAB 2  —  Summary (sign count schedule only — no pricing)
  // ──────────────────────────────────────────────────
  const ws2 = workbook.addWorksheet("Summary");
  const S2_COLS = 4;
  ws2.columns = [
    { key: "signType", width: 26 },
    { key: "size",     width: 16 },
    { key: "totalQty", width: 12 },
    { key: "adaReq",   width: 16 },
  ];

  const S2H = ws2.getRow(1);
  S2H.height = 18;
  ["Sign Type", "Standard Size", "Total Qty", "ADA Required"].forEach((h, i) => {
    const cell = S2H.getCell(i + 1);
    cell.value = h;
    cell.fill = solidFill(C_DARK_HDR);
    cell.font = { name: FONT_NAME, size: FONT_SZ, bold: true, color: { argb: C_WHITE } };
    cell.alignment = { horizontal: "center", vertical: "middle" };
  });

  const typeMap = new Map<string, { qty: number; size: string; ada: boolean }>();
  for (const row of signs) {
    const t = row.sign.signType ?? "Unknown";
    if (!typeMap.has(t)) typeMap.set(t, { qty: 0, size: row.sign.dimensions ?? "", ada: isAdaSignType(t) });
    typeMap.get(t)!.qty += row.sign.qty ?? 1;
  }

  let s2ri = 2;
  for (const [signType, info] of typeMap) {
    const r = ws2.getRow(s2ri);
    r.height = 15;
    const bg = (s2ri - 2) % 2 === 0 ? C_WHITE : C_ALT_ROW;
    for (let c = 1; c <= S2_COLS; c++) {
      r.getCell(c).fill = solidFill(bg);
      r.getCell(c).font = { name: FONT_NAME, size: FONT_SZ };
      r.getCell(c).alignment = { vertical: "middle" };
    }
    r.getCell(1).value = signType;
    r.getCell(2).value = info.size || "";
    r.getCell(3).value = info.qty;
    r.getCell(3).alignment = { horizontal: "center", vertical: "middle" };
    r.getCell(4).value = info.ada ? "Yes" : "No";
    r.getCell(4).alignment = { horizontal: "center", vertical: "middle" };
    s2ri++;
  }

  // ──────────────────────────────────────────────────
  // TAB 3  —  Pricing (always present; MSRP defaults when no tenant pricing)
  // ──────────────────────────────────────────────────
  {
    const pricingSource = hasPricing ? "company settings" : "MSRP defaults";
    console.log(`[exports] Pricing tab: using ${pricingSource} pricing for job ${jobId}`);

    const ws3 = workbook.addWorksheet("Pricing");
    const P_COLS = 12; // A–L
    ws3.columns = [
      { key: "signType",  width: 22 }, // A
      { key: "size",      width: 10 }, // B
      { key: "sqin",      width: 10 }, // C
      { key: "qty",       width:  8 }, // D
      { key: "material",  width: 28 }, // E
      { key: "finishing", width: 28 }, // F
      { key: "baseRate",  width: 12 }, // G
      { key: "finRate",   width: 14 }, // H
      { key: "totalRate", width: 12 }, // I
      { key: "unitPrice", width: 12 }, // J
      { key: "extPrice",  width: 14 }, // K
      { key: "notes",     width: 20 }, // L
    ];

    // Row 1 — Project title (merged, amber, 14pt)
    const defaultMat = hasPricing && pricing
      ? (pricing.materials.find(m => m.id === pricing.signDefaults[0]?.materialId) ?? pricing.materials[0])
      : null;
    const pricingMaterialName = defaultMat?.name ?? "MSRP defaults";
    const p3Title = `${job.name ?? "Untitled"} | ${buildingType || "Unknown Type"} | ${today} | Pricing based on: ${pricingMaterialName}`;
    const p3r1 = ws3.getRow(1);
    p3r1.height = 24;
    ws3.mergeCells(1, 1, 1, P_COLS);
    p3r1.getCell(1).value = p3Title;
    p3r1.getCell(1).fill = solidFill(C_AMBER);
    p3r1.getCell(1).font = { name: FONT_NAME, size: 14, bold: true, color: { argb: C_WHITE } };
    p3r1.getCell(1).alignment = { horizontal: "left", vertical: "middle" };

    // Row 2 — Note (merged, light yellow, italic gray)
    const p3r2 = ws3.getRow(2);
    p3r2.height = 18;
    ws3.mergeCells(2, 1, 2, P_COLS);
    p3r2.getCell(1).value =
      "Base prices from company settings. Adjust quantities or unit prices as needed. Yellow cells are editable.";
    p3r2.getCell(1).fill = solidFill(C_YELLOW_EDIT);
    p3r2.getCell(1).font = { name: FONT_NAME, size: 10, italic: true, color: { argb: "FF6B7280" } };
    p3r2.getCell(1).alignment = { horizontal: "left", vertical: "middle" };

    // Row 3 — Column headers (dark, centered)
    const p3Headers = [
      "Sign Type", "Size (W \u00d7 H)", "Sq Inches", "Qty",
      "Material", "Finishing", "Base $/sq in", "Finishing $/sq in",
      "Total $/sq in", "Unit Price", "Extended Price", "Notes",
    ];
    const p3r3 = ws3.getRow(3);
    p3r3.height = 18;
    p3Headers.forEach((h, i) => {
      const cell = p3r3.getCell(i + 1);
      cell.value = h;
      cell.fill = solidFill(C_DARK_HDR);
      cell.font = { name: FONT_NAME, size: FONT_SZ, bold: true, color: { argb: C_WHITE } };
      cell.alignment = { horizontal: "center", vertical: "middle" };
    });

    // Freeze first 3 rows; auto-filter on header row
    ws3.views = [{ state: "frozen", ySplit: 3, xSplit: 0 }];
    ws3.autoFilter = `A3:L3`;

    // ── Data rows (starting at row 4) ──────────────────
    const dataStartRow = 4;
    let p3ri = dataStartRow;
    let p3Subtotal = 0;
    const signTypeRowMap = new Map<string, number>(); // signType → row number in Pricing sheet

    const jobMaterialSpec = await getJobMaterialSpec(jobId);

    for (const [signType, info] of typeMap) {
      const pInfo = { ...getSignPricingInfo(signType, info.size, pricing) };
      // Apply project-wide material spec overrides from sign schedule (when available)
      if (jobMaterialSpec) {
        if (jobMaterialSpec.substrate)    pInfo.materialName  = jobMaterialSpec.substrate;
        if (jobMaterialSpec.finishMethod) pInfo.finishingName = jobMaterialSpec.finishMethod;
      }
      const isFlat = pInfo.flatPrice != null;
      const sqin = isFlat ? 0 : (pInfo.width * pInfo.height);
      const totalRate = pInfo.materialRate + pInfo.finishingRate;
      const base = isFlat ? pInfo.flatPrice! : sqin * totalRate;
      const unitPrice = Number(Math.max(pInfo.minPrice, base).toFixed(2));
      const extPrice  = Number((unitPrice * info.qty).toFixed(2));
      p3Subtotal += extPrice;

      const r = ws3.getRow(p3ri);
      r.height = 15;
      const altBg = (p3ri - dataStartRow) % 2 === 0 ? C_WHITE : C_ALT_ROW;

      for (let c = 1; c <= P_COLS; c++) {
        const cell = r.getCell(c);
        // Yellow editable: D=4, J=10, L=12
        if (c === 4 || c === 10 || c === 12) cell.fill = solidFill(C_YELLOW_EDIT);
        // Gray reference: E=5, F=6, G=7, H=8, I=9
        else if (c >= 5 && c <= 9) cell.fill = solidFill(C_GRAY_REF);
        else cell.fill = solidFill(altBg);
        cell.font = { name: FONT_NAME, size: FONT_SZ };
        cell.alignment = { vertical: "middle" };
        applyBorders(cell);
      }

      // A — Sign Type
      r.getCell(1).value = signType;
      // B — Size
      r.getCell(2).value = isFlat ? "\u2014" : (info.size || `${pInfo.width} \u00d7 ${pInfo.height}`);
      // C — Sq Inches
      if (!isFlat && sqin > 0) {
        r.getCell(3).value = sqin;
        r.getCell(3).alignment = { horizontal: "center", vertical: "middle" };
      }
      // D — Qty (bold, editable)
      r.getCell(4).value = info.qty;
      r.getCell(4).font = { name: FONT_NAME, size: FONT_SZ, bold: true };
      r.getCell(4).alignment = { horizontal: "center", vertical: "middle" };
      // E — Material (gray text)
      r.getCell(5).value = pInfo.materialName;
      r.getCell(5).font = { name: FONT_NAME, size: FONT_SZ, color: { argb: "FF6B7280" } };
      // F — Finishing (gray text)
      r.getCell(6).value = pInfo.finishingName || "\u2014";
      r.getCell(6).font = { name: FONT_NAME, size: FONT_SZ, color: { argb: "FF6B7280" } };
      // G — Base $/sq in (gray)
      if (!isFlat && pInfo.materialRate > 0) {
        r.getCell(7).value = pInfo.materialRate;
        r.getCell(7).numFmt = '"$"#,##0.00';
        r.getCell(7).font = { name: FONT_NAME, size: FONT_SZ, color: { argb: "FF6B7280" } };
      }
      // H — Finishing $/sq in (gray)
      if (!isFlat && pInfo.finishingRate > 0) {
        r.getCell(8).value = pInfo.finishingRate;
        r.getCell(8).numFmt = '"$"#,##0.00';
        r.getCell(8).font = { name: FONT_NAME, size: FONT_SZ, color: { argb: "FF6B7280" } };
      }
      // I — Total $/sq in (gray, formula G+H)
      if (!isFlat && totalRate > 0) {
        r.getCell(9).value = { formula: `G${p3ri}+H${p3ri}`, result: totalRate };
        r.getCell(9).numFmt = '"$"#,##0.00';
        r.getCell(9).font = { name: FONT_NAME, size: FONT_SZ, color: { argb: "FF6B7280" } };
      }
      // J — Unit Price (bold, editable yellow, formula MAX(minP, C*I) or flat)
      if (isFlat) {
        r.getCell(10).value = unitPrice;
      } else {
        r.getCell(10).value = {
          formula: `MAX(${pInfo.minPrice},C${p3ri}*I${p3ri})`,
          result: unitPrice,
        };
      }
      r.getCell(10).numFmt = '"$"#,##0.00';
      r.getCell(10).font = { name: FONT_NAME, size: FONT_SZ, bold: true };
      // K — Extended Price (bold, formula D*J)
      r.getCell(11).value = { formula: `D${p3ri}*J${p3ri}`, result: extPrice };
      r.getCell(11).numFmt = '"$"#,##0.00';
      r.getCell(11).font = { name: FONT_NAME, size: FONT_SZ, bold: true };
      // L — Notes (editable yellow)
      {
        let notesVal = pInfo.notes || "";
        if (jobMaterialSpec?.manufacturer) {
          notesVal = notesVal
            ? `${notesVal} | Manufacturer: ${jobMaterialSpec.manufacturer}`
            : `Manufacturer: ${jobMaterialSpec.manufacturer}`;
        }
        r.getCell(12).value = notesVal;
      }

      signTypeRowMap.set(signType, p3ri);
      p3ri++;
    }

    const dataEndRow = p3ri - 1;

    // ── INSTALLATION section ──────────────────────────

    // Blank row before install section
    p3ri++;

    // INSTALLATION label row (dark header, white bold)
    const installLabelRowNum = p3ri++;
    const instLbl = ws3.getRow(installLabelRowNum);
    instLbl.height = 16;
    ws3.mergeCells(installLabelRowNum, 1, installLabelRowNum, P_COLS);
    instLbl.getCell(1).value = "INSTALLATION";
    instLbl.getCell(1).fill = solidFill(C_DARK_HDR);
    instLbl.getCell(1).font = { name: FONT_NAME, size: FONT_SZ, bold: true, color: { argb: C_WHITE } };
    instLbl.getCell(1).alignment = { horizontal: "left", vertical: "middle" };

    // One row per sign type
    const installRowNums: number[] = [];
    for (const [signType, info] of typeMap) {
      const origRow = signTypeRowMap.get(signType);
      const installCost = getInstallCost(signType);
      const extInstall = Number((installCost * info.qty).toFixed(2));
      const iRow = ws3.getRow(p3ri);
      iRow.height = 15;
      const altBg = (installRowNums.length) % 2 === 0 ? C_WHITE : C_ALT_ROW;
      for (let c = 1; c <= P_COLS; c++) {
        const cell = iRow.getCell(c);
        if (c === 4 || c === 10) cell.fill = solidFill(C_YELLOW_EDIT);
        else cell.fill = solidFill(altBg);
        cell.font = { name: FONT_NAME, size: FONT_SZ };
        cell.alignment = { vertical: "middle" };
        applyBorders(cell);
      }
      // A — label
      iRow.getCell(1).value = `${signType} Installation`;
      // D — Qty linked to original sign row (editable yellow)
      iRow.getCell(4).value = origRow
        ? { formula: `D${origRow}`, result: info.qty }
        : info.qty;
      iRow.getCell(4).font = { name: FONT_NAME, size: FONT_SZ, bold: true };
      iRow.getCell(4).alignment = { horizontal: "center", vertical: "middle" };
      // J — Install cost per sign (editable yellow)
      iRow.getCell(10).value = installCost;
      iRow.getCell(10).numFmt = '"$"#,##0.00';
      iRow.getCell(10).font = { name: FONT_NAME, size: FONT_SZ, bold: true };
      // K — Extended (=D*J)
      iRow.getCell(11).value = { formula: `D${p3ri}*J${p3ri}`, result: extInstall };
      iRow.getCell(11).numFmt = '"$"#,##0.00';
      iRow.getCell(11).font = { name: FONT_NAME, size: FONT_SZ, bold: true };
      installRowNums.push(p3ri);
      p3ri++;
    }

    // Installation subtotal row (light green)
    const installSubtotalRowNum = p3ri++;
    const instSub = ws3.getRow(installSubtotalRowNum);
    instSub.height = 16;
    for (let c = 1; c <= P_COLS; c++) {
      instSub.getCell(c).fill = solidFill(C_INSTALL_SUB);
      instSub.getCell(c).font = { name: FONT_NAME, size: FONT_SZ, bold: true, color: { argb: C_INSTALL_FONT } };
      applyBorders(instSub.getCell(c));
    }
    instSub.getCell(1).value = "Installation Subtotal";
    let p3InstallTotal = 0;
    for (const [st2, info2] of typeMap) p3InstallTotal += getInstallCost(st2) * info2.qty;
    if (installRowNums.length > 0) {
      const firstIR = installRowNums[0];
      const lastIR  = installRowNums[installRowNums.length - 1];
      instSub.getCell(11).value = {
        formula: `SUM(K${firstIR}:K${lastIR})`,
        result: Number(p3InstallTotal.toFixed(2)),
      };
    } else {
      instSub.getCell(11).value = 0;
    }
    instSub.getCell(11).numFmt = '"$"#,##0.00';

    // Blank row before signs subtotal
    p3ri++;

    // ── SUBTOTAL row (light blue) ──
    const subtotalRowNum = p3ri++;
    const p3sub = ws3.getRow(subtotalRowNum);
    p3sub.height = 16;
    for (let c = 1; c <= P_COLS; c++) {
      p3sub.getCell(c).fill = solidFill(C_SUBTOTAL);
      p3sub.getCell(c).font = { name: FONT_NAME, size: FONT_SZ, bold: true, color: { argb: C_SUB_FONT } };
      applyBorders(p3sub.getCell(c));
    }
    p3sub.getCell(1).value = "Subtotal";
    p3sub.getCell(11).value = {
      formula: `SUM(K${dataStartRow}:K${dataEndRow})`,
      result: p3Subtotal,
    };
    p3sub.getCell(11).numFmt = '"$"#,##0.00';

    // ── RUSH FEE row ──
    const rushFeeRowNum = p3ri++;
    const p3rush = ws3.getRow(rushFeeRowNum);
    p3rush.height = 15;
    for (let c = 1; c <= P_COLS; c++) {
      p3rush.getCell(c).fill = solidFill(C_WHITE);
      p3rush.getCell(c).font = { name: FONT_NAME, size: FONT_SZ };
      applyBorders(p3rush.getCell(c));
    }
    p3rush.getCell(1).value = "Rush Fee (if applicable)";
    p3rush.getCell(4).value = "\u2014";
    p3rush.getCell(4).alignment = { horizontal: "center", vertical: "middle" };
    // J — estimator enters % (e.g. 0.10 for 10%)
    p3rush.getCell(10).fill = solidFill(C_YELLOW_EDIT);
    p3rush.getCell(10).numFmt = "0%";
    // K — subtotal × rush %
    p3rush.getCell(11).value = {
      formula: `K${subtotalRowNum}*IF(J${rushFeeRowNum}="",0,J${rushFeeRowNum})`,
      result: 0,
    };
    p3rush.getCell(11).numFmt = '"$"#,##0.00';

    // ── SHIPPING row ──
    const shippingRowNum = p3ri++;
    const p3ship = ws3.getRow(shippingRowNum);
    p3ship.height = 15;
    for (let c = 1; c <= P_COLS; c++) {
      p3ship.getCell(c).fill = solidFill(C_WHITE);
      p3ship.getCell(c).font = { name: FONT_NAME, size: FONT_SZ };
      applyBorders(p3ship.getCell(c));
    }
    p3ship.getCell(1).value = "Shipping";
    p3ship.getCell(11).fill = solidFill(C_YELLOW_EDIT); // K — estimator enters
    p3ship.getCell(11).numFmt = '"$"#,##0.00';

    // ── ADDITIONAL CHARGES row ──
    const additionalRowNum = p3ri++;
    const p3add = ws3.getRow(additionalRowNum);
    p3add.height = 15;
    for (let c = 1; c <= P_COLS; c++) {
      p3add.getCell(c).fill = solidFill(C_WHITE);
      p3add.getCell(c).font = { name: FONT_NAME, size: FONT_SZ };
      applyBorders(p3add.getCell(c));
    }
    p3add.getCell(1).value = "Additional Charges";
    p3add.getCell(11).fill = solidFill(C_YELLOW_EDIT); // K — estimator enters
    p3add.getCell(11).numFmt = '"$"#,##0.00';

    // Blank before grand total
    p3ri++;

    // ── GRAND TOTAL row (amber, 12pt) ──
    const grandTotalRowNum = p3ri++;
    const p3gt = ws3.getRow(grandTotalRowNum);
    p3gt.height = 22;
    for (let c = 1; c <= P_COLS; c++) {
      p3gt.getCell(c).fill = solidFill(C_AMBER);
      p3gt.getCell(c).font = { name: FONT_NAME, size: 12, bold: true, color: { argb: C_WHITE } };
      applyBorders(p3gt.getCell(c));
    }
    p3gt.getCell(1).value = "GRAND TOTAL";
    p3gt.getCell(11).value = {
      formula: `K${subtotalRowNum}+IFERROR(K${installSubtotalRowNum},0)+IFERROR(K${rushFeeRowNum},0)+IFERROR(K${shippingRowNum},0)+IFERROR(K${additionalRowNum},0)`,
      result: Number((p3Subtotal + p3InstallTotal).toFixed(2)),
    };
    p3gt.getCell(11).numFmt = '"$"#,##0.00';

    // ── Footer note ──
    const footerRowNum = grandTotalRowNum + 2;
    ws3.mergeCells(footerRowNum, 1, footerRowNum, P_COLS);
    const p3footer = ws3.getRow(footerRowNum);
    p3footer.height = 28;
    p3footer.getCell(1).value =
      "* Prices shown are suggested bid prices based on your company settings (Settings \u2192 Pricing). " +
      "Yellow cells can be edited for this estimate. To update default prices, go to Settings \u2192 Pricing.";
    p3footer.getCell(1).font = { name: FONT_NAME, size: 9, italic: true, color: { argb: "FF6B7280" } };
    p3footer.getCell(1).alignment = { horizontal: "left", vertical: "middle", wrapText: true };
  }

  // TAB 4  —  Specialty Signs (orange; only included when specialty signs exist)
  // ──────────────────────────────────────────────────
  {
    const specialtySigns = await db.select().from(specialtySignsTable)
      .where(and(eq(specialtySignsTable.jobId, jobId), eq(specialtySignsTable.tenantId, tenantId)))
      .orderBy(specialtySignsTable.signCode);

    if (specialtySigns.length > 0) {
      const C_ORANGE      = "FFE8610D";
      const C_ORANGE_LITE = "FFFFF0E6";
      const SS_COLS = 7; // A–G

      const ws4 = workbook.addWorksheet("Specialty Signs");
      ws4.columns = [
        { key: "signCode",   width: 14 }, // A
        { key: "desc",       width: 40 }, // B
        { key: "dimensions", width: 14 }, // C
        { key: "material",   width: 20 }, // D
        { key: "finish",     width: 20 }, // E
        { key: "qty",        width:  8 }, // F
        { key: "notes",      width: 30 }, // G
      ];

      // Row 1 — title (orange)
      const ss1 = ws4.getRow(1);
      ss1.height = 24;
      ws4.mergeCells(1, 1, 1, SS_COLS);
      ss1.getCell(1).value = `${job.name ?? "Untitled"} — Specialty Signs  |  ${today}`;
      ss1.getCell(1).fill = solidFill(C_ORANGE);
      ss1.getCell(1).font = { name: FONT_NAME, size: 14, bold: true, color: { argb: C_WHITE } };
      ss1.getCell(1).alignment = { horizontal: "left", vertical: "middle" };

      // Row 2 — note
      const ss2 = ws4.getRow(2);
      ss2.height = 18;
      ws4.mergeCells(2, 1, 2, SS_COLS);
      ss2.getCell(1).value =
        "Specialty signs, wallcoverings, and graphic elements extracted from detail sheets. " +
        "Review and confirm quantities before bidding.";
      ss2.getCell(1).fill = solidFill(C_ORANGE_LITE);
      ss2.getCell(1).font = { name: FONT_NAME, size: 10, italic: true, color: { argb: "FF6B7280" } };
      ss2.getCell(1).alignment = { horizontal: "left", vertical: "middle" };

      // Row 3 — column headers
      const ssHeaders = ["Code", "Description", "Dimensions", "Material", "Finish", "Qty", "Notes"];
      const ss3 = ws4.getRow(3);
      ss3.height = 20;
      ssHeaders.forEach((h, i) => {
        const c = ss3.getCell(i + 1);
        c.value = h;
        c.fill = solidFill(C_ORANGE);
        c.font = { name: FONT_NAME, size: 11, bold: true, color: { argb: C_WHITE } };
        c.alignment = { horizontal: "center", vertical: "middle" };
        applyBorders(c);
      });
      ws4.views = [{ state: "frozen", ySplit: 3 }];

      // Data rows
      for (let idx = 0; idx < specialtySigns.length; idx++) {
        const ss = specialtySigns[idx];
        const ssRowNum = idx + 4;
        const ssRow = ws4.getRow(ssRowNum);
        ssRow.height = 18;
        const bg = idx % 2 === 0 ? C_ORANGE_LITE : C_ALT_ROW;
        const vals = [
          ss.signCode ?? "",
          ss.description,
          ss.dimensions ?? "",
          ss.material ?? "",
          ss.finish ?? "",
          ss.qty ?? "",
          ss.notes ?? "",
        ];
        vals.forEach((v, i) => {
          const c = ssRow.getCell(i + 1);
          c.value = v;
          c.fill = solidFill(bg);
          c.font = { name: FONT_NAME, size: 11 };
          c.alignment = { vertical: "middle", wrapText: i === 1 };
          applyBorders(c);
        });
      }

      // Totals row
      const ssTotalRow = ws4.getRow(specialtySigns.length + 4);
      ssTotalRow.height = 20;
      ws4.mergeCells(specialtySigns.length + 4, 1, specialtySigns.length + 4, SS_COLS - 2);
      ssTotalRow.getCell(1).value = `${specialtySigns.length} specialty item(s)`;
      ssTotalRow.getCell(1).fill = solidFill(C_ORANGE);
      ssTotalRow.getCell(1).font = { name: FONT_NAME, size: 11, bold: true, color: { argb: C_WHITE } };
      ssTotalRow.getCell(1).alignment = { horizontal: "left", vertical: "middle" };
    }
  }

  // ── Assumptions tab ─────────────────────────────────────────────────────────
  {
    const wsA = workbook.addWorksheet("Assumptions");
    const C_AMBER_FILL = "FFFEF3C7";
    const C_AMBER_DARK = "FFD97706";

    wsA.columns = [
      { key: "label", width: 30 },
      { key: "value", width: 70 },
    ];

    // Row 1 — header
    const aR1 = wsA.getRow(1);
    aR1.height = 28;
    aR1.getCell(1).value = "Estimation Use Only — Not for Production";
    wsA.mergeCells(1, 1, 1, 2);
    aR1.getCell(1).fill = solidFill(C_AMBER_DARK);
    aR1.getCell(1).font = { name: FONT_NAME, size: 14, bold: true, color: { argb: C_WHITE } };
    aR1.getCell(1).alignment = { horizontal: "left", vertical: "middle" };

    // Row 2 — blank spacer
    wsA.getRow(2).height = 6;

    // Strategy-aware rows
    const jobMeta = (job.metadata ?? {}) as Record<string, unknown>;
    const strategyStored = jobMeta.pipelineStrategy as string | undefined;
    const detectedStrategy = strategyStored ?? (job.hasScheduleImport ? "schedule_primary" : "floor_plan_primary");
    const pricingOverrides = job.pricingOverrides ?? null;

    const strategyRows: [string, string][] = [
      [
        "Pipeline Strategy",
        detectedStrategy === "schedule_primary"
          ? "schedule_primary — sign schedule drives count and type"
          : detectedStrategy === "floor_plan_primary"
          ? "floor_plan_primary — full AI floor plan extraction"
          : "hybrid — combined schedule and AI extraction",
      ],
      [
        "Sign Count Source",
        detectedStrategy === "schedule_primary"
          ? "Sign schedule (explicit room-by-type table)"
          : "AI vision extraction from floor plans",
      ],
      [
        "Egress Signs",
        detectedStrategy === "schedule_primary"
          ? "Rules engine R1–R4 only (stair, exit, evacuation map)"
          : "Full rules engine",
      ],
      [
        "Floor Plan Usage",
        detectedStrategy === "schedule_primary"
          ? "Coordinate extraction + egress room detection only"
          : "Full room extraction and classification",
      ],
      [
        "Pricing Basis",
        pricingOverrides && Object.keys(pricingOverrides).length > 0
          ? "Custom per-sign-type overrides applied"
          : hasPricing
          ? "Custom tenant material rates"
          : "Default list rates",
      ],
      [
        "Last Scan",
        job.updatedAt ? new Date(job.updatedAt).toLocaleString() : today,
      ],
    ];

    let aRow = 3;
    for (const [label, value] of strategyRows) {
      const row = wsA.getRow(aRow);
      row.height = 20;
      const c1 = row.getCell(1);
      const c2 = row.getCell(2);
      c1.value = label;
      c2.value = value;
      c1.font = { name: FONT_NAME, size: 11, bold: true };
      c2.font = { name: FONT_NAME, size: 11 };
      c1.alignment = { horizontal: "left", vertical: "middle" };
      c2.alignment = { horizontal: "left", vertical: "middle" };
      if (aRow % 2 === 0) {
        c1.fill = solidFill(C_ALT_ROW);
        c2.fill = solidFill(C_ALT_ROW);
      }
      applyBorders(c1);
      applyBorders(c2);
      aRow++;
    }

    // Blank spacer
    wsA.getRow(aRow++).height = 10;

    // Disclaimer
    const disclaimerBody =
      "Produced by AI-Assist Takeoffs. This estimate was generated by combining automated plan reading, ADA code logic, " +
      "and sign schedule extraction into a single pass across your construction documents. Results reflect plan data " +
      "available at the time of processing — review against final issued-for-construction documents before submitting for production.";
    const aRDisc = wsA.getRow(aRow);
    aRDisc.height = 60;
    aRDisc.getCell(1).value = disclaimerBody;
    wsA.mergeCells(aRow, 1, aRow, 2);
    aRDisc.getCell(1).fill = solidFill(C_AMBER_FILL);
    aRDisc.getCell(1).font = { name: FONT_NAME, size: 11, color: { argb: "FF92400E" } };
    aRDisc.getCell(1).alignment = { horizontal: "left", vertical: "top", wrapText: true };
  }

  // ── Send ─────────────────────────────────────────
  const fileName = `${safeFileName(job.name ?? "Takeoff")}_Takeoff_${today}.xlsx`;
  const buffer = await workbook.xlsx.writeBuffer();
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  res.send(Buffer.from(buffer));
});

router.get("/jobs/:jobId/export/pdf", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const jobId = String(req.params.jobId);
  const includePending = req.query.includePending !== "false";

  const [job] = await db.select().from(jobsTable)
    .where(and(eq(jobsTable.id, jobId), eq(jobsTable.tenantId, tenantId)));

  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  const signsRaw = await db.select({
    sign: signsTable,
    roomNumber: roomsTable.roomNumber,
    roomName: roomsTable.roomName,
    level: roomsTable.level,
    roomReviewStatus: roomsTable.reviewStatus,
    roomSource: roomsTable.source,
  })
    .from(signsTable)
    .leftJoin(roomsTable, eq(signsTable.roomId, roomsTable.id))
    .where(and(
      eq(signsTable.jobId, jobId),
      eq(signsTable.tenantId, tenantId),
      eq(signsTable.isDeleted, false),
    ));

  const signs = signsRaw.filter(row => {
    if (row.roomReviewStatus === "dismissed") return false;
    if (!includePending && row.roomSource === "ai_vision" && row.roomReviewStatus === "pending") return false;
    return true;
  });

  const dismissedRoomIds = new Set(
    signsRaw
      .filter(row => row.roomReviewStatus === "dismissed" && row.sign.roomId != null)
      .map(row => row.sign.roomId!)
  );
  const dismissedRoomCount = dismissedRoomIds.size;

  const sheets = await db.select()
    .from(jobSheetsTable)
    .where(and(
      eq(jobSheetsTable.jobId, jobId),
      eq(jobSheetsTable.tenantId, tenantId),
    ));

  const files = await db.select()
    .from(jobFilesTable)
    .where(and(
      eq(jobFilesTable.jobId, jobId),
      eq(jobFilesTable.tenantId, tenantId),
    ));

  const sheetMap = new Map(sheets.map(s => [s.id, s]));
  const pdfDoc = await PDFDocument.create();
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const MARKER_RADIUS = 10;
  const FONT_SIZE = 8;
  let overlaidAny = false;

  for (const file of files) {
    const storagePath = file.storagePath;

    if (!storagePath || !storagePath.startsWith("/objects/")) {
      console.warn(`Skipping file ${file.id}: storagePath "${storagePath}" is not a valid /objects/ path`);
      continue;
    }

    let pdfBytes: Uint8Array | null = null;
    try {
      const gcsFile = await objectStorageService.getObjectEntityFile(storagePath);
      const [contents] = await gcsFile.download();
      pdfBytes = new Uint8Array(contents);
    } catch (err) {
      if (err instanceof ObjectNotFoundError) {
        console.warn(`File ${file.id} not found in object storage: ${storagePath}`);
      } else {
        console.warn(`Failed to download file ${file.id}:`, err);
      }
      continue;
    }

    let sourcePdf: PDFDocument;
    try {
      sourcePdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    } catch (err) {
      console.warn(`Failed to parse PDF for file ${file.id}:`, err);
      continue;
    }

    const pageCount = sourcePdf.getPageCount();
    const copiedPages = await pdfDoc.copyPages(sourcePdf, Array.from({ length: pageCount }, (_, i) => i));

    const signsForFile = signs.filter(row => {
      if (!row.sign.sheetId) return false;
      const sheet = sheetMap.get(row.sign.sheetId);
      return sheet?.fileId === file.id;
    });

    const pageToSigns = new Map<number, typeof signs>();
    for (const row of signsForFile) {
      const sheet = row.sign.sheetId ? sheetMap.get(row.sign.sheetId) : undefined;
      const pageIdx = (sheet?.pdfPage ?? 1) - 1;
      if (!pageToSigns.has(pageIdx)) pageToSigns.set(pageIdx, []);
      pageToSigns.get(pageIdx)!.push(row);
    }

    for (let i = 0; i < pageCount; i++) {
      const page = copiedPages[i];
      pdfDoc.addPage(page);
      overlaidAny = true;

      const { width, height } = page.getSize();
      const pageSigns = pageToSigns.get(i) || [];

      for (const row of pageSigns) {
        const { markerX, markerY } = row.sign;
        if (markerX == null || markerY == null) continue;

        const pdfX = (markerX / MARKER_COORD_SCALE) * width;
        const pdfY = height - (markerY / MARKER_COORD_SCALE) * height;

        const isPendingAiRoom = row.roomSource === "ai_vision" && row.roomReviewStatus === "pending";
        const markerColor = isPendingAiRoom
          ? { r: 0.867, g: 0.420, b: 0.125 }
          : getColorForSignType(row.sign.signType || "");

        page.drawCircle({
          x: pdfX,
          y: pdfY,
          size: MARKER_RADIUS,
          color: rgb(markerColor.r, markerColor.g, markerColor.b),
          opacity: isPendingAiRoom ? 0.60 : 0.80,
          borderColor: isPendingAiRoom ? rgb(0.6, 0.3, 0.05) : rgb(1, 1, 1),
          borderWidth: isPendingAiRoom ? 2 : 1.5,
        });

        const label = (row.sign.signType || "?").substring(0, 4).toUpperCase();
        const textWidth = helvetica.widthOfTextAtSize(label, FONT_SIZE);
        page.drawText(label, {
          x: pdfX - textWidth / 2,
          y: pdfY - FONT_SIZE / 2,
          size: FONT_SIZE,
          font: helvetica,
          color: rgb(1, 1, 1),
        });
      }
    }
  }

  if (!overlaidAny) {
    const coverPage = pdfDoc.addPage([612, 792]);
    const { width, height } = coverPage.getSize();

    coverPage.drawText(`${job.name} – Sign Takeoff`, {
      x: 50, y: height - 80,
      size: 22, font: helveticaBold,
      color: rgb(0.102, 0.212, 0.378),
    });
    coverPage.drawText(`No floor plan PDFs are associated with this job. Upload PDFs to enable marked-up overlays.`, {
      x: 50, y: height - 116,
      size: 11, font: helvetica,
      color: rgb(0.5, 0.5, 0.5),
      maxWidth: width - 100,
    });
    coverPage.drawText(`Total signs: ${signs.length}`, {
      x: 50, y: height - 148,
      size: 12, font: helveticaBold,
      color: rgb(0.2, 0.2, 0.2),
    });

    if (dismissedRoomCount > 0) {
      const dismissedLabel = `${dismissedRoomCount} dismissed room${dismissedRoomCount === 1 ? "" : "s"} excluded from this export`;
      coverPage.drawText(dismissedLabel, {
        x: 50, y: height - 168,
        size: 10, font: helvetica,
        color: rgb(0.6, 0.3, 0.05),
      });
    }

    let yPos = height - (dismissedRoomCount > 0 ? 200 : 180);
    coverPage.drawText("Sign Schedule:", {
      x: 50, y: yPos, size: 14,
      font: helveticaBold, color: rgb(0.1, 0.1, 0.1),
    });
    yPos -= 22;

    for (const row of signs) {
      if (yPos < 60) break;
      const isPendingAiRoom = row.roomSource === "ai_vision" && row.roomReviewStatus === "pending";
      const label = [
        row.sign.signType || "Unknown",
        `Qty: ${row.sign.qty ?? 1}`,
        (row.roomName ?? row.sign.roomName) ? `Room: ${row.roomName ?? row.sign.roomName}` : null,
        (row.level ?? row.sign.floorLabel) ? `Level: ${row.level ?? row.sign.floorLabel}` : null,
        isPendingAiRoom ? "(Pending Review)" : null,
      ].filter(Boolean).join("  |  ");
      coverPage.drawText(label, {
        x: 60, y: yPos, size: 10,
        font: isPendingAiRoom ? helveticaBold : helvetica,
        color: isPendingAiRoom ? rgb(0.6, 0.3, 0.05) : rgb(0.2, 0.2, 0.2),
        maxWidth: width - 110,
      });
      yPos -= 16;
    }
  }

  const legendPage = pdfDoc.addPage([612, 792]);
  const { width: lw, height: lh } = legendPage.getSize();

  legendPage.drawText("Sign Type Legend", {
    x: 50, y: lh - 60,
    size: 20, font: helveticaBold,
    color: rgb(0.102, 0.212, 0.378),
  });
  legendPage.drawText(`Job: ${job.name}`, {
    x: 50, y: lh - 88,
    size: 12, font: helvetica,
    color: rgb(0.4, 0.4, 0.4),
  });
  legendPage.drawLine({
    start: { x: 50, y: lh - 102 },
    end: { x: lw - 50, y: lh - 102 },
    thickness: 1, color: rgb(0.8, 0.8, 0.8),
  });

  const grouped = new Map<string, { count: number; totalQty: number }>();
  for (const row of signs) {
    const t = row.sign.signType || "Unknown";
    if (!grouped.has(t)) grouped.set(t, { count: 0, totalQty: 0 });
    const entry = grouped.get(t)!;
    entry.count++;
    entry.totalQty += row.sign.qty ?? 1;
  }

  let ly = lh - 128;
  legendPage.drawText("Sign Type", { x: 50, y: ly + 6, size: 10, font: helveticaBold, color: rgb(0.2, 0.2, 0.2) });
  legendPage.drawText("Count", { x: 360, y: ly + 6, size: 10, font: helveticaBold, color: rgb(0.2, 0.2, 0.2) });
  legendPage.drawText("Total Qty", { x: 450, y: ly + 6, size: 10, font: helveticaBold, color: rgb(0.2, 0.2, 0.2) });
  ly -= 22;

  for (const [signType, stats] of grouped) {
    if (ly < 60) break;
    const color = getColorForSignType(signType);
    legendPage.drawCircle({ x: 64, y: ly + 5, size: 7, color: rgb(color.r, color.g, color.b), opacity: 0.9 });
    legendPage.drawText(signType, { x: 80, y: ly, size: 11, font: helvetica, color: rgb(0.1, 0.1, 0.1) });
    legendPage.drawText(String(stats.count), { x: 360, y: ly, size: 11, font: helvetica, color: rgb(0.3, 0.3, 0.3) });
    legendPage.drawText(String(stats.totalQty), { x: 450, y: ly, size: 11, font: helvetica, color: rgb(0.3, 0.3, 0.3) });
    ly -= 20;
  }

  legendPage.drawLine({
    start: { x: 50, y: ly - 4 }, end: { x: lw - 50, y: ly - 4 },
    thickness: 0.5, color: rgb(0.8, 0.8, 0.8),
  });
  legendPage.drawText(`Total: ${signs.length} sign entries  |  ${grouped.size} sign types`, {
    x: 50, y: ly - 20,
    size: 11, font: helveticaBold, color: rgb(0.1, 0.1, 0.1),
  });

  if (dismissedRoomCount > 0) {
    const dismissedLabel = `${dismissedRoomCount} dismissed room${dismissedRoomCount === 1 ? "" : "s"} excluded from this export`;
    legendPage.drawText(dismissedLabel, {
      x: 50, y: ly - 40,
      size: 10, font: helvetica, color: rgb(0.6, 0.3, 0.05),
    });
  }

  legendPage.drawText(`Generated by Sign Takeoff IQ  —  ${new Date().toLocaleDateString()}`, {
    x: 50, y: 30,
    size: 9, font: helvetica, color: rgb(0.6, 0.6, 0.6),
  });

  const pdfBytes = await pdfDoc.save();

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${job.name}-marked-up.pdf"`);
  res.send(Buffer.from(pdfBytes));
});

// ── Handoff Report PDF ──────────────────────────────────────────────────────
router.get("/jobs/:jobId/export/handoff-pdf", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const jobId = String(req.params.jobId);
  const includePricing = req.query.includePricing === "true";

  const [job] = await db.select().from(jobsTable)
    .where(and(eq(jobsTable.id, jobId), eq(jobsTable.tenantId, tenantId)));
  if (!job) { res.status(404).json({ error: "Job not found" }); return; }

  const signsRaw = await db.select({
    sign: signsTable,
    roomNumber: roomsTable.roomNumber,
    roomName: roomsTable.roomName,
    level: roomsTable.level,
    roomReviewStatus: roomsTable.reviewStatus,
    roomSource: roomsTable.source,
  })
    .from(signsTable)
    .leftJoin(roomsTable, eq(signsTable.roomId, roomsTable.id))
    .where(and(
      eq(signsTable.jobId, jobId),
      eq(signsTable.tenantId, tenantId),
      eq(signsTable.isDeleted, false),
    ));

  const signs = signsRaw.filter(row => row.roomReviewStatus !== "dismissed");
  const matSpec = await getJobMaterialSpec(jobId);
  const today = new Date().toLocaleDateString();
  const dateStr = new Date().toISOString().split("T")[0];

  const pdfDoc = await PDFDocument.create();
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const PW = 792; const PH = 612; // Letter landscape
  const MARGIN = 40;
  const AMBER = rgb(212 / 255, 160 / 255, 23 / 255);
  const LGRAY = rgb(245 / 255, 245 / 255, 245 / 255);
  let pageNum = 0;

  const newPage = () => {
    pageNum++;
    return pdfDoc.addPage([PW, PH]);
  };

  const drawHeader = (page: ReturnType<typeof pdfDoc.addPage>, subtitle: string) => {
    page.drawRectangle({ x: 0, y: PH - 50, width: PW, height: 50, color: AMBER });
    page.drawText("Sign Takeoff IQ", {
      x: MARGIN, y: PH - 33, size: 16, font: helveticaBold, color: rgb(1, 1, 1),
    });
    if (subtitle) {
      const tw = helveticaBold.widthOfTextAtSize(subtitle, 11);
      page.drawText(subtitle, {
        x: PW - MARGIN - tw, y: PH - 33, size: 11, font: helveticaBold, color: rgb(1, 1, 1),
      });
    }
  };

  const drawFooter = (page: ReturnType<typeof pdfDoc.addPage>, num: number) => {
    page.drawLine({
      start: { x: MARGIN, y: 36 }, end: { x: PW - MARGIN, y: 36 },
      thickness: 0.5, color: rgb(0.8, 0.8, 0.8),
    });
    page.drawText(`AI-Assist Takeoffs  |  Generated ${today}`, {
      x: MARGIN, y: 22, size: 8, font: helvetica, color: rgb(0.6, 0.6, 0.6),
    });
    const pStr = `Page ${num}`;
    page.drawText(pStr, {
      x: PW - MARGIN - helvetica.widthOfTextAtSize(pStr, 8), y: 22,
      size: 8, font: helvetica, color: rgb(0.6, 0.6, 0.6),
    });
  };

  // ── Cover page ────────────────────────────────────────────────────────────
  const cover = newPage();
  const coverNum = pageNum;
  cover.drawRectangle({ x: 0, y: PH - 80, width: PW, height: 80, color: AMBER });
  cover.drawText("Sign Takeoff IQ", {
    x: MARGIN, y: PH - 42, size: 26, font: helveticaBold, color: rgb(1, 1, 1),
  });
  cover.drawText("Handoff Report", {
    x: MARGIN, y: PH - 64, size: 13, font: helvetica, color: rgb(1, 1, 0.9),
  });

  let cy = PH - 120;
  const fieldRow = (label: string, value: string) => {
    cover.drawText(label + ":", {
      x: MARGIN, y: cy, size: 10, font: helveticaBold, color: rgb(0.4, 0.4, 0.4),
    });
    cover.drawText(value, {
      x: MARGIN + 120, y: cy, size: 10, font: helvetica, color: rgb(0.1, 0.1, 0.1),
    });
    cy -= 20;
  };
  fieldRow("Project", job.name ?? "Untitled");
  fieldRow("Building Type", job.buildingType ?? "—");
  fieldRow("Location", job.location ?? "—");
  fieldRow("Report Date", today);
  cy -= 10;

  const totalQty = signs.reduce((s, r) => s + (r.sign.qty ?? 1), 0);
  const highConf = signs
    .filter(r => !(r.roomSource === "ai_vision" && r.roomReviewStatus === "pending"))
    .reduce((s, r) => s + (r.sign.qty ?? 1), 0);

  cover.drawRectangle({ x: MARGIN, y: cy - 56, width: PW - MARGIN * 2, height: 72, color: LGRAY });
  cover.drawText("Total Signs", {
    x: MARGIN + 20, y: cy - 12, size: 10, font: helveticaBold, color: rgb(0.4, 0.4, 0.4),
  });
  cover.drawText(String(totalQty), {
    x: MARGIN + 20, y: cy - 36, size: 28, font: helveticaBold, color: AMBER,
  });
  cover.drawText("High Confidence", {
    x: MARGIN + 170, y: cy - 12, size: 10, font: helveticaBold, color: rgb(0.4, 0.4, 0.4),
  });
  cover.drawText(String(highConf), {
    x: MARGIN + 170, y: cy - 36, size: 28, font: helveticaBold, color: rgb(0.18, 0.55, 0.18),
  });
  cy -= 80;

  // Estimation disclaimer callout box — amber left border, light amber fill
  const disclaimerText =
    "This estimate was generated by combining automated plan reading, ADA code logic, and sign schedule extraction " +
    "into a single pass across your construction documents. Results reflect plan data available at the time of " +
    "processing — review against final issued-for-construction documents before submitting for production.";
  const DISC_X = MARGIN;
  const DISC_W = PW - MARGIN * 2;
  const DISC_H = 52;
  const DISC_Y = cy - DISC_H - 8;
  cover.drawRectangle({ x: DISC_X, y: DISC_Y, width: DISC_W, height: DISC_H, color: rgb(255/255, 248/255, 231/255) });
  cover.drawRectangle({ x: DISC_X, y: DISC_Y, width: 4, height: DISC_H, color: rgb(212/255, 160/255, 23/255) });
  cover.drawText("Produced by AI-Assist Takeoffs.", {
    x: DISC_X + 12, y: DISC_Y + DISC_H - 14, size: 9, font: helveticaBold, color: rgb(0.5, 0.35, 0.0),
  });
  cover.drawText(disclaimerText, {
    x: DISC_X + 12, y: DISC_Y + DISC_H - 28, size: 6.5, font: helvetica, color: rgb(0.45, 0.32, 0.0), maxWidth: DISC_W - 20,
  });
  cy = DISC_Y - 8;

  cover.drawText("Generated by AI-Assist Takeoffs", {
    x: MARGIN, y: cy - 16, size: 9, font: helvetica, color: rgb(0.55, 0.55, 0.55),
  });
  drawFooter(cover, coverNum);

  // ── Sign summary by floor ─────────────────────────────────────────────────
  const byLevel = new Map<string, typeof signs>();
  for (const row of signs) {
    const lvl = row.level ?? "Unassigned";
    if (!byLevel.has(lvl)) byLevel.set(lvl, []);
    byLevel.get(lvl)!.push(row);
  }

  const LEVEL_ORDER = ["ground", "l1", "1", "first", "1st", "l2", "2", "second", "2nd",
    "l3", "3", "third", "3rd", "l4", "4", "fourth", "4th"];
  const sortedLevels = [...byLevel.keys()].sort((a, b) => {
    const ai = LEVEL_ORDER.findIndex(l => a.toLowerCase().includes(l));
    const bi = LEVEL_ORDER.findIndex(l => b.toLowerCase().includes(l));
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });

  // Landscape column layout: left margin 40, content 710, right margin 42
  const COL_X = [40, 100, 230, 340, 375, 410];
  const COL_WIDTHS = [60, 130, 110, 35, 35, 340];
  const COL_HEADS = ["Room #", "Room Name", "Sign Type", "Qty", "ADA", "Notes"];
  const ROW_H = 18;
  const TABLE_CONTENT_TOP = PH - 68;

  let curPage: ReturnType<typeof pdfDoc.addPage> | null = null;
  let curY = 0;

  const ensurePage = (needed = ROW_H * 2) => {
    if (!curPage || curY - needed < 48) {
      if (curPage) drawFooter(curPage, pageNum);
      curPage = newPage();
      drawHeader(curPage, "Sign Summary");
      curY = TABLE_CONTENT_TOP;
    }
  };

  const drawTableHeader = (page: ReturnType<typeof pdfDoc.addPage>, y: number): number => {
    page.drawRectangle({
      x: MARGIN, y: y - ROW_H + 4, width: PW - MARGIN * 2, height: ROW_H,
      color: rgb(0.2, 0.2, 0.2),
    });
    COL_HEADS.forEach((h, i) => {
      page.drawText(h, {
        x: COL_X[i] + 4, y: y - ROW_H + 7, size: 8, font: helveticaBold, color: rgb(1, 1, 1),
      });
    });
    return y - ROW_H;
  };

  for (const lvl of sortedLevels) {
    const rows = byLevel.get(lvl)!;
    ensurePage(ROW_H * 3);

    curPage!.drawRectangle({
      x: MARGIN, y: curY - ROW_H + 4, width: PW - MARGIN * 2, height: ROW_H, color: AMBER,
    });
    curPage!.drawText(`Floor: ${lvl}`, {
      x: MARGIN + 8, y: curY - ROW_H + 7, size: 9, font: helveticaBold, color: rgb(1, 1, 1),
    });
    curY -= ROW_H;
    curY = drawTableHeader(curPage!, curY);

    rows.forEach((row, idx) => {
      ensurePage(ROW_H + 4);
      if (idx % 2 === 1) {
        curPage!.drawRectangle({
          x: MARGIN, y: curY - ROW_H + 4, width: PW - MARGIN * 2, height: ROW_H, color: LGRAY,
        });
      }
      const isAda = isAdaSignType(row.sign.signType ?? "");
      const cells = [
        row.roomNumber ?? "",
        row.roomName ?? "",
        row.sign.signType ?? "",
        String(row.sign.qty ?? 1),
        isAda ? "Yes" : "",
        row.sign.notes ?? "",
      ];
      cells.forEach((cell, i) => {
        const maxW = (COL_WIDTHS[i] ?? 58) - 8;
        let text = cell;
        while (text.length > 0 && helvetica.widthOfTextAtSize(text, 8) > maxW) {
          text = text.slice(0, -1);
        }
        if (text !== cell && text.length > 0) text = text.slice(0, -1) + "…";
        curPage!.drawText(text, {
          x: COL_X[i] + 4, y: curY - ROW_H + 7, size: 8, font: helvetica, color: rgb(0.1, 0.1, 0.1),
        });
      });
      curY -= ROW_H;
    });
    curY -= 8;
  }
  if (curPage) drawFooter(curPage, pageNum);

  // ── Pricing summary page (optional) ───────────────────────────────────────
  if (includePricing) {
    const [pricingRow] = await db.select().from(tenantPricingSettingsTable)
      .where(eq(tenantPricingSettingsTable.tenantId, tenantId));
    const pricingData = pricingRow ? {
      materials: (pricingRow.materials as PricingMaterial[]) ?? [],
      finishings: (pricingRow.finishings as PricingFinishing[]) ?? [],
      signDefaults: (pricingRow.signDefaults as PricingSignDefault[]) ?? [],
    } : null;

    // Group signs by type + size, summing qty
    const pricingMap = new Map<string, { signType: string; size: string; qty: number }>();
    for (const row of signs) {
      const st = row.sign.signType ?? "unknown";
      const sz = row.sign.dimensions ?? "";
      const key = `${st}|||${sz}`;
      const qty = row.sign.qty ?? 1;
      const existing = pricingMap.get(key);
      if (existing) { existing.qty += qty; } else { pricingMap.set(key, { signType: st, size: sz, qty }); }
    }

    type PricRow = { signType: string; size: string; sqIn: number; qty: number; material: string; finishing: string; rate: number; estTotal: number };
    const pricingRows: PricRow[] = [];
    for (const { signType, size, qty } of pricingMap.values()) {
      const info = getSignPricingInfo(signType, size, pricingData);
      const sqIn = info.width * info.height;
      const rate = info.materialRate + info.finishingRate;
      const estTotal = info.flatPrice != null
        ? info.flatPrice * qty
        : Math.max(sqIn * qty * rate, info.minPrice * qty);
      pricingRows.push({ signType, size, sqIn, qty, material: info.materialName, finishing: info.finishingName, rate, estTotal });
    }
    pricingRows.sort((a, b) => a.signType.localeCompare(b.signType));
    const grandTotal = pricingRows.reduce((s, r) => s + r.estTotal, 0);

    const pricPage = newPage();
    drawHeader(pricPage, "Pricing Summary");
    let py = TABLE_CONTENT_TOP;

    pricPage.drawText("Estimated pricing based on sign type defaults", {
      x: 40, y: py, size: 9, font: helvetica, color: rgb(0.55, 0.55, 0.55),
    });
    py -= 24;

    // Pricing table columns — widths sum to 710 (40 left + 710 content + 42 right = 792)
    const PC_HEADS = ["Sign Type", "Size", "Sq In", "Qty", "Material", "Finishing", "$/sq in", "Est. Total"];
    const PC_WIDTHS = [130, 60, 40, 30, 120, 120, 60, 150];
    const PC_X: number[] = [];
    let pcx = 40;
    for (const w of PC_WIDTHS) { PC_X.push(pcx); pcx += w; }

    pricPage.drawRectangle({ x: 40, y: py - ROW_H + 4, width: 710, height: ROW_H, color: rgb(0.2, 0.2, 0.2) });
    PC_HEADS.forEach((h, i) => {
      pricPage.drawText(h, { x: PC_X[i] + 4, y: py - ROW_H + 7, size: 8, font: helveticaBold, color: rgb(1, 1, 1) });
    });
    py -= ROW_H;

    pricingRows.forEach((row, idx) => {
      if (idx % 2 === 1) {
        pricPage.drawRectangle({ x: 40, y: py - ROW_H + 4, width: 710, height: ROW_H, color: LGRAY });
      }
      const cells = [
        row.signType.replace(/_/g, " "),
        row.size || "—",
        String(row.sqIn),
        String(row.qty),
        row.material,
        row.finishing,
        `$${row.rate.toFixed(2)}`,
        `$${row.estTotal.toFixed(2)}`,
      ];
      cells.forEach((cell, i) => {
        const maxW = PC_WIDTHS[i] - 8;
        let text = cell;
        while (text.length > 0 && helvetica.widthOfTextAtSize(text, 8) > maxW) { text = text.slice(0, -1); }
        if (text !== cell && text.length > 0) text = text.slice(0, -1) + "…";
        pricPage.drawText(text, { x: PC_X[i] + 4, y: py - ROW_H + 7, size: 8, font: helvetica, color: rgb(0.1, 0.1, 0.1) });
      });
      py -= ROW_H;
    });

    py -= 4;
    pricPage.drawRectangle({ x: 40, y: py - ROW_H + 4, width: 710, height: ROW_H, color: LGRAY });
    pricPage.drawText("Grand Total", { x: 44, y: py - ROW_H + 7, size: 9, font: helveticaBold, color: AMBER });
    const gtStr = `$${grandTotal.toFixed(2)}`;
    pricPage.drawText(gtStr, { x: PC_X[7] + 4, y: py - ROW_H + 7, size: 9, font: helveticaBold, color: AMBER });
    drawFooter(pricPage, pageNum);
  }

  // ── Material spec page (if available) ────────────────────────────────────
  if (matSpec) {
    const specPage = newPage();
    drawHeader(specPage, "Material Specifications");
    let sy = TABLE_CONTENT_TOP;

    specPage.drawText("Specifications extracted from uploaded sign schedule", {
      x: MARGIN, y: sy, size: 9, font: helvetica, color: rgb(0.55, 0.55, 0.55),
    });
    sy -= 28;

    const specRow = (label: string, value: string | null) => {
      if (!value) return;
      specPage.drawRectangle({
        x: MARGIN, y: sy - 20, width: PW - MARGIN * 2, height: 26, color: LGRAY,
      });
      specPage.drawText(label, {
        x: MARGIN + 8, y: sy - 12, size: 10, font: helveticaBold, color: rgb(0.35, 0.35, 0.35),
      });
      specPage.drawText(value, {
        x: MARGIN + 160, y: sy - 12, size: 10, font: helvetica, color: rgb(0.1, 0.1, 0.1),
      });
      sy -= 32;
    };

    specRow("Substrate", matSpec.substrate);
    specRow("Finish Method", matSpec.finishMethod);
    specRow("Braille Spec", matSpec.brailleSpec);
    specRow("Mounting Height", matSpec.mountingHeight);
    specRow("Manufacturer", matSpec.manufacturer);
    drawFooter(specPage, pageNum);
  }

  const safeName = (job.name ?? "Takeoff").replace(/[^a-z0-9_\- ]/gi, "").trim().replace(/\s+/g, "_");
  const handoffBytes = await pdfDoc.save();
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}_Handoff_${dateStr}.pdf"`);
  res.send(Buffer.from(handoffBytes));
});

export default router;
