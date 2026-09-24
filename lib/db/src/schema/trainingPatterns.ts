import { pgTable, text, timestamp, integer, jsonb } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";

export const trainingPatternsTable = pgTable("training_patterns", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  patternType: text("pattern_type").notNull(),
  description: text("description").notNull(),
  evidenceCount: integer("evidence_count").notNull().default(0),
  buildingTypesAffected: jsonb("building_types_affected").notNull().default([]),
  exampleJobIds: jsonb("example_job_ids").notNull().default([]),
  suggestedFix: text("suggested_fix"),
  status: text("status").notNull().default("detected"),
  accuracyImpactEstimate: text("accuracy_impact_estimate"),
  approvedBy: text("approved_by"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  deployedAt: timestamp("deployed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type TrainingPattern = typeof trainingPatternsTable.$inferSelect;
