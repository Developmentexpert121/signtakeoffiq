/**
 * Sign Takeoff IQ — Full Database Schema
 * ORM: Drizzle ORM + PostgreSQL
 * Validation: drizzle-zod
 *
 * Table dependency order (safe to create in this sequence):
 *   tenants → users
 *   tenants → jobs → job_files → job_sheets
 *   tenants → jobs → rooms
 *   tenants → jobs → rooms → signs → job_sheets
 *   tenants → jobs → ai_scans
 *   tenants → jobs → training_corrections
 *   tenants → rule_overrides
 *   tenants → jobs → plaque_schedule
 *   tenants → jobs → validation_results
 *   tenants → jobs → import_snapshots
 *   cache_entries (standalone)
 *   system_settings (standalone)
 */

import {
  pgTable, text, timestamp, integer, numeric, jsonb,
  boolean, real,
} from "drizzle-orm/pg-core";

// ─── TENANTS ────────────────────────────────────────────────────────────────
// One row per customer. settings JSONB stores configurable pipeline params
// (AI retry limits, vision cap, DPI, etc.)
export const tenantsTable = pgTable("tenants", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  plan: text("plan").notNull().default("starter"),
  settings: jsonb("settings").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  lastActiveAt: timestamp("last_active_at", { withTimezone: true }),
});

// ─── USERS ───────────────────────────────────────────────────────────────────
// Clerk-authenticated users. role: "admin" | "member"
export const usersTable = pgTable("users", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  fullName: text("full_name"),
  role: text("role").notNull().default("member"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── JOBS ─────────────────────────────────────────────────────────────────────
// One row per project / drawing set.
// status: "pending" | "processing" | "completed" | "error" | "archived"
// scopeFlag: "restroom_only" | null
// metadata JSONB contains:
//   { progress, steps[], aiScanSummary, projectSignDictionary,
//     estimatorModeEligible, processingStartedAt }
export const jobsTable = pgTable("jobs", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  status: text("status").notNull().default("pending"),
  location: text("location"),
  jurisdiction: text("jurisdiction"),
  buildingType: text("building_type"),
  fileCount: integer("file_count").notNull().default(0),
  totalSigns: integer("total_signs").notNull().default(0),
  highConfidence: integer("high_confidence").notNull().default(0),
  needsReview: integer("needs_review").notNull().default(0),
  aiTokenCost: numeric("ai_token_cost", { precision: 10, scale: 6 }).notNull().default("0"),
  visionThreshold: integer("vision_threshold"),
  hasScheduleImport: boolean("has_schedule_import").notNull().default(false),
  scopeFlag: text("scope_flag"),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── JOB_FILES ────────────────────────────────────────────────────────────────
// Uploaded PDF files for a job. storagePath is the object-storage key.
// fileCategory: "floor_plans" | "sign_schedule" | null
export const jobFilesTable = pgTable("job_files", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull().references(() => jobsTable.id, { onDelete: "cascade" }),
  tenantId: text("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(),
  storagePath: text("storage_path").notNull(),
  pageCount: integer("page_count"),
  fileSizeBytes: integer("file_size_bytes"),
  fileCategory: text("file_category"),    // "floor_plans" | "sign_schedule" | null
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── JOB_SHEETS ───────────────────────────────────────────────────────────────
// One row per PDF page/sheet identified by the sidecar.
// sheetType: "floor_plan" | "signage_schedule" | "other"
// isRelevant: true = included in vision scan loop (Step 3)
// rasterizedPath: object-storage key for the 150-DPI PNG
// coordX/Y are not stored here — see rooms table
export const jobSheetsTable = pgTable("job_sheets", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull().references(() => jobsTable.id, { onDelete: "cascade" }),
  tenantId: text("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  fileId: text("file_id").references(() => jobFilesTable.id, { onDelete: "set null" }),
  sheetId: text("sheet_id").notNull(),           // e.g. "A0.6", "E1", "D2"
  sheetTitle: text("sheet_title"),               // from sidecar title-block parser
  pdfPage: integer("pdf_page").notNull().default(1),
  sheetType: text("sheet_type"),                 // "floor_plan" | "signage_schedule" | "other"
  rasterizedPath: text("rasterized_path"),       // object storage path for PNG
  level: text("level"),                          // "Level 1", "Level 2", "Basement", etc.
  isRelevant: boolean("is_relevant").notNull().default(true),
  visionIsPlanView: boolean("vision_is_plan_view"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── ROOMS ────────────────────────────────────────────────────────────────────
// All rooms extracted from floor plans (via Claude vision in Step 3).
// coordX / coordY: 0–1000 scale (Claude's 0–100% × 10).
//   (0,0) = top-left of rasterized sheet image.
// bboxX0, bboxY0, pageWPts, pageHPts: raw PDF coordinate metadata from pdfplumber
//   (in PDF points, not used for marker positioning currently).
// Classification booleans are set by keyword regex matching in Step 8.
export const roomsTable = pgTable("rooms", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull().references(() => jobsTable.id, { onDelete: "cascade" }),
  tenantId: text("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  sheetId: text("sheet_id").references(() => jobSheetsTable.id, { onDelete: "set null" }),
  roomNumber: text("room_number").notNull(),
  roomName: text("room_name").notNull(),
  level: text("level").notNull().default("1"),
  coordX: integer("coord_x"),                    // 0–1000, derived from Claude x% × 10
  coordY: integer("coord_y"),                    // 0–1000, derived from Claude y% × 10
  occupantLoad: integer("occupant_load"),
  occupancyGroup: text("occupancy_group"),
  isResidentialUnit: boolean("is_residential_unit").notNull().default(false),
  isRestroom: boolean("is_restroom").notNull().default(false),
  isStair: boolean("is_stair").notNull().default(false),
  isElevator: boolean("is_elevator").notNull().default(false),
  isVestibule: boolean("is_vestibule").notNull().default(false),
  isCorridorOrHall: boolean("is_corridor_or_hall").notNull().default(false),
  isVehicleBay: boolean("is_vehicle_bay").notNull().default(false),
  isMepUnoccupied: boolean("is_mep_unoccupied").notNull().default(false),
  isVariableUse: boolean("is_variable_use").notNull().default(false),
  isPublicFacing: boolean("is_public_facing").notNull().default(false),
  isAssembly: boolean("is_assembly").notNull().default(false),
  source: text("source").notNull().default("pdf"),  // "pdf" | "ai_vision" | "manual"
  reviewStatus: text("review_status").notNull().default("confirmed"),
  dismissalReason: text("dismissal_reason"),
  warningDismissed: boolean("warning_dismissed").notNull().default(false),
  confidence: numeric("confidence", { precision: 5, scale: 4 }).notNull().default("1.0"),
  bboxX0: real("bbox_x0").default(0),
  bboxY0: real("bbox_y0").default(0),
  pageWPts: real("page_w_pts").default(0),
  pageHPts: real("page_h_pts").default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── SIGNS ────────────────────────────────────────────────────────────────────
// Final sign schedule — one row per sign assignment.
// markerX / markerY: 0–1000 scale, copied from rooms.coordX/Y for floor plan dots.
// source: "rules_engine" | "schedule_import" | "estimator" | "manual"
// ruleRef: which rule produced this sign (e.g. "R1", "R2", "R3")
// status: "needs_review" | "confirmed" | "dismissed"
export const signsTable = pgTable("signs", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull().references(() => jobsTable.id, { onDelete: "cascade" }),
  tenantId: text("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  roomId: text("room_id").references(() => roomsTable.id, { onDelete: "set null" }),
  sheetId: text("sheet_id").references(() => jobSheetsTable.id, { onDelete: "set null" }),
  signType: text("sign_type").notNull(),
  plaqueTypeId: text("plaque_type_id"),
  qty: integer("qty").notNull().default(1),
  markerX: integer("marker_x"),                  // 0–1000 for floor plan dot overlay
  markerY: integer("marker_y"),                  // 0–1000 for floor plan dot overlay
  canvasX: real("canvas_x"),
  canvasY: real("canvas_y"),
  ruleRef: text("rule_ref"),                     // "R1"–"R17" or custom
  color: text("color"),
  confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull().default("0.5"),
  status: text("status").notNull().default("needs_review"),
  source: text("source").notNull().default("rules_engine"),
  dimensions: text("dimensions"),
  dimSource: text("dim_source"),
  mounting: text("mounting"),
  finishColor: text("finish_color"),
  message: text("message"),
  isDeleted: boolean("is_deleted").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── AI_SCANS ─────────────────────────────────────────────────────────────────
// Log of every Claude API call. callType matches Step labels.
// callType: "room_extraction" | "plaque_schedule" | "occupant_loads" |
//           "estimator_dict" | "estimator_assignment"
export const aiScansTable = pgTable("ai_scans", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull().references(() => jobsTable.id, { onDelete: "cascade" }),
  tenantId: text("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  callType: text("call_type").notNull(),
  model: text("model").notNull().default("claude-sonnet-4-6"),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  cost: numeric("cost", { precision: 10, scale: 6 }).notNull().default("0"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── TRAINING_CORRECTIONS ─────────────────────────────────────────────────────
// Per-tenant corrections applied in Step 9 after rules engine runs.
// correctionType: "add_sign" | "remove_sign" | "change_type" | "change_qty"
// roomNamePattern: substring matched against room names (case-insensitive)
// appliedCount: incremented each time this correction fires during a pipeline run
export const trainingCorrectionsTable = pgTable("training_corrections", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  jobId: text("job_id").references(() => jobsTable.id, { onDelete: "set null" }),
  signId: text("sign_id"),
  roomId: text("room_id"),
  correctionType: text("correction_type").notNull(),
  originalValue: jsonb("original_value").notNull().default({}),
  correctedValue: jsonb("corrected_value").notNull().default({}),
  roomNamePattern: text("room_name_pattern"),
  signType: text("sign_type"),
  ruleRef: text("rule_ref"),
  reason: text("reason"),
  isActive: boolean("is_active").notNull().default(true),
  appliedCount: integer("applied_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── RULE_OVERRIDES ───────────────────────────────────────────────────────────
// Per-tenant rule adjustments: disable a rule, change qty, add custom sign type.
// overrideType: "add" | "remove" | "modify"
// condition / action: arbitrary JSONB for rule matching and action spec
export const ruleOverridesTable = pgTable("rule_overrides", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  ruleRef: text("rule_ref").notNull(),
  overrideType: text("override_type").notNull().default("add"),
  condition: jsonb("condition").notNull().default({}),
  action: jsonb("action").notNull().default({}),
  confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull().default("0.5"),
  sourceCorrections: integer("source_corrections").notNull().default(1),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── PLAQUE_SCHEDULE ──────────────────────────────────────────────────────────
// Structured plaque type entries extracted by Claude from sign schedule sheets.
export const plaqueScheduleTable = pgTable("plaque_schedule", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull().references(() => jobsTable.id, { onDelete: "cascade" }),
  tenantId: text("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  typeId: text("type_id").notNull(),
  name: text("name").notNull(),
  braille: boolean("braille").notNull().default(false),
  hasInsert: boolean("has_insert").notNull().default(false),
  insertSize: text("insert_size"),
  letterHeight: text("letter_height"),
  triggerDescription: text("trigger_description"),
  mapsToColumn: text("maps_to_column"),
  materialNotes: text("material_notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── VALIDATION_RESULTS ───────────────────────────────────────────────────────
// Post-pipeline validation warnings written in Step 10.
// checkName: e.g. "missing_room_numbers", "low_confidence_signs"
// status: "pass" | "warn" | "fail"
export const validationResultsTable = pgTable("validation_results", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull().references(() => jobsTable.id, { onDelete: "cascade" }),
  tenantId: text("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  checkName: text("check_name").notNull(),
  status: text("status").notNull().default("pending"),
  details: text("details"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── IMPORT_SNAPSHOTS ─────────────────────────────────────────────────────────
// Snapshots of sign schedule imports used for training accuracy tracking.
export const importSnapshotsTable = pgTable("import_snapshots", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  snapshotDate: timestamp("snapshot_date", { withTimezone: true }).notNull().defaultNow(),
  avgConfidence: numeric("avg_confidence", { precision: 6, scale: 4 }).notNull(),
  activeOverrideCount: integer("active_override_count").notNull().default(0),
  newRulesCount: integer("new_rules_count").notNull().default(0),
  updatedRulesCount: integer("updated_rules_count").notNull().default(0),
  batchLabel: text("batch_label"),
  sourceJobId: text("source_job_id").references(() => jobsTable.id, { onDelete: "set null" }),
  sourceType: text("source_type"),
  matchedCount: integer("matched_count").notNull().default(0),
  aiMissedCount: integer("ai_missed_count").notNull().default(0),
  aiExtraCount: integer("ai_extra_count").notNull().default(0),
  buildingType: text("building_type"),
  jurisdiction: text("jurisdiction"),
  accuracyScore: text("accuracy_score"),
  totalHumanSigns: integer("total_human_signs"),
});

// ─── CACHE_ENTRIES ────────────────────────────────────────────────────────────
// Generic TTL key-value cache. Used to cache sidecar results and API responses.
export const cacheEntriesTable = pgTable("cache_entries", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

// ─── SYSTEM_SETTINGS ──────────────────────────────────────────────────────────
// Global system-level configuration key-value store.
export const systemSettingsTable = pgTable("system_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
