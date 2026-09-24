import { pgTable, text, boolean, timestamp, unique } from "drizzle-orm/pg-core";

/**
 * Building-type-aware semantic lexicon.
 *
 * Each row maps one keyword to one flag for one building type.
 * The semantic mapper loads all active rows and uses them to
 * override the building-type-agnostic classifyRoom() flags.
 *
 * One keyword per row allows fine-grained activation/deactivation
 * without schema changes.
 */
export const buildingTypeLexiconsTable = pgTable("building_type_lexicons", {
  id: text("id").primaryKey(),
  buildingType: text("building_type").notNull(),
  flagName: text("flag_name").notNull(),
  keyword: text("keyword").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniq: unique("btl_type_flag_keyword").on(t.buildingType, t.flagName, t.keyword),
}));

export type BuildingTypeLexicon = typeof buildingTypeLexiconsTable.$inferSelect;
