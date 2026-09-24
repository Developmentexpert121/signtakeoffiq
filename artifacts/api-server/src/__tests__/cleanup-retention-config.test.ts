/**
 * Unit tests for PATCH /api/admin/config — the cleanup retention config endpoint.
 *
 * Covers:
 *  - Valid updates to cleanupHistoryMaxAgeDays and cleanupHistoryMaxRows
 *  - Invalid values (0, negative, above max, non-integer)
 *  - Non-admin access rejected with 403
 *  - Unauthenticated access rejected with 401
 *  - In-memory getter values are actually updated after a valid PATCH
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import express from "express";
import cookieParser from "cookie-parser";
import { db, tenantsTable, usersTable } from "@workspace/db";
import adminRouter from "../routes/admin";
import { cleanupTenants, uid, seedRegularTenant } from "./fixtures";
import { GUEST_TENANT_PREFIX } from "../lib/guestAuth";
import { signSession } from "../lib/sessionAuth";
import {
  getCleanupHistoryMaxAgeDays,
  getCleanupHistoryMaxRows,
  setCleanupHistoryMaxAgeDays,
  setCleanupHistoryMaxRows,
} from "../lib/guestCleanup";

function createApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use("/api", adminRouter);
  return app;
}

const app = createApp();

function sessionCookie(userId: string, tenantId: string): string {
  return `stiq_session=${signSession({ sub: userId, tid: tenantId })}`;
}

interface SeededAdminTenant {
  tenantId: string;
  userId: string;
}

async function seedAdminTenant(): Promise<SeededAdminTenant> {
  const tenantId = `${GUEST_TENANT_PREFIX}${uid("config-admin")}`;
  const slug = uid("config-slug");

  await db.insert(tenantsTable).values({
    id: tenantId,
    name: "Config Admin Tenant",
    slug,
    lastActiveAt: new Date(),
    settings: {},
  });

  const userId = uid("config-user");
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
let savedMaxAgeDays: number;
let savedMaxRows: number;

beforeEach(async () => {
  savedMaxAgeDays = getCleanupHistoryMaxAgeDays();
  savedMaxRows = getCleanupHistoryMaxRows();

  tenant = await seedAdminTenant();
  trackedTenantIds.push(tenant.tenantId);
  adminCookie = sessionCookie(tenant.userId, tenant.tenantId);
});

afterEach(async () => {
  setCleanupHistoryMaxAgeDays(savedMaxAgeDays);
  setCleanupHistoryMaxRows(savedMaxRows);
  await cleanupTenants([...trackedTenantIds]);
  trackedTenantIds.length = 0;
});

// ---------------------------------------------------------------------------
// Valid updates — cleanupHistoryMaxAgeDays
// ---------------------------------------------------------------------------

describe("PATCH /api/admin/config — valid cleanupHistoryMaxAgeDays updates", () => {
  it("accepts a typical valid value and returns 200 with it reflected in the response", async () => {
    const res = await request(app)
      .patch("/api/admin/config")
      .set("Cookie", adminCookie)
      .send({ cleanupHistoryMaxAgeDays: 30 });

    expect(res.status).toBe(200);
    expect(res.body.cleanupHistoryMaxAgeDays).toBe(30);
  });

  it("accepts the minimum valid value of 1", async () => {
    const res = await request(app)
      .patch("/api/admin/config")
      .set("Cookie", adminCookie)
      .send({ cleanupHistoryMaxAgeDays: 1 });

    expect(res.status).toBe(200);
    expect(res.body.cleanupHistoryMaxAgeDays).toBe(1);
  });

  it("accepts the maximum valid value of 3650", async () => {
    const res = await request(app)
      .patch("/api/admin/config")
      .set("Cookie", adminCookie)
      .send({ cleanupHistoryMaxAgeDays: 3650 });

    expect(res.status).toBe(200);
    expect(res.body.cleanupHistoryMaxAgeDays).toBe(3650);
  });

  it("actually updates the in-memory getter after a valid PATCH", async () => {
    await request(app)
      .patch("/api/admin/config")
      .set("Cookie", adminCookie)
      .send({ cleanupHistoryMaxAgeDays: 45 });

    expect(getCleanupHistoryMaxAgeDays()).toBe(45);
  });
});

// ---------------------------------------------------------------------------
// Valid updates — cleanupHistoryMaxRows
// ---------------------------------------------------------------------------

describe("PATCH /api/admin/config — valid cleanupHistoryMaxRows updates", () => {
  it("accepts a typical valid value and returns 200 with it reflected in the response", async () => {
    const res = await request(app)
      .patch("/api/admin/config")
      .set("Cookie", adminCookie)
      .send({ cleanupHistoryMaxRows: 500 });

    expect(res.status).toBe(200);
    expect(res.body.cleanupHistoryMaxRows).toBe(500);
  });

  it("accepts the minimum valid value of 1", async () => {
    const res = await request(app)
      .patch("/api/admin/config")
      .set("Cookie", adminCookie)
      .send({ cleanupHistoryMaxRows: 1 });

    expect(res.status).toBe(200);
    expect(res.body.cleanupHistoryMaxRows).toBe(1);
  });

  it("accepts the maximum valid value of 100000", async () => {
    const res = await request(app)
      .patch("/api/admin/config")
      .set("Cookie", adminCookie)
      .send({ cleanupHistoryMaxRows: 100000 });

    expect(res.status).toBe(200);
    expect(res.body.cleanupHistoryMaxRows).toBe(100000);
  });

  it("actually updates the in-memory getter after a valid PATCH", async () => {
    await request(app)
      .patch("/api/admin/config")
      .set("Cookie", adminCookie)
      .send({ cleanupHistoryMaxRows: 250 });

    expect(getCleanupHistoryMaxRows()).toBe(250);
  });
});

// ---------------------------------------------------------------------------
// Valid updates — both fields at once
// ---------------------------------------------------------------------------

describe("PATCH /api/admin/config — updating both fields simultaneously", () => {
  it("applies both cleanupHistoryMaxAgeDays and cleanupHistoryMaxRows in one request", async () => {
    const res = await request(app)
      .patch("/api/admin/config")
      .set("Cookie", adminCookie)
      .send({ cleanupHistoryMaxAgeDays: 60, cleanupHistoryMaxRows: 750 });

    expect(res.status).toBe(200);
    expect(res.body.cleanupHistoryMaxAgeDays).toBe(60);
    expect(res.body.cleanupHistoryMaxRows).toBe(750);
  });

  it("updates both in-memory getters when both fields are provided", async () => {
    await request(app)
      .patch("/api/admin/config")
      .set("Cookie", adminCookie)
      .send({ cleanupHistoryMaxAgeDays: 60, cleanupHistoryMaxRows: 750 });

    expect(getCleanupHistoryMaxAgeDays()).toBe(60);
    expect(getCleanupHistoryMaxRows()).toBe(750);
  });

  it("returns 200 with no body (neither field provided) and leaves values unchanged", async () => {
    const beforeAgeDays = getCleanupHistoryMaxAgeDays();
    const beforeRows = getCleanupHistoryMaxRows();

    const res = await request(app)
      .patch("/api/admin/config")
      .set("Cookie", adminCookie)
      .send({});

    expect(res.status).toBe(200);
    expect(getCleanupHistoryMaxAgeDays()).toBe(beforeAgeDays);
    expect(getCleanupHistoryMaxRows()).toBe(beforeRows);
  });
});

// ---------------------------------------------------------------------------
// Invalid cleanupHistoryMaxAgeDays values
// ---------------------------------------------------------------------------

describe("PATCH /api/admin/config — invalid cleanupHistoryMaxAgeDays values rejected with 400", () => {
  it("rejects 0", async () => {
    const res = await request(app)
      .patch("/api/admin/config")
      .set("Cookie", adminCookie)
      .send({ cleanupHistoryMaxAgeDays: 0 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cleanupHistoryMaxAgeDays/);
  });

  it("rejects a negative integer", async () => {
    const res = await request(app)
      .patch("/api/admin/config")
      .set("Cookie", adminCookie)
      .send({ cleanupHistoryMaxAgeDays: -1 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cleanupHistoryMaxAgeDays/);
  });

  it("rejects a value above the maximum (3651)", async () => {
    const res = await request(app)
      .patch("/api/admin/config")
      .set("Cookie", adminCookie)
      .send({ cleanupHistoryMaxAgeDays: 3651 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cleanupHistoryMaxAgeDays/);
  });

  it("rejects a non-integer (float)", async () => {
    const res = await request(app)
      .patch("/api/admin/config")
      .set("Cookie", adminCookie)
      .send({ cleanupHistoryMaxAgeDays: 1.5 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cleanupHistoryMaxAgeDays/);
  });

  it("rejects a string value", async () => {
    const res = await request(app)
      .patch("/api/admin/config")
      .set("Cookie", adminCookie)
      .send({ cleanupHistoryMaxAgeDays: "30" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cleanupHistoryMaxAgeDays/);
  });

  it("does not update the in-memory getter when validation fails", async () => {
    const before = getCleanupHistoryMaxAgeDays();
    await request(app)
      .patch("/api/admin/config")
      .set("Cookie", adminCookie)
      .send({ cleanupHistoryMaxAgeDays: 0 });

    expect(getCleanupHistoryMaxAgeDays()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Invalid cleanupHistoryMaxRows values
// ---------------------------------------------------------------------------

describe("PATCH /api/admin/config — invalid cleanupHistoryMaxRows values rejected with 400", () => {
  it("rejects 0", async () => {
    const res = await request(app)
      .patch("/api/admin/config")
      .set("Cookie", adminCookie)
      .send({ cleanupHistoryMaxRows: 0 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cleanupHistoryMaxRows/);
  });

  it("rejects a negative integer", async () => {
    const res = await request(app)
      .patch("/api/admin/config")
      .set("Cookie", adminCookie)
      .send({ cleanupHistoryMaxRows: -5 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cleanupHistoryMaxRows/);
  });

  it("rejects a value above the maximum (100001)", async () => {
    const res = await request(app)
      .patch("/api/admin/config")
      .set("Cookie", adminCookie)
      .send({ cleanupHistoryMaxRows: 100001 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cleanupHistoryMaxRows/);
  });

  it("rejects a non-integer (float)", async () => {
    const res = await request(app)
      .patch("/api/admin/config")
      .set("Cookie", adminCookie)
      .send({ cleanupHistoryMaxRows: 10.5 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cleanupHistoryMaxRows/);
  });

  it("rejects a string value", async () => {
    const res = await request(app)
      .patch("/api/admin/config")
      .set("Cookie", adminCookie)
      .send({ cleanupHistoryMaxRows: "500" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cleanupHistoryMaxRows/);
  });

  it("does not update the in-memory getter when validation fails", async () => {
    const before = getCleanupHistoryMaxRows();
    await request(app)
      .patch("/api/admin/config")
      .set("Cookie", adminCookie)
      .send({ cleanupHistoryMaxRows: 0 });

    expect(getCleanupHistoryMaxRows()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

describe("PATCH /api/admin/config — access control", () => {
  it("returns 401 when not authenticated", async () => {
    const res = await request(app)
      .patch("/api/admin/config")
      .send({ cleanupHistoryMaxAgeDays: 30 });

    expect(res.status).toBe(401);
  });

  it("returns 403 when authenticated as a non-admin (guest) user via Bearer token", async () => {
    const { bearerToken, tenantId } = await seedRegularTenant();
    trackedTenantIds.push(tenantId);

    const res = await request(app)
      .patch("/api/admin/config")
      .set("Authorization", `Bearer ${bearerToken}`)
      .send({ cleanupHistoryMaxAgeDays: 30 });

    expect(res.status).toBe(403);
  });

  it("returns 403 when session resolves to a non-admin DB user", async () => {
    const memberTenantId = `${GUEST_TENANT_PREFIX}${uid("member-tenant")}`;
    const memberSlug = uid("member-slug");

    await db.insert(tenantsTable).values({
      id: memberTenantId,
      name: "Member Tenant",
      slug: memberSlug,
      lastActiveAt: new Date(),
      settings: {},
    });
    trackedTenantIds.push(memberTenantId);

    const memberUserId = uid("member-user");
    await db.insert(usersTable).values({
      id: memberUserId,
      tenantId: memberTenantId,
      email: `${memberUserId}@test.local`,
      role: "user",
    });

    const res = await request(app)
      .patch("/api/admin/config")
      .set("Cookie", sessionCookie(memberUserId, memberTenantId))
      .send({ cleanupHistoryMaxAgeDays: 30 });

    expect(res.status).toBe(403);
  });

  it("returns 200 when authenticated as an admin user", async () => {
    const res = await request(app)
      .patch("/api/admin/config")
      .set("Cookie", adminCookie)
      .send({ cleanupHistoryMaxAgeDays: 30 });

    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

describe("PATCH /api/admin/config — response shape", () => {
  it("returns the expected top-level fields in the response body", async () => {
    const res = await request(app)
      .patch("/api/admin/config")
      .set("Cookie", adminCookie)
      .send({ cleanupHistoryMaxAgeDays: 30 });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("cleanupHistoryMaxAgeDays");
    expect(res.body).toHaveProperty("cleanupHistoryMaxRows");
    expect(res.body).toHaveProperty("rasterizeDpi");
    expect(res.body).toHaveProperty("maxAiVisionCallsPerRun");
    expect(res.body).toHaveProperty("aiModel");
    expect(res.body).toHaveProperty("aiProvider");
  });

  it("returns numeric types for cleanupHistoryMaxAgeDays and cleanupHistoryMaxRows", async () => {
    const res = await request(app)
      .patch("/api/admin/config")
      .set("Cookie", adminCookie)
      .send({ cleanupHistoryMaxAgeDays: 30, cleanupHistoryMaxRows: 500 });

    expect(typeof res.body.cleanupHistoryMaxAgeDays).toBe("number");
    expect(typeof res.body.cleanupHistoryMaxRows).toBe("number");
  });
});
