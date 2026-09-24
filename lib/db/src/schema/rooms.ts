import { pgTable, text, timestamp, integer, boolean, numeric, real, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./tenants";
import { jobsTable } from "./jobs";
import { jobSheetsTable } from "./jobSheets";

export const roomsTable = pgTable("rooms", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull().references(() => jobsTable.id, { onDelete: "cascade" }),
  tenantId: text("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  sheetId: text("sheet_id").references(() => jobSheetsTable.id, { onDelete: "set null" }),
  roomNumber: text("room_number").notNull(),
  roomName: text("room_name").notNull(),
  level: text("level").notNull().default("1"),
  coordX: integer("coord_x"),
  coordY: integer("coord_y"),
  occupantLoad: integer("occupant_load"),
  occupancyGroup: text("occupancy_group"),
  isResidentialUnit: boolean("is_residential_unit").notNull().default(false),
  isRestroom: boolean("is_restroom").notNull().default(false),
  isStair: boolean("is_stair").notNull().default(false),
  isElevator: boolean("is_elevator").notNull().default(false),
  isVestibule: boolean("is_vestibule").notNull().default(false),
  isCorridorOrHall: boolean("is_corridor_or_hall").notNull().default(false),
  isVehicleBay: boolean("is_vehicle_bay").notNull().default(false),
  isMepUnoccupied: boolean("is_mep_unoccupied").notNull().default(false),
  isVariableUse: boolean("is_variable_use").notNull().default(false),
  isPublicFacing: boolean("is_public_facing").notNull().default(false),
  isAssembly: boolean("is_assembly").notNull().default(false),
  publicDoorCount: integer("public_door_count"),
  flagOverrides: jsonb("flag_overrides").$type<Partial<Record<string, boolean>>>(),
  source: text("source").notNull().default("pdf"),
  reviewStatus: text("review_status").notNull().default("confirmed"),
  dismissalReason: text("dismissal_reason"),
  warningDismissed: boolean("warning_dismissed").notNull().default(false),
  confidence: numeric("confidence", { precision: 5, scale: 4 }).notNull().default("1.0"),
  bboxX0: real("bbox_x0").default(0),
  bboxY0: real("bbox_y0").default(0),
  pageWPts: real("page_w_pts").default(0),
  pageHPts: real("page_h_pts").default(0),
  coordSource: text("coord_source").notNull().default("pdf_native"),
  pipelineVersion: text("pipeline_version"),
  doorSide: text("door_side"),
  doorType: text("door_type"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertRoomSchema = createInsertSchema(roomsTable).omit({ createdAt: true });
export type InsertRoom = z.infer<typeof insertRoomSchema>;
export type Room = typeof roomsTable.$inferSelect;
