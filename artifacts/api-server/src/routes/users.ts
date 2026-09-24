import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { and, eq, or, sql } from "drizzle-orm";
import {
  requireAuth,
  requireOwnerOrAbove,
  isSuperAdmin,
  normalizeRole,
} from "../lib/tenantAuth";

const router: IRouter = Router();

const ROLE_VALUES = ["super_admin", "owner", "user"] as const;
type Role = (typeof ROLE_VALUES)[number];

function parseUpdateBody(body: unknown):
  | { ok: true; data: { fullName?: string | null; role?: Role } }
  | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "Body must be an object" };
  const b = body as Record<string, unknown>;
  const out: { fullName?: string | null; role?: Role } = {};
  if (b.fullName !== undefined) {
    if (b.fullName === null) {
      out.fullName = null;
    } else {
      if (typeof b.fullName !== "string") return { ok: false, error: "fullName must be string or null" };
      const t = b.fullName.trim();
      if (t.length > 200) return { ok: false, error: "fullName too long" };
      out.fullName = t || null;
    }
  }
  if (b.role !== undefined) {
    if (typeof b.role !== "string" || !ROLE_VALUES.includes(b.role as Role)) {
      return { ok: false, error: "role must be one of super_admin, owner, user" };
    }
    out.role = b.role as Role;
  }
  return { ok: true, data: out };
}

function toApi(u: typeof usersTable.$inferSelect) {
  return {
    id: u.id,
    tenantId: u.tenantId,
    email: u.email,
    fullName: u.fullName,
    role: normalizeRole(u.role),
    ownerId: u.ownerId,
    createdAt: u.createdAt.toISOString(),
    pending: u.id.startsWith("pending_"),
  };
}

// GET /api/users — list users visible to the caller.
// - super_admin: all users across all tenants
// - owner: themselves + users they created (ownerId = self)
// - user: themselves only
router.get("/users", requireAuth, async (req, res): Promise<void> => {
  const ctx = req.auth_ctx!;
  const role = normalizeRole(ctx.role);

  let rows: (typeof usersTable.$inferSelect)[];
  if (role === "super_admin") {
    rows = await db.select().from(usersTable);
  } else if (role === "owner") {
    rows = await db
      .select()
      .from(usersTable)
      .where(
        and(
          eq(usersTable.tenantId, ctx.tenantId),
          or(eq(usersTable.ownerId, ctx.userId), eq(usersTable.id, ctx.userId)),
        ),
      );
  } else {
    rows = await db.select().from(usersTable).where(eq(usersTable.id, ctx.userId));
  }

  res.json(rows.map(toApi));
});

// POST /api/users is intentionally removed. New users are added via the
// invitation flow (see /api/invitations).
router.post("/users", requireAuth, (_req, res): void => {
  res.status(410).json({
    error: "Direct user creation has been replaced by the invitation flow. POST /api/invitations instead.",
  });
});

// PATCH /api/users/:id — update name and/or role of a user.
// Scoping:
// - super_admin: can update anyone
// - owner: can update users they created (ownerId = self) — but NOT change their role,
//   and can update their own name.
// - user: can only update their own name.
router.patch("/users/:id", requireAuth, async (req, res): Promise<void> => {
  const ctx = req.auth_ctx!;
  const callerRole = normalizeRole(ctx.role);
  const targetId = String(req.params.id);

  const parsed = parseUpdateBody(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const { fullName, role: newRole } = parsed.data;

  const [target] = await db.select().from(usersTable).where(eq(usersTable.id, targetId)).limit(1);
  if (!target) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const isSelf = target.id === ctx.userId;
  const sameTenant = target.tenantId === ctx.tenantId;
  const ownsTarget = target.ownerId === ctx.userId && sameTenant;

  // Authorization
  if (callerRole === "super_admin") {
    // allowed all
  } else if (callerRole === "owner") {
    if (!isSelf && !ownsTarget) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    if (newRole && newRole !== normalizeRole(target.role)) {
      res.status(403).json({ error: "Owners cannot change roles." });
      return;
    }
  } else {
    if (!isSelf) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    if (newRole && newRole !== normalizeRole(target.role)) {
      res.status(403).json({ error: "You cannot change your own role." });
      return;
    }
  }

  // If demoting the last super_admin, block it.
  if (
    callerRole === "super_admin" &&
    newRole &&
    newRole !== "super_admin" &&
    isSuperAdmin(target.role)
  ) {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(usersTable)
      .where(or(eq(usersTable.role, "super_admin"), eq(usersTable.role, "admin")));
    if (Number(count) <= 1) {
      res.status(400).json({ error: "Cannot demote the last super admin." });
      return;
    }
  }

  const patch: Partial<typeof usersTable.$inferInsert> = {};
  if (fullName !== undefined) patch.fullName = fullName;
  if (newRole !== undefined) patch.role = newRole;

  if (Object.keys(patch).length === 0) {
    res.json(toApi(target));
    return;
  }

  const [updated] = await db.update(usersTable).set(patch).where(eq(usersTable.id, targetId)).returning();
  res.json(toApi(updated));
});

// DELETE /api/users/:id — remove a user.
// Scoping:
// - super_admin: can delete anyone except themselves and the last super_admin
// - owner: can delete users they created (ownerId = self) — but not themselves
router.delete("/users/:id", requireAuth, requireOwnerOrAbove, async (req, res): Promise<void> => {
  const ctx = req.auth_ctx!;
  const callerRole = normalizeRole(ctx.role);
  const targetId = String(req.params.id);

  if (targetId === ctx.userId) {
    res.status(400).json({ error: "You cannot delete your own account." });
    return;
  }

  const [target] = await db.select().from(usersTable).where(eq(usersTable.id, targetId)).limit(1);
  if (!target) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  if (
    callerRole === "owner" &&
    (target.ownerId !== ctx.userId || target.tenantId !== ctx.tenantId)
  ) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  // Never allow deleting the last super_admin.
  if (isSuperAdmin(target.role)) {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(usersTable)
      .where(or(eq(usersTable.role, "super_admin"), eq(usersTable.role, "admin")));
    if (Number(count) <= 1) {
      res.status(400).json({ error: "Cannot delete the last super admin." });
      return;
    }
  }

  await db.delete(usersTable).where(eq(usersTable.id, targetId));
  res.status(204).end();
});

export default router;
