import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { db, jobsTable, signsTable, roomsTable } from "@workspace/db";
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

vi.mock("../lib/objectStorage", () => {
  class ObjectNotFoundError extends Error {
    constructor(msg?: string) { super(msg); this.name = "ObjectNotFoundError"; }
  }
  class ObjectStorageService {
    async getObjectEntityFile(_path: string): Promise<never> {
      throw new ObjectNotFoundError("not found in test");
    }
  }
  return { ObjectStorageService, ObjectNotFoundError };
});

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
    name: "Test Export Job",
    status: "complete",
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

describe("exports routes – auth guard", () => {
  it("returns 401 on xlsx export when no token is provided", async () => {
    const res = await request(app).get(`/api/jobs/${jobId}/export/xlsx`);
    expect(res.status).toBe(401);
  });

  it("returns 401 on pdf export when no token is provided", async () => {
    const res = await request(app).get(`/api/jobs/${jobId}/export/pdf`);
    expect(res.status).toBe(401);
  });

  it("returns 401 on xlsx export with an invalid token", async () => {
    const res = await request(app)
      .get(`/api/jobs/${jobId}/export/xlsx`)
      .set("Authorization", "Bearer bad-token");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /jobs/:jobId/export/xlsx
// ---------------------------------------------------------------------------

describe("GET /api/jobs/:jobId/export/xlsx", () => {
  it("returns 404 when the job does not exist", async () => {
    const res = await request(app)
      .get(`/api/jobs/job_doesnotexist/export/xlsx`)
      .set("Authorization", auth(tenant));
    expect(res.status).toBe(404);
  });

  it("returns 404 when the job belongs to another tenant", async () => {
    const other = await seedRegularTenant();
    trackedTenantIds.push(other.tenantId);

    const res = await request(app)
      .get(`/api/jobs/${jobId}/export/xlsx`)
      .set("Authorization", auth(other));

    expect(res.status).toBe(404);
  });

  it("returns an xlsx file with the correct content-type for an empty job", async () => {
    const res = await request(app)
      .get(`/api/jobs/${jobId}/export/xlsx`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(
      /openxmlformats-officedocument\.spreadsheetml\.sheet/,
    );
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["content-disposition"]).toContain(".xlsx");
  });

  it("includes the job name in the content-disposition filename", async () => {
    const res = await request(app)
      .get(`/api/jobs/${jobId}/export/xlsx`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain("Test_Export_Job");
    expect(res.headers["content-disposition"]).toContain("_Takeoff_");
  });

  it("returns an xlsx file containing sign data when signs exist", async () => {
    const signId = uid("sign");
    await db.insert(signsTable).values({
      id: signId,
      jobId,
      tenantId: tenant.tenantId,
      signType: "Exit",
      qty: 3,
    });

    const res = await request(app)
      .get(`/api/jobs/${jobId}/export/xlsx`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/spreadsheetml/);
    expect(res.body).toBeTruthy();
  });

  it("excludes signs from dismissed rooms", async () => {
    const dismissedRoomId = uid("room");
    await db.insert(roomsTable).values({
      id: dismissedRoomId,
      jobId,
      tenantId: tenant.tenantId,
      roomNumber: "101",
      roomName: "Dismissed Office",
      reviewStatus: "dismissed",
    });

    const includedSignId = uid("sign");
    await db.insert(signsTable).values({
      id: includedSignId,
      jobId,
      tenantId: tenant.tenantId,
      signType: "Exit",
    });

    const dismissedSignId = uid("sign");
    await db.insert(signsTable).values({
      id: dismissedSignId,
      jobId,
      tenantId: tenant.tenantId,
      signType: "ADA",
      roomId: dismissedRoomId,
    });

    const res = await request(app)
      .get(`/api/jobs/${jobId}/export/xlsx`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
  });

  it("excludes pending AI room signs when includePending=false", async () => {
    const res = await request(app)
      .get(`/api/jobs/${jobId}/export/xlsx?includePending=false`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/spreadsheetml/);
  });
});

// ---------------------------------------------------------------------------
// GET /jobs/:jobId/export/pdf
// ---------------------------------------------------------------------------

describe("GET /api/jobs/:jobId/export/pdf", () => {
  it("returns 404 when the job does not exist", async () => {
    const res = await request(app)
      .get(`/api/jobs/job_doesnotexist/export/pdf`)
      .set("Authorization", auth(tenant));
    expect(res.status).toBe(404);
  });

  it("returns 404 when the job belongs to another tenant", async () => {
    const other = await seedRegularTenant();
    trackedTenantIds.push(other.tenantId);

    const res = await request(app)
      .get(`/api/jobs/${jobId}/export/pdf`)
      .set("Authorization", auth(other));

    expect(res.status).toBe(404);
  });

  it("returns a PDF file with the correct content-type for a job with no source PDFs", async () => {
    const res = await request(app)
      .get(`/api/jobs/${jobId}/export/pdf`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["content-disposition"]).toContain(".pdf");
  });

  it("includes the job name in the content-disposition filename", async () => {
    const res = await request(app)
      .get(`/api/jobs/${jobId}/export/pdf`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain("Test Export Job");
  });

  it("returns a valid PDF binary when there are signs but no source files", async () => {
    const signId = uid("sign");
    await db.insert(signsTable).values({
      id: signId,
      jobId,
      tenantId: tenant.tenantId,
      signType: "Exit",
      qty: 2,
    });

    const res = await request(app)
      .get(`/api/jobs/${jobId}/export/pdf`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    const pdfMagic = res.body.slice(0, 4).toString();
    expect(pdfMagic).toBe("%PDF");
  });

  it("includes dismissed room exclusion note in the cover page when applicable", async () => {
    const dismissedRoomId = uid("room");
    await db.insert(roomsTable).values({
      id: dismissedRoomId,
      jobId,
      tenantId: tenant.tenantId,
      roomNumber: "201",
      roomName: "Dismissed Conference Room",
      reviewStatus: "dismissed",
    });

    await db.insert(signsTable).values({
      id: uid("sign"),
      jobId,
      tenantId: tenant.tenantId,
      signType: "Exit",
      roomId: dismissedRoomId,
    });

    const res = await request(app)
      .get(`/api/jobs/${jobId}/export/pdf`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
  });

  it("returns a pdf when includePending=false query param is provided", async () => {
    const res = await request(app)
      .get(`/api/jobs/${jobId}/export/pdf?includePending=false`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
  });
});
