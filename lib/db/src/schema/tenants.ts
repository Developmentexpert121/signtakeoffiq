import { pgTable, text, integer, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const tenantsTable = pgTable("tenants", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  plan: text("plan").notNull().default("starter"),
  // SignSuiteIQ business_details.id — set when the tenant is provisioned via the SignSuite webhook.
  signsuiteiqCompanyId: integer("signsuiteiq_company_id"),
  email: text("email"),
  phone: text("phone"),
  website: text("website"),
  settings: jsonb("settings").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  lastActiveAt: timestamp("last_active_at", { withTimezone: true }),
}, (t) => ({
  signsuiteiqCompanyIdx: index("tenants_signsuiteiq_company_id_idx").on(t.signsuiteiqCompanyId),
}));

export const insertTenantSchema = createInsertSchema(tenantsTable).omit({ createdAt: true, updatedAt: true });
export type InsertTenant = z.infer<typeof insertTenantSchema>;
export type Tenant = typeof tenantsTable.$inferSelect;
