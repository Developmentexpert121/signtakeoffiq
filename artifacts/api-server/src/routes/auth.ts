import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  tenantsTable,
  usersTable,
  authCredentialsTable,
  passwordResetTokensTable,
  invitationsTable,
} from "@workspace/db";
import { and, eq, isNull, gt } from "drizzle-orm";
import {
  hashPassword,
  verifyPassword,
  signSession,
  setSessionCookie,
  clearSessionCookie,
  readSessionCookie,
  verifySession,
  newId,
  genResetToken,
  hashResetToken,
  validatePassword,
} from "../lib/sessionAuth";
import { newGuestId, signGuestToken } from "../lib/guestAuth";
import { sendPasswordResetEmail } from "../lib/email";
import { normalizeRole, isOwnerOrAbove, type Role } from "../lib/tenantAuth";
import crypto from "node:crypto";

function hashInviteToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

const router: IRouter = Router();

const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

function cleanEmail(s: unknown): string {
  return typeof s === "string" ? s.trim().toLowerCase() : "";
}

// POST /api/auth/sign-up
// Invite-only: requires a valid invitation token. There is no public self-serve
// sign-up. This endpoint mirrors POST /api/invitations/accept/:token but is
// exposed under /auth/sign-up so the auth surface is complete.
router.post("/auth/sign-up", async (req, res): Promise<void> => {
  const token = typeof req.body?.invitationToken === "string" ? req.body.invitationToken : "";
  const fullName = typeof req.body?.fullName === "string" ? req.body.fullName.trim() : "";
  const pw = validatePassword(req.body?.password);
  if (!token) {
    res.status(400).json({ error: "An invitation token is required. Public sign-up is disabled." });
    return;
  }
  if (!pw.ok) {
    res.status(400).json({ error: pw.error });
    return;
  }

  const tokenHash = hashInviteToken(token);
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

  const [existing] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, inv.email))
    .limit(1);
  if (existing && !existing.id.startsWith("pending_")) {
    res.status(409).json({ error: "An account with this email already exists. Please sign in." });
    return;
  }

  const targetRole: Role = normalizeRole(inv.role);
  const ownerId = isOwnerOrAbove(inv.role) ? null : inv.createdByUserId;
  const newUserId = newId("usr");
  const passwordHash = await hashPassword(pw.value);

  let createdUserId: string;
  try {
    createdUserId = await db.transaction(async (tx) => {
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

      if (claimed.length === 0) throw new Error("INVITATION_RACE");

      if (existing && existing.id.startsWith("pending_")) {
        await tx.delete(usersTable).where(eq(usersTable.id, existing.id));
      }

      await tx.insert(usersTable).values({
        id: newUserId,
        tenantId: inv.tenantId,
        email: inv.email,
        fullName: fullName || null,
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
    res.status(500).json({ error: err instanceof Error ? err.message : "Sign-up failed" });
    return;
  }

  const sessionToken = signSession({ sub: createdUserId, tid: inv.tenantId });
  setSessionCookie(res, sessionToken);

  res.status(201).json({
    ok: true,
    user: {
      id: createdUserId,
      tenantId: inv.tenantId,
      email: inv.email,
      fullName: fullName || null,
      role: targetRole,
    },
  });
});

// POST /api/auth/sign-in
router.post("/auth/sign-in", async (req, res): Promise<void> => {
  const email = cleanEmail(req.body?.email);
  const password = req.body?.password;
  if (!email || typeof password !== "string" || password.length === 0) {
    res.status(400).json({ error: "Email and password are required." });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
  if (!user || user.id.startsWith("pending_") || user.deletedAt) {
    res.status(401).json({ error: "Invalid email or password." });
    return;
  }

  const [cred] = await db
    .select()
    .from(authCredentialsTable)
    .where(eq(authCredentialsTable.userId, user.id))
    .limit(1);

  if (!cred) {
    res.status(401).json({
      error: "This account has no password set. Please use 'Forgot password' to set one.",
    });
    return;
  }

  const ok = await verifyPassword(password, cred.passwordHash);
  if (!ok) {
    res.status(401).json({ error: "Invalid email or password." });
    return;
  }

  const token = signSession({ sub: user.id, tid: user.tenantId });
  setSessionCookie(res, token);

  res.json({
    user: {
      id: user.id,
      tenantId: user.tenantId,
      email: user.email,
      fullName: user.fullName,
      role: normalizeRole(user.role),
    },
  });
});

// POST /api/auth/sign-out
router.post("/auth/sign-out", async (_req, res): Promise<void> => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// GET /api/auth/me — returns the signed-in user (or 401)
router.get("/auth/me", async (req, res): Promise<void> => {
  const token = readSessionCookie(req);
  const session = token ? verifySession(token) : null;
  if (!session) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, session.sub))
    .limit(1);
  if (!user || user.deletedAt) {
    clearSessionCookie(res);
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  res.json({
    user: {
      id: user.id,
      tenantId: user.tenantId,
      email: user.email,
      fullName: user.fullName,
      role: normalizeRole(user.role),
    },
  });
});

// POST /api/auth/forgot-password
// Always returns { ok: true } to avoid email enumeration.
router.post("/auth/forgot-password", async (req, res): Promise<void> => {
  const email = cleanEmail(req.body?.email);
  if (!email) {
    res.json({ ok: true });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
  if (!user || user.id.startsWith("pending_") || user.role === "guest" || user.deletedAt) {
    res.json({ ok: true });
    return;
  }

  const token = genResetToken();
  const tokenHash = hashResetToken(token);
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);

  await db.insert(passwordResetTokensTable).values({
    id: newId("prt"),
    userId: user.id,
    tokenHash,
    expiresAt,
  });

  try {
    await sendPasswordResetEmail({
      toEmail: user.email,
      fullName: user.fullName,
      token,
      expiresAt,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to send password reset email");
    // Still return ok so we don't leak which addresses are real.
  }

  res.json({ ok: true });
});

// GET /api/auth/reset-password/:token — validate token (for UI)
router.get("/auth/reset-password/:token", async (req, res): Promise<void> => {
  const token = String(req.params.token || "");
  if (!token) {
    res.status(400).json({ error: "Missing token." });
    return;
  }
  const [row] = await db
    .select()
    .from(passwordResetTokensTable)
    .where(eq(passwordResetTokensTable.tokenHash, hashResetToken(token)))
    .limit(1);
  if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) {
    res.status(410).json({ error: "This password reset link is no longer valid." });
    return;
  }
  const [user] = await db
    .select({ email: usersTable.email, deletedAt: usersTable.deletedAt })
    .from(usersTable)
    .where(eq(usersTable.id, row.userId))
    .limit(1);
  if (!user || user.deletedAt) {
    res.status(410).json({ error: "This password reset link is no longer valid." });
    return;
  }
  res.json({ email: user.email });
});

// POST /api/auth/reset-password/:token
router.post("/auth/reset-password/:token", async (req, res): Promise<void> => {
  const token = String(req.params.token || "");
  const pw = validatePassword(req.body?.password);
  if (!pw.ok) {
    res.status(400).json({ error: pw.error });
    return;
  }
  const tokenHash = hashResetToken(token);

  const [row] = await db
    .select()
    .from(passwordResetTokensTable)
    .where(eq(passwordResetTokensTable.tokenHash, tokenHash))
    .limit(1);

  if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) {
    res.status(410).json({ error: "This password reset link is no longer valid." });
    return;
  }

  // Reject archived (soft-deleted) users even if they hold a token minted
  // before they were archived — they must not be able to reset or get a session.
  const [resetTarget] = await db
    .select({ deletedAt: usersTable.deletedAt })
    .from(usersTable)
    .where(eq(usersTable.id, row.userId))
    .limit(1);
  if (!resetTarget || resetTarget.deletedAt) {
    res.status(410).json({ error: "This password reset link is no longer valid." });
    return;
  }

  const passwordHash = await hashPassword(pw.value);

  await db.transaction(async (tx) => {
    // Atomically mark token used (single-use).
    const claimed = await tx
      .update(passwordResetTokensTable)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(passwordResetTokensTable.id, row.id),
          isNull(passwordResetTokensTable.usedAt),
          gt(passwordResetTokensTable.expiresAt, new Date()),
        ),
      )
      .returning({ id: passwordResetTokensTable.id });

    if (claimed.length === 0) {
      throw new Error("RESET_RACE");
    }

    await tx
      .insert(authCredentialsTable)
      .values({ userId: row.userId, passwordHash })
      .onConflictDoUpdate({
        target: authCredentialsTable.userId,
        set: { passwordHash, updatedAt: new Date() },
      });
  });

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, row.userId)).limit(1);
  if (user) {
    const sessionToken = signSession({ sub: user.id, tid: user.tenantId });
    setSessionCookie(res, sessionToken);
    res.json({
      ok: true,
      user: {
        id: user.id,
        tenantId: user.tenantId,
        email: user.email,
        fullName: user.fullName,
        role: normalizeRole(user.role),
      },
    });
    return;
  }

  res.json({ ok: true });
});

// POST /api/auth/guest — unchanged (creates a guest tenant + Bearer token)
router.post("/auth/guest", async (_req, res): Promise<void> => {
  const guestUserId = newGuestId();
  const guestTenantId = `tenant_${guestUserId}`;
  const slug = `guest_${guestUserId}_${Date.now().toString(36)}`;

  await db
    .insert(tenantsTable)
    .values({
      id: guestTenantId,
      name: "Guest",
      slug,
      plan: "starter",
      settings: {},
    })
    .onConflictDoNothing();

  await db
    .insert(usersTable)
    .values({
      id: guestUserId,
      tenantId: guestTenantId,
      email: `${guestUserId}@guest.local`,
      fullName: "Guest",
      role: "guest",
    })
    .onConflictDoNothing();

  const token = signGuestToken(guestUserId, guestTenantId);

  res.json({ token });
});

export default router;
