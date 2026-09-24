import { pgTable, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";

export const tenantPricingSettingsTable = pgTable("tenant_pricing_settings", {
  tenantId: text("tenant_id").primaryKey().references(() => tenantsTable.id, { onDelete: "cascade" }),
  materials: jsonb("materials").notNull().default([]),
  finishings: jsonb("finishings").notNull().default([]),
  laser: jsonb("laser").notNull().default([]),
  additionalCharges: jsonb("additional_charges").notNull().default([]),
  rushFee: jsonb("rush_fee").notNull().default({}),
  shipping: jsonb("shipping").notNull().default({}),
  signDefaults: jsonb("sign_defaults").notNull().default([]),
  customProducts: jsonb("custom_products").notNull().default([]),
  installation: jsonb("installation").default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
