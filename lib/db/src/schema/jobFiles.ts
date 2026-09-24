import { pgTable, text, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./tenants";
import { jobsTable } from "./jobs";

export const jobFilesTable = pgTable("job_files", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull().references(() => jobsTable.id, { onDelete: "cascade" }),
  tenantId: text("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(),
  storagePath: text("storage_path").notNull(),
  pageCount: integer("page_count"),
  fileSizeBytes: integer("file_size_bytes"),
  /** "floor_plans" | "sign_schedule" | null (unclassified) */
  fileCategory: text("file_category"),
  /** User-supplied floor label from the structured upload UI, e.g. "First floor" or "Floors 1–3" */
  floorLabel: text("floor_label"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertJobFileSchema = createInsertSchema(jobFilesTable).omit({ createdAt: true });
export type InsertJobFile = z.infer<typeof insertJobFileSchema>;
export type JobFile = typeof jobFilesTable.$inferSelect;
