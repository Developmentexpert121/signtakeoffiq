import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { db, jobsTable } from "@workspace/db";
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

async function insertJob(
  tenantId: string,
  overrides: Partial<{
    status: string;
    totalSigns: number;
    highConfidence: number;
    needsReview: number;
    aiTokenCost: string;
  }> = {},
) {
  const jobId = uid("job");
  await db.insert(jobsTable).values({
    id: jobId,
    tenantId,
    name: `Job ${jobId}`,
    status: overrides.status ?? "pending",
    totalSigns: overrides.totalSigns ?? 0,
    highConfidence: overrides.highConfidence ?? 0,
    needsReview: overrides.needsReview ?? 0,
    aiTokenCost: overrides.aiTokenCost ?? "0",
  });
  return jobId;
}

// ---------------------------------------------------------------------------
// Authentication guard
// ---------------------------------------------------------------------------

describe("dashboard routes – auth guard", () => {
  it("returns 401 for /dashboard/summary when no Authorization header is provided", async () => {
    const res = await request(app).get("/api/dashboard/summary");
    expect(res.status).toBe(401);
  });

  it("returns 401 for /dashboard/summary when an invalid token is provided", async () => {
    const res = await request(app)
      .get("/api/dashboard/summary")
      .set("Authorization", "Bearer not-a-real-token");
    expect(res.status).toBe(401);
  });

  it("returns 401 for /dashboard/recent-jobs when no Authorization header is provided", async () => {
    const res = await request(app).get("/api/dashboard/recent-jobs");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /api/dashboard/summary
// ---------------------------------------------------------------------------

describe("GET /api/dashboard/summary", () => {
  it("returns zero counts when the tenant has no jobs", async () => {
    const res = await request(app)
      .get("/api/dashboard/summary")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      totalJobs: 0,
      activeJobs: 0,
      completedJobs: 0,
      totalSigns: 0,
      totalHighConfidence: 0,
      totalNeedsReview: 0,
      totalAiCost: 0,
    });
  });

  it("counts jobs by status correctly", async () => {
    await insertJob(tenant.tenantId, { status: "completed" });
    await insertJob(tenant.tenantId, { status: "processing" });
    await insertJob(tenant.tenantId, { status: "pending" });
    await insertJob(tenant.tenantId, { status: "failed" });

    const res = await request(app)
      .get("/api/dashboard/summary")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body.totalJobs).toBe(4);
    expect(res.body.completedJobs).toBe(1);
    expect(res.body.activeJobs).toBe(2);
  });

  it("sums sign counts across multiple jobs", async () => {
    await insertJob(tenant.tenantId, {
      totalSigns: 10,
      highConfidence: 8,
      needsReview: 2,
    });
    await insertJob(tenant.tenantId, {
      totalSigns: 5,
      highConfidence: 3,
      needsReview: 2,
    });

    const res = await request(app)
      .get("/api/dashboard/summary")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body.totalSigns).toBe(15);
    expect(res.body.totalHighConfidence).toBe(11);
    expect(res.body.totalNeedsReview).toBe(4);
  });

  it("sums aiTokenCost across multiple jobs", async () => {
    await insertJob(tenant.tenantId, { aiTokenCost: "1.50" });
    await insertJob(tenant.tenantId, { aiTokenCost: "2.25" });

    const res = await request(app)
      .get("/api/dashboard/summary")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body.totalAiCost).toBeCloseTo(3.75);
  });

  it("treats null aiTokenCost as zero", async () => {
    await insertJob(tenant.tenantId, { aiTokenCost: undefined });

    const res = await request(app)
      .get("/api/dashboard/summary")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body.totalAiCost).toBe(0);
  });

  it("does not include jobs from another tenant in the summary", async () => {
    const other = await seedRegularTenant();
    trackedTenantIds.push(other.tenantId);

    await insertJob(other.tenantId, {
      status: "completed",
      totalSigns: 99,
      highConfidence: 90,
      needsReview: 9,
      aiTokenCost: "50.00",
    });

    const res = await request(app)
      .get("/api/dashboard/summary")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body.totalJobs).toBe(0);
    expect(res.body.totalSigns).toBe(0);
    expect(res.body.totalAiCost).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GET /api/dashboard/recent-jobs
// ---------------------------------------------------------------------------

describe("GET /api/dashboard/recent-jobs", () => {
  it("returns an empty array when the tenant has no jobs", async () => {
    const res = await request(app)
      .get("/api/dashboard/recent-jobs")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  it("returns jobs belonging to the tenant", async () => {
    await insertJob(tenant.tenantId, { status: "completed" });
    await insertJob(tenant.tenantId, { status: "pending" });

    const res = await request(app)
      .get("/api/dashboard/recent-jobs")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  it("defaults to returning at most 5 jobs", async () => {
    for (let i = 0; i < 7; i++) {
      await insertJob(tenant.tenantId, { status: "completed" });
    }

    const res = await request(app)
      .get("/api/dashboard/recent-jobs")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(5);
  });

  it("respects the limit query parameter", async () => {
    for (let i = 0; i < 4; i++) {
      await insertJob(tenant.tenantId, { status: "completed" });
    }

    const res = await request(app)
      .get("/api/dashboard/recent-jobs?limit=2")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  it("does not return jobs from another tenant", async () => {
    const other = await seedRegularTenant();
    trackedTenantIds.push(other.tenantId);

    await insertJob(other.tenantId, { status: "completed" });

    const res = await request(app)
      .get("/api/dashboard/recent-jobs")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });

  it("serializes aiTokenCost as a number", async () => {
    await insertJob(tenant.tenantId, { aiTokenCost: "3.14" });

    const res = await request(app)
      .get("/api/dashboard/recent-jobs")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(typeof res.body[0].aiTokenCost).toBe("number");
    expect(res.body[0].aiTokenCost).toBeCloseTo(3.14);
  });

  it("serializes metadata as an object even when null in the database", async () => {
    await insertJob(tenant.tenantId);

    const res = await request(app)
      .get("/api/dashboard/recent-jobs")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body[0].metadata).toBeDefined();
    expect(typeof res.body[0].metadata).toBe("object");
  });
});
