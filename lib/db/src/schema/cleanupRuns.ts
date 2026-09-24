import { pgTable, serial, integer, bigint, timestamp } from "drizzle-orm/pg-core";

export const cleanupRunsTable = pgTable("cleanup_runs", {
  id: serial("id").primaryKey(),
  tenantsDeleted: integer("tenants_deleted").notNull().default(0),
  filesDeleted: integer("files_deleted").notNull().default(0),
  bytesRecovered: bigint("bytes_recovered", { mode: "number" }).notNull().default(0),
  ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
});

export type CleanupRun = typeof cleanupRunsTable.$inferSelect;
