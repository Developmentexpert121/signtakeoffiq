import { pgTable, text, jsonb, timestamp } from "drizzle-orm/pg-core";

export const cacheEntriesTable = pgTable("cache_entries", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export type CacheEntry = typeof cacheEntriesTable.$inferSelect;
