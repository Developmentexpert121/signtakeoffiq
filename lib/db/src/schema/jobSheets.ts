import { pgTable, text, timestamp, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./tenants";
import { jobsTable } from "./jobs";
import { jobFilesTable } from "./jobFiles";

export const jobSheetsTable = pgTable("job_sheets", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull().references(() => jobsTable.id, { onDelete: "cascade" }),
  tenantId: text("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  fileId: text("file_id").references(() => jobFilesTable.id, { onDelete: "set null" }),
  sheetId: text("sheet_id").notNull(),
  sheetTitle: text("sheet_title"),
  pdfPage: integer("pdf_page").notNull().default(1),
  sheetType: text("sheet_type"),
  rasterizedPath: text("rasterized_path"),
  level: text("level"),
  isRelevant: boolean("is_relevant").notNull().default(true),
  visionIsPlanView: boolean("vision_is_plan_view"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertJobSheetSchema = createInsertSchema(jobSheetsTable).omit({ createdAt: true });
export type InsertJobSheet = z.infer<typeof insertJobSheetSchema>;
export type JobSheet = typeof jobSheetsTable.$inferSelect;
