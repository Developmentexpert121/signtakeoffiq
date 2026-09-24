import { GARBLED_NAME_PATTERNS } from "../roomValidation";
import type { SidecarWord } from "../sidecar-client";
import { isAllowedRoomNumber } from "./room-number";

const ROOM_SYNONYMS: Record<string, string> = {
  VEST: "VESTIBULE",
  VESTIBULE: "VESTIBULE",
  CORR: "CORRIDOR",
  CORRIDOR: "CORRIDOR",
  HALL: "HALLWAY",
  HALLWAY: "HALLWAY",
  STOR: "STORAGE",
  STORAGE: "STORAGE",
  MECH: "MECHANICAL",
  MECHANICAL: "MECHANICAL",
  ELEC: "ELECTRICAL",
  ELECTRICAL: "ELECTRICAL",
  CONF: "CONFERENCE",
  CONFERENCE: "CONFERENCE",
  TLTL: "TOILET",
  TLT: "TOILET",
  TOIL: "TOILET",
  TOILET: "TOILET",
  REST: "RESTROOM",
  RESTROOM: "RESTROOM",
  BLDG: "BUILDING",
  RR: "RESTROOM",
  MRR: "MENS RESTROOM",
  WRR: "WOMENS RESTROOM",
  EMERG: "EMERGENCY",
  EMERGENCY: "EMERGENCY",
  INTERROG: "INTERROGATION",
  INTERROGATION: "INTERROGATION",
};

export function expandSynonyms(roomName: string): string {
  const parts = roomName.toUpperCase().split(/\s+/);
  const expanded = parts.map((p) => ROOM_SYNONYMS[p] ?? p);
  return expanded.join(" ");
}

// ---------------------------------------------------------------------------
// Room name extraction from words
// ---------------------------------------------------------------------------

export interface ExtractedRoom {
  roomNumber: string;
  roomName: string;
  x: number;
  y: number;
  pageWidth: number;
  pageHeight: number;
  /** PDF bbox metadata for accurate pixel coordinate conversion. */
  bboxX0?: number;
  bboxY0?: number;
  pageWPts?: number;
  pageHPts?: number;
  /** Set to true for rooms discovered by the AI vision pass (Step 6b). */
  aiVision?: boolean;
  /** Confidence override for AI-vision rooms (stored as string for numeric column). */
  aiConfidence?: string;
  /** isRestroom flag set by AI vision when no classification is available yet. */
  aiIsRestroom?: boolean;
  /**
   * Coordinate provenance:
   *   "pdf_native"       – centroid of sidecar word bbox(es)
   *   "vision_estimated" – percentage coordinates returned by Claude
   *   "human_corrected"  – manually repositioned in the UI
   */
  coordSource?: string;
}

// Matches:
//   \d{3}[A-Z]?               residential 3-digit units (103, 204A)
//   1[0-4]\d{2}[A-Z]?(\.\d)?   government floors 1000-1499 with optional alpha/decimal (1101, 1101.1)
//   2[0-4]\d{2}[A-Z]?(\.\d)?   government floors 2000-2499 with optional alpha/decimal (2102, 2102A)
//   [A-Z]{1,2}P?\d?-\d{3}[A-Z]? service rooms (BP1-101, A1-103, SP1-201, EP1-102)
//   [A-Z]\d{3}[A-Z]?           alpha-prefix rooms (A101, B204)
// Does NOT match: 7087 (building#), 2026/2024 (years caught by YEAR_RE), 12345 (5 digits)

export const ROOM_NUMBER_RE = /^(\d{3}[A-Z]?|1[0-4]\d{2}[A-Z]?(\.\d)?|2[0-4]\d{2}[A-Z]?(\.\d)?|[A-Z]{1,2}P?\d?-\d{3}[A-Z]?|[A-Z]\d{3}[A-Z]?)$/;

// Used to reject years (2026, 2024, etc.) that could match the digit pattern.

const YEAR_RE = /^(19|20)\d{2}$/;

// ---------------------------------------------------------------------------
// Room number allowlists — keyed by canonical building type.
// When the job's building type matches a key, only room numbers that pass the
// corresponding regex are kept.  All other buildings fall back to the broad
// ROOM_NUMBER_RE + isRoomNum checks.
//
// Education (K-12 DiNisco Design pattern):
//   W/E + 3 digits ± one suffix letter   → W100, E205, W223A
//   WC/EC + 3 digits ± one suffix letter → WC200, WC210A
//   SA/SB/SC/SD + 2 digits               → SA01 (stair cores)
//   EV + 2 digits                        → EV01 (elevators)
// ---------------------------------------------------------------------------

const IGNORE_WORDS = new Set([
  "THE", "AND", "OR", "OF", "A", "AN", "IN", "AT", "BY", "FOR",
  "N", "S", "E", "W", "NE", "NW", "SE", "SW",
  "FT", "SF", "SQ", "FT²", "M²",
  "FF", "EQ", "TYP", "SIM", "REF",
]);

// ---------------------------------------------------------------------------
// Room-name junk filter
// ---------------------------------------------------------------------------
// Text extraction from PDFs sometimes picks up finish-schedule rows, material
// legends, construction notes, and other non-room annotations.  These four
// rules gate every room name before it enters the extracted-room inventory.
// ---------------------------------------------------------------------------

/**
 * Tokens that indicate a non-room text blob when they appear as standalone
 * words.  Includes architectural abbreviations, material descriptions, and
 * construction-instruction verbs.
 */

const JUNK_TOKEN_SET = new Set([
  // Architectural abbreviations (not room-type words)
  "PTD", "HM", "VIF", "GWB", "CMU", "ACT", "MTL", "STL", "GALV", "FL-N",
  // Material / finish descriptions
  "QUARTZ", "RUBBER", "SEAMLESS", "PAINTED", "EXISTING",
  "FLOORING", "CEILING", "LEGEND",
  // Construction instruction verbs / adjectives
  "REMOVED", "DEMOLISHED", "NEW", "REINSTALL", "INSTALL", "PROVIDE", "COORDINATE",
]);

/**
 * Words associated with finish-schedule table headers.  Three or more of these
 * appearing in a single text blob strongly indicate a schedule row, not a room.
 * "ROOM NUMBER" and "ROOM NAME" are represented by their second word so that
 * they each count as one hit in the token scan.
 */

const SCHEDULE_WORDS = new Set([
  "FLOOR", "BASE", "WALLS", "CEILING", "COMMENTS", "LEGEND",
  "FLOORING", "RUBBER", "SEAMLESS", "PAINTED", "EXISTING",
  "FINISH", "SCHEDULE", "NUMBER", "NAME",
]);

/** Phrases whose presence in the uppercased name indicates a construction note. */

const CONSTRUCTION_NOTE_PHRASES = [
  "FIELD MEASURE",
  "V.I.F.",
  "SEE DETAIL",
  "COORDINATE WITH",
  "SEE DRAWING",
  "NEW WORK",
  "AREA OF WORK",
  "TEMPORARY",
  "REINSTALL",
  "DEMOLISH",
];

/**
 * Regex patterns that match document-schedule row headers, legends, and similar
 * non-room table entries that AI vision or PDF text extraction may return as
 * room names.  Any match rejects the name immediately (Rule 5 of isJunkRoomName).
 *
 * These patterns are never valid room names in any building type.
 */

const SCHEDULE_ROW_PATTERNS: RegExp[] = [
  /occupant.?load/i,
  /load.?table/i,
  /fixture.?table/i,
  /door.?schedule/i,
  /finish.?schedule/i,
  /plumbing.?schedule/i,
  /hardware.?set/i,
  /^keynote/i,
  /^general.?note/i,
  /^note:/i,
  /^legend/i,
  /^abbreviation/i,
  /^symbol/i,
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

/**
 * Returns true when the room name looks like a junk text blob — a finish-
 * schedule row, material legend, construction note, or other non-room
 * annotation — and should be discarded before entering the room inventory.
 *
 * Four independent rules; any one match rejects the name:
 *
 *  1. Length  — longer than 60 characters.  Real room names are 1–5 words;
 *               anything longer is a note or schedule entry.
 *
 *  2. Junk-token ratio  — more than 40 % of whitespace-separated tokens are:
 *       • a single letter or digit (grid labels, column tags)
 *       • a word in JUNK_TOKEN_SET (abbreviations, material words, verb notes)
 *
 *  3. Schedule density  — 3 or more tokens from SCHEDULE_WORDS appear in the
 *     text (e.g. "FLOOR BASE WALLS CEILING COMMENTS" is a schedule header).
 *
 *  4. Construction-note phrase  — the uppercased text contains any of the
 *     known construction-note phrases (FIELD MEASURE, V.I.F., DEMOLISH, …).
 */

export function isJunkRoomName(roomName: string): boolean {
  if (!roomName) return false;
  const upper = roomName.toUpperCase().trim();

  // Rule 1: max length
  if (upper.length > 60) return true;

  // Rule 4: construction-note phrases (early exit before tokenising)
  for (const phrase of CONSTRUCTION_NOTE_PHRASES) {
    if (upper.includes(phrase)) return true;
  }

  const tokens = upper.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;

  // Residential unit exemption — "UNIT A", "UNIT B", "SUITE 4A", "APT 3" are valid
  // room identifiers whose single-letter/digit suffix is a unit type, not a grid label.
  // Must fire before Rule 2 which would otherwise reject them via junk-token ratio.
  const RESIDENTIAL_PREFIX = /^(UNIT|APT|SUITE|APARTMENT|FLAT)\s+[A-Z0-9]{1,4}$/i;
  if (RESIDENTIAL_PREFIX.test(upper.trim())) {
    console.log(`[pipeline] isJunkRoomName: "${roomName}" exempted as residential unit name`);
    return false;
  }

  // Rule 2: junk-token ratio > 40 %
  const junkCount = tokens.filter(
    (t) => /^[A-Z0-9]$/.test(t) || JUNK_TOKEN_SET.has(t),
  ).length;
  if (junkCount / tokens.length > 0.40) return true;

  // Rule 3: schedule-word density ≥ 3
  const scheduleHits = tokens.filter((t) => SCHEDULE_WORDS.has(t)).length;
  if (scheduleHits >= 3) return true;

  // Rule 5: schedule/table row header patterns — these are NEVER real room names.
  // Catches "OCCUPANT LOAD", "DOOR SCHEDULE", "KEYNOTE", "LEGEND", etc. that AI
  // vision or PDF text extraction may extract from tables alongside room names.
  for (const pat of SCHEDULE_ROW_PATTERNS) {
    if (pat.test(roomName)) return true;
  }

  // Rule 6: annotation reference strings — coordinate callouts like "W139.1" or "E100.2"
  // that appear on signage plan drawings as room-number-variant annotations.
  if (/^[A-Z]{1,2}\d{2,}\.\d+$/i.test(upper.trim())) return true;

  // Rule 7: sign-legend code + dimension pattern (e.g. "MB 8'-0''", "TB 6'-0''")
  // Two-letter sign type code followed by a dimension string — never a room name.
  if (/^[A-Z]{1,3}\s+\d+['"''\u2019\u2018]/.test(upper.trim())) return true;

  // Rule 8: all-dimension blob — string composed entirely of numbers, dashes, quotes, spaces
  if (/^[\d\s\-'"`''""''/]+$/.test(roomName.trim()) && roomName.trim().length > 0) return true;

  // Rule 9: name starts with a non-letter, non-digit character (e.g. ".1 .1 MB CORRIDOR",
  // "- '0' SLP - 1.") — valid room names always begin with a letter or number.
  if (/^[^A-Za-z0-9]/.test(roomName.trim())) return true;

  // Rule 10: contains dimension tokens like "8'-0''", "60X21" — measurement callouts that
  // were extracted adjacent to a room number.
  if (/\d+['"''\u2019\u2018][-–]\d+/.test(roomName) || /\b\d+\s*[Xx]\s*\d+\b/.test(roomName)) return true;

  // Rule 11: all tokens are ≤ 2 characters with no substantive alphabetic word.
  // Catches partial-scan fragments like "RY CT TA" or "MB UP FT".
  // Valid short abbreviations (WC, RR, IT, etc.) are exempted.
  {
    const VALID_SHORT = new Set(["WC", "RR", "IT", "MR", "DR", "AV", "HR", "PR", "SR", "NO", "OF", "BY"]);
    if (tokens.length >= 3) {
      const hasSubstantive = tokens.some(t => t.length > 2 || VALID_SHORT.has(t));
      if (!hasSubstantive) return true;
    }
  }

  // Rule 12: callout range references like "E119C.1 TO E119C.2" or
  // "W200 TO W210" — room-number range annotations, never real room names.
  if (/\bTO\s+[EW][A-Z0-9]/i.test(roomName)) return true;

  // Rule 13: high non-alpha density — more than 50% of the non-space characters
  // are non-alphabetic.  Catches "21X60", "8'-0'' 4'-6''", symbol blobs.
  {
    const noSpace = roomName.replace(/\s+/g, "");
    if (noSpace.length > 3) {
      const alphaCount = (noSpace.match(/[A-Za-z]/g) ?? []).length;
      if (alphaCount / noSpace.length < 0.5) return true;
    }
  }

  // Rule 14: shared garbled-name patterns from the room validation module.
  // Covers: LEED sign codes (19A 19B), marker/tackboard callouts with numbers,
  // dotted callout refs (.1 .1 .1), and PDF split-word artefacts (KIT EN,
  // CAF ERIA, RY CT) that none of the above rules catch individually.
  if (GARBLED_NAME_PATTERNS.some((p) => p.test(roomName))) return true;

  return false;
}

export function extractRoomsFromWords(
  words: SidecarWord[],
  pageWidth: number,
  pageHeight: number
): ExtractedRoom[] {
  // Title block exclusion: rightmost 22% and bottom 12% of the page contain
  // the title block (architect name, address, sheet number, copyright) and
  // must be excluded entirely to avoid matching metadata as room numbers.
  const titleBlockXThreshold = pageWidth * 0.78;
  const titleBlockYThreshold = pageHeight * 0.88;

  // Pre-process: merge adjacent single-letter wing-prefix + room-number tokens.
  // Multi-wing school plans (A, B, C, D wings) often have room numbers like
  // "B225" or "A226A" that PDF text extraction splits into two separate text
  // runs: the letter "B" and the digits "225". Detect and re-join them so the
  // wing prefix survives into ROOM_NUMBER_RE matching.
  const processedWords: SidecarWord[] = [];
  {
    const byPos = [...words].sort((a, b) => a.y0 !== b.y0 ? a.y0 - b.y0 : a.x0 - b.x0);
    for (let i = 0; i < byPos.length; i++) {
      const w = byPos[i];
      const upper = w.text.toUpperCase();
      if (/^[A-Z]$/.test(upper) && i + 1 < byPos.length) {
        const next = byPos[i + 1];
        const sameY   = Math.abs(next.y0 - w.y0) < 10; // same horizontal baseline
        const adjacent = (next.x0 - w.x1) < 20;        // gap < 20 pts = touching / very close
        if (sameY && adjacent && /^\d{2,4}[A-Z]?$/.test(next.text)) {
          // Merge into compound wing-prefixed room number (e.g. "A" + "209" → "A209")
          processedWords.push({ ...w, text: upper + next.text, x1: next.x1, y1: Math.max(w.y1, next.y1) });
          i++; // skip the digit token — already merged
          continue;
        }
      }
      processedWords.push(w);
    }
  }

  // Expanded room number test (superset of ROOM_NUMBER_RE).
  // Adds 2-digit pure numbers, A-NNN prefixed forms, and single-letter+digit unit tags.
  const isRoomNum = (text: string): boolean => {
    if (YEAR_RE.test(text)) return false;
    if (ROOM_NUMBER_RE.test(text)) return true;
    if (/^\d{2,4}$/.test(text)) return true;             // 12, 108, 2045
    if (/^[A-Z]-?\d{2,4}[A-Z]?$/.test(text)) return true; // A-110, B-102A
    if (/^[A-Z]\d[A-Z]?$/.test(text)) return true;      // A1, B1D, C3A
    return false;
  };

  // Returns true when a word qualifies as part of a room name label.
  const isValidNameWord = (w: SidecarWord): boolean => {
    const text = w.text;
    const upper = text.toUpperCase();
    if (isRoomNum(text)) return false;
    if (upper.length === 1 && /[A-Z]/.test(upper)) return false; // grid column/row labels
    if (/^\d+\.\d+$/.test(text)) return false;                   // grid axis labels (2.2, 4.8)
    if (/^\d+$/.test(text) && text.length <= 2) return false;    // small room-count callouts
    if (IGNORE_WORDS.has(upper)) return false;
    if (YEAR_RE.test(text)) return false;
    if (text.length > 30) return false;
    if (/^\d+['"\-\/]/.test(text)) return false;                // dimension annotations 8'-0"
    // Reject annotation reference strings like "W139.1", "E100.2" (alpha-prefix room variant refs)
    if (/^[A-Z]{1,2}\d{2,}\.\d+$/i.test(text)) return false;
    // Reject drawing grid references like "A.1", "K.4", "J.5"
    if (/^[A-Z]\.\d+$/i.test(text)) return false;
    return true;
  };

  // New line-based clustering algorithm
  //
  // Step 1  Group words into lines (dy < 8 pts = same horizontal text line).
  // Step 2  Split each line into segments at horizontal gaps > 150 pts so that
  //         room labels far apart on the same line stay independent.
  // Step 3  Group segments into clusters: vertical gap <= 20 pts AND x-overlap
  //         > 30% of the shorter segment width.  Max 4 segments per cluster.
  // Step 4  For each cluster that contains a room number token, collect name
  //         words from the same cluster.  If no name exists in the cluster,
  //         find the nearest other cluster within 60 pts (bbox edge-to-edge).

  // Restroom keywords used to expand pairing radius in both extraction paths.
  const RESTROOM_LABEL_KW = /\b(TOILET|RESTROOM|RR|BATHROOM|LAVATORY|WC|UNISEX|STAFF|NURSES|CUSTODIAN|PRINCIPALS?)\b/i;

  function clusterExtraction(): ExtractedRoom[] {
    const valid = processedWords.filter(w => !(w.x0 > titleBlockXThreshold || w.y0 > titleBlockYThreshold));
    if (!valid.length) return [];

    const sorted = [...valid].sort((a, b) => a.y0 !== b.y0 ? a.y0 - b.y0 : a.x0 - b.x0);

    // Step 1: group into lines by y-proximity (dy < 8 pts)
    type WLine = { words: SidecarWord[]; x0: number; x1: number; y0: number; y1: number; baseY: number };
    const rawLines: WLine[] = [];
    for (const w of sorted) {
      const line = rawLines.find(l => Math.abs(w.y0 - l.baseY) < 8);
      if (line) {
        line.words.push(w);
        line.x0 = Math.min(line.x0, w.x0);
        line.x1 = Math.max(line.x1, w.x1);
        line.y0 = Math.min(line.y0, w.y0);
        line.y1 = Math.max(line.y1, w.y1);
        line.baseY = (line.y0 + line.y1) / 2;
      } else {
        rawLines.push({ words: [w], x0: w.x0, x1: w.x1, y0: w.y0, y1: w.y1, baseY: (w.y0 + w.y1) / 2 });
      }
    }

    // Step 2: split each line into segments at horizontal gaps > 150 pts
    type Seg = { words: SidecarWord[]; x0: number; x1: number; y0: number; y1: number };
    const segments: Seg[] = [];
    for (const line of rawLines) {
      const byX = [...line.words].sort((a, b) => a.x0 - b.x0);
      let seg: Seg = { words: [byX[0]], x0: byX[0].x0, x1: byX[0].x1, y0: byX[0].y0, y1: byX[0].y1 };
      for (let i = 1; i < byX.length; i++) {
        const w = byX[i];
        if (w.x0 - seg.x1 > 150) {
          segments.push(seg);
          seg = { words: [w], x0: w.x0, x1: w.x1, y0: w.y0, y1: w.y1 };
        } else {
          seg.words.push(w);
          seg.x1 = Math.max(seg.x1, w.x1);
          seg.y0 = Math.min(seg.y0, w.y0);
          seg.y1 = Math.max(seg.y1, w.y1);
        }
      }
      segments.push(seg);
    }

    segments.sort((a, b) => a.y0 - b.y0);

    // Step 3: group segments into clusters (vert gap <= 20 pts + x-overlap > 30%)
    type Cluster = { segs: Seg[]; x0: number; x1: number; y0: number; y1: number };
    const clusters: Cluster[] = [];
    for (const seg of segments) {
      let merged = false;
      for (const cl of clusters) {
        const yGap = seg.y0 - cl.y1;
        if (yGap > 20) continue;
        const overlapL = Math.max(cl.x0, seg.x0);
        const overlapR = Math.min(cl.x1, seg.x1);
        const overlap = Math.max(0, overlapR - overlapL);
        const minW = Math.min(cl.x1 - cl.x0, seg.x1 - seg.x0);
        if (minW <= 0 || overlap / minW < 0.3) continue;
        if (cl.segs.length >= 4) continue;
        cl.segs.push(seg);
        cl.x0 = Math.min(cl.x0, seg.x0);
        cl.x1 = Math.max(cl.x1, seg.x1);
        cl.y1 = Math.max(cl.y1, seg.y1);
        merged = true;
        break;
      }
      if (!merged) {
        clusters.push({ segs: [seg], x0: seg.x0, x1: seg.x1, y0: seg.y0, y1: seg.y1 });
      }
    }

    // Minimum bounding-box edge-to-edge distance between two clusters.
    const bboxDist = (a: Cluster, b: Cluster): number => {
      const dx = Math.max(0, Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1));
      const dy = Math.max(0, Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1));
      return Math.sqrt(dx * dx + dy * dy);
    };

    // Step 4: extract rooms from clusters
    const rooms: ExtractedRoom[] = [];
    // Tracks clusters already consumed as a name source so they are not reused.
    const usedNameClusterIdx = new Set<number>();

    for (let ci = 0; ci < clusters.length; ci++) {
      const cl = clusters[ci];
      const allW = cl.segs.flatMap(s => s.words);
      const roomNumWords = allW.filter(w => isRoomNum(w.text));
      if (!roomNumWords.length) continue;

      // Prevent this cluster from being used as a name source by other clusters.
      usedNameClusterIdx.add(ci);

      for (const rnW of roomNumWords) {
        const roomNumber = rnW.text;
        if (YEAR_RE.test(roomNumber)) continue;

        // Prefer name words co-located in the same cluster.
        let nameW = allW
          .filter(w => w !== rnW && isValidNameWord(w))
          .map(w => ({ text: w.text.toUpperCase(), x0: w.x0, x1: w.x1, y0: w.y0, y1: w.y1 }));

        let pairingIdx = -1;
        if (nameW.length === 0) {
          // Search for the nearest cluster that has name words.
          // Default radius: 60 pts.  Expanded to 120 pts when the candidate
          // name cluster contains restroom keywords — on dense multi-wing school
          // plans, "GIRLS TOILET" / "BOYS TOILET" labels are often placed farther
          // from the room number (B225, A226A) than generic room labels.
          let bestDist = Infinity;
          for (let nci = 0; nci < clusters.length; nci++) {
            if (nci === ci || usedNameClusterIdx.has(nci)) continue;
            const nc = clusters[nci];
            const ncWords = nc.segs.flatMap(s => s.words);
            if (!ncWords.some(w => isValidNameWord(w))) continue;
            const d = bboxDist(cl, nc);
            const ncHasRestroomKw = ncWords.some(w => RESTROOM_LABEL_KW.test(w.text));
            const maxRadius = ncHasRestroomKw ? 120 : 60;
            if (d < maxRadius && d < bestDist) {
              bestDist = d;
              pairingIdx = nci;
            }
          }
          if (pairingIdx >= 0) {
            const nc = clusters[pairingIdx];
            nameW = nc.segs.flatMap(s => s.words)
              .filter(w => isValidNameWord(w))
              .map(w => ({ text: w.text.toUpperCase(), x0: w.x0, x1: w.x1, y0: w.y0, y1: w.y1 }));
            usedNameClusterIdx.add(pairingIdx);
          }
        }

        // Sort by (y0, x0) for natural multi-line reading order.
        nameW.sort((a, b) => a.y0 !== b.y0 ? a.y0 - b.y0 : a.x0 - b.x0);
        const rawName = nameW.map(n => n.text).join(" ").trim();

        // Centroid of the room-number cluster (plus paired name cluster when present).
        const centroidWords = [...allW];
        if (pairingIdx >= 0) centroidWords.push(...clusters[pairingIdx].segs.flatMap(s => s.words));
        const xs = centroidWords.flatMap(w => [w.x0, w.x1]);
        const ys = centroidWords.flatMap(w => [w.y0, w.y1]);
        const rx = (Math.min(...xs) + Math.max(...xs)) / 2;
        // Offset marker downward: 35% of label bbox height (room-size-aware) or 2.5% of page height.
        const labelBboxH = Math.max(...ys) - Math.min(...ys);
        const nudge = labelBboxH > 0 ? labelBboxH * 0.35 : pageHeight * 0.025;
        const ry = (Math.min(...ys) + Math.max(...ys)) / 2 + nudge;

        // Reject address-like / copyright names.
        const isAddressLike =
          rawName.includes(",") ||
          /\b(AVE|BLVD|ST\b|RD\b|DR\b|MA\b|NY\b|CA\b|COPYRIGHT|DRAWING|PROJECT|JACOBS|CORPS)\b/.test(rawName);
        if (isAddressLike) continue;

        const normX = Math.max(1000, Math.min(99000, Math.round((rx / pageWidth) * 100000)));
        const normY = Math.max(1000, Math.min(99000, Math.round((ry / pageHeight) * 100000)));

        // Reject finish-material code names (C4, WD1, A1-420).
        const FINISH_CODE_TOKEN = /^[A-Z]{1,3}-?\d|^\d+$/;
        const isAllFinishCodes =
          rawName.length > 0 &&
          rawName.length < 25 &&
          rawName.split(/\s+/).every(t => FINISH_CODE_TOKEN.test(t));

        // 3-digit numbers are residential unit numbers in most projects.
        const isResidentialUnit = /^\d{3}[A-Z]?$/.test(roomNumber);

        if (isAllFinishCodes || (isResidentialUnit && rawName.split(/\s+/).length > 4)) {
          if (isResidentialUnit) {
            rooms.push({ roomNumber, roomName: `UNIT ${roomNumber}`, x: normX, y: normY, pageWidth, pageHeight, bboxX0: rx, bboxY0: ry, pageWPts: pageWidth, pageHPts: pageHeight, coordSource: "pdf_native" });
          }
          continue;
        }

        const roomName = rawName
          ? expandSynonyms(rawName)
          : isResidentialUnit
            ? `UNIT ${roomNumber}`
            : `ROOM ${roomNumber}`;

        if (isJunkRoomName(roomName)) continue;
        rooms.push({ roomNumber, roomName, x: normX, y: normY, pageWidth, pageHeight, bboxX0: rx, bboxY0: ry, pageWPts: pageWidth, pageHPts: pageHeight, coordSource: "pdf_native" });
      }
    }

    return rooms;
  }

  // Legacy proximity algorithm (preserved as fallback).
  //
  // Used verbatim when the new clustering finds 0 rooms on a sheet (e.g. very
  // sparse word lists where line/cluster heuristics produce nothing).
  function legacyExtraction(): ExtractedRoom[] {
    const rooms: ExtractedRoom[] = [];
    const usedIndices = new Set<number>();

    for (let i = 0; i < processedWords.length; i++) {
      const word = processedWords[i];
      if (!ROOM_NUMBER_RE.test(word.text)) continue;
      if (YEAR_RE.test(word.text)) continue;
      if (usedIndices.has(i)) continue;

      const rx0 = word.x0;
      const ry0 = word.y0;
      if (rx0 > titleBlockXThreshold || ry0 > titleBlockYThreshold) continue;

      const roomNumber = word.text;

      const nearby: Array<{ text: string; x0: number; x1: number; y0: number; y1: number }> = [];
      for (let j = 0; j < processedWords.length; j++) {
        if (j === i || usedIndices.has(j)) continue;
        const w2 = processedWords[j];
        const dy = Math.abs(w2.y0 - ry0);
        const dx = Math.abs(w2.x0 - rx0);
        // Expand vertical proximity for restroom-keyword labels — "GIRLS TOILET",
        // "BOYS RESTROOM" etc. are often placed farther from their room number on
        // dense multi-wing school plans than generic room labels.
        const nearbyIsRestroom = RESTROOM_LABEL_KW.test(w2.text);
        const tightCluster = (nearbyIsRestroom ? dy < 80 : dy < 40) && dx < 80;
        const sameLineClose = dy < 15 && dx < 200;
        if ((!tightCluster && !sameLineClose) || ROOM_NUMBER_RE.test(w2.text)) continue;
        const upper = w2.text.toUpperCase();
        if (upper.length === 1 && /[A-Z]/.test(upper)) continue;
        if (/^\d+\.\d+$/.test(w2.text)) continue;
        if (/^\d+$/.test(w2.text) && w2.text.length <= 2) continue;
        if (
          !IGNORE_WORDS.has(upper) &&
          !YEAR_RE.test(w2.text) &&
          w2.text.length <= 30 &&
          !/^\d+['"\-\/]/.test(w2.text)
        ) {
          nearby.push({ text: upper, x0: w2.x0, x1: w2.x1, y0: w2.y0, y1: w2.y1 });
        }
      }

      const sortedNearby = nearby.sort((a, b) => a.x0 - b.x0).map(n => n.text);
      const rawName = sortedNearby.slice(0, 5).join(" ").trim();

      const allLabelXs = [word.x0, word.x1, ...nearby.map(w => w.x0), ...nearby.map(w => w.x1)];
      const allLabelYs = [word.y0, word.y1, ...nearby.map(w => w.y0), ...nearby.map(w => w.y1)];
      const rx = (Math.min(...allLabelXs) + Math.max(...allLabelXs)) / 2;
      const labelBboxH2 = Math.max(...allLabelYs) - Math.min(...allLabelYs);
      const nudge2 = labelBboxH2 > 0 ? labelBboxH2 * 0.35 : pageHeight * 0.025;
      const ry = (Math.min(...allLabelYs) + Math.max(...allLabelYs)) / 2 + nudge2;

      const isAddressLike =
        rawName.includes(",") ||
        /\b(AVE|BLVD|ST\b|RD\b|DR\b|MA\b|NY\b|CA\b|COPYRIGHT|DRAWING|PROJECT|JACOBS|CORPS)\b/.test(rawName);
      if (isAddressLike) continue;

      const normX = Math.max(1000, Math.min(99000, Math.round((rx / pageWidth) * 100000)));
      const normY = Math.max(1000, Math.min(99000, Math.round((ry / pageHeight) * 100000)));

      const FINISH_CODE_TOKEN = /^[A-Z]{1,3}-?\d|^\d+$/;
      const isAllFinishCodes =
        rawName.length > 0 &&
        rawName.length < 25 &&
        rawName.split(/\s+/).every(w => FINISH_CODE_TOKEN.test(w));

      const isResidentialUnit = /^\d{3}[A-Z]?$/.test(roomNumber);

      if (isAllFinishCodes || (isResidentialUnit && rawName.split(/\s+/).length > 4)) {
        if (isResidentialUnit) {
          usedIndices.add(i);
          rooms.push({ roomNumber, roomName: `UNIT ${roomNumber}`, x: normX, y: normY, pageWidth, pageHeight, bboxX0: rx, bboxY0: ry, pageWPts: pageWidth, pageHPts: pageHeight, coordSource: "pdf_native" });
        }
        continue;
      }

      const roomName = rawName
        ? expandSynonyms(rawName)
        : isResidentialUnit
          ? `UNIT ${roomNumber}`
          : `ROOM ${roomNumber}`;

      usedIndices.add(i);
      if (isJunkRoomName(roomName)) continue;
      rooms.push({ roomNumber, roomName, x: normX, y: normY, pageWidth, pageHeight, bboxX0: rx, bboxY0: ry, pageWPts: pageWidth, pageHPts: pageHeight, coordSource: "pdf_native" });
    }

    return rooms;
  }

  // Run the new clustering algorithm; fall back to legacy only when it returns
  // 0 rooms (e.g. very sparse pages where line heuristics find nothing).
  const newRooms = clusterExtraction();
  const legacyRooms = legacyExtraction();
  console.log(
    `[Room clustering] found ${newRooms.length} rooms using new line-based clustering` +
    ` vs ${legacyRooms.length} rooms with legacy proximity method`,
  );
  return newRooms.length > 0 ? newRooms : legacyRooms;
}


// ---------------------------------------------------------------------------
// Estimator mode types
// ---------------------------------------------------------------------------

/** A single sign type entry as extracted from a signage notes sheet. */
