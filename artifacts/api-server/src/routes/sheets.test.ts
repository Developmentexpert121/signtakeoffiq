import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { db, jobsTable, jobSheetsTable } from "@workspace/db";
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

async function insertSheet(
  t: SeededRegularTenant,
  jId: string,
  overrides: Partial<typeof jobSheetsTable.$inferInsert> = {},
) {
  const sheetId = uid("sheet");
  await db.insert(jobSheetsTable).values({
    id: sheetId,
    jobId: jId,
    tenantId: t.tenantId,
    sheetId: uid("sid"),
    pdfPage: 1,
    ...overrides,
  });
  return sheetId;
}

// ---------------------------------------------------------------------------
// Authentication guard
// ---------------------------------------------------------------------------

describe("sheets routes – auth guard", () => {
  it("returns 401 when no Authorization header is provided for list", async () => {
    const res = await request(app).get(`/api/jobs/${jobId}/sheets`);
    expect(res.status).toBe(401);
  });

  it("returns 401 when an invalid token is provided for list", async () => {
    const res = await request(app)
      .get(`/api/jobs/${jobId}/sheets`)
      .set("Authorization", "Bearer not-a-real-token");
    expect(res.status).toBe(401);
  });

  it("returns 401 when no Authorization header is provided for single read", async () => {
    const res = await request(app).get(`/api/jobs/${jobId}/sheets/some-id`);
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /jobs/:jobId/sheets – list
// ---------------------------------------------------------------------------

describe("GET /api/jobs/:jobId/sheets", () => {
  it("returns an empty array when the job has no sheets", async () => {
    const res = await request(app)
      .get(`/api/jobs/${jobId}/sheets`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  it("returns all sheets belonging to the job", async () => {
    await insertSheet(tenant, jobId, { sheetTitle: "Floor Plan 1", pdfPage: 1 });
    await insertSheet(tenant, jobId, { sheetTitle: "Floor Plan 2", pdfPage: 2 });

    const res = await request(app)
      .get(`/api/jobs/${jobId}/sheets`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  it("does not return sheets from a different job", async () => {
    const otherJobId = uid("job");
    await db.insert(jobsTable).values({
      id: otherJobId,
      tenantId: tenant.tenantId,
      name: "Other Job",
      status: "pending",
    });

    await insertSheet(tenant, otherJobId, { sheetTitle: "Other Sheet" });
    await insertSheet(tenant, jobId, { sheetTitle: "My Sheet" });

    const res = await request(app)
      .get(`/api/jobs/${jobId}/sheets`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].sheetTitle).toBe("My Sheet");
  });

  it("does not return sheets belonging to a different tenant", async () => {
    const other = await seedRegularTenant();
    trackedTenantIds.push(other.tenantId);

    const otherJobId = uid("job");
    await db.insert(jobsTable).values({
      id: otherJobId,
      tenantId: other.tenantId,
      name: "Other Tenant Job",
      status: "pending",
    });

    await insertSheet(other, otherJobId, { sheetTitle: "Other Tenant Sheet" });

    const res = await request(app)
      .get(`/api/jobs/${otherJobId}/sheets`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });

  it("returns sheet fields correctly", async () => {
    await insertSheet(tenant, jobId, {
      sheetTitle: "Level 1 Egress",
      sheetType: "egress",
      level: "1",
      pdfPage: 3,
    });

    const res = await request(app)
      .get(`/api/jobs/${jobId}/sheets`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      sheetTitle: "Level 1 Egress",
      sheetType: "egress",
      level: "1",
      pdfPage: 3,
    });
  });
});

// ---------------------------------------------------------------------------
// GET /jobs/:jobId/sheets/:sheetId – read single
// ---------------------------------------------------------------------------

describe("GET /api/jobs/:jobId/sheets/:sheetId", () => {
  it("returns the sheet when it exists and belongs to the tenant", async () => {
    const id = await insertSheet(tenant, jobId, { sheetTitle: "Readable Sheet" });

    const res = await request(app)
      .get(`/api/jobs/${jobId}/sheets/${id}`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id, sheetTitle: "Readable Sheet" });
  });

  it("returns 404 for a non-existent sheet", async () => {
    const res = await request(app)
      .get(`/api/jobs/${jobId}/sheets/sheet_doesnotexist`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(404);
  });

  it("returns 404 when the sheet belongs to a different job", async () => {
    const otherJobId = uid("job");
    await db.insert(jobsTable).values({
      id: otherJobId,
      tenantId: tenant.tenantId,
      name: "Other Job",
      status: "pending",
    });

    const id = await insertSheet(tenant, otherJobId, { sheetTitle: "Wrong Job Sheet" });

    const res = await request(app)
      .get(`/api/jobs/${jobId}/sheets/${id}`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(404);
  });

  it("returns 404 when the sheet belongs to a different tenant", async () => {
    const other = await seedRegularTenant();
    trackedTenantIds.push(other.tenantId);

    const otherJobId = uid("job");
    await db.insert(jobsTable).values({
      id: otherJobId,
      tenantId: other.tenantId,
      name: "Other Tenant Job",
      status: "pending",
    });

    const id = await insertSheet(other, otherJobId, { sheetTitle: "Other Tenant Sheet" });

    const res = await request(app)
      .get(`/api/jobs/${jobId}/sheets/${id}`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(404);
  });
});

