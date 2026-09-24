import { pgTable, text, timestamp, integer, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./tenants";
import { jobsTable } from "./jobs";

export const aiScansTable = pgTable("ai_scans", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull().references(() => jobsTable.id, { onDelete: "cascade" }),
  tenantId: text("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  callType: text("call_type").notNull(),
  model: text("model").notNull().default("claude-sonnet-4-6"),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  cost: numeric("cost", { precision: 10, scale: 6 }).notNull().default("0"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertAiScanSchema = createInsertSchema(aiScansTable).omit({ createdAt: true });
export type InsertAiScan = z.infer<typeof insertAiScanSchema>;
export type AiScan = typeof aiScansTable.$inferSelect;
