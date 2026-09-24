import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";
import { db, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { uid, GUEST_TENANT_PREFIX } from "./fixtures";

/**
 * The tenantId for the seeded tenant shared across all tests in this file.
 * Populated in beforeAll, used by the mocked requireAuth closure.
 */
let testTenantId = "";

/**
 * Mock out requireAuth / requireAdmin so tests can run without Clerk credentials.
 * requireAuth injects a fake admin auth_ctx using the module-level testTenantId.
 * requireAdmin is a no-op pass-through (the injected role is already "admin").
 */
vi.mock("../lib/tenantAuth", () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    req.auth_ctx = { userId: "admin-test-user", tenantId: testTenantId, role: "admin" };
    next();
  },
  requireAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireSuperAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
  isSuperAdmin: (role: string | null | undefined) => role === "admin" || role === "super_admin",
  normalizeRole: (role: string | null | undefined) => {
    if (!role) return "user";
    if (role === "admin" || role === "super_admin") return "super_admin";
    if (role === "owner") return "owner";
    if (role === "guest") return "guest";
    return "user";
  },
}));

/**
 * Mock guestCleanup to avoid pulling in objectStorage and other heavy deps
 * that are not needed for these validation tests.
 */
vi.mock("../lib/guestCleanup", () => ({
  countExpiredGuestTenants: vi.fn(async () => 0),
  deleteExpiredGuestTenants: vi.fn(async () => ({ tenantsDeleted: 0, filesDeleted: 0, bytesRecovered: 0 })),
  getLastCleanupResult: vi.fn(async () => null),
  getCleanupHistory: vi.fn(async () => []),
  startGuestCleanupJob: vi.fn(),
}));

async function buildTestApp() {
  const { default: adminRouter } = await import("../routes/admin");
  const app = express();
  app.use(express.json());
  app.use("/api", adminRouter);
  return app;
}

let app: Awaited<ReturnType<typeof buildTestApp>>;

beforeAll(async () => {
  testTenantId = `${GUEST_TENANT_PREFIX}${uid("admin-settings-test")}`;
  await db.insert(tenantsTable).values({
    id: testTenantId,
    name: "Admin Settings Test Tenant",
    slug: uid("admin-settings-slug"),
    plan: "starter",
    settings: {},
    lastActiveAt: new Date(),
  });

  app = await buildTestApp();
});

afterAll(async () => {
  await db.delete(tenantsTable).where(eq(tenantsTable.id, testTenantId));
});

// ---------------------------------------------------------------------------
// aiRetryMax
// ---------------------------------------------------------------------------

describe("PATCH /api/admin/tenant — aiRetryMax validation", () => {
  it("accepts 0 (minimum boundary)", async () => {
    const res = await request(app)
      .patch("/api/admin/tenant")
      .send({ settings: { aiRetryMax: 0 } });
    expect(res.status).toBe(200);
  });

  it("accepts 5 (mid-range)", async () => {
    const res = await request(app)
      .patch("/api/admin/tenant")
      .send({ settings: { aiRetryMax: 5 } });
    expect(res.status).toBe(200);
  });

  it("accepts 10 (maximum boundary)", async () => {
    const res = await request(app)
      .patch("/api/admin/tenant")
      .send({ settings: { aiRetryMax: 10 } });
    expect(res.status).toBe(200);
  });

  it("rejects -1 (below minimum) with 400 and descriptive message", async () => {
    const res = await request(app)
      .patch("/api/admin/tenant")
      .send({ settings: { aiRetryMax: -1 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/aiRetryMax must be an integer between 0 and 10/);
  });

  it("rejects 11 (above maximum) with 400 and descriptive message", async () => {
    const res = await request(app)
      .patch("/api/admin/tenant")
      .send({ settings: { aiRetryMax: 11 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/aiRetryMax must be an integer between 0 and 10/);
  });

  it("rejects 999 (far out of range) with 400 and descriptive message", async () => {
    const res = await request(app)
      .patch("/api/admin/tenant")
      .send({ settings: { aiRetryMax: 999 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/aiRetryMax must be an integer between 0 and 10/);
  });

  it("rejects 1.5 (non-integer float) with 400 and descriptive message", async () => {
    const res = await request(app)
      .patch("/api/admin/tenant")
      .send({ settings: { aiRetryMax: 1.5 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/aiRetryMax must be an integer between 0 and 10/);
  });

  it('rejects "abc" (non-numeric string) with 400 and descriptive message', async () => {
    const res = await request(app)
      .patch("/api/admin/tenant")
      .send({ settings: { aiRetryMax: "abc" } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/aiRetryMax must be an integer between 0 and 10/);
  });
});

// ---------------------------------------------------------------------------
// aiCallCap
// ---------------------------------------------------------------------------

describe("PATCH /api/admin/tenant — aiCallCap validation", () => {
  it("accepts 1 (minimum boundary)", async () => {
    const res = await request(app)
      .patch("/api/admin/tenant")
      .send({ settings: { aiCallCap: 1 } });
    expect(res.status).toBe(200);
  });

  it("accepts 100 (mid-range)", async () => {
    const res = await request(app)
      .patch("/api/admin/tenant")
      .send({ settings: { aiCallCap: 100 } });
    expect(res.status).toBe(200);
  });

  it("accepts 1000 (maximum boundary)", async () => {
    const res = await request(app)
      .patch("/api/admin/tenant")
      .send({ settings: { aiCallCap: 1000 } });
    expect(res.status).toBe(200);
  });

  it("rejects 0 (below minimum) with 400 and descriptive message", async () => {
    const res = await request(app)
      .patch("/api/admin/tenant")
      .send({ settings: { aiCallCap: 0 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/aiCallCap must be an integer between 1 and 1000/);
  });

  it("rejects -1 (negative) with 400 and descriptive message", async () => {
    const res = await request(app)
      .patch("/api/admin/tenant")
      .send({ settings: { aiCallCap: -1 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/aiCallCap must be an integer between 1 and 1000/);
  });

  it("rejects 1001 (above maximum) with 400 and descriptive message", async () => {
    const res = await request(app)
      .patch("/api/admin/tenant")
      .send({ settings: { aiCallCap: 1001 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/aiCallCap must be an integer between 1 and 1000/);
  });

  it("rejects 50.5 (non-integer float) with 400 and descriptive message", async () => {
    const res = await request(app)
      .patch("/api/admin/tenant")
      .send({ settings: { aiCallCap: 50.5 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/aiCallCap must be an integer between 1 and 1000/);
  });

  it('rejects "abc" (non-numeric string) with 400 and descriptive message', async () => {
    const res = await request(app)
      .patch("/api/admin/tenant")
      .send({ settings: { aiCallCap: "abc" } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/aiCallCap must be an integer between 1 and 1000/);
  });
});

// ---------------------------------------------------------------------------
// aiVisionCallsPerRun
// ---------------------------------------------------------------------------

describe("PATCH /api/admin/tenant — aiVisionCallsPerRun validation", () => {
  it("accepts 1 (minimum boundary)", async () => {
    const res = await request(app)
      .patch("/api/admin/tenant")
      .send({ settings: { aiVisionCallsPerRun: 1 } });
    expect(res.status).toBe(200);
  });

  it("accepts 50 (mid-range)", async () => {
    const res = await request(app)
      .patch("/api/admin/tenant")
      .send({ settings: { aiVisionCallsPerRun: 50 } });
    expect(res.status).toBe(200);
  });

  it("accepts 500 (maximum boundary)", async () => {
    const res = await request(app)
      .patch("/api/admin/tenant")
      .send({ settings: { aiVisionCallsPerRun: 500 } });
    expect(res.status).toBe(200);
  });

  it("rejects 0 (below minimum) with 400 and descriptive message", async () => {
    const res = await request(app)
      .patch("/api/admin/tenant")
      .send({ settings: { aiVisionCallsPerRun: 0 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/aiVisionCallsPerRun/);
  });

  it("rejects -1 (negative) with 400 and descriptive message", async () => {
    const res = await request(app)
      .patch("/api/admin/tenant")
      .send({ settings: { aiVisionCallsPerRun: -1 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/aiVisionCallsPerRun/);
  });

  it("rejects 501 (above maximum) with 400 and descriptive message", async () => {
    const res = await request(app)
      .patch("/api/admin/tenant")
      .send({ settings: { aiVisionCallsPerRun: 501 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/aiVisionCallsPerRun/);
  });

  it("rejects 2.5 (non-integer float) with 400 and descriptive message", async () => {
    const res = await request(app)
      .patch("/api/admin/tenant")
      .send({ settings: { aiVisionCallsPerRun: 2.5 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/aiVisionCallsPerRun/);
  });

  it('rejects "abc" (non-numeric string) with 400 and descriptive message', async () => {
    const res = await request(app)
      .patch("/api/admin/tenant")
      .send({ settings: { aiVisionCallsPerRun: "abc" } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/aiVisionCallsPerRun/);
  });
});

// ---------------------------------------------------------------------------
// Retry timeout limit — cross-field check: aiBaseDelayMs × aiRetryMax
// ---------------------------------------------------------------------------
//
// The cross-field rule uses computeMaxRetryWaitMs (exponential backoff, capped
// at 64 s per step) to calculate the maximum total retry wait. The combination
// is rejected when that total strictly exceeds 5 minutes (300,000 ms).
//
// Boundary values used below are derived from computeMaxRetryWaitMs:
//   computeMaxRetryWaitMs(30000, 7)  ≈ 346,000 ms  → rejected (> 300,000)
//   computeMaxRetryWaitMs(30000, 6)  ≈ 282,000 ms  → accepted (≤ 300,000)
//   computeMaxRetryWaitMs(10000, 5)  ≈ 134,000 ms  → accepted (≤ 300,000)
//
// The cross-field check is skipped when no explicit aiBaseDelayMs is present
// (neither in the request nor stored in the tenant record).
//
// A beforeEach resets the shared test tenant settings so each test is isolated.
// ---------------------------------------------------------------------------

describe("PATCH /api/admin/tenant — retry timeout cross-field limit", () => {
  beforeEach(async () => {
    await db
      .update(tenantsTable)
      .set({ settings: {} })
      .where(eq(tenantsTable.id, testTenantId));
  });

  // ── Both fields in a single request that exceeds the limit ───────────────

  it("rejects both fields in one request when exponential-backoff total exceeds 5 minutes", async () => {
    const res = await request(app)
      .patch("/api/admin/tenant")
      .send({ settings: { aiBaseDelayMs: 30000, aiRetryMax: 7 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/5-minute limit/);
  });

  // ── Only aiRetryMax in the request ──────────────────────────────────────

  it("rejects only-aiRetryMax PATCH when stored aiBaseDelayMs pushes backoff total over 5 minutes", async () => {
    await db
      .update(tenantsTable)
      .set({ settings: { aiBaseDelayMs: 30000 } })
      .where(eq(tenantsTable.id, testTenantId));

    const res = await request(app)
      .patch("/api/admin/tenant")
      .send({ settings: { aiRetryMax: 7 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/5-minute limit/);
  });

  // ── Only aiBaseDelayMs in the request ───────────────────────────────────

  it("rejects only-aiBaseDelayMs PATCH when stored aiRetryMax pushes backoff total over 5 minutes", async () => {
    await db
      .update(tenantsTable)
      .set({ settings: { aiRetryMax: 7 } })
      .where(eq(tenantsTable.id, testTenantId));

    const res = await request(app)
      .patch("/api/admin/tenant")
      .send({ settings: { aiBaseDelayMs: 30000 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/5-minute limit/);
  });

  // ── Combinations at or just below the 5-minute limit ────────────────────

  it("accepts both fields when backoff total is just below 5 minutes (30,000 ms base, 6 retries ≈ 282 s)", async () => {
    const res = await request(app)
      .patch("/api/admin/tenant")
      .send({ settings: { aiBaseDelayMs: 30000, aiRetryMax: 6 } });
    expect(res.status).toBe(200);
  });

  it("accepts both fields well within the limit (10,000 ms base, 5 retries ≈ 134 s)", async () => {
    const res = await request(app)
      .patch("/api/admin/tenant")
      .send({ settings: { aiBaseDelayMs: 10000, aiRetryMax: 5 } });
    expect(res.status).toBe(200);
  });

  it("accepts only-aiRetryMax PATCH when stored aiBaseDelayMs keeps backoff total below the limit", async () => {
    await db
      .update(tenantsTable)
      .set({ settings: { aiBaseDelayMs: 30000 } })
      .where(eq(tenantsTable.id, testTenantId));

    const res = await request(app)
      .patch("/api/admin/tenant")
      .send({ settings: { aiRetryMax: 6 } });
    expect(res.status).toBe(200);
  });

  it("accepts only-aiBaseDelayMs PATCH when stored aiRetryMax keeps backoff total below the limit", async () => {
    await db
      .update(tenantsTable)
      .set({ settings: { aiRetryMax: 6 } })
      .where(eq(tenantsTable.id, testTenantId));

    const res = await request(app)
      .patch("/api/admin/tenant")
      .send({ settings: { aiBaseDelayMs: 30000 } });
    expect(res.status).toBe(200);
  });

  it("accepts only-aiRetryMax PATCH when no aiBaseDelayMs is stored (cross-field check skipped)", async () => {
    const res = await request(app)
      .patch("/api/admin/tenant")
      .send({ settings: { aiRetryMax: 10 } });
    expect(res.status).toBe(200);
  });

  it("accepts only-aiBaseDelayMs PATCH when no aiRetryMax is stored (falls back to default retry count)", async () => {
    const res = await request(app)
      .patch("/api/admin/tenant")
      .send({ settings: { aiBaseDelayMs: 30000 } });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// lowConfidenceThreshold
// ---------------------------------------------------------------------------

describe("PATCH /api/admin/tenant — lowConfidenceThreshold validation", () => {
  it("accepts 1 (minimum boundary)", async () => {
    const res = await request(app)
      .patch("/api/admin/tenant")
      .send({ settings: { lowConfidenceThreshold: 1 } });
    expect(res.status).toBe(200);
  });

  it("accepts 50 (mid-range)", async () => {
    const res = await request(app)
      .patch("/api/admin/tenant")
      .send({ settings: { lowConfidenceThreshold: 50 } });
    expect(res.status).toBe(200);
  });

  it("accepts 70 (mid-range)", async () => {
    const res = await request(app)
      .patch("/api/admin/tenant")
      .send({ settings: { lowConfidenceThreshold: 70 } });
    expect(res.status).toBe(200);
  });

  it("accepts 99 (maximum boundary)", async () => {
    const res = await request(app)
      .patch("/api/admin/tenant")
      .send({ settings: { lowConfidenceThreshold: 99 } });
    expect(res.status).toBe(200);
  });

  it("rejects 0 (below minimum) with 400 and descriptive message", async () => {
    const res = await request(app)
      .patch("/api/admin/tenant")
      .send({ settings: { lowConfidenceThreshold: 0 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/lowConfidenceThreshold must be an integer between 1 and 99/);
  });

  it("rejects -1 (negative) with 400 and descriptive message", async () => {
    const res = await request(app)
      .patch("/api/admin/tenant")
      .send({ settings: { lowConfidenceThreshold: -1 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/lowConfidenceThreshold must be an integer between 1 and 99/);
  });

  it("rejects 100 (above maximum) with 400 and descriptive message", async () => {
    const res = await request(app)
      .patch("/api/admin/tenant")
      .send({ settings: { lowConfidenceThreshold: 100 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/lowConfidenceThreshold must be an integer between 1 and 99/);
  });

  it("rejects 50.5 (non-integer float) with 400 and descriptive message", async () => {
    const res = await request(app)
      .patch("/api/admin/tenant")
      .send({ settings: { lowConfidenceThreshold: 50.5 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/lowConfidenceThreshold must be an integer between 1 and 99/);
  });

  it('rejects "abc" (non-numeric string) with 400 and descriptive message', async () => {
    const res = await request(app)
      .patch("/api/admin/tenant")
      .send({ settings: { lowConfidenceThreshold: "abc" } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/lowConfidenceThreshold must be an integer between 1 and 99/);
  });
});
