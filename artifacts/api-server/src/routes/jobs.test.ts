import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { eq, and } from "drizzle-orm";
import { db, jobsTable, roomsTable, signsTable } from "@workspace/db";
import { SIGN_COLORS, DEFAULT_SIGN_COLOR } from "../lib/signColors";
import { createTestApp } from "../__tests__/testApp";
import {
  cleanupTenants,
  seedRegularTenant,
  uid,
} from "../__tests__/fixtures";
import type { SeededRegularTenant } from "../__tests__/fixtures";

vi.mock("../lib/pipeline", () => ({
  processJob: vi.fn().mockResolvedValue(undefined),
  ESTIMATED_SECONDS_PER_SHEET: 30,
}));

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createJob(t: SeededRegularTenant, overrides: Record<string, unknown> = {}) {
  return request(app)
    .post("/api/jobs")
    .set("Authorization", auth(t))
    .send({ name: "Test Job", buildingType: "commercial", ...overrides });
}

// ---------------------------------------------------------------------------
// Authentication guard
// ---------------------------------------------------------------------------

describe("jobs routes – auth guard", () => {
  it("returns 401 when no Authorization header is provided", async () => {
    const res = await request(app).get("/api/jobs");
    expect(res.status).toBe(401);
  });

  it("returns 401 when an invalid token is provided", async () => {
    const res = await request(app)
      .get("/api/jobs")
      .set("Authorization", "Bearer not-a-real-token");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /jobs – create
// ---------------------------------------------------------------------------

describe("POST /api/jobs", () => {
  it("creates a job and returns 201 with the new job", async () => {
    const res = await createJob(tenant, { name: "My First Job" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: "My First Job",
      tenantId: tenant.tenantId,
      status: "pending",
    });
    expect(res.body.id).toBeTruthy();
  });

  it("persists the created job in the database", async () => {
    const res = await createJob(tenant, { name: "Persisted Job" });
    expect(res.status).toBe(201);

    const [row] = await db
      .select()
      .from(jobsTable)
      .where(and(eq(jobsTable.id, res.body.id), eq(jobsTable.tenantId, tenant.tenantId)));

    expect(row).toBeDefined();
    expect(row.name).toBe("Persisted Job");
    expect(row.status).toBe("pending");
  });

  it("stores optional fields when provided", async () => {
    const res = await createJob(tenant, {
      name: "Detailed Job",
      location: "123 Main St",
      jurisdiction: "CA",
      buildingType: "commercial",
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      location: "123 Main St",
      jurisdiction: "CA",
      buildingType: "commercial",
    });
  });

  it("returns 400 when name is missing", async () => {
    const res = await request(app)
      .post("/api/jobs")
      .set("Authorization", auth(tenant))
      .send({});

    expect(res.status).toBe(400);
  });

  it("accepts visionThreshold of 0 (off)", async () => {
    const res = await createJob(tenant, { name: "Threshold Zero", visionThreshold: 0 });
    expect(res.status).toBe(201);
    expect(res.body.visionThreshold).toBe(0);
  });

  it("accepts visionThreshold of 50 (maximum)", async () => {
    const res = await createJob(tenant, { name: "Threshold Max", visionThreshold: 50 });
    expect(res.status).toBe(201);
    expect(res.body.visionThreshold).toBe(50);
  });

  it("rejects visionThreshold above 50 with 422", async () => {
    const res = await createJob(tenant, { name: "Threshold Over Max", visionThreshold: 51 });
    expect(res.status).toBe(422);
    expect(res.body.error).toBeTruthy();
  });

  it("rejects a missing buildingType with 400", async () => {
    const res = await request(app)
      .post("/api/jobs")
      .set("Authorization", auth(tenant))
      .send({ name: "No Type Job" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/buildingType is required/);
  });

  it("rejects an invalid buildingType with 400", async () => {
    const res = await createJob(tenant, { name: "Bad Type Job", buildingType: "office" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid building type/);
  });

  it("accepts all 8 canonical buildingType values", async () => {
    const canonicalTypes = ["commercial", "residential", "education", "healthcare", "government", "hotel", "assembly", "unknown"];
    for (const bt of canonicalTypes) {
      const res = await createJob(tenant, { name: `Type ${bt}`, buildingType: bt });
      expect(res.status, `Expected 201 for buildingType "${bt}"`).toBe(201);
    }
  });

  it("rejects negative visionThreshold with 422", async () => {
    const res = await createJob(tenant, { name: "Threshold Negative", visionThreshold: -1 });
    expect(res.status).toBe(422);
    expect(res.body.error).toBeTruthy();
  });

  it("does not return jobs belonging to a different tenant", async () => {
    const other = await seedRegularTenant();
    trackedTenantIds.push(other.tenantId);

    const createRes = await createJob(other, { name: "Other Tenant Job" });
    expect(createRes.status).toBe(201);
    const otherJobId = createRes.body.id;

    const getRes = await request(app)
      .get(`/api/jobs/${otherJobId}`)
      .set("Authorization", auth(tenant));

    expect(getRes.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /jobs – list
// ---------------------------------------------------------------------------

describe("GET /api/jobs", () => {
  it("returns an empty array when the tenant has no jobs", async () => {
    const res = await request(app)
      .get("/api/jobs")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  it("returns only jobs belonging to the authenticated tenant", async () => {
    const other = await seedRegularTenant();
    trackedTenantIds.push(other.tenantId);

    await createJob(tenant, { name: "Tenant A Job" });
    await createJob(other, { name: "Tenant B Job" });

    const res = await request(app)
      .get("/api/jobs")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].name).toBe("Tenant A Job");
  });

  it("returns multiple jobs for the tenant", async () => {
    await createJob(tenant, { name: "Job Alpha" });
    await createJob(tenant, { name: "Job Beta" });
    await createJob(tenant, { name: "Job Gamma" });

    const res = await request(app)
      .get("/api/jobs")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body.length).toBe(3);
  });

  it("respects the limit query parameter", async () => {
    await createJob(tenant, { name: "Job 1" });
    await createJob(tenant, { name: "Job 2" });
    await createJob(tenant, { name: "Job 3" });

    const res = await request(app)
      .get("/api/jobs?limit=2")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// GET /jobs/:jobId – read single
// ---------------------------------------------------------------------------

describe("GET /api/jobs/:jobId", () => {
  it("returns the job when it exists and belongs to the tenant", async () => {
    const createRes = await createJob(tenant, { name: "Readable Job" });
    const jobId = createRes.body.id;

    const res = await request(app)
      .get(`/api/jobs/${jobId}`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: jobId, name: "Readable Job" });
  });

  it("returns 404 for a non-existent job", async () => {
    const res = await request(app)
      .get("/api/jobs/job_doesnotexist")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PATCH /jobs/:jobId – update
// ---------------------------------------------------------------------------

describe("PATCH /api/jobs/:jobId", () => {
  it("updates the job name and returns the updated job", async () => {
    const createRes = await createJob(tenant, { name: "Old Name" });
    const jobId = createRes.body.id;

    const res = await request(app)
      .patch(`/api/jobs/${jobId}`)
      .set("Authorization", auth(tenant))
      .send({ name: "New Name" });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("New Name");
  });

  it("updates the job status", async () => {
    const createRes = await createJob(tenant, { name: "Status Job" });
    const jobId = createRes.body.id;

    const res = await request(app)
      .patch(`/api/jobs/${jobId}`)
      .set("Authorization", auth(tenant))
      .send({ status: "completed" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("completed");

    const [row] = await db
      .select()
      .from(jobsTable)
      .where(eq(jobsTable.id, jobId));
    expect(row.status).toBe("completed");
  });

  it("returns 404 when patching a non-existent job", async () => {
    const res = await request(app)
      .patch("/api/jobs/job_doesnotexist")
      .set("Authorization", auth(tenant))
      .send({ name: "Anything" });

    expect(res.status).toBe(404);
  });

  it("accepts visionThreshold of 50 when updating", async () => {
    const createRes = await createJob(tenant, { name: "Threshold Update Job" });
    const jobId = createRes.body.id;

    const res = await request(app)
      .patch(`/api/jobs/${jobId}`)
      .set("Authorization", auth(tenant))
      .send({ visionThreshold: 50 });

    expect(res.status).toBe(200);
    expect(res.body.visionThreshold).toBe(50);
  });

  it("rejects visionThreshold above 50 via PATCH with 422", async () => {
    const createRes = await createJob(tenant, { name: "Threshold PATCH Over Max" });
    const jobId = createRes.body.id;

    const res = await request(app)
      .patch(`/api/jobs/${jobId}`)
      .set("Authorization", auth(tenant))
      .send({ visionThreshold: 51 });

    expect(res.status).toBe(422);
    expect(res.body.error).toBeTruthy();
  });

  it("rejects negative visionThreshold via PATCH with 422", async () => {
    const createRes = await createJob(tenant, { name: "Threshold PATCH Negative" });
    const jobId = createRes.body.id;

    const res = await request(app)
      .patch(`/api/jobs/${jobId}`)
      .set("Authorization", auth(tenant))
      .send({ visionThreshold: -1 });

    expect(res.status).toBe(422);
    expect(res.body.error).toBeTruthy();
  });

  it("cannot patch a job belonging to another tenant", async () => {
    const other = await seedRegularTenant();
    trackedTenantIds.push(other.tenantId);

    const createRes = await createJob(other, { name: "Other Job" });
    const jobId = createRes.body.id;

    const res = await request(app)
      .patch(`/api/jobs/${jobId}`)
      .set("Authorization", auth(tenant))
      .send({ name: "Hijacked Name" });

    expect(res.status).toBe(404);

    const [row] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId));
    expect(row.name).toBe("Other Job");
  });
});

// ---------------------------------------------------------------------------
// DELETE /jobs/:jobId – archive
// ---------------------------------------------------------------------------

describe("DELETE /api/jobs/:jobId", () => {
  it("returns 204 and sets status to archived", async () => {
    const createRes = await createJob(tenant, { name: "To Archive" });
    const jobId = createRes.body.id;

    const res = await request(app)
      .delete(`/api/jobs/${jobId}`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(204);

    const [row] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId));
    expect(row.status).toBe("archived");
  });

  it("does not remove the job row from the database", async () => {
    const createRes = await createJob(tenant, { name: "Soft Delete Job" });
    const jobId = createRes.body.id;

    await request(app)
      .delete(`/api/jobs/${jobId}`)
      .set("Authorization", auth(tenant));

    const [row] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId));
    expect(row).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// POST /jobs/:jobId/process – pipeline trigger
// ---------------------------------------------------------------------------

describe("POST /api/jobs/:jobId/process", () => {
  it("returns 202 and sets status to processing", async () => {
    const createRes = await createJob(tenant, { name: "Pipeline Job" });
    const jobId = createRes.body.id;

    const res = await request(app)
      .post(`/api/jobs/${jobId}/process`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ jobId, status: "processing" });
  });

  it("sets the job status to processing in the DB", async () => {
    const createRes = await createJob(tenant, { name: "DB Status Job" });
    const jobId = createRes.body.id;

    await request(app)
      .post(`/api/jobs/${jobId}/process`)
      .set("Authorization", auth(tenant));

    const [row] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId));
    expect(row.status).toBe("processing");
  });

  it("writes estimatedSecondsPerSheet into initial job metadata", async () => {
    const createRes = await createJob(tenant, { name: "Metadata Estimate Job" });
    const jobId = createRes.body.id;

    await request(app)
      .post(`/api/jobs/${jobId}/process`)
      .set("Authorization", auth(tenant));

    const [row] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId));
    const meta = row.metadata as Record<string, unknown>;
    expect(typeof meta.estimatedSecondsPerSheet).toBe("number");
    expect(meta.estimatedSecondsPerSheet).toBeGreaterThan(0);
  });

  it("writes a valid ISO processingStartedAt timestamp into job metadata", async () => {
    const before = new Date();
    const createRes = await createJob(tenant, { name: "Process Start Time Job" });
    const jobId = createRes.body.id;

    await request(app)
      .post(`/api/jobs/${jobId}/process`)
      .set("Authorization", auth(tenant));

    const after = new Date();
    const [row] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId));
    const meta = row.metadata as Record<string, unknown>;
    expect(typeof meta.processingStartedAt).toBe("string");
    const parsed = new Date(meta.processingStartedAt as string);
    expect(isNaN(parsed.getTime())).toBe(false);
    expect(parsed.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(parsed.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("returns 409 when the job is already processing", async () => {
    const createRes = await createJob(tenant, { name: "Already Processing Job" });
    const jobId = createRes.body.id;

    await request(app)
      .post(`/api/jobs/${jobId}/process`)
      .set("Authorization", auth(tenant));

    const res = await request(app)
      .post(`/api/jobs/${jobId}/process`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(409);
  });

  it("returns 404 for a non-existent job", async () => {
    const res = await request(app)
      .post("/api/jobs/job_doesnotexist/process")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(404);
  });

  it("returns 404 when trying to process a job from another tenant", async () => {
    const other = await seedRegularTenant();
    trackedTenantIds.push(other.tenantId);

    const createRes = await createJob(other, { name: "Other Pipeline Job" });
    const jobId = createRes.body.id;

    const res = await request(app)
      .post(`/api/jobs/${jobId}/process`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /jobs/:jobId/rescan – rescan trigger
// ---------------------------------------------------------------------------

describe("POST /api/jobs/:jobId/rescan", () => {
  it("returns 202 when triggering a rescan on a pending job", async () => {
    const createRes = await createJob(tenant, { name: "Rescan Job" });
    const jobId = createRes.body.id;

    const res = await request(app)
      .post(`/api/jobs/${jobId}/rescan`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ jobId, status: "processing" });
  });

  it("writes estimatedSecondsPerSheet into initial job metadata", async () => {
    const createRes = await createJob(tenant, { name: "Rescan Metadata Estimate Job" });
    const jobId = createRes.body.id;

    await request(app)
      .post(`/api/jobs/${jobId}/rescan`)
      .set("Authorization", auth(tenant));

    const [row] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId));
    const meta = row.metadata as Record<string, unknown>;
    expect(typeof meta.estimatedSecondsPerSheet).toBe("number");
    expect(meta.estimatedSecondsPerSheet).toBeGreaterThan(0);
  });

  it("writes a valid ISO processingStartedAt timestamp into job metadata", async () => {
    const before = new Date();
    const createRes = await createJob(tenant, { name: "Rescan Start Time Job" });
    const jobId = createRes.body.id;

    await request(app)
      .post(`/api/jobs/${jobId}/rescan`)
      .set("Authorization", auth(tenant));

    const after = new Date();
    const [row] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId));
    const meta = row.metadata as Record<string, unknown>;
    expect(typeof meta.processingStartedAt).toBe("string");
    const parsed = new Date(meta.processingStartedAt as string);
    expect(isNaN(parsed.getTime())).toBe(false);
    expect(parsed.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(parsed.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("returns 409 when the job is already processing", async () => {
    const createRes = await createJob(tenant, { name: "Concurrent Rescan Job" });
    const jobId = createRes.body.id;

    await request(app)
      .post(`/api/jobs/${jobId}/rescan`)
      .set("Authorization", auth(tenant));

    const res = await request(app)
      .post(`/api/jobs/${jobId}/rescan`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(409);
  });

  it("returns 404 for a non-existent job", async () => {
    const res = await request(app)
      .post("/api/jobs/job_doesnotexist/rescan")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /jobs/:jobId/confidence-histogram
// ---------------------------------------------------------------------------

type HistogramBucket = { bucket: string; minConfidence: number; maxConfidence: number; count: number };

describe("GET /api/jobs/:jobId/confidence-histogram", () => {
  it("returns 401 when no Authorization header is provided", async () => {
    const createRes = await createJob(tenant, { name: "Histogram Auth Job" });
    const jobId = createRes.body.id;

    const res = await request(app).get(`/api/jobs/${jobId}/confidence-histogram`);
    expect(res.status).toBe(401);
  });

  it("returns an empty array when no AI-detected rooms exist", async () => {
    const createRes = await createJob(tenant, { name: "Empty Histogram Job" });
    const jobId = createRes.body.id;

    const res = await request(app)
      .get(`/api/jobs/${jobId}/confidence-histogram`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns correct bucket counts, ranges, and total coverage for a known set of AI rooms", async () => {
    const createRes = await createJob(tenant, { name: "Histogram Counts Job" });
    const jobId = createRes.body.id;

    await db.insert(roomsTable).values([
      { id: uid("room"), jobId, tenantId: tenant.tenantId, roomNumber: "101", roomName: "Office A", source: "ai_vision", confidence: "0.9500" },
      { id: uid("room"), jobId, tenantId: tenant.tenantId, roomNumber: "102", roomName: "Office B", source: "ai_vision", confidence: "0.9000" },
      { id: uid("room"), jobId, tenantId: tenant.tenantId, roomNumber: "103", roomName: "Office C", source: "ai_vision", confidence: "0.8500" },
      { id: uid("room"), jobId, tenantId: tenant.tenantId, roomNumber: "104", roomName: "Office D", source: "ai_vision", confidence: "0.7000" },
      { id: uid("room"), jobId, tenantId: tenant.tenantId, roomNumber: "105", roomName: "Office E", source: "ai_vision", confidence: "0.6000" },
      { id: uid("room"), jobId, tenantId: tenant.tenantId, roomNumber: "106", roomName: "Office F", source: "ai_vision", confidence: "0.5000" },
      { id: uid("room"), jobId, tenantId: tenant.tenantId, roomNumber: "107", roomName: "Office G", source: "ai_vision", confidence: "0.3000" },
    ]);

    const res = await request(app)
      .get(`/api/jobs/${jobId}/confidence-histogram`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(4);

    const b = res.body as HistogramBucket[];
    const lt50   = b.find(x => x.bucket === "< 50%");
    const b5059  = b.find(x => x.bucket === "50\u201359%");
    const b6079  = b.find(x => x.bucket === "60\u201379%");
    const b80100 = b.find(x => x.bucket === "80\u2013100%");

    expect(lt50).toBeDefined();
    expect(b5059).toBeDefined();
    expect(b6079).toBeDefined();
    expect(b80100).toBeDefined();

    // 0.30 falls in < 50%
    expect(lt50!.count).toBe(1);
    expect(lt50!.minConfidence).toBe(0.00);
    expect(lt50!.maxConfidence).toBe(0.50);

    // 0.50 falls in 50–59%
    expect(b5059!.count).toBe(1);
    expect(b5059!.minConfidence).toBe(0.50);
    expect(b5059!.maxConfidence).toBe(0.60);

    // 0.60, 0.70 fall in 60–79%
    expect(b6079!.count).toBe(2);
    expect(b6079!.minConfidence).toBe(0.60);
    expect(b6079!.maxConfidence).toBe(0.80);

    // 0.85, 0.90, 0.95 fall in 80–100%
    expect(b80100!.count).toBe(3);
    expect(b80100!.minConfidence).toBe(0.80);
    expect(b80100!.maxConfidence).toBe(1.00);

    const total = b.reduce((sum, x) => sum + x.count, 0);
    expect(total).toBe(7);
  });

  it("does not count non-AI-vision rooms (pdf-sourced rooms are excluded)", async () => {
    const createRes = await createJob(tenant, { name: "Histogram Source Filter Job" });
    const jobId = createRes.body.id;

    await db.insert(roomsTable).values([
      { id: uid("room"), jobId, tenantId: tenant.tenantId, roomNumber: "201", roomName: "PDF Room", source: "pdf", confidence: "0.9500" },
      { id: uid("room"), jobId, tenantId: tenant.tenantId, roomNumber: "202", roomName: "AI Room", source: "ai_vision", confidence: "0.9500" },
    ]);

    const res = await request(app)
      .get(`/api/jobs/${jobId}/confidence-histogram`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);

    const total = (res.body as HistogramBucket[]).reduce((sum, b) => sum + b.count, 0);
    expect(total).toBe(1);
  });

  it("does not include AI rooms from a different tenant's job", async () => {
    const other = await seedRegularTenant();
    trackedTenantIds.push(other.tenantId);

    const createRes = await createJob(tenant, { name: "Histogram Tenant Job" });
    const jobId = createRes.body.id;

    const otherCreateRes = await createJob(other, { name: "Other Tenant Job" });
    const otherJobId = otherCreateRes.body.id;

    await db.insert(roomsTable).values([
      { id: uid("room"), jobId: otherJobId, tenantId: other.tenantId, roomNumber: "301", roomName: "Other Room", source: "ai_vision", confidence: "0.9500" },
    ]);

    const res = await request(app)
      .get(`/api/jobs/${jobId}/confidence-histogram`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GET /jobs/:jobId/sign-type-distribution
// ---------------------------------------------------------------------------

describe("GET /api/jobs/:jobId/sign-type-distribution", () => {
  let jobId: string;

  beforeEach(async () => {
    jobId = uid("job");
    await db.insert(jobsTable).values({
      id: jobId,
      tenantId: tenant.tenantId,
      name: "Distribution Test Job",
      status: "pending",
    });
  });

  it("returns 401 without an Authorization header", async () => {
    const res = await request(app).get(`/api/jobs/${jobId}/sign-type-distribution`);
    expect(res.status).toBe(401);
  });

  it("returns 401 with an invalid token", async () => {
    const res = await request(app)
      .get(`/api/jobs/${jobId}/sign-type-distribution`)
      .set("Authorization", "Bearer not-a-real-token");
    expect(res.status).toBe(401);
  });

  it("returns an empty array when the job has no signs", async () => {
    const res = await request(app)
      .get(`/api/jobs/${jobId}/sign-type-distribution`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns correct signType counts and known colors", async () => {
    await db.insert(signsTable).values([
      { id: uid("s"), jobId, tenantId: tenant.tenantId, signType: "Exit", qty: 3 },
      { id: uid("s"), jobId, tenantId: tenant.tenantId, signType: "Exit", qty: 2 },
      { id: uid("s"), jobId, tenantId: tenant.tenantId, signType: "Restroom", qty: 1 },
    ]);

    const res = await request(app)
      .get(`/api/jobs/${jobId}/sign-type-distribution`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);

    const exitEntry = res.body.find((e: { signType: string }) => e.signType === "Exit");
    const restroomEntry = res.body.find((e: { signType: string }) => e.signType === "Restroom");

    expect(exitEntry).toMatchObject({ signType: "Exit", count: 5, color: SIGN_COLORS["Exit"] });
    expect(restroomEntry).toMatchObject({ signType: "Restroom", count: 1, color: SIGN_COLORS["Restroom"] });
  });

  it("uses fallback color for an unknown sign type", async () => {
    await db.insert(signsTable).values([
      { id: uid("s"), jobId, tenantId: tenant.tenantId, signType: "Custom Mystery Sign", qty: 2 },
    ]);

    const res = await request(app)
      .get(`/api/jobs/${jobId}/sign-type-distribution`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    const entry = res.body.find((e: { signType: string }) => e.signType === "Custom Mystery Sign");
    expect(entry).toMatchObject({ signType: "Custom Mystery Sign", count: 2, color: DEFAULT_SIGN_COLOR });
  });

  it("excludes soft-deleted signs from the distribution", async () => {
    await db.insert(signsTable).values([
      { id: uid("s"), jobId, tenantId: tenant.tenantId, signType: "Evac Map", qty: 4 },
      { id: uid("s"), jobId, tenantId: tenant.tenantId, signType: "Evac Map", qty: 1, isDeleted: true },
    ]);

    const res = await request(app)
      .get(`/api/jobs/${jobId}/sign-type-distribution`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    const entry = res.body.find((e: { signType: string }) => e.signType === "Evac Map");
    expect(entry).toMatchObject({ count: 4 });
  });

  it("excludes signs belonging to a different tenant", async () => {
    const otherTenant = await seedRegularTenant();
    trackedTenantIds.push(otherTenant.tenantId);

    const otherJobId = uid("job");
    await db.insert(jobsTable).values({
      id: otherJobId,
      tenantId: otherTenant.tenantId,
      name: "Other Tenant Job",
      status: "pending",
    });

    await db.insert(signsTable).values([
      { id: uid("s"), jobId, tenantId: tenant.tenantId, signType: "Room ID", qty: 2 },
      { id: uid("s"), jobId: otherJobId, tenantId: otherTenant.tenantId, signType: "Room ID", qty: 99 },
    ]);

    const res = await request(app)
      .get(`/api/jobs/${jobId}/sign-type-distribution`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    const entry = res.body.find((e: { signType: string }) => e.signType === "Room ID");
    expect(entry).toMatchObject({ count: 2 });
  });

  it("covers all color-mapped sign types from SIGN_COLORS", async () => {
    const knownTypes = Object.keys(SIGN_COLORS);

    await db.insert(signsTable).values(
      knownTypes.map((signType) => ({
        id: uid("s"),
        jobId,
        tenantId: tenant.tenantId,
        signType,
        qty: 1,
      })),
    );

    const res = await request(app)
      .get(`/api/jobs/${jobId}/sign-type-distribution`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);

    for (const signType of knownTypes) {
      const entry = res.body.find((e: { signType: string }) => e.signType === signType);
      expect(entry).toMatchObject({ signType, count: 1, color: SIGN_COLORS[signType] });
    }
  });

  it("every entry in SIGN_COLORS has a unique, valid hex color", () => {
    const hexPattern = /^#[0-9a-f]{6}$/i;

    for (const [type, color] of Object.entries(SIGN_COLORS)) {
      expect(color, `Color for "${type}" must be a valid hex color`).toMatch(hexPattern);
    }

    const unique = new Set(Object.values(SIGN_COLORS));
    expect(unique.size).toBe(Object.keys(SIGN_COLORS).length);
  });
});
