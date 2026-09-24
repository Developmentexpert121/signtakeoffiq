import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { eq, and } from "drizzle-orm";
import { db, jobsTable, jobFilesTable } from "@workspace/db";
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
// Authentication guard
// ---------------------------------------------------------------------------

describe("files routes – auth guard", () => {
  it("returns 401 when no Authorization header is provided", async () => {
    const res = await request(app).get(`/api/jobs/${jobId}/files`);
    expect(res.status).toBe(401);
  });

  it("returns 401 when an invalid token is provided", async () => {
    const res = await request(app)
      .get(`/api/jobs/${jobId}/files`)
      .set("Authorization", "Bearer not-a-real-token");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /jobs/:jobId/files – create
// ---------------------------------------------------------------------------

describe("POST /api/jobs/:jobId/files", () => {
  it("creates a file record and returns 201 with the new file", async () => {
    const res = await request(app)
      .post(`/api/jobs/${jobId}/files`)
      .set("Authorization", auth(tenant))
      .send({ filename: "floor-plan.pdf", storagePath: "/objects/tenants/test/floor-plan.pdf" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      jobId,
      tenantId: tenant.tenantId,
      filename: "floor-plan.pdf",
      storagePath: "/objects/tenants/test/floor-plan.pdf",
    });
    expect(res.body.id).toBeTruthy();
  });

  it("persists the created file in the database", async () => {
    const res = await request(app)
      .post(`/api/jobs/${jobId}/files`)
      .set("Authorization", auth(tenant))
      .send({ filename: "site.pdf", storagePath: "/objects/tenants/test/site.pdf" });

    expect(res.status).toBe(201);

    const [row] = await db
      .select()
      .from(jobFilesTable)
      .where(
        and(
          eq(jobFilesTable.id, res.body.id),
          eq(jobFilesTable.tenantId, tenant.tenantId),
        ),
      );

    expect(row).toBeDefined();
    expect(row.filename).toBe("site.pdf");
  });

  it("stores optional fileSizeBytes when provided", async () => {
    const res = await request(app)
      .post(`/api/jobs/${jobId}/files`)
      .set("Authorization", auth(tenant))
      .send({
        filename: "big.pdf",
        storagePath: "/objects/tenants/test/big.pdf",
        fileSizeBytes: 204800,
      });

    expect(res.status).toBe(201);
    expect(res.body.fileSizeBytes).toBe(204800);
  });

  it("returns 400 when filename is missing", async () => {
    const res = await request(app)
      .post(`/api/jobs/${jobId}/files`)
      .set("Authorization", auth(tenant))
      .send({ storagePath: "/objects/tenants/test/plan.pdf" });

    expect(res.status).toBe(400);
  });

  it("returns 400 when storagePath is missing", async () => {
    const res = await request(app)
      .post(`/api/jobs/${jobId}/files`)
      .set("Authorization", auth(tenant))
      .send({ filename: "plan.pdf" });

    expect(res.status).toBe(400);
  });

  it("increments the job fileCount after uploading", async () => {
    await request(app)
      .post(`/api/jobs/${jobId}/files`)
      .set("Authorization", auth(tenant))
      .send({ filename: "a.pdf", storagePath: "/objects/a.pdf" });

    await request(app)
      .post(`/api/jobs/${jobId}/files`)
      .set("Authorization", auth(tenant))
      .send({ filename: "b.pdf", storagePath: "/objects/b.pdf" });

    const [job] = await db
      .select()
      .from(jobsTable)
      .where(eq(jobsTable.id, jobId));

    expect(job.fileCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// GET /jobs/:jobId/files – list
// ---------------------------------------------------------------------------

describe("GET /api/jobs/:jobId/files", () => {
  it("returns an empty array when the job has no files", async () => {
    const res = await request(app)
      .get(`/api/jobs/${jobId}/files`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  it("returns all files belonging to the job", async () => {
    await request(app)
      .post(`/api/jobs/${jobId}/files`)
      .set("Authorization", auth(tenant))
      .send({ filename: "a.pdf", storagePath: "/objects/a.pdf" });

    await request(app)
      .post(`/api/jobs/${jobId}/files`)
      .set("Authorization", auth(tenant))
      .send({ filename: "b.pdf", storagePath: "/objects/b.pdf" });

    const res = await request(app)
      .get(`/api/jobs/${jobId}/files`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body.length).toBe(2);
  });

  it("does not return files from a different job", async () => {
    const otherJobId = uid("job");
    await db.insert(jobsTable).values({
      id: otherJobId,
      tenantId: tenant.tenantId,
      name: "Other Job",
      status: "pending",
    });

    await request(app)
      .post(`/api/jobs/${otherJobId}/files`)
      .set("Authorization", auth(tenant))
      .send({ filename: "other.pdf", storagePath: "/objects/other.pdf" });

    await request(app)
      .post(`/api/jobs/${jobId}/files`)
      .set("Authorization", auth(tenant))
      .send({ filename: "mine.pdf", storagePath: "/objects/mine.pdf" });

    const res = await request(app)
      .get(`/api/jobs/${jobId}/files`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].filename).toBe("mine.pdf");
  });

  it("does not return files from a different tenant", async () => {
    const other = await seedRegularTenant();
    trackedTenantIds.push(other.tenantId);

    const otherJobId = uid("job");
    await db.insert(jobsTable).values({
      id: otherJobId,
      tenantId: other.tenantId,
      name: "Other Tenant Job",
      status: "pending",
    });

    await request(app)
      .post(`/api/jobs/${otherJobId}/files`)
      .set("Authorization", auth(other))
      .send({ filename: "theirs.pdf", storagePath: "/objects/theirs.pdf" });

    const res = await request(app)
      .get(`/api/jobs/${otherJobId}/files`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });
});
