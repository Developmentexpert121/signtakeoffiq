import { pgTable, text, timestamp, integer, bigint } from "drizzle-orm/pg-core";

export const guestCleanupRunsTable = pgTable("guest_cleanup_runs", {
  id: text("id").primaryKey(),
  ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
  tenantsDeleted: integer("tenants_deleted").notNull().default(0),
  filesDeleted: integer("files_deleted").notNull().default(0),
  bytesRecovered: bigint("bytes_recovered", { mode: "number" }).notNull().default(0),
});

export type GuestCleanupRun = typeof guestCleanupRunsTable.$inferSelect;
