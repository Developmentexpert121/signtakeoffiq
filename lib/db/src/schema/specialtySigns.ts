import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./tenants";
import { jobsTable } from "./jobs";
import { jobSheetsTable } from "./jobSheets";

export const specialtySignsTable = pgTable("specialty_signs", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull().references(() => jobsTable.id, { onDelete: "cascade" }),
  tenantId: text("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  sheetId: text("sheet_id").references(() => jobSheetsTable.id, { onDelete: "set null" }),
  sourceSheetNumber: text("source_sheet_number"),
  signCode: text("sign_code"),
  description: text("description").notNull(),
  dimensions: text("dimensions"),
  material: text("material"),
  finish: text("finish"),
  qty: integer("qty"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertSpecialtySignSchema = createInsertSchema(specialtySignsTable).omit({ createdAt: true, updatedAt: true });
export type InsertSpecialtySign = z.infer<typeof insertSpecialtySignSchema>;
export type SpecialtySign = typeof specialtySignsTable.$inferSelect;
