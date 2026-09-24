import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import {
  db,
  jobsTable,
  plaqueScheduleTable,
  validationResultsTable,
  roomsTable,
} from "@workspace/db";
import { createTestApp } from "../__tests__/testApp";
import {
  cleanupTenants,
  seedRegularTenant,
  uid,
} from "../__tests__/fixtures";
import type { SeededRegularTenant } from "../__tests__/fixtures";

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
// GET /jobs/:jobId/plaque-schedule
// ---------------------------------------------------------------------------

describe("GET /api/jobs/:jobId/plaque-schedule – auth guard", () => {
  it("returns 401 when no Authorization header is provided", async () => {
    const res = await request(app).get(`/api/jobs/${jobId}/plaque-schedule`);
    expect(res.status).toBe(401);
  });

  it("returns 401 when an invalid token is provided", async () => {
    const res = await request(app)
      .get(`/api/jobs/${jobId}/plaque-schedule`)
      .set("Authorization", "Bearer not-a-real-token");
    expect(res.status).toBe(401);
  });
});

describe("GET /api/jobs/:jobId/plaque-schedule", () => {
  it("returns an empty array when the job has no plaque schedule items", async () => {
    const res = await request(app)
      .get(`/api/jobs/${jobId}/plaque-schedule`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  it("returns all plaque schedule items belonging to the job", async () => {
    await db.insert(plaqueScheduleTable).values([
      {
        id: uid("plaque"),
        jobId,
        tenantId: tenant.tenantId,
        typeId: "type-a",
        name: "Exit Sign",
      },
      {
        id: uid("plaque"),
        jobId,
        tenantId: tenant.tenantId,
        typeId: "type-b",
        name: "Room ID",
      },
    ]);

    const res = await request(app)
      .get(`/api/jobs/${jobId}/plaque-schedule`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    const names = res.body.map((p: { name: string }) => p.name);
    expect(names).toContain("Exit Sign");
    expect(names).toContain("Room ID");
  });

  it("does not return plaque items from a different job", async () => {
    const otherJobId = uid("job");
    await db.insert(jobsTable).values({
      id: otherJobId,
      tenantId: tenant.tenantId,
      name: "Other Job",
      status: "pending",
    });

    await db.insert(plaqueScheduleTable).values({
      id: uid("plaque"),
      jobId: otherJobId,
      tenantId: tenant.tenantId,
      typeId: "type-x",
      name: "Other Job Plaque",
    });

    await db.insert(plaqueScheduleTable).values({
      id: uid("plaque"),
      jobId,
      tenantId: tenant.tenantId,
      typeId: "type-a",
      name: "My Job Plaque",
    });

    const res = await request(app)
      .get(`/api/jobs/${jobId}/plaque-schedule`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe("My Job Plaque");
  });

  it("does not return plaque items belonging to a different tenant", async () => {
    const other = await seedRegularTenant();
    trackedTenantIds.push(other.tenantId);

    const otherJobId = uid("job");
    await db.insert(jobsTable).values({
      id: otherJobId,
      tenantId: other.tenantId,
      name: "Other Tenant Job",
      status: "pending",
    });

    await db.insert(plaqueScheduleTable).values({
      id: uid("plaque"),
      jobId: otherJobId,
      tenantId: other.tenantId,
      typeId: "type-x",
      name: "Other Tenant Plaque",
    });

    const res = await request(app)
      .get(`/api/jobs/${otherJobId}/plaque-schedule`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });

  it("returns plaque item fields correctly", async () => {
    await db.insert(plaqueScheduleTable).values({
      id: uid("plaque"),
      jobId,
      tenantId: tenant.tenantId,
      typeId: "type-ada",
      name: "ADA Sign",
      braille: true,
      hasInsert: true,
      insertSize: "4x4",
    });

    const res = await request(app)
      .get(`/api/jobs/${jobId}/plaque-schedule`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      typeId: "type-ada",
      name: "ADA Sign",
      braille: true,
      hasInsert: true,
      insertSize: "4x4",
    });
  });
});

// ---------------------------------------------------------------------------
// GET /jobs/:jobId/validation
// ---------------------------------------------------------------------------

describe("GET /api/jobs/:jobId/validation – auth guard", () => {
  it("returns 401 when no Authorization header is provided", async () => {
    const res = await request(app).get(`/api/jobs/${jobId}/validation`);
    expect(res.status).toBe(401);
  });

  it("returns 401 when an invalid token is provided", async () => {
    const res = await request(app)
      .get(`/api/jobs/${jobId}/validation`)
      .set("Authorization", "Bearer invalid-token");
    expect(res.status).toBe(401);
  });
});

describe("GET /api/jobs/:jobId/validation", () => {
  it("returns an empty array when the job has no validation results", async () => {
    const res = await request(app)
      .get(`/api/jobs/${jobId}/validation`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  it("returns all validation results belonging to the job", async () => {
    await db.insert(validationResultsTable).values([
      {
        id: uid("vr"),
        jobId,
        tenantId: tenant.tenantId,
        checkName: "sign_count",
        status: "pass",
      },
      {
        id: uid("vr"),
        jobId,
        tenantId: tenant.tenantId,
        checkName: "room_coverage",
        status: "fail",
      },
    ]);

    const res = await request(app)
      .get(`/api/jobs/${jobId}/validation`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    const checks = res.body.map((r: { checkName: string }) => r.checkName);
    expect(checks).toContain("sign_count");
    expect(checks).toContain("room_coverage");
  });

  it("does not return validation results from a different job", async () => {
    const otherJobId = uid("job");
    await db.insert(jobsTable).values({
      id: otherJobId,
      tenantId: tenant.tenantId,
      name: "Other Job",
      status: "pending",
    });

    await db.insert(validationResultsTable).values({
      id: uid("vr"),
      jobId: otherJobId,
      tenantId: tenant.tenantId,
      checkName: "other_check",
      status: "pass",
    });

    await db.insert(validationResultsTable).values({
      id: uid("vr"),
      jobId,
      tenantId: tenant.tenantId,
      checkName: "my_check",
      status: "pass",
    });

    const res = await request(app)
      .get(`/api/jobs/${jobId}/validation`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].checkName).toBe("my_check");
  });

  it("does not return validation results belonging to a different tenant", async () => {
    const other = await seedRegularTenant();
    trackedTenantIds.push(other.tenantId);

    const otherJobId = uid("job");
    await db.insert(jobsTable).values({
      id: otherJobId,
      tenantId: other.tenantId,
      name: "Other Tenant Job",
      status: "pending",
    });

    await db.insert(validationResultsTable).values({
      id: uid("vr"),
      jobId: otherJobId,
      tenantId: other.tenantId,
      checkName: "other_tenant_check",
      status: "pass",
    });

    const res = await request(app)
      .get(`/api/jobs/${otherJobId}/validation`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });

  it("returns validation result fields correctly", async () => {
    await db.insert(validationResultsTable).values({
      id: uid("vr"),
      jobId,
      tenantId: tenant.tenantId,
      checkName: "egress_coverage",
      status: "warn",
      details: "3 rooms missing egress signs",
    });

    const res = await request(app)
      .get(`/api/jobs/${jobId}/validation`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      checkName: "egress_coverage",
      status: "warn",
      details: "3 rooms missing egress signs",
    });
  });
});

// ---------------------------------------------------------------------------
// GET /jobs/:jobId/occupant-loads
// ---------------------------------------------------------------------------

describe("GET /api/jobs/:jobId/occupant-loads – auth guard", () => {
  it("returns 401 when no Authorization header is provided", async () => {
    const res = await request(app).get(`/api/jobs/${jobId}/occupant-loads`);
    expect(res.status).toBe(401);
  });
});

describe("GET /api/jobs/:jobId/occupant-loads", () => {
  it("returns an empty array when no rooms have occupant loads", async () => {
    await db.insert(roomsTable).values({
      id: uid("room"),
      jobId,
      tenantId: tenant.tenantId,
      roomNumber: "101",
      roomName: "Office",
      level: "1",
    });

    const res = await request(app)
      .get(`/api/jobs/${jobId}/occupant-loads`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  it("returns only rooms that have an occupant load set", async () => {
    await db.insert(roomsTable).values([
      {
        id: uid("room"),
        jobId,
        tenantId: tenant.tenantId,
        roomNumber: "101",
        roomName: "Office",
        level: "1",
        occupantLoad: 50,
      },
      {
        id: uid("room"),
        jobId,
        tenantId: tenant.tenantId,
        roomNumber: "102",
        roomName: "Storage",
        level: "1",
      },
    ]);

    const res = await request(app)
      .get(`/api/jobs/${jobId}/occupant-loads`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].roomNumber).toBe("101");
    expect(res.body[0].occupantLoad).toBe(50);
  });

  it("does not return rooms from a different tenant", async () => {
    const other = await seedRegularTenant();
    trackedTenantIds.push(other.tenantId);

    const otherJobId = uid("job");
    await db.insert(jobsTable).values({
      id: otherJobId,
      tenantId: other.tenantId,
      name: "Other Tenant Job",
      status: "pending",
    });

    await db.insert(roomsTable).values({
      id: uid("room"),
      jobId: otherJobId,
      tenantId: other.tenantId,
      roomNumber: "200",
      roomName: "Conference",
      level: "2",
      occupantLoad: 100,
    });

    const res = await request(app)
      .get(`/api/jobs/${otherJobId}/occupant-loads`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });

  it("does not return occupant loads from a different job", async () => {
    const otherJobId = uid("job");
    await db.insert(jobsTable).values({
      id: otherJobId,
      tenantId: tenant.tenantId,
      name: "Other Job",
      status: "pending",
    });

    await db.insert(roomsTable).values({
      id: uid("room"),
      jobId: otherJobId,
      tenantId: tenant.tenantId,
      roomNumber: "200",
      roomName: "Conference",
      level: "2",
      occupantLoad: 100,
    });

    const res = await request(app)
      .get(`/api/jobs/${jobId}/occupant-loads`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });
});
