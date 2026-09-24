import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, jobsTable, tenantsTable, usersTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import { createTestApp } from "./testApp";
import { seedRegularTenant, uid } from "./fixtures";

const app = createTestApp();

describe("GET /api/jobs — buildingType filter", () => {
  let tenantId: string;
  let bearerToken: string;
  let jobIds: string[] = [];

  beforeAll(async () => {
    const tenant = await seedRegularTenant();
    tenantId = tenant.tenantId;
    bearerToken = tenant.bearerToken;

    const commercialId = uid("job");
    const healthcareId = uid("job");
    const educationId = uid("job");
    const noTypeId = uid("job");

    jobIds = [commercialId, healthcareId, educationId, noTypeId];

    await db.insert(jobsTable).values([
      { id: commercialId, tenantId, name: "Commercial Job", status: "pending", buildingType: "commercial" },
      { id: healthcareId, tenantId, name: "Healthcare Job", status: "pending", buildingType: "Healthcare" },
      { id: educationId, tenantId, name: "Education Job", status: "pending", buildingType: "education" },
      { id: noTypeId, tenantId, name: "No Type Job", status: "pending" },
    ]);
  });

  afterAll(async () => {
    if (jobIds.length > 0) {
      await db.delete(jobsTable).where(inArray(jobsTable.id, jobIds));
    }
    await db.delete(usersTable).where(inArray(usersTable.tenantId, [tenantId]));
    await db.delete(tenantsTable).where(inArray(tenantsTable.id, [tenantId]));
  });

  it("returns all jobs when no buildingType filter is applied", async () => {
    const res = await request(app)
      .get("/api/jobs")
      .set("Authorization", `Bearer ${bearerToken}`);

    expect(res.status).toBe(200);
    const ids = res.body.map((j: { id: string }) => j.id);
    expect(ids).toContain(jobIds[0]);
    expect(ids).toContain(jobIds[1]);
    expect(ids).toContain(jobIds[2]);
    expect(ids).toContain(jobIds[3]);
  });

  it("filters jobs by a single building type (case-insensitive match)", async () => {
    const res = await request(app)
      .get("/api/jobs?buildingType=commercial")
      .set("Authorization", `Bearer ${bearerToken}`);

    expect(res.status).toBe(200);
    const ids = res.body.map((j: { id: string }) => j.id);
    expect(ids).toContain(jobIds[0]);
    expect(ids).not.toContain(jobIds[1]);
    expect(ids).not.toContain(jobIds[2]);
    expect(ids).not.toContain(jobIds[3]);
  });

  it("matches stored 'Healthcare' via case-insensitive filter 'healthcare'", async () => {
    const res = await request(app)
      .get("/api/jobs?buildingType=healthcare")
      .set("Authorization", `Bearer ${bearerToken}`);

    expect(res.status).toBe(200);
    const ids = res.body.map((j: { id: string }) => j.id);
    expect(ids).toContain(jobIds[1]);
    expect(ids).not.toContain(jobIds[0]);
    expect(ids).not.toContain(jobIds[2]);
    expect(ids).not.toContain(jobIds[3]);
  });

  it("filters by multiple building types (OR semantics)", async () => {
    const res = await request(app)
      .get("/api/jobs?buildingType=commercial&buildingType=education")
      .set("Authorization", `Bearer ${bearerToken}`);

    expect(res.status).toBe(200);
    const ids = res.body.map((j: { id: string }) => j.id);
    expect(ids).toContain(jobIds[0]);
    expect(ids).not.toContain(jobIds[1]);
    expect(ids).toContain(jobIds[2]);
    expect(ids).not.toContain(jobIds[3]);
  });

  it("excludes jobs belonging to a different tenant (tenant isolation)", async () => {
    const otherTenant = await seedRegularTenant();
    const otherId = uid("job");

    await db.insert(jobsTable).values({
      id: otherId,
      tenantId: otherTenant.tenantId,
      name: "Other Tenant Job",
      status: "pending",
      buildingType: "commercial",
    });

    try {
      const res = await request(app)
        .get("/api/jobs?buildingType=commercial")
        .set("Authorization", `Bearer ${bearerToken}`);

      expect(res.status).toBe(200);
      const ids = res.body.map((j: { id: string }) => j.id);
      expect(ids).not.toContain(otherId);
    } finally {
      await db.delete(jobsTable).where(inArray(jobsTable.id, [otherId]));
      await db.delete(usersTable).where(inArray(usersTable.tenantId, [otherTenant.tenantId]));
      await db.delete(tenantsTable).where(inArray(tenantsTable.id, [otherTenant.tenantId]));
    }
  });
});
