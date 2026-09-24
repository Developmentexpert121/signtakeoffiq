import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { eq, and } from "drizzle-orm";
import { db, jobsTable, signsTable } from "@workspace/db";
import { createTestApp } from "../__tests__/testApp";
import {
  cleanupTenants,
  seedRegularTenant,
  uid,
} from "../__tests__/fixtures";
import type { SeededRegularTenant } from "../__tests__/fixtures";
import { SIGN_COLORS, DEFAULT_SIGN_COLOR } from "../lib/signColors";

vi.mock("../lib/pipeline", () => ({
  processJob: vi.fn().mockResolvedValue(undefined),
}));

const app = createTestApp();

let tenant: SeededRegularTenant;
let jobId: string;
const trackedTenantIds: string[] = [];

beforeEach(async () => {
  tenant = await seedRegularTenant();
  trackedTenantIds.push(tenant.tenantId);

  jobId = uid("job");
  await db.insert(jobsTable).values({
    id: jobId,
    tenantId: tenant.tenantId,
    name: "Test Job",
    status: "pending",
  });
});

afterEach(async () => {
  await cleanupTenants([...trackedTenantIds]);
  trackedTenantIds.length = 0;
  vi.clearAllMocks();
});

function auth(t: SeededRegularTenant) {
  return `Bearer ${t.bearerToken}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createSign(
  t: SeededRegularTenant,
  jId: string,
  overrides: Record<string, unknown> = {},
) {
  return request(app)
    .post(`/api/jobs/${jId}/signs`)
    .set("Authorization", auth(t))
    .send({ signType: "Exit", ...overrides });
}

// ---------------------------------------------------------------------------
// Authentication guard
// ---------------------------------------------------------------------------

describe("signs routes – auth guard", () => {
  it("returns 401 when no Authorization header is provided", async () => {
    const res = await request(app).get(`/api/jobs/${jobId}/signs`);
    expect(res.status).toBe(401);
  });

  it("returns 401 when an invalid token is provided", async () => {
    const res = await request(app)
      .get(`/api/jobs/${jobId}/signs`)
      .set("Authorization", "Bearer not-a-real-token");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /jobs/:jobId/signs – create
// ---------------------------------------------------------------------------

describe("POST /api/jobs/:jobId/signs", () => {
  it("creates a sign and returns 201 with the new sign", async () => {
    const res = await createSign(tenant, jobId, { signType: "Exit" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      jobId,
      tenantId: tenant.tenantId,
      signType: "Exit",
    });
    expect(res.body.id).toBeTruthy();
  });

  it("persists the created sign in the database", async () => {
    const res = await createSign(tenant, jobId, { signType: "Room ID" });
    expect(res.status).toBe(201);

    const [row] = await db
      .select()
      .from(signsTable)
      .where(
        and(
          eq(signsTable.id, res.body.id),
          eq(signsTable.tenantId, tenant.tenantId),
        ),
      );

    expect(row).toBeDefined();
    expect(row.signType).toBe("Room ID");
    expect(row.isDeleted).toBe(false);
  });

  it("stores optional fields when provided", async () => {
    const res = await createSign(tenant, jobId, {
      signType: "Exit",
      qty: 3,
      dimensions: "12x12",
      mounting: "wall",
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      qty: 3,
      dimensions: "12x12",
      mounting: "wall",
    });
  });

  it("returns 400 when signType is missing", async () => {
    const res = await request(app)
      .post(`/api/jobs/${jobId}/signs`)
      .set("Authorization", auth(tenant))
      .send({});

    expect(res.status).toBe(400);
  });

  it("sets source to manual and confidence to 0.95 for manually created signs", async () => {
    const res = await createSign(tenant, jobId);

    expect(res.status).toBe(201);
    expect(res.body.source).toBe("manual");
    expect(res.body.confidence).toBe(0.95);
  });
});

// ---------------------------------------------------------------------------
// GET /jobs/:jobId/signs – list
// ---------------------------------------------------------------------------

describe("GET /api/jobs/:jobId/signs", () => {
  it("returns an empty array when the job has no signs", async () => {
    const res = await request(app)
      .get(`/api/jobs/${jobId}/signs`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  it("returns all signs belonging to the job", async () => {
    await createSign(tenant, jobId, { signType: "Exit" });
    await createSign(tenant, jobId, { signType: "Room ID" });

    const res = await request(app)
      .get(`/api/jobs/${jobId}/signs`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body.length).toBe(2);
  });

  it("does not return signs from a different job", async () => {
    const otherJobId = uid("job");
    await db.insert(jobsTable).values({
      id: otherJobId,
      tenantId: tenant.tenantId,
      name: "Other Job",
      status: "pending",
    });

    await createSign(tenant, otherJobId, { signType: "Exit" });
    await createSign(tenant, jobId, { signType: "Room ID" });

    const res = await request(app)
      .get(`/api/jobs/${jobId}/signs`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].signType).toBe("Room ID");
  });

  it("does not return signs from a different tenant", async () => {
    const other = await seedRegularTenant();
    trackedTenantIds.push(other.tenantId);

    const otherJobId = uid("job");
    await db.insert(jobsTable).values({
      id: otherJobId,
      tenantId: other.tenantId,
      name: "Other Tenant Job",
      status: "pending",
    });

    await createSign(other, otherJobId, { signType: "Exit" });

    const res = await request(app)
      .get(`/api/jobs/${otherJobId}/signs`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });

  it("does not return deleted signs", async () => {
    const createRes = await createSign(tenant, jobId, { signType: "Exit" });
    const signId = createRes.body.id;

    await db
      .update(signsTable)
      .set({ isDeleted: true })
      .where(eq(signsTable.id, signId));

    const res = await request(app)
      .get(`/api/jobs/${jobId}/signs`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// GET /jobs/:jobId/signs/:signId – read single
// ---------------------------------------------------------------------------

describe("GET /api/jobs/:jobId/signs/:signId", () => {
  it("returns the sign when it exists and belongs to the tenant", async () => {
    const createRes = await createSign(tenant, jobId, { signType: "Restroom" });
    const signId = createRes.body.id;

    const res = await request(app)
      .get(`/api/jobs/${jobId}/signs/${signId}`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: signId, signType: "Restroom" });
  });

  it("returns 404 for a non-existent sign", async () => {
    const res = await request(app)
      .get(`/api/jobs/${jobId}/signs/sign_doesnotexist`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(404);
  });

  it("returns 404 when sign belongs to another tenant", async () => {
    const other = await seedRegularTenant();
    trackedTenantIds.push(other.tenantId);

    const otherJobId = uid("job");
    await db.insert(jobsTable).values({
      id: otherJobId,
      tenantId: other.tenantId,
      name: "Other Job",
      status: "pending",
    });

    const createRes = await createSign(other, otherJobId, { signType: "Exit" });
    const signId = createRes.body.id;

    const res = await request(app)
      .get(`/api/jobs/${jobId}/signs/${signId}`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PATCH /jobs/:jobId/signs/:signId – update
// ---------------------------------------------------------------------------

describe("PATCH /api/jobs/:jobId/signs/:signId", () => {
  it("updates the sign type and returns the updated sign", async () => {
    const createRes = await createSign(tenant, jobId, { signType: "Exit" });
    const signId = createRes.body.id;

    const res = await request(app)
      .patch(`/api/jobs/${jobId}/signs/${signId}`)
      .set("Authorization", auth(tenant))
      .send({ signType: "Room ID" });

    expect(res.status).toBe(200);
    expect(res.body.signType).toBe("Room ID");
  });

  it("updates the qty and persists it in the database", async () => {
    const createRes = await createSign(tenant, jobId, { signType: "Exit" });
    const signId = createRes.body.id;

    const res = await request(app)
      .patch(`/api/jobs/${jobId}/signs/${signId}`)
      .set("Authorization", auth(tenant))
      .send({ qty: 5 });

    expect(res.status).toBe(200);
    expect(res.body.qty).toBe(5);

    const [row] = await db
      .select()
      .from(signsTable)
      .where(eq(signsTable.id, signId));
    expect(row.qty).toBe(5);
  });

  it("returns 404 when patching a non-existent sign", async () => {
    const res = await request(app)
      .patch(`/api/jobs/${jobId}/signs/sign_doesnotexist`)
      .set("Authorization", auth(tenant))
      .send({ qty: 2 });

    expect(res.status).toBe(404);
  });

  it("cannot patch a sign belonging to another tenant", async () => {
    const other = await seedRegularTenant();
    trackedTenantIds.push(other.tenantId);

    const otherJobId = uid("job");
    await db.insert(jobsTable).values({
      id: otherJobId,
      tenantId: other.tenantId,
      name: "Other Job",
      status: "pending",
    });

    const createRes = await createSign(other, otherJobId, { signType: "Exit" });
    const signId = createRes.body.id;

    const res = await request(app)
      .patch(`/api/jobs/${jobId}/signs/${signId}`)
      .set("Authorization", auth(tenant))
      .send({ signType: "Room ID" });

    expect(res.status).toBe(404);

    const [row] = await db
      .select()
      .from(signsTable)
      .where(eq(signsTable.id, signId));
    expect(row.signType).toBe("Exit");
  });
});

// ---------------------------------------------------------------------------
// DELETE /jobs/:jobId/signs/:signId – soft delete
// ---------------------------------------------------------------------------

describe("DELETE /api/jobs/:jobId/signs/:signId", () => {
  it("returns 204 and soft-deletes the sign", async () => {
    const createRes = await createSign(tenant, jobId, { signType: "Exit" });
    const signId = createRes.body.id;

    const res = await request(app)
      .delete(`/api/jobs/${jobId}/signs/${signId}`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(204);

    const [row] = await db
      .select()
      .from(signsTable)
      .where(eq(signsTable.id, signId));
    expect(row.isDeleted).toBe(true);
    expect(row.status).toBe("deleted");
  });

  it("does not remove the sign row from the database", async () => {
    const createRes = await createSign(tenant, jobId, { signType: "Exit" });
    const signId = createRes.body.id;

    await request(app)
      .delete(`/api/jobs/${jobId}/signs/${signId}`)
      .set("Authorization", auth(tenant));

    const [row] = await db
      .select()
      .from(signsTable)
      .where(eq(signsTable.id, signId));
    expect(row).toBeDefined();
  });

  it("returns 404 when deleting a non-existent sign", async () => {
    const res = await request(app)
      .delete(`/api/jobs/${jobId}/signs/sign_doesnotexist`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(404);
  });

  it("returns 404 when deleting a sign belonging to another tenant", async () => {
    const other = await seedRegularTenant();
    trackedTenantIds.push(other.tenantId);

    const otherJobId = uid("job");
    await db.insert(jobsTable).values({
      id: otherJobId,
      tenantId: other.tenantId,
      name: "Other Job",
      status: "pending",
    });

    const createRes = await createSign(other, otherJobId, { signType: "Exit" });
    const signId = createRes.body.id;

    const res = await request(app)
      .delete(`/api/jobs/${jobId}/signs/${signId}`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(404);

    const [row] = await db
      .select()
      .from(signsTable)
      .where(eq(signsTable.id, signId));
    expect(row.isDeleted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Color assignment – POST and PATCH
// ---------------------------------------------------------------------------

describe("sign color assignment", () => {
  it("POST returns the SIGN_COLORS entry for a known sign type", async () => {
    const knownType = "Exit";
    const res = await createSign(tenant, jobId, { signType: knownType });

    expect(res.status).toBe(201);
    expect(res.body.color).toBe(SIGN_COLORS[knownType]);
  });

  it("POST returns the SIGN_COLORS entry for every known sign type", async () => {
    for (const [signType, expectedColor] of Object.entries(SIGN_COLORS)) {
      const res = await createSign(tenant, jobId, { signType });
      expect(res.status).toBe(201);
      expect(res.body.color).toBe(expectedColor);
    }
  });

  it("POST returns the fallback color for an unknown sign type", async () => {
    const res = await createSign(tenant, jobId, {
      signType: "Completely Unknown Type XYZ",
    });

    expect(res.status).toBe(201);
    expect(res.body.color).toBe(DEFAULT_SIGN_COLOR);
  });

  it("GET list returns correct colors from SIGN_COLORS for each sign", async () => {
    await createSign(tenant, jobId, { signType: "Exit" });
    await createSign(tenant, jobId, { signType: "Restroom" });

    const res = await request(app)
      .get(`/api/jobs/${jobId}/signs`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);

    const exitSign = res.body.find(
      (s: { signType: string }) => s.signType === "Exit",
    );
    const restroomSign = res.body.find(
      (s: { signType: string }) => s.signType === "Restroom",
    );

    expect(exitSign.color).toBe(SIGN_COLORS["Exit"]);
    expect(restroomSign.color).toBe(SIGN_COLORS["Restroom"]);
  });

  it("GET list returns the fallback color for an unknown sign type", async () => {
    await createSign(tenant, jobId, { signType: "Unknown Custom Type" });

    const res = await request(app)
      .get(`/api/jobs/${jobId}/signs`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body[0].color).toBe(DEFAULT_SIGN_COLOR);
  });

  it("PATCH updates color to SIGN_COLORS entry when sign type changes to a known type", async () => {
    const createRes = await createSign(tenant, jobId, { signType: "Exit" });
    const signId = createRes.body.id;

    const res = await request(app)
      .patch(`/api/jobs/${jobId}/signs/${signId}`)
      .set("Authorization", auth(tenant))
      .send({ signType: "Room ID" });

    expect(res.status).toBe(200);
    expect(res.body.color).toBe(SIGN_COLORS["Room ID"]);
  });

  it("PATCH updating sign type from one known type to another reflects the new SIGN_COLORS entry", async () => {
    const createRes = await createSign(tenant, jobId, { signType: "Exit" });
    const signId = createRes.body.id;

    expect(createRes.body.color).toBe(SIGN_COLORS["Exit"]);

    const res = await request(app)
      .patch(`/api/jobs/${jobId}/signs/${signId}`)
      .set("Authorization", auth(tenant))
      .send({ signType: "Evac Map" });

    expect(res.status).toBe(200);
    expect(res.body.color).toBe(SIGN_COLORS["Evac Map"]);
    expect(res.body.color).not.toBe(SIGN_COLORS["Exit"]);
  });

  it("PATCH returns the fallback color when the updated sign type is unknown", async () => {
    const createRes = await createSign(tenant, jobId, {
      signType: "Unknown Type Alpha",
    });
    const signId = createRes.body.id;

    expect(createRes.body.color).toBe(DEFAULT_SIGN_COLOR);

    const res = await request(app)
      .patch(`/api/jobs/${jobId}/signs/${signId}`)
      .set("Authorization", auth(tenant))
      .send({ signType: "Unknown Type Beta" });

    expect(res.status).toBe(200);
    expect(res.body.color).toBe(DEFAULT_SIGN_COLOR);
  });

  it("GET single sign returns the fallback color for an unknown sign type", async () => {
    const createRes = await createSign(tenant, jobId, {
      signType: "Unknown Type XYZ",
    });
    const signId = createRes.body.id;

    const res = await request(app)
      .get(`/api/jobs/${jobId}/signs/${signId}`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body.color).toBe(DEFAULT_SIGN_COLOR);
  });
});
