import { pgTable, text, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { tenantsTable } from "./tenants";

export const savedDateRangesTable = pgTable("saved_date_ranges", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  tenantId: text("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  start: text("start").notNull(),
  end: text("end").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertSavedDateRangeSchema = createInsertSchema(savedDateRangesTable).omit({ createdAt: true });
export type InsertSavedDateRange = z.infer<typeof insertSavedDateRangeSchema>;
export type SavedDateRange = typeof savedDateRangesTable.$inferSelect;
