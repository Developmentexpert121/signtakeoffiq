import { pgTable, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./tenants";

export const usersTable = pgTable("users", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  username: text("username"),
  fullName: text("full_name"),
  role: text("role").notNull().default("user"),
  ownerId: text("owner_id"),
  phone: text("phone"),
  jobTitle: text("job_title"),
  location: text("location"),
  // SignSuiteIQ users.id — set when the row is provisioned via the SignSuite webhook.
  signsuiteiqUserId: integer("signsuiteiq_user_id"),
  // Soft-delete marker. A non-null value means the user is archived and cannot log in.
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  emailIdx: index("users_email_idx").on(t.email),
  ownerIdx: index("users_owner_id_idx").on(t.ownerId),
  signsuiteiqUserIdx: index("users_signsuiteiq_user_id_idx").on(t.signsuiteiqUserId),
}));

export const insertUserSchema = createInsertSchema(usersTable).omit({ createdAt: true, updatedAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
