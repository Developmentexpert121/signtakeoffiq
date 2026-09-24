import { type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import { tenantsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { verifyGuestToken } from "./guestAuth";
import { readSessionCookie, verifySessionFull, maybeRefreshSession } from "./sessionAuth";

export interface AuthContext {
  userId: string;
  tenantId: string;
  role: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth_ctx?: AuthContext;
    }
  }
}

const DEV_BYPASS_USER_ID = "dev_bypass_user";
const DEV_BYPASS_TENANT_ID = "dev_bypass_tenant";

// Canonical roles. Legacy "admin" => "super_admin"; legacy "member" => "user".
export type Role = "super_admin" | "owner" | "user" | "guest";

export function normalizeRole(role: string | null | undefined): Role {
  if (!role) return "user";
  if (role === "admin" || role === "super_admin") return "super_admin";
  if (role === "owner") return "owner";
  if (role === "guest") return "guest";
  return "user";
}

export function isSuperAdmin(role: string | null | undefined): boolean {
  return normalizeRole(role) === "super_admin";
}

export function isOwner(role: string | null | undefined): boolean {
  return normalizeRole(role) === "owner";
}

export function isOwnerOrAbove(role: string | null | undefined): boolean {
  const r = normalizeRole(role);
  return r === "super_admin" || r === "owner";
}

async function ensureDevBypassUser(): Promise<AuthContext> {
  await db
    .insert(tenantsTable)
    .values({
      id: DEV_BYPASS_TENANT_ID,
      name: "Dev Bypass Tenant",
      slug: "dev-bypass",
      plan: "starter",
      settings: {},
    })
    .onConflictDoNothing();

  await db
    .insert(usersTable)
    .values({
      id: DEV_BYPASS_USER_ID,
      tenantId: DEV_BYPASS_TENANT_ID,
      email: "dev@local",
      fullName: "Dev Admin",
      role: "super_admin",
    })
    .onConflictDoNothing();

  return { userId: DEV_BYPASS_USER_ID, tenantId: DEV_BYPASS_TENANT_ID, role: "super_admin" };
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (process.env.DEV_BYPASS_AUTH === "true" && process.env.NODE_ENV !== "test") {
    req.auth_ctx = await ensureDevBypassUser();
    next();
    return;
  }

  // 1) Guest Bearer token path (unchanged from prior implementation).
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const guest = verifyGuestToken(token);
    if (guest) {
      const [guestUser] = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, guest.sub))
        .limit(1);

      if (!guestUser || guestUser.tenantId !== guest.tenantId) {
        res.status(401).json({ error: "Invalid guest session" });
        return;
      }

      req.auth_ctx = {
        userId: guestUser.id,
        tenantId: guestUser.tenantId,
        role: guestUser.role,
      };

      touchGuestLastActive(guestUser.tenantId, "guest").catch(() => {});

      next();
      return;
    }
  }

  // 2) Native session cookie path (replaces Clerk).
  const sessionToken = readSessionCookie(req);
  if (!sessionToken) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const session = verifySessionFull(sessionToken);
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
    res.status(401).json({ error: "Session user not found." });
    return;
  }

  // Enforce tenant-claim consistency.
  if (session.tid !== user.tenantId) {
    res.status(401).json({ error: "Session tenant mismatch." });
    return;
  }

  // Sliding refresh: re-issue cookie when nearing expiry.
  maybeRefreshSession(res, session);

  req.auth_ctx = {
    userId: user.id,
    tenantId: user.tenantId,
    role: user.role,
  };

  next();
}

export async function touchGuestLastActive(tenantId: string, role: string): Promise<void> {
  if (role !== "guest") return;
  await db
    .update(tenantsTable)
    .set({ lastActiveAt: new Date() })
    .where(eq(tenantsTable.id, tenantId));
}

// Legacy: treat "admin" as "owner or above".
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth_ctx || !isOwnerOrAbove(req.auth_ctx.role)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
}

export function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth_ctx || !isSuperAdmin(req.auth_ctx.role)) {
    res.status(403).json({ error: "Super admin access required" });
    return;
  }
  next();
}

export function requireOwnerOrAbove(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth_ctx || !isOwnerOrAbove(req.auth_ctx.role)) {
    res.status(403).json({ error: "Owner or super admin access required" });
    return;
  }
  next();
}
