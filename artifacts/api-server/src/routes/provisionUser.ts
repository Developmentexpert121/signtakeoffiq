import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { usersTable, tenantsTable, authCredentialsTable } from "@workspace/db";
import { and, eq, ne, sql } from "drizzle-orm";
import crypto from "node:crypto";
import { hashPassword, newId } from "../lib/sessionAuth";
import { normalizeRole } from "../lib/tenantAuth";

const router: IRouter = Router();

/**
 * Constant-time comparison of the incoming X-App-Secret against the configured
 * SIGNSUITE_SSO_SECRET. Both sides are hashed to a fixed length first so that
 * timingSafeEqual never sees mismatched buffer lengths (which would otherwise
 * throw and leak length information).
 */
function secretMatches(provided: string, expected: string): boolean {
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function asNullableString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function cleanEmail(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim().toLowerCase() : null;
}

function asExternalId(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

interface TenantInput {
  external_id?: unknown;
  name?: unknown;
  slug?: unknown;
  email?: unknown;
  phone?: unknown;
  website?: unknown;
}

/**
 * Upsert the tenant referenced by the webhook payload. Matches an existing
 * tenant by signsuiteiq_company_id (preferred) then slug, keeping the local id
 * stable. Returns the local tenant id to link the user to.
 */
async function upsertTenant(tenant: TenantInput): Promise<string> {
  const companyId = asExternalId(tenant.external_id);
  const slug = asString(tenant.slug);
  const name = asString(tenant.name) ?? "Untitled Company";
  const tenantFields = {
    name,
    email: asNullableString(tenant.email),
    phone: asNullableString(tenant.phone),
    website: asNullableString(tenant.website),
    ...(companyId !== null ? { signsuiteiqCompanyId: companyId } : {}),
  };

  let existing: { id: string } | undefined;
  if (companyId !== null) {
    [existing] = await db
      .select({ id: tenantsTable.id })
      .from(tenantsTable)
      .where(eq(tenantsTable.signsuiteiqCompanyId, companyId))
      .limit(1);
  }
  if (!existing && slug) {
    [existing] = await db
      .select({ id: tenantsTable.id })
      .from(tenantsTable)
      .where(eq(tenantsTable.slug, slug))
      .limit(1);
  }

  if (existing) {
    await db.update(tenantsTable).set(tenantFields).where(eq(tenantsTable.id, existing.id));
    return existing.id;
  }

  const id = newId("ten");
  await db.insert(tenantsTable).values({
    id,
    slug: slug ?? `tenant-${id}`,
    ...tenantFields,
  });
  return id;
}

/** Create a standalone personal tenant for a provisioned user that has no company. */
async function createPersonalTenant(name: string): Promise<string> {
  const id = newId("ten");
  await db.insert(tenantsTable).values({
    id,
    name,
    slug: `personal-${id}`,
  });
  return id;
}

/** Find a free username by appending 1, 2, 3… to the requested base if taken. */
async function findFreeUsername(base: string, excludeUserId?: string): Promise<string> {
  let candidate = base;
  let suffix = 1;
  // Webhook calls are serialized with retries, so contention is low.
  for (;;) {
    const clash = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(
        excludeUserId
          ? and(eq(usersTable.username, candidate), ne(usersTable.id, excludeUserId))
          : eq(usersTable.username, candidate),
      )
      .limit(1);
    if (clash.length === 0) return candidate;
    candidate = `${base}${suffix}`;
    suffix += 1;
  }
}

function unusableHash(): string {
  return `!unusable!${crypto.randomBytes(24).toString("hex")}`;
}

// POST /api/internal/provision-user
// Webhook called by SignSuiteIQ whenever a user is created / updated /
// password-changed / archived so this app's users table stays in lock-step.
router.post("/internal/provision-user", async (req, res): Promise<void> => {
  // 1) Authenticate with the shared app secret (constant-time).
  const expected = process.env.SIGNSUITE_SSO_SECRET;
  if (!expected || expected.length === 0) {
    req.log.error("[Provision] SIGNSUITE_SSO_SECRET is not configured");
    res.status(500).json({ error: "internal error" });
    return;
  }
  const provided = req.header("x-app-secret");
  if (!provided || !secretMatches(provided, expected)) {
    res.status(401).json({ error: "invalid app secret" });
    return;
  }

  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const action = body.action === "delete" ? "delete" : body.action === "upsert" ? "upsert" : null;
    if (!action) {
      res.status(400).json({ error: "action must be 'upsert' or 'delete'" });
      return;
    }

    const email = cleanEmail(body.email);
    const externalId = asExternalId(body.external_id);
    if (!email && externalId === null) {
      res.status(400).json({ error: "email or external_id is required" });
      return;
    }

    // 2) Look up the existing row: first by email (case-insensitive), then by
    //    signsuiteiq_user_id (covers the case where the user changed their email).
    let existing: typeof usersTable.$inferSelect | undefined;
    if (email) {
      [existing] = await db
        .select()
        .from(usersTable)
        .where(sql`lower(${usersTable.email}) = ${email}`)
        .limit(1);
    }
    if (!existing && externalId !== null) {
      [existing] = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.signsuiteiqUserId, externalId))
        .limit(1);
    }

    // 2b) Guard against mismatched records: if the row we matched by email is
    //     not the row that owns this external_id, the request describes two
    //     distinct people. Mutating the email-matched row here would silently
    //     re-point its signsuiteiq_user_id and re-link them. Refuse loudly so
    //     the caller can retry/escalate, and leave both rows untouched.
    if (existing && externalId !== null && existing.signsuiteiqUserId !== externalId) {
      const [externalMatch] = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(eq(usersTable.signsuiteiqUserId, externalId))
        .limit(1);
      if (externalMatch && externalMatch.id !== existing.id) {
        req.log.error(
          {
            email,
            externalId,
            emailUserId: existing.id,
            externalIdUserId: externalMatch.id,
          },
          "[Provision] Conflict: email and external_id resolve to different users",
        );
        res.status(409).json({ error: "email and external_id resolve to different users" });
        return;
      }
    }

    // 3) Delete → soft-delete only. An already-archived row is treated as a miss
    //    so repeated delete calls are idempotent.
    if (action === "delete") {
      if (!existing || existing.deletedAt) {
        req.log.info({ email, externalId }, "[Provision] delete miss — no active matching user");
        res.json({ ok: true, ignored: true });
        return;
      }
      await db
        .update(usersTable)
        .set({ deletedAt: new Date() })
        .where(eq(usersTable.id, existing.id));
      res.json({ ok: true, user_id: existing.id, action: "delete" });
      return;
    }

    // 4) Upsert. For an upsert we require an email so the row is usable for login.
    if (!email) {
      res.status(400).json({ error: "email is required for upsert" });
      return;
    }

    const password = typeof body.password === "string" && body.password.length > 0 ? body.password : null;
    const tenantInput = (body.tenant && typeof body.tenant === "object" ? body.tenant : null) as TenantInput | null;

    if (existing) {
      // Resolve username collision-safely: only adopt the new username if it is
      // free (ignoring this same row).
      let username = existing.username;
      const requestedUsername = asString(body.username);
      if (requestedUsername && requestedUsername !== existing.username) {
        const [clash] = await db
          .select({ id: usersTable.id })
          .from(usersTable)
          .where(and(eq(usersTable.username, requestedUsername), ne(usersTable.id, existing.id)))
          .limit(1);
        if (!clash) username = requestedUsername;
      }

      const updates: Partial<typeof usersTable.$inferInsert> = {
        email,
        username,
        deletedAt: null, // re-activate an archived user
      };
      if ("name" in body) updates.fullName = asNullableString(body.name);
      if ("role" in body) updates.role = normalizeRole(asString(body.role));
      if ("phone" in body) updates.phone = asNullableString(body.phone);
      if ("job_title" in body) updates.jobTitle = asNullableString(body.job_title);
      if ("location" in body) updates.location = asNullableString(body.location);
      if (externalId !== null) updates.signsuiteiqUserId = externalId;
      if (tenantInput) updates.tenantId = await upsertTenant(tenantInput);

      await db.update(usersTable).set(updates).where(eq(usersTable.id, existing.id));

      if (password) {
        const passwordHash = await hashPassword(password);
        await db
          .insert(authCredentialsTable)
          .values({ userId: existing.id, passwordHash })
          .onConflictDoUpdate({
            target: authCredentialsTable.userId,
            set: { passwordHash, updatedAt: new Date() },
          });
      }

      res.json({ ok: true, user_id: existing.id, action: "upsert" });
      return;
    }

    // 5) Brand-new user.
    const name = asNullableString(body.name);
    const baseUsername = asString(body.username) ?? email.split("@")[0];
    const finalUsername = await findFreeUsername(baseUsername);
    const tenantId = tenantInput ? await upsertTenant(tenantInput) : await createPersonalTenant(name ?? email);
    const userId = newId("usr");
    const passwordHash = password ? await hashPassword(password) : unusableHash();

    await db.transaction(async (tx) => {
      await tx.insert(usersTable).values({
        id: userId,
        tenantId,
        email,
        username: finalUsername,
        fullName: name,
        role: normalizeRole(asString(body.role)),
        phone: asNullableString(body.phone),
        jobTitle: asNullableString(body.job_title),
        location: asNullableString(body.location),
        signsuiteiqUserId: externalId ?? undefined,
      });
      await tx.insert(authCredentialsTable).values({ userId, passwordHash });
    });

    res.json({ ok: true, user_id: userId, action: "upsert" });
  } catch (err) {
    // Deliberately generic so SignSuite retries with backoff and we don't leak
    // schema details over the wire. Real error is logged for our own debugging.
    req.log.error({ err }, "[Provision] Error: failed to provision user");
    res.status(500).json({ error: "internal error" });
  }
});

export default router;
