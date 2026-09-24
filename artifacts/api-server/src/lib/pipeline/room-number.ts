const ROOM_NUMBER_ALLOWLISTS: Record<string, RegExp> = {
  education: /^(W|E)\d{3}[A-Z]?$|^(WC|EC)\d{3}[A-Z]?$|^(SA|SB|SC|SD)\d{2}$|^EV\d{2}$/i,
  school:    /^(W|E)\d{3}[A-Z]?$|^(WC|EC)\d{3}[A-Z]?$|^(SA|SB|SC|SD)\d{2}$|^EV\d{2}$/i,
};

/** Returns false when the room number is explicitly disallowed for the given
 *  building type.  Returns true (allowed) when no allowlist is configured. */

export function isAllowedRoomNumber(roomNumber: string, buildingType: string | null | undefined): boolean {
  if (!buildingType) return true;
  const key = buildingType.toLowerCase().trim();
  const pattern = ROOM_NUMBER_ALLOWLISTS[key];
  if (!pattern) return true; // no restriction configured for this type
  return pattern.test(roomNumber);
}

/**
 * Decide whether the per-type room-number allowlist should actually be enforced
 * for this building's room set.
 *
 * The allowlists (e.g. Education's W/E-wing scheme) are tuned to one firm's
 * numbering convention.  Enforcing such an allowlist as a hard keep-only filter
 * on a building that uses a *different* convention (e.g. a dormitory with
 * plain-numeric `201` / `UNIT 309` rooms) deletes the entire room inventory.
 *
 * Guard: only enforce when the configured pattern genuinely dominates — at least
 * 5 numbered rooms AND ≥50% of them match.  When skipped, the universal
 * hard-reject safety net (short garbled tokens like `35`, `W1`, `E11`) still
 * runs, so noise protection is preserved.
 */

export function shouldApplyRoomNumberAllowlist(
  rooms: { roomNumber: string; coordSource?: string | null }[],
  buildingType: string | null | undefined,
): boolean {
  if (!buildingType) return false;
  const pattern = ROOM_NUMBER_ALLOWLISTS[buildingType.toLowerCase().trim()];
  if (!pattern) return false; // no allowlist configured → nothing to gate
  const numbered = rooms.filter(
    (r) => r.coordSource !== "schedule" && (r.roomNumber ?? "").trim().length > 0,
  );
  if (numbered.length < 5) return false; // too few numbered rooms to judge safely
  const matches = numbered.filter((r) => pattern.test(r.roomNumber.trim())).length;
  return matches / numbered.length >= 0.5;
}

/** UNIT/APT name pattern shared by the pipeline + rules-engine suppression guards. */

export const UNIT_APT_NAME_RE = /^UNIT\b|^APT\b/i;

/** Count of rooms whose name is a UNIT/APT dwelling-unit identifier. */

export function unitNameCount(rooms: { roomName: string }[]): number {
  return rooms.filter((r) => UNIT_APT_NAME_RE.test((r.roomName ?? "").trim())).length;
}

/**
 * True when UNIT/APT-named rooms dominate the set, meaning they are real dwelling
 * units (dorm / apartment) rather than stray non-residential artifacts (airport
 * gates, door-schedule codes).  Requires BOTH a ≥30% share (the same threshold
 * `detectBuildingType` uses to classify a building as residential) AND ≥5 such
 * rooms in absolute terms, so a handful of stray UNIT labels in a small set never
 * trip the guard.  When this returns true the non-residential UNIT/APT suppression
 * must stand down even if the building type is non-residential.
 */

export function unitNamesDominant(rooms: { roomName: string }[]): boolean {
  const count = unitNameCount(rooms);
  return count >= 5 && count / rooms.length >= 0.3;
}
