import { pgTable, text, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./tenants";
import { jobsTable } from "./jobs";

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

export const insertPlaqueScheduleSchema = createInsertSchema(plaqueScheduleTable).omit({ createdAt: true });
export type InsertPlaqueSchedule = z.infer<typeof insertPlaqueScheduleSchema>;
export type PlaqueSchedule = typeof plaqueScheduleTable.$inferSelect;
