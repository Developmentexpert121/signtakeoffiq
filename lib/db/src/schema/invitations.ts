import { pgTable, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";

export const invitationsTable = pgTable("invitations", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role").notNull(),
  tokenHash: text("token_hash").notNull(),
  createdByUserId: text("created_by_user_id").notNull(),
  createdByName: text("created_by_name"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tokenHashIdx: uniqueIndex("invitations_token_hash_idx").on(t.tokenHash),
  emailIdx: index("invitations_email_idx").on(t.email),
  tenantIdx: index("invitations_tenant_idx").on(t.tenantId),
}));

export type Invitation = typeof invitationsTable.$inferSelect;
