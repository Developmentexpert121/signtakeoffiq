import { pgTable, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const passwordResetTokensTable = pgTable(
  "password_reset_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tokenHashIdx: uniqueIndex("password_reset_tokens_token_hash_idx").on(t.tokenHash),
    userIdx: index("password_reset_tokens_user_idx").on(t.userId),
  }),
);

export type PasswordResetToken = typeof passwordResetTokensTable.$inferSelect;
