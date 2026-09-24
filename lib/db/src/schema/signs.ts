import { pgTable, text, timestamp, integer, numeric, boolean, real } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./tenants";
import { jobsTable } from "./jobs";
import { roomsTable } from "./rooms";
import { jobSheetsTable } from "./jobSheets";

export const signsTable = pgTable("signs", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull().references(() => jobsTable.id, { onDelete: "cascade" }),
  tenantId: text("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  roomId: text("room_id").references(() => roomsTable.id, { onDelete: "set null" }),
  sheetId: text("sheet_id").references(() => jobSheetsTable.id, { onDelete: "set null" }),
  signType: text("sign_type").notNull(),
  plaqueTypeId: text("plaque_type_id"),
  qty: integer("qty").notNull().default(1),
  markerX: integer("marker_x"),
  markerY: integer("marker_y"),
  canvasX: real("canvas_x"),
  canvasY: real("canvas_y"),
  ruleRef: text("rule_ref"),
  color: text("color"),
  confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull().default("0.5"),
  status: text("status").notNull().default("needs_review"),
  source: text("source").notNull().default("rules_engine"),
  dimensions: text("dimensions"),
  dimSource: text("dim_source"),
  mounting: text("mounting"),
  finishColor: text("finish_color"),
  message: text("message"),
  adaRequired: boolean("ada_required"),
  notes: text("notes"),
  floorLabel: text("floor_label"),
  roomNumber: text("room_number"),
  roomName: text("room_name"),
  markerColor: text("marker_color"),
  sourceSheetNumber: text("source_sheet_number"),
  isDeleted: boolean("is_deleted").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertSignSchema = createInsertSchema(signsTable).omit({ createdAt: true, updatedAt: true });
export type InsertSign = z.infer<typeof insertSignSchema>;
export type Sign = typeof signsTable.$inferSelect;
