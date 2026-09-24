import type { SignScheduleEntry } from "./types";

export function deduplicateSignSchedule(signSchedule: SignScheduleEntry[]): SignScheduleEntry[] {
  if (signSchedule.length === 0) return signSchedule;

  const seen = new Set<string>();
  const deduped = signSchedule.filter(entry => {
    const key = [
      entry.sheetId.trim().toLowerCase(),
      entry.roomNumber.trim().toLowerCase(),
      entry.signType.trim().toLowerCase(),
      (entry.typeMark ?? "").trim().toLowerCase(),
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  signSchedule.length = 0;
  signSchedule.push(...deduped);
  return signSchedule;
}

/**
 * Step 3a per-sheet dedup: key on roomNumber|signType.
 * Catches the same row appearing in multiple table instances on a single sheet.
 * Mutates the array in-place and returns it.
 */

export function deduplicateSchedulePerSheet(signSchedule: SignScheduleEntry[]): SignScheduleEntry[] {
  if (signSchedule.length === 0) return signSchedule;

  const seen = new Set<string>();
  const deduped = signSchedule.filter(entry => {
    const key = [
      entry.roomNumber.trim().toLowerCase(),
      entry.signType.trim().toLowerCase(),
      (entry.typeMark ?? "").trim().toLowerCase(),
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  signSchedule.length = 0;
  signSchedule.push(...deduped);
  return signSchedule;
}

/**
 * Step 3a global cross-sheet dedup: 3-field key (roomNumber|roomName|signType).
 * Catches duplicates that span multiple sheets (e.g. a sheet with 27 table instances).
 * Mutates the array in-place and returns it.
 */

export function deduplicateScheduleGlobal(signSchedule: SignScheduleEntry[]): SignScheduleEntry[] {
  if (signSchedule.length === 0) return signSchedule;

  const seen = new Set<string>();
  const deduped = signSchedule.filter(entry => {
    const key = [
      entry.roomNumber.trim().toLowerCase(),
      entry.roomName.trim().toLowerCase(),
      entry.signType.trim().toLowerCase(),
      (entry.typeMark ?? "").trim().toLowerCase(),
    ].filter(Boolean).join("|");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  signSchedule.length = 0;
  signSchedule.push(...deduped);
  return signSchedule;
}

export interface Step3aBridgeEntry {
  roomNumber: string;
  roomName: string;
  signType: string;
  quantity: number;
}

/**
 * applyStep3aBridge — the bridge that fires at the end of Step 3a.
 *
 * When dedicated sign-schedule files were uploaded AND Gemini (or the text
 * path) successfully extracted at least one entry from them, the job's
 * schedule-import flag must be raised so Step 9 skips the rules engine and
 * inserts the schedule rows directly.
 *
 * Returns both the flag AND the bridged row array so callers can verify
 * that the exact entries Step 9 will consume are propagated correctly.
 *
 * @param dedicatedSignScheduleFiles - files whose file_category is "sign_schedule"
 * @param signSchedule               - entries extracted during Step 3a
 * @returns hasScheduleImport flag + bridgedRows (signSchedule slice when bridge fires)
 */

export function applyStep3aBridge(
  dedicatedSignScheduleFiles: { id: string }[],
  signSchedule: Step3aBridgeEntry[],
): { hasScheduleImport: boolean; bridgedRows: Step3aBridgeEntry[] } {
  if (dedicatedSignScheduleFiles.length > 0 && signSchedule.length > 0) {
    return { hasScheduleImport: true, bridgedRows: signSchedule };
  }
  return { hasScheduleImport: false, bridgedRows: [] };
}

// Main pipeline
// ---------------------------------------------------------------------------

// Module-level concurrency guard — prevents sidecar overload.
// Configurable via MAX_CONCURRENT_PIPELINES (default 4); raise once the sidecar
// is concurrent (S1).
