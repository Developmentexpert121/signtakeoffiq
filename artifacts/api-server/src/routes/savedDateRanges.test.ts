import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { db, savedDateRangesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp } from "../__tests__/testApp";
import {
  cleanupTenants,
  seedRegularTenant,
  uid,
} from "../__tests__/fixtures";
import type { SeededRegularTenant } from "../__tests__/fixtures";

const app = createTestApp();

let tenant: SeededRegularTenant;
const trackedTenantIds: string[] = [];

beforeEach(async () => {
  tenant = await seedRegularTenant();
  trackedTenantIds.push(tenant.tenantId);
});

afterEach(async () => {
  await cleanupTenants([...trackedTenantIds]);
  trackedTenantIds.length = 0;
  vi.clearAllMocks();
});

function auth(t: SeededRegularTenant) {
  return `Bearer ${t.bearerToken}`;
}

async function createRange(
  t: SeededRegularTenant,
  body: Record<string, unknown> = {},
) {
  return request(app)
    .post("/api/saved-date-ranges")
    .set("Authorization", auth(t))
    .send({
      name: "Q1 2025",
      start: "2025-01-01",
      end: "2025-03-31",
      ...body,
    });
}

// ---------------------------------------------------------------------------
// Authentication guard
// ---------------------------------------------------------------------------

describe("saved-date-ranges routes – auth guard", () => {
  it("returns 401 when no Authorization header is provided for GET", async () => {
    const res = await request(app).get("/api/saved-date-ranges");
    expect(res.status).toBe(401);
  });

  it("returns 401 when no Authorization header is provided for POST", async () => {
    const res = await request(app)
      .post("/api/saved-date-ranges")
      .send({ name: "Q1", start: "2025-01-01", end: "2025-03-31" });
    expect(res.status).toBe(401);
  });

  it("returns 401 when no Authorization header is provided for DELETE", async () => {
    const res = await request(app).delete("/api/saved-date-ranges/some-id");
    expect(res.status).toBe(401);
  });

  it("returns 401 when no Authorization header is provided for PATCH reorder", async () => {
    const res = await request(app)
      .patch("/api/saved-date-ranges/reorder")
      .send({ orderedIds: [] });
    expect(res.status).toBe(401);
  });

  it("returns 401 when an invalid token is provided", async () => {
    const res = await request(app)
      .get("/api/saved-date-ranges")
      .set("Authorization", "Bearer not-a-real-token");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /saved-date-ranges – create
// ---------------------------------------------------------------------------

describe("POST /api/saved-date-ranges", () => {
  it("creates a date range and returns 201 with the new range", async () => {
    const res = await createRange(tenant, {
      name: "My Range",
      start: "2025-01-01",
      end: "2025-06-30",
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: "My Range",
      start: "2025-01-01",
      end: "2025-06-30",
    });
    expect(res.body.id).toBeTruthy();
  });

  it("persists the created range in the database", async () => {
    const res = await createRange(tenant, { name: "Persisted Range" });
    expect(res.status).toBe(201);

    const [row] = await db
      .select()
      .from(savedDateRangesTable)
      .where(eq(savedDateRangesTable.id, res.body.id));

    expect(row).toBeDefined();
    expect(row.name).toBe("Persisted Range");
    expect(row.userId).toBe(tenant.userId);
    expect(row.tenantId).toBe(tenant.tenantId);
  });

  it("returns 400 when name is missing", async () => {
    const res = await request(app)
      .post("/api/saved-date-ranges")
      .set("Authorization", auth(tenant))
      .send({ start: "2025-01-01", end: "2025-03-31" });

    expect(res.status).toBe(400);
  });

  it("returns 400 when name is empty", async () => {
    const res = await request(app)
      .post("/api/saved-date-ranges")
      .set("Authorization", auth(tenant))
      .send({ name: "   ", start: "2025-01-01", end: "2025-03-31" });

    expect(res.status).toBe(400);
  });

  it("returns 400 when start is missing", async () => {
    const res = await request(app)
      .post("/api/saved-date-ranges")
      .set("Authorization", auth(tenant))
      .send({ name: "Q1", end: "2025-03-31" });

    expect(res.status).toBe(400);
  });

  it("returns 400 when end is missing", async () => {
    const res = await request(app)
      .post("/api/saved-date-ranges")
      .set("Authorization", auth(tenant))
      .send({ name: "Q1", start: "2025-01-01" });

    expect(res.status).toBe(400);
  });

  it("trims the name before storing", async () => {
    const res = await createRange(tenant, { name: "  Trimmed Name  " });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Trimmed Name");
  });

  it("assigns sortOrder sequentially starting from 0", async () => {
    const r1 = await createRange(tenant, { name: "First" });
    const r2 = await createRange(tenant, { name: "Second" });
    const r3 = await createRange(tenant, { name: "Third" });

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r3.status).toBe(201);
    expect(r1.body.sortOrder).toBe(0);
    expect(r2.body.sortOrder).toBe(1);
    expect(r3.body.sortOrder).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// GET /saved-date-ranges – list
// ---------------------------------------------------------------------------

describe("GET /api/saved-date-ranges", () => {
  it("returns an empty array when the user has no saved date ranges", async () => {
    const res = await request(app)
      .get("/api/saved-date-ranges")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  it("returns all date ranges belonging to the authenticated user", async () => {
    await createRange(tenant, { name: "Range A" });
    await createRange(tenant, { name: "Range B" });

    const res = await request(app)
      .get("/api/saved-date-ranges")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    const names = res.body.map((r: { name: string }) => r.name);
    expect(names).toContain("Range A");
    expect(names).toContain("Range B");
  });

  it("does not return ranges belonging to a different user in the same tenant", async () => {
    const other = await seedRegularTenant();
    trackedTenantIds.push(other.tenantId);

    await createRange(other, { name: "Other User Range" });
    await createRange(tenant, { name: "My Range" });

    const res = await request(app)
      .get("/api/saved-date-ranges")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    const names = res.body.map((r: { name: string }) => r.name);
    expect(names).toContain("My Range");
    expect(names).not.toContain("Other User Range");
  });

  it("returns only id, name, start, end, and sortOrder fields", async () => {
    await createRange(tenant, { name: "Field Test", start: "2025-04-01", end: "2025-06-30" });

    const res = await request(app)
      .get("/api/saved-date-ranges")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const range = res.body[0];
    expect(range).toHaveProperty("id");
    expect(range).toHaveProperty("name", "Field Test");
    expect(range).toHaveProperty("start", "2025-04-01");
    expect(range).toHaveProperty("end", "2025-06-30");
    expect(range).toHaveProperty("sortOrder");
    expect(range).not.toHaveProperty("userId");
    expect(range).not.toHaveProperty("tenantId");
    expect(range).not.toHaveProperty("createdAt");
  });

  it("returns ranges in ascending sortOrder", async () => {
    const id1 = uid("sdr");
    const id2 = uid("sdr");
    const id3 = uid("sdr");

    await db.insert(savedDateRangesTable).values([
      { id: id1, userId: tenant.userId, tenantId: tenant.tenantId, name: "Last",   start: "2025-01-01", end: "2025-12-31", sortOrder: 2 },
      { id: id2, userId: tenant.userId, tenantId: tenant.tenantId, name: "First",  start: "2025-01-01", end: "2025-12-31", sortOrder: 0 },
      { id: id3, userId: tenant.userId, tenantId: tenant.tenantId, name: "Middle", start: "2025-01-01", end: "2025-12-31", sortOrder: 1 },
    ]);

    const res = await request(app)
      .get("/api/saved-date-ranges")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    expect(res.body[0].name).toBe("First");
    expect(res.body[1].name).toBe("Middle");
    expect(res.body[2].name).toBe("Last");
  });
});

// ---------------------------------------------------------------------------
// DELETE /saved-date-ranges/:rangeId – delete
// ---------------------------------------------------------------------------

describe("DELETE /api/saved-date-ranges/:rangeId", () => {
  it("returns 204 and removes the date range", async () => {
    const createRes = await createRange(tenant, { name: "To Delete" });
    const rangeId = createRes.body.id;

    const res = await request(app)
      .delete(`/api/saved-date-ranges/${rangeId}`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(204);

    const rows = await db
      .select()
      .from(savedDateRangesTable)
      .where(eq(savedDateRangesTable.id, rangeId));
    expect(rows).toHaveLength(0);
  });

  it("returns 404 when the range does not exist", async () => {
    const res = await request(app)
      .delete("/api/saved-date-ranges/sdr_doesnotexist")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(404);
  });

  it("returns 404 when the range belongs to a different user", async () => {
    const other = await seedRegularTenant();
    trackedTenantIds.push(other.tenantId);

    const createRes = await createRange(other, { name: "Other User Range" });
    const rangeId = createRes.body.id;

    const res = await request(app)
      .delete(`/api/saved-date-ranges/${rangeId}`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(404);

    const rows = await db
      .select()
      .from(savedDateRangesTable)
      .where(eq(savedDateRangesTable.id, rangeId));
    expect(rows).toHaveLength(1);
  });

  it("does not remove ranges from other users after deleting one", async () => {
    const res1 = await createRange(tenant, { name: "Keep Me" });
    const res2 = await createRange(tenant, { name: "Delete Me" });

    await request(app)
      .delete(`/api/saved-date-ranges/${res2.body.id}`)
      .set("Authorization", auth(tenant));

    const remaining = await request(app)
      .get("/api/saved-date-ranges")
      .set("Authorization", auth(tenant));

    expect(remaining.status).toBe(200);
    expect(remaining.body).toHaveLength(1);
    expect(remaining.body[0].id).toBe(res1.body.id);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/saved-date-ranges/reorder
// ---------------------------------------------------------------------------

describe("PATCH /api/saved-date-ranges/reorder", () => {
  it("returns 204 and persists the new sortOrder", async () => {
    const r1 = await createRange(tenant, { name: "A" });
    const r2 = await createRange(tenant, { name: "B" });
    const r3 = await createRange(tenant, { name: "C" });

    const id1 = r1.body.id;
    const id2 = r2.body.id;
    const id3 = r3.body.id;

    const res = await request(app)
      .patch("/api/saved-date-ranges/reorder")
      .set("Authorization", auth(tenant))
      .send({ orderedIds: [id3, id1, id2] });

    expect(res.status).toBe(204);

    const rows = await db
      .select()
      .from(savedDateRangesTable)
      .where(eq(savedDateRangesTable.tenantId, tenant.tenantId));

    const byId = Object.fromEntries(rows.map((r) => [r.id, r.sortOrder]));
    expect(byId[id3]).toBe(0);
    expect(byId[id1]).toBe(1);
    expect(byId[id2]).toBe(2);
  });

  it("GET returns ranges in the new sortOrder after reorder", async () => {
    const r1 = await createRange(tenant, { name: "Alpha" });
    const r2 = await createRange(tenant, { name: "Beta" });

    const id1 = r1.body.id;
    const id2 = r2.body.id;

    await request(app)
      .patch("/api/saved-date-ranges/reorder")
      .set("Authorization", auth(tenant))
      .send({ orderedIds: [id2, id1] });

    const listRes = await request(app)
      .get("/api/saved-date-ranges")
      .set("Authorization", auth(tenant));

    expect(listRes.status).toBe(200);
    expect(listRes.body[0].id).toBe(id2);
    expect(listRes.body[1].id).toBe(id1);
  });

  it("does not change sortOrder for ranges belonging to another tenant", async () => {
    const other = await seedRegularTenant();
    trackedTenantIds.push(other.tenantId);

    const otherId = uid("sdr");
    await db.insert(savedDateRangesTable).values({
      id: otherId,
      userId: other.userId,
      tenantId: other.tenantId,
      name: "Other Range",
      start: "2025-01-01",
      end: "2025-12-31",
      sortOrder: 5,
    });

    const res = await request(app)
      .patch("/api/saved-date-ranges/reorder")
      .set("Authorization", auth(tenant))
      .send({ orderedIds: [otherId] });

    expect(res.status).toBe(204);

    const [row] = await db
      .select()
      .from(savedDateRangesTable)
      .where(eq(savedDateRangesTable.id, otherId));
    expect(row.sortOrder).toBe(5);
  });

  it("returns 400 when orderedIds is not an array", async () => {
    const res = await request(app)
      .patch("/api/saved-date-ranges/reorder")
      .set("Authorization", auth(tenant))
      .send({ orderedIds: "not-an-array" });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("returns 400 when orderedIds contains non-string values", async () => {
    const res = await request(app)
      .patch("/api/saved-date-ranges/reorder")
      .set("Authorization", auth(tenant))
      .send({ orderedIds: [1, 2, 3] });

    expect(res.status).toBe(400);
  });

  it("accepts an empty orderedIds array and returns 204", async () => {
    const res = await request(app)
      .patch("/api/saved-date-ranges/reorder")
      .set("Authorization", auth(tenant))
      .send({ orderedIds: [] });

    expect(res.status).toBe(204);
  });
});
