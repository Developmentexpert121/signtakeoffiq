import { pgTable, text, timestamp, integer, boolean, numeric, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./tenants";

export const ruleOverridesTable = pgTable("rule_overrides", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  ruleRef: text("rule_ref").notNull(),
  overrideType: text("override_type").notNull().default("add"),
  condition: jsonb("condition").notNull().default({}),
  action: jsonb("action").notNull().default({}),
  confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull().default("0.5"),
  sourceCorrections: integer("source_corrections").notNull().default(1),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertRuleOverrideSchema = createInsertSchema(ruleOverridesTable).omit({ createdAt: true, updatedAt: true });
export type InsertRuleOverride = z.infer<typeof insertRuleOverrideSchema>;
export type RuleOverride = typeof ruleOverridesTable.$inferSelect;
