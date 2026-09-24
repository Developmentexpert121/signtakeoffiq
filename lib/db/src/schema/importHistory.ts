import { pgTable, text, timestamp, integer } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";

export const importHistoryTable = pgTable("import_history", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  filename: text("filename").notNull().default(""),
  importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
  rowsParsed: integer("rows_parsed").notNull().default(0),
  rowsSaved: integer("rows_saved").notNull().default(0),
  rowsSkipped: integer("rows_skipped").notNull().default(0),
  status: text("status").notNull().default("success"),
});

export type ImportHistory = typeof importHistoryTable.$inferSelect;
