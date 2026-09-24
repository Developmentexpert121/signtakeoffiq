import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./tenants";
import { jobsTable } from "./jobs";

export const validationResultsTable = pgTable("validation_results", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull().references(() => jobsTable.id, { onDelete: "cascade" }),
  tenantId: text("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  checkName: text("check_name").notNull(),
  status: text("status").notNull().default("pending"),
  details: text("details"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertValidationResultSchema = createInsertSchema(validationResultsTable).omit({ createdAt: true });
export type InsertValidationResult = z.infer<typeof insertValidationResultSchema>;
export type ValidationResult = typeof validationResultsTable.$inferSelect;
