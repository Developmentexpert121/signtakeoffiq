/**
 * Semantic Mapper — building-type-aware room flag assignment.
 *
 * classifyRoom() in rules-engine.ts assigns flags based on keywords that are
 * the same for every building type (restroom, stair, elevator, etc.).
 * This module adds a second pass that applies building-type-specific overrides
 * from the building_type_lexicons DB table.
 *
 * Example:  CLASSROOM → isVariableUse = true  (Education)
 *           EXAM ROOM → isVariableUse = true  (Healthcare)
 *           COURTROOM → isAssembly = true       (Government)
 *
 * Merge order (highest priority wins):
 *   classifyRoom flags  →  semanticMapper flags  →  manual flagOverrides (from UI)
 */

import { db } from "@workspace/db";
import { buildingTypeLexiconsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type SemanticFlags = {
  isRestroom?: boolean;
  isAssembly?: boolean;
  isVariableUse?: boolean;
  isMepUnoccupied?: boolean;
  isCorridorOrHall?: boolean;
  isStair?: boolean;
  isElevator?: boolean;
  isVestibule?: boolean;
  isPublicFacing?: boolean;
  isResidentialUnit?: boolean;
};

type LexiconEntry = { flagName: string; keyword: string };

// ─────────────────────────────────────────────────────────────────────────────
// In-memory cache
// One cache entry per building type; refreshed every 5 minutes.
// ─────────────────────────────────────────────────────────────────────────────

interface CacheEntry {
  loadedAt: number;
  /** Map from flag name to array of uppercase keywords */
  byFlag: Map<string, string[]>;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const cache = new Map<string, CacheEntry>();

async function loadLexicon(buildingType: string): Promise<Map<string, string[]>> {
  const now = Date.now();
  const cached = cache.get(buildingType);
  if (cached && now - cached.loadedAt < CACHE_TTL_MS) {
    return cached.byFlag;
  }

  const rows: LexiconEntry[] = await db
    .select({ flagName: buildingTypeLexiconsTable.flagName, keyword: buildingTypeLexiconsTable.keyword })
    .from(buildingTypeLexiconsTable)
    .where(
      and(
        eq(buildingTypeLexiconsTable.buildingType, buildingType),
        eq(buildingTypeLexiconsTable.active, true),
      ),
    );

  const byFlag = new Map<string, string[]>();
  for (const { flagName, keyword } of rows) {
    const arr = byFlag.get(flagName) ?? [];
    arr.push(keyword.toUpperCase());
    byFlag.set(flagName, arr);
  }

  cache.set(buildingType, { loadedAt: now, byFlag });
  return byFlag;
}

/** Explicitly evict a building type from the in-memory cache (e.g. after lexicon edits). */
export function evictLexiconCache(buildingType?: string): void {
  if (buildingType) {
    cache.delete(buildingType);
  } else {
    cache.clear();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Core mapping function
// ─────────────────────────────────────────────────────────────────────────────

const WORD_BOUNDARY_RE: RegExp = /\b/;
void WORD_BOUNDARY_RE; // not used directly but for clarity

/**
 * Build a word-boundary regex for a list of keywords.
 * Returns null when the list is empty (matches nothing).
 */
function buildKeywordRegex(keywords: string[]): RegExp | null {
  if (keywords.length === 0) return null;
  const parts = keywords.map((kw) => {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const prefix = /\w/.test(kw[0]) ? "\\b" : "";
    const suffix = /\w/.test(kw[kw.length - 1]) ? "\\b" : "";
    return `${prefix}${escaped}${suffix}`;
  });
  return new RegExp(parts.join("|"), "i");
}

/**
 * Map a room name to semantic flags for the given building type.
 *
 * Returns ONLY the flags that should override classifyRoom() output.
 * If the building type is unknown or has no lexicon entry, returns {}.
 */
export async function mapRoomToFlags(
  roomName: string,
  buildingType: string,
): Promise<SemanticFlags> {
  if (!roomName || !buildingType || buildingType.toLowerCase() === "unknown") {
    return {};
  }

  const btKey = buildingType.toLowerCase().trim();
  const byFlag = await loadLexicon(btKey);

  if (byFlag.size === 0) return {};

  const flags: SemanticFlags = {};
  const name = roomName.toUpperCase().trim();

  for (const [flagName, keywords] of byFlag.entries()) {
    const re = buildKeywordRegex(keywords);
    if (re && re.test(name)) {
      (flags as Record<string, boolean>)[flagName] = true;
    }
  }

  return flags;
}

/**
 * Synchronous version using a pre-loaded lexicon map.
 * Use this inside the pipeline after a single async load per run.
 */
export function mapRoomToFlagsSync(
  roomName: string,
  byFlag: Map<string, string[]>,
): SemanticFlags {
  if (!roomName || byFlag.size === 0) return {};

  const flags: SemanticFlags = {};
  const name = roomName.toUpperCase().trim();

  for (const [flagName, keywords] of byFlag.entries()) {
    const re = buildKeywordRegex(keywords);
    if (re && re.test(name)) {
      (flags as Record<string, boolean>)[flagName] = true;
    }
  }

  return flags;
}

/**
 * Pre-load the lexicon for a building type (returns the byFlag map for
 * use with mapRoomToFlagsSync in tight loops).
 */
export async function preloadLexicon(buildingType: string): Promise<Map<string, string[]>> {
  if (!buildingType || buildingType.toLowerCase() === "unknown") {
    return new Map();
  }
  return loadLexicon(buildingType.toLowerCase().trim());
}
