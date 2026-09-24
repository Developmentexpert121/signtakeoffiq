import { pgTable, text, integer, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";

/**
 * Building-type profile configuration table.
 *
 * One row per canonical building type (8 types + aliases).
 * Stores operational parameters that drive the rules engine and sign fabrication workflow.
 * Editing a row overrides the hard-coded defaults in rules-engine.ts without a code deploy.
 */
export const buildingTypeProfilesTable = pgTable("building_type_profiles", {
  /** Canonical building type key (e.g. "commercial", "healthcare") */
  buildingType: text("building_type").primaryKey(),

  /** Max evac maps placed per floor based on IBC 1010 placement rules. */
  evacMapMaxPerFloor: integer("evac_map_max_per_floor").notNull(),

  /**
   * Minimum number of exterior exit doors for this building type.
   * Used by the formula-exit rule (Fix 3) to estimate Exit sign count.
   * Value is a conservative IBC code minimum — verify against actual plans.
   */
  minExitsPerFloor: integer("min_exits_per_floor").notNull(),

  /**
   * IBC occupancy group (e.g. "B", "A-3", "I-2", "R-2").
   * Used for code-citation display in the review UI.
   */
  ibcOccupancyGroup: text("ibc_occupancy_group"),

  /**
   * Stair sign panel content note shown in the purchasing/fabrication report.
   * Includes the variable "[X]" placeholder for the stair identifier letter.
   * Example: "STAIR [X] — SMOKE COMPARTMENT: SEE PLANS"
   */
  stairSignVariant: text("stair_sign_variant").notNull(),

  /**
   * Preferred mount side for Unit ID plaques relative to the door latch.
   * "latch" = mount adjacent to the latch (most common for accessibility).
   * "hinge" = mount on the hinge side (atypical; some jurisdictions require).
   * null = not applicable (non-residential building types).
   */
  unitMountSide: text("unit_mount_side"),

  /**
   * Whether IBC 1007 (Areas of Rescue Assistance) applies to this building type.
   * When true, applyStairRules emits one Area of Rescue sign per floor per stair.
   */
  requiresAreaOfRescue: boolean("requires_area_of_rescue").notNull().default(false),

  /**
   * Default number of stair cores to assume when plan extraction finds none.
   * Used by egress-sign-generator as a conservative fallback.
   */
  stairCountDefault: integer("stair_count_default"),

  /**
   * JSONB array of room-name / room-number patterns used to identify stair cores
   * during egress sign generation (e.g. ["STAIR A", "SA", "S1", "EXIT STAIR"]).
   */
  stairNamePatterns: jsonb("stair_name_patterns").$type<string[]>(),

  /**
   * Optional formula description for reference (e.g. "stairCount × floorCount + minExterior").
   * Used for UI display only; actual formula is hard-coded in egress-sign-generator.
   */
  exitFormula: text("exit_formula"),

  /**
   * Room names that trigger assembly-occupancy rules (Max Occupancy sign) for this type.
   */
  assemblyLexicon: jsonb("assembly_lexicon").$type<string[]>(),

  /** Room names classified as unoccupied MEP/utility spaces for this building type. */
  mepLexicon: jsonb("mep_lexicon").$type<string[]>(),

  /** Room names classified as restroom/toilet rooms for this building type. */
  restroomLexicon: jsonb("restroom_lexicon").$type<string[]>(),

  /** Room names classified as corridors/lobbies (evac map placement targets). */
  corridorLexicon: jsonb("corridor_lexicon").$type<string[]>(),

  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type BuildingTypeProfile = typeof buildingTypeProfilesTable.$inferSelect;
export type NewBuildingTypeProfile = typeof buildingTypeProfilesTable.$inferInsert;
