/**
 * Production seed entry point — bundled by esbuild into dist/seed.mjs.
 *
 * Runs the idempotent base seed from @workspace/db (default tenant, admin user,
 * building-type profiles + lexicons, pricing + retention settings), then ensures
 * the super-admin account exists with a usable login credential, then exits.
 *
 * All steps are idempotent and safe to re-run on every deploy. The super-admin's
 * password credential is only created when one does not already exist, so a
 * later password change is never clobbered by a redeploy.
 *
 * Overridable via env: SEED_SUPER_ADMIN_ID / _EMAIL / _NAME / _PASSWORD,
 * SEED_TENANT_ID.
 */
import { eq } from "drizzle-orm";
import {
  runSeed,
  pool,
  db,
  usersTable,
  authCredentialsTable,
} from "@workspace/db";
import { hashPassword } from "./lib/sessionAuth";

const SUPER_ADMIN_ID = process.env.SEED_SUPER_ADMIN_ID ?? "usr_super_admin";
const SUPER_ADMIN_EMAIL =
  process.env.SEED_SUPER_ADMIN_EMAIL ?? "john.dowd@fastsigns.com";
const SUPER_ADMIN_NAME = process.env.SEED_SUPER_ADMIN_NAME ?? "John Dowd";
const SUPER_ADMIN_PASSWORD = process.env.SEED_SUPER_ADMIN_PASSWORD ?? "1waltham";
const SEED_TENANT_ID = process.env.SEED_TENANT_ID ?? "default";

async function seedSuperAdmin(): Promise<void> {
  // Reuse an existing row if this email is already present (under any id);
  // otherwise create the canonical super-admin user in the default tenant.
  // Either way the account ends up with the super_admin role (deterministic).
  const existing = await db
    .select({ id: usersTable.id, role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.email, SUPER_ADMIN_EMAIL))
    .limit(1);

  let userId: string;
  if (existing[0]) {
    userId = existing[0].id;
    if (existing[0].role !== "super_admin") {
      await db
        .update(usersTable)
        .set({ role: "super_admin" })
        .where(eq(usersTable.id, userId));
    }
  } else {
    userId = SUPER_ADMIN_ID;
    await db
      .insert(usersTable)
      .values({
        id: userId,
        tenantId: SEED_TENANT_ID,
        email: SUPER_ADMIN_EMAIL,
        fullName: SUPER_ADMIN_NAME,
        role: "super_admin",
      })
      // If this id somehow pre-exists, still guarantee the role invariant.
      .onConflictDoUpdate({
        target: usersTable.id,
        set: { role: "super_admin" },
      });
  }

  // Set the login credential only if one does not already exist, so a later
  // password change is never clobbered by a redeploy.
  const passwordHash = await hashPassword(SUPER_ADMIN_PASSWORD);
  await db
    .insert(authCredentialsTable)
    .values({ userId, passwordHash })
    .onConflictDoNothing({ target: authCredentialsTable.userId });

  console.log(`[seed] super-admin ensured: ${SUPER_ADMIN_EMAIL}`);
}

runSeed()
  .then(seedSuperAdmin)
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("[seed] FAILED:", err);
    try {
      await pool.end();
    } catch {
      /* noop */
    }
    process.exit(1);
  });
