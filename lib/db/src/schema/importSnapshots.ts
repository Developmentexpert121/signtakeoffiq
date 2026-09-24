import { pgTable, text, timestamp, integer, numeric } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";
import { jobsTable } from "./jobs";

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

export type ImportSnapshot = typeof importSnapshotsTable.$inferSelect;
