import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import express from "express";
import cookieParser from "cookie-parser";
import { db, tenantsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import adminRouter from "./admin";
import { cleanupTenants, uid } from "../__tests__/fixtures";
import { GUEST_TENANT_PREFIX } from "../lib/guestAuth";
import { signSession } from "../lib/sessionAuth";

function createAdminApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use("/api", adminRouter);
  return app;
}

const app = createAdminApp();

function sessionCookie(userId: string, tenantId: string): string {
  return `stiq_session=${signSession({ sub: userId, tid: tenantId })}`;
}

interface SeededAdminTenant {
  tenantId: string;
  userId: string;
}

async function seedAdminTenant(opts: { customBuildingTypes?: string[] } = {}): Promise<SeededAdminTenant> {
  const tenantId = `${GUEST_TENANT_PREFIX}${uid("admin-test")}`;
  const slug = uid("admin-slug");

  await db.insert(tenantsTable).values({
    id: tenantId,
    name: "Admin Test Tenant",
    slug,
    lastActiveAt: new Date(),
    settings: opts.customBuildingTypes ? { customBuildingTypes: opts.customBuildingTypes } : {},
  });

  const userId = uid("admin-user");
  await db.insert(usersTable).values({
    id: userId,
    tenantId,
    email: `${userId}@test.local`,
    role: "admin",
  });

  return { tenantId, userId };
}

const trackedTenantIds: string[] = [];
let tenant: SeededAdminTenant;
let adminCookie: string;

beforeEach(async () => {
  tenant = await seedAdminTenant();
  trackedTenantIds.push(tenant.tenantId);
  adminCookie = sessionCookie(tenant.userId, tenant.tenantId);
});

afterEach(async () => {
  await cleanupTenants([...trackedTenantIds]);
  trackedTenantIds.length = 0;
});

describe("PATCH /api/admin/tenant — customBuildingTypes case-insensitive uniqueness", () => {
  it("rejects a fresh duplicate pair in the same request (exact case)", async () => {
    const res = await request(app)
      .patch("/api/admin/tenant")
      .set("Cookie", adminCookie)
      .send({ settings: { customBuildingTypes: ["Education", "Education"] } });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unique.*case-insensitive/i);
  });

  it("rejects a case-variant duplicate in the same request", async () => {
    const res = await request(app)
      .patch("/api/admin/tenant")
      .set("Cookie", adminCookie)
      .send({ settings: { customBuildingTypes: ["Education", "education"] } });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unique.*case-insensitive/i);
  });

  it("rejects adding a case-variant of an already stored type", async () => {
    tenant = await seedAdminTenant({ customBuildingTypes: ["Education"] });
    trackedTenantIds.push(tenant.tenantId);
    adminCookie = sessionCookie(tenant.userId, tenant.tenantId);

    const res = await request(app)
      .patch("/api/admin/tenant")
      .set("Cookie", adminCookie)
      .send({ settings: { customBuildingTypes: ["Education", "education"] } });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unique.*case-insensitive/i);
  });

  it("rejects an exact-string duplicate when only one copy is stored", async () => {
    tenant = await seedAdminTenant({ customBuildingTypes: ["Education"] });
    trackedTenantIds.push(tenant.tenantId);
    adminCookie = sessionCookie(tenant.userId, tenant.tenantId);

    const res = await request(app)
      .patch("/api/admin/tenant")
      .set("Cookie", adminCookie)
      .send({ settings: { customBuildingTypes: ["Education", "Education"] } });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unique.*case-insensitive/i);
  });

  it("accepts a list with no duplicates", async () => {
    const res = await request(app)
      .patch("/api/admin/tenant")
      .set("Cookie", adminCookie)
      .send({ settings: { customBuildingTypes: ["Education", "Retail", "Healthcare"] } });

    expect(res.status).toBe(200);
    const stored = res.body.settings?.customBuildingTypes;
    expect(stored).toEqual(["Education", "Retail", "Healthcare"]);
  });

  it("allows an unrelated settings update when legacy duplicates already exist in storage", async () => {
    tenant = await seedAdminTenant({ customBuildingTypes: ["Education", "education"] });
    trackedTenantIds.push(tenant.tenantId);
    adminCookie = sessionCookie(tenant.userId, tenant.tenantId);

    const res = await request(app)
      .patch("/api/admin/tenant")
      .set("Cookie", adminCookie)
      .send({ settings: { customBuildingTypes: ["Education", "education"], aiRetryMax: 3 } });

    expect(res.status).toBe(200);
  });

  it("allows a legacy-duplicate tenant to add a new unique type", async () => {
    tenant = await seedAdminTenant({ customBuildingTypes: ["Education", "education"] });
    trackedTenantIds.push(tenant.tenantId);
    adminCookie = sessionCookie(tenant.userId, tenant.tenantId);

    const res = await request(app)
      .patch("/api/admin/tenant")
      .set("Cookie", adminCookie)
      .send({ settings: { customBuildingTypes: ["Education", "education", "Retail"] } });

    expect(res.status).toBe(200);
  });

  it("verifies stored customBuildingTypes after a successful PATCH", async () => {
    await request(app)
      .patch("/api/admin/tenant")
      .set("Cookie", adminCookie)
      .send({ settings: { customBuildingTypes: ["Retail"] } });

    const [row] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenant.tenantId));
    const settings = row.settings as Record<string, unknown>;
    expect(settings.customBuildingTypes).toEqual(["Retail"]);
  });
});

describe("GET /api/admin/users — RBAC enforcement", () => {
  it("returns 200 and the user list when the requester is an admin", async () => {
    const res = await request(app).get("/api/admin/users").set("Cookie", adminCookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    expect(res.body[0]).toMatchObject({ id: tenant.userId, tenantId: tenant.tenantId, role: "admin" });
  });

  it("returns 403 when the requester is a member (non-admin)", async () => {
    const memberId = uid("member-user");
    await db.insert(usersTable).values({
      id: memberId,
      tenantId: tenant.tenantId,
      email: `${memberId}@test.local`,
      role: "user",
    });

    const res = await request(app)
      .get("/api/admin/users")
      .set("Cookie", sessionCookie(memberId, tenant.tenantId));
    expect(res.status).toBe(403);
  });

  it("returns 401 when the requester is unauthenticated", async () => {
    const res = await request(app).get("/api/admin/users");
    expect(res.status).toBe(401);
  });
});
