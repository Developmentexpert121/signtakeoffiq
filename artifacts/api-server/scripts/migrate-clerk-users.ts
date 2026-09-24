/**
 * One-shot migration: for every legacy user (typically those whose id starts
 * with the Clerk "user_" prefix) that has NO row in auth_credentials, generate
 * a password-reset token and send a branded "set your new password" email.
 *
 * Clerk does not export password hashes, so a reset is unavoidable. Existing
 * user ids are preserved so all foreign keys remain intact.
 *
 * Usage:
 *   pnpm --filter @workspace/api-server exec tsx scripts/migrate-clerk-users.ts            # dry-run
 *   pnpm --filter @workspace/api-server exec tsx scripts/migrate-clerk-users.ts --apply    # actually send
 */

import { db, usersTable, authCredentialsTable, passwordResetTokensTable } from "@workspace/db";
import { eq, isNull, ne } from "drizzle-orm";
import { genResetToken, hashResetToken, newId } from "../src/lib/sessionAuth";
import { sendPasswordResetEmail } from "../src/lib/email";

const PASSWORD_RESET_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days for migration

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  console.log(`[migrate-clerk-users] mode=${apply ? "APPLY" : "DRY-RUN"}`);

  // Find users with no auth_credentials row, excluding guests and pending placeholders.
  const rows = await db
    .select({
      id: usersTable.id,
      email: usersTable.email,
      fullName: usersTable.fullName,
      role: usersTable.role,
      credUserId: authCredentialsTable.userId,
    })
    .from(usersTable)
    .leftJoin(authCredentialsTable, eq(authCredentialsTable.userId, usersTable.id))
    .where(ne(usersTable.role, "guest"));

  const needsMigration = rows.filter(
    (r) => !r.credUserId && !r.id.startsWith("pending_") && r.email && !r.email.endsWith("@guest.local"),
  );

  console.log(`[migrate-clerk-users] candidates: ${needsMigration.length}`);

  let sent = 0;
  let failed = 0;

  for (const u of needsMigration) {
    console.log(`  - ${u.id}  <${u.email}>  role=${u.role}`);
    if (!apply) continue;

    try {
      const token = genResetToken();
      const tokenHash = hashResetToken(token);
      const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);

      // Step 1: persist the reset token first so the link is valid when the
      // email lands. Do NOT yet write the auth_credentials marker — if email
      // delivery fails the user must remain eligible for retry on the next run.
      await db.insert(passwordResetTokensTable).values({
        id: newId("prt"),
        userId: u.id,
        tokenHash,
        expiresAt,
      });

      // Step 2: send the email. If this throws, the credential marker is
      // never written and the candidate is naturally re-picked on a rerun.
      await sendPasswordResetEmail({
        toEmail: u.email,
        fullName: u.fullName,
        token,
        expiresAt,
      });

      // Step 3: only after the email is accepted by the SMTP server do we
      // insert the non-verifiable placeholder credential so this user is
      // excluded from future runs. Argon2.verify() will safely reject this
      // sentinel value for any user-supplied password.
      await db
        .insert(authCredentialsTable)
        .values({
          userId: u.id,
          passwordHash: "MIGRATION_PENDING_RESET",
        })
        .onConflictDoNothing();

      sent += 1;
    } catch (err) {
      failed += 1;
      console.error(`    FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`[migrate-clerk-users] done. sent=${sent} failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[migrate-clerk-users] fatal:", err);
  process.exit(1);
});

// Reference isNull so future filters can use it without a re-import lint nag.
void isNull;
