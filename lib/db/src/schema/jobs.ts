import { pgTable, text, timestamp, integer, numeric, jsonb, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./tenants";

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
  aiDetectedBuildingType: text("ai_detected_building_type"),
  aiDetectedTypeConfidence: numeric("ai_detected_type_confidence", { precision: 4, scale: 3 }),
  materialSpec: jsonb("material_spec").$type<{
    substrate:      string | null;
    finishMethod:   string | null;
    brailleSpec:    string | null;
    mountingHeight: string | null;
    manufacturer:   string | null;
    source:         string;
  } | null>(),
  pricingOverrides: jsonb("pricing_overrides").$type<Record<string, number>>(),
  xlsxDirty: boolean("xlsx_dirty").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertJobSchema = createInsertSchema(jobsTable).omit({ createdAt: true, updatedAt: true });
export type InsertJob = z.infer<typeof insertJobSchema>;
export type Job = typeof jobsTable.$inferSelect;
