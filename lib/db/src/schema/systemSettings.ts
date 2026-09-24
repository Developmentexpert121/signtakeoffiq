import { pgTable, text, jsonb, timestamp } from "drizzle-orm/pg-core";

export const systemSettingsTable = pgTable("system_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type SystemSetting = typeof systemSettingsTable.$inferSelect;
