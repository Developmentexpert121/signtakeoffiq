import { pgTable, text, timestamp, integer, boolean, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./tenants";
import { jobsTable } from "./jobs";

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

export const insertTrainingCorrectionSchema = createInsertSchema(trainingCorrectionsTable).omit({ createdAt: true });
export type InsertTrainingCorrection = z.infer<typeof insertTrainingCorrectionSchema>;
export type TrainingCorrection = typeof trainingCorrectionsTable.$inferSelect;
