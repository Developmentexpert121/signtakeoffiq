import { Router } from "express";
import { db, invitationsTable, usersTable, tenantsTable, authCredentialsTable } from "@workspace/db";
import { and, desc, eq, isNull, gt } from "drizzle-orm";
import crypto from "node:crypto";
import {
  requireAuth,
  requireOwnerOrAbove,
  normalizeRole,
  isSuperAdmin,
  isOwnerOrAbove,
  type Role,
} from "../lib/tenantAuth";
import { sendInvitationEmail } from "../lib/email";
import {
  hashPassword,
  signSession,
  setSessionCookie,
  validatePassword,
  newId,
} from "../lib/sessionAuth";

const router = Router();

const ROLE_LABEL: Record<Role, string> = {
  super_admin: "Super Admin",
  owner: "Owner",
  user: "User",
  guest: "Guest",
};

function toApi(inv: typeof invitationsTable.$inferSelect) {
  return {
    id: inv.id,
    email: inv.email,
    role: inv.role,
    expiresAt: inv.expiresAt.toISOString(),
    createdAt: inv.createdAt.toISOString(),
    createdByName: inv.createdByName,
    acceptedAt: inv.acceptedAt?.toISOString() ?? null,
  };
}

function genToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function genInvId(): string {
  return `inv_${crypto.randomBytes(8).toString("hex")}`;
}

function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at < 1) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const visible = local.slice(0, 1);
  return `${visible}${"*".repeat(Math.max(1, local.length - 1))}@${domain}`;
}

// POST /api/invitations — create + send invitation email
router.post("/invitations", requireAuth, requireOwnerOrAbove, async (req, res): Promise<void> => {
  const ctx = req.auth_ctx!;
  const callerRole = normalizeRole(ctx.role);
  const { email, role } = req.body ?? {};

  const cleanEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!cleanEmail || !cleanEmail.includes("@")) {
    res.status(400).json({ error: "Valid email is required" });
    return;
  }

  const targetRole = normalizeRole(role);
  if (targetRole === "guest") {
    res.status(400).json({ error: "Cannot invite guests" });
    return;
  }
  if (!isSuperAdmin(callerRole) && targetRole !== "user") {
    res.status(403).json({ error: "Only Super Admins can invite Super Admins or Owners" });
    return;
  }

  const [existingUser] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, cleanEmail))
    .limit(1);
  if (existingUser && !existingUser.id.startsWith("pending_")) {
    res.status(409).json({ error: "A user with that email already exists" });
    return;
  }

  // Revoke any prior pending invites for the same email in this tenant.
  await db
    .update(invitationsTable)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(invitationsTable.email, cleanEmail),
        eq(invitationsTable.tenantId, ctx.tenantId),
        isNull(invitationsTable.acceptedAt),
        isNull(invitationsTable.revokedAt),
      ),
    );

  const [creator] = await db.select().from(usersTable).where(eq(usersTable.id, ctx.userId)).limit(1);
  const inviterName = creator?.fullName || creator?.email || "A teammate";
  const inviterEmail = creator?.email || "";

  const token = genToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const [created] = await db
    .insert(invitationsTable)
    .values({
      id: genInvId(),
      tenantId: ctx.tenantId,
      email: cleanEmail,
      role: targetRole,
      tokenHash,
      createdByUserId: ctx.userId,
      createdByName: inviterName,
      expiresAt,
    })
    .returning();

  try {
    await sendInvitationEmail({
      toEmail: cleanEmail,
      inviterName,
      inviterEmail,
      roleLabel: ROLE_LABEL[targetRole],
      token,
      expiresAt,
    });
  } catch (err) {
    await db.delete(invitationsTable).where(eq(invitationsTable.id, created.id));
    const message = err instanceof Error ? err.message : "Failed to send invitation email";
    res.status(502).json({ error: message });
    return;
  }

  res.status(201).json(toApi(created));
});

// GET /api/invitations — list pending invitations
router.get("/invitations", requireAuth, requireOwnerOrAbove, async (req, res): Promise<void> => {
  const ctx = req.auth_ctx!;
  const callerRole = normalizeRole(ctx.role);

  const baseFilters = [
    isNull(invitationsTable.acceptedAt),
    isNull(invitationsTable.revokedAt),
    gt(invitationsTable.expiresAt, new Date()),
  ];

  const where = isSuperAdmin(callerRole)
    ? and(...baseFilters)
    : and(eq(invitationsTable.tenantId, ctx.tenantId), ...baseFilters);

  const rows = await db
    .select()
    .from(invitationsTable)
    .where(where)
    .orderBy(desc(invitationsTable.createdAt));

  res.json(rows.map(toApi));
});

// DELETE /api/invitations/:id — revoke
router.delete("/invitations/:id", requireAuth, requireOwnerOrAbove, async (req, res): Promise<void> => {
  const ctx = req.auth_ctx!;
  const callerRole = normalizeRole(ctx.role);
  const id = String(req.params.id);

  const [inv] = await db.select().from(invitationsTable).where(eq(invitationsTable.id, id)).limit(1);
  if (!inv) {
    res.status(404).json({ error: "Invitation not found" });
    return;
  }
  if (!isSuperAdmin(callerRole) && inv.tenantId !== ctx.tenantId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  await db
    .update(invitationsTable)
    .set({ revokedAt: new Date() })
    .where(eq(invitationsTable.id, id));

  res.status(204).end();
});

// GET /api/invitations/by-token/:token — PUBLIC: validate token for accept page
router.get("/invitations/by-token/:token", async (req, res): Promise<void> => {
  const token = String(req.params.token);
  const tokenHash = hashToken(token);
  const [inv] = await db
    .select()
    .from(invitationsTable)
    .where(eq(invitationsTable.tokenHash, tokenHash))
    .limit(1);

  if (!inv) {
    res.status(404).json({ error: "Invitation not found" });
    return;
  }
  if (inv.revokedAt) {
    res.status(410).json({ error: "This invitation has been revoked" });
    return;
  }
  if (inv.acceptedAt) {
    res.status(410).json({ error: "This invitation has already been accepted" });
    return;
  }
  if (inv.expiresAt.getTime() < Date.now()) {
    res.status(410).json({ error: "This invitation has expired" });
    return;
  }

  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, inv.tenantId)).limit(1);

  res.json({
    emailMasked: maskEmail(inv.email),
    role: inv.role,
    roleLabel: ROLE_LABEL[normalizeRole(inv.role)],
    inviterName: inv.createdByName,
    tenantName: tenant?.name ?? "Sign Takeoff IQ",
    expiresAt: inv.expiresAt.toISOString(),
  });
});

// POST /api/invitations/accept/:token — PUBLIC
// Creates the user + auth credential locally, marks the invitation accepted,
// and signs the new user in via session cookie.
router.post("/invitations/accept/:token", async (req, res): Promise<void> => {
  const token = String(req.params.token);
  const tokenHash = hashToken(token);
  const { fullName } = req.body ?? {};
  const pw = validatePassword(req.body?.password);
  if (!pw.ok) {
    res.status(400).json({ error: pw.error });
    return;
  }

  const [inv] = await db
    .select()
    .from(invitationsTable)
    .where(eq(invitationsTable.tokenHash, tokenHash))
    .limit(1);

  if (!inv) {
    res.status(404).json({ error: "Invitation not found" });
    return;
  }
  if (inv.revokedAt || inv.acceptedAt || inv.expiresAt.getTime() < Date.now()) {
    res.status(410).json({ error: "This invitation is no longer valid" });
    return;
  }

  const [existing] = await db.select().from(usersTable).where(eq(usersTable.email, inv.email)).limit(1);
  if (existing && !existing.id.startsWith("pending_")) {
    res.status(409).json({ error: "An account with this email already exists. Please sign in." });
    return;
  }

  const cleanName = typeof fullName === "string" ? fullName.trim() : "";
  const targetRole = normalizeRole(inv.role);
  const ownerId = isOwnerOrAbove(inv.role) ? null : inv.createdByUserId;
  const newUserId = newId("usr");
  const passwordHash = await hashPassword(pw.value);

  let createdUserId: string;
  try {
    createdUserId = await db.transaction(async (tx) => {
      // Conditional claim of the invitation.
      const claimed = await tx
        .update(invitationsTable)
        .set({ acceptedAt: new Date() })
        .where(
          and(
            eq(invitationsTable.id, inv.id),
            isNull(invitationsTable.acceptedAt),
            isNull(invitationsTable.revokedAt),
            gt(invitationsTable.expiresAt, new Date()),
          ),
        )
        .returning({ id: invitationsTable.id });

      if (claimed.length === 0) {
        throw new Error("INVITATION_RACE");
      }

      // Replace any pre-created "pending_" placeholder row.
      if (existing && existing.id.startsWith("pending_")) {
        await tx.delete(usersTable).where(eq(usersTable.id, existing.id));
      }

      await tx.insert(usersTable).values({
        id: newUserId,
        tenantId: inv.tenantId,
        email: inv.email,
        fullName: cleanName || null,
        role: targetRole,
        ownerId,
      });

      await tx.insert(authCredentialsTable).values({
        userId: newUserId,
        passwordHash,
      });

      return newUserId;
    });
  } catch (err) {
    if (err instanceof Error && err.message === "INVITATION_RACE") {
      res.status(410).json({ error: "This invitation is no longer valid" });
      return;
    }
    const message = err instanceof Error ? err.message : "Failed to accept invitation";
    req.log.error({ err }, "Failed to accept invitation");
    res.status(500).json({ error: message });
    return;
  }

  const sessionToken = signSession({ sub: createdUserId, tid: inv.tenantId });
  setSessionCookie(res, sessionToken);

  res.json({
    ok: true,
    user: {
      id: createdUserId,
      tenantId: inv.tenantId,
      email: inv.email,
      fullName: cleanName || null,
      role: targetRole,
    },
  });
});

export default router;
