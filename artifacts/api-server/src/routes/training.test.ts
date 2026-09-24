import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { eq, and } from "drizzle-orm";
import { db, trainingCorrectionsTable, ruleOverridesTable, importSnapshotsTable } from "@workspace/db";
import { createTestApp } from "../__tests__/testApp";
import {
  cleanupTenants,
  seedRegularTenant,
  uid,
} from "../__tests__/fixtures";
import type { SeededRegularTenant } from "../__tests__/fixtures";

vi.mock("../lib/objectStorage", () => {
  class MockObjectStorageService {
    uploadFile = vi.fn().mockResolvedValue("/objects/uploads/mock-path");
    downloadFile = vi.fn().mockResolvedValue(Buffer.from(""));
    deleteFile = vi.fn().mockResolvedValue(undefined);
  }
  return { ObjectStorageService: MockObjectStorageService };
});

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

async function confirmImport(
  t: SeededRegularTenant,
  body: Record<string, unknown>,
) {
  return request(app)
    .post("/api/training/import/confirm")
    .set("Authorization", auth(t))
    .send(body);
}

async function getCorrections(t: SeededRegularTenant, roomNamePattern: string, signType: string) {
  return db
    .select()
    .from(trainingCorrectionsTable)
    .where(
      and(
        eq(trainingCorrectionsTable.tenantId, t.tenantId),
        eq(trainingCorrectionsTable.roomNamePattern, roomNamePattern),
        eq(trainingCorrectionsTable.signType, signType),
      ),
    );
}

// ---------------------------------------------------------------------------
// POST /training/import/confirm – skipOverwrite collision decisions
// ---------------------------------------------------------------------------

describe("POST /api/training/import/confirm – skipOverwrite flag", () => {
  it("inserts a new correction when no collision exists", async () => {
    const res = await confirmImport(tenant, {
      mode: "update",
      diffs: [
        {
          roomName: "Conference Room",
          humanSignType: "Exit Sign",
          pipelineSignType: "Unknown",
        },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.saved).toBe(1);
    expect(res.body.updated).toBe(0);
    expect(res.body.skipped).toBe(0);

    const rows = await getCorrections(tenant, "Conference Room", "Exit Sign");
    expect(rows).toHaveLength(1);
    expect(rows[0].roomNamePattern).toBe("Conference Room");
    expect(rows[0].signType).toBe("Exit Sign");
  });

  it("updates an existing correction when skipOverwrite is absent and mode is update", async () => {
    await confirmImport(tenant, {
      mode: "skip",
      diffs: [
        {
          roomName: "Server Room",
          humanSignType: "IT Sign",
          pipelineSignType: "Unknown",
        },
      ],
    });

    const res = await confirmImport(tenant, {
      mode: "update",
      diffs: [
        {
          roomName: "Server Room",
          humanSignType: "IT Sign",
          pipelineSignType: "DataCenter",
          roomNumber: "B1",
          level: "Basement",
        },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);
    expect(res.body.skipped).toBe(0);

    const rows = await getCorrections(tenant, "Server Room", "IT Sign");
    expect(rows).toHaveLength(1);
    const corrected = rows[0].correctedValue as Record<string, string>;
    expect(corrected.roomNumber).toBe("B1");
    expect(corrected.level).toBe("Basement");
  });

  it("updates an existing correction when skipOverwrite is false and mode is update", async () => {
    await confirmImport(tenant, {
      mode: "skip",
      diffs: [
        {
          roomName: "Lobby",
          humanSignType: "Fire Exit",
          pipelineSignType: "Unknown",
        },
      ],
    });

    const res = await confirmImport(tenant, {
      mode: "update",
      diffs: [
        {
          roomName: "Lobby",
          humanSignType: "Fire Exit",
          pipelineSignType: "EmergencyExit",
          skipOverwrite: false,
          roomNumber: "1A",
          level: "Ground",
        },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);
    expect(res.body.skipped).toBe(0);

    const rows = await getCorrections(tenant, "Lobby", "Fire Exit");
    expect(rows).toHaveLength(1);
    const corrected = rows[0].correctedValue as Record<string, string>;
    expect(corrected.roomNumber).toBe("1A");
    expect(corrected.level).toBe("Ground");
  });

  it("skips an existing correction when skipOverwrite is true even in update mode", async () => {
    await confirmImport(tenant, {
      mode: "skip",
      diffs: [
        {
          roomName: "Stairwell A",
          humanSignType: "Stair Sign",
          pipelineSignType: "Unknown",
          roomNumber: "original",
          level: "1",
        },
      ],
    });

    const original = await getCorrections(tenant, "Stairwell A", "Stair Sign");
    expect(original).toHaveLength(1);

    const res = await confirmImport(tenant, {
      mode: "update",
      diffs: [
        {
          roomName: "Stairwell A",
          humanSignType: "Stair Sign",
          pipelineSignType: "EmergencyExit",
          skipOverwrite: true,
          roomNumber: "should-not-appear",
          level: "99",
        },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe(1);
    expect(res.body.updated).toBe(0);

    const after = await getCorrections(tenant, "Stairwell A", "Stair Sign");
    expect(after).toHaveLength(1);
    const corrected = after[0].correctedValue as Record<string, string>;
    expect(corrected.roomNumber).not.toBe("should-not-appear");
  });

  it("skips an existing correction when skipOverwrite is absent and mode is skip", async () => {
    await confirmImport(tenant, {
      mode: "skip",
      diffs: [
        {
          roomName: "Break Room",
          humanSignType: "Evacuation Map",
          pipelineSignType: "Unknown",
        },
      ],
    });

    const res = await confirmImport(tenant, {
      mode: "skip",
      diffs: [
        {
          roomName: "Break Room",
          humanSignType: "Evacuation Map",
          pipelineSignType: "SomethingNew",
          roomNumber: "42",
        },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe(1);
    expect(res.body.updated).toBe(0);
  });

  it("handles a mixed batch: some rows skip, some rows update", async () => {
    await confirmImport(tenant, {
      mode: "skip",
      diffs: [
        {
          roomName: "Room Alpha",
          humanSignType: "Exit Sign",
          pipelineSignType: "Unknown",
        },
        {
          roomName: "Room Beta",
          humanSignType: "Fire Extinguisher",
          pipelineSignType: "Unknown",
        },
      ],
    });

    const res = await confirmImport(tenant, {
      mode: "update",
      diffs: [
        {
          roomName: "Room Alpha",
          humanSignType: "Exit Sign",
          pipelineSignType: "EmergencyExit",
          skipOverwrite: true,
          roomNumber: "skip-me",
        },
        {
          roomName: "Room Beta",
          humanSignType: "Fire Extinguisher",
          pipelineSignType: "FireSafety",
          skipOverwrite: false,
          roomNumber: "update-me",
        },
        {
          roomName: "Room Gamma",
          humanSignType: "ADA Sign",
          pipelineSignType: "Unknown",
          roomNumber: "new-insert",
        },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe(1);
    expect(res.body.updated).toBe(1);
    expect(res.body.saved).toBe(1);

    const alpha = await getCorrections(tenant, "Room Alpha", "Exit Sign");
    const alphaCorrected = alpha[0].correctedValue as Record<string, string>;
    expect(alphaCorrected.roomNumber).not.toBe("skip-me");

    const beta = await getCorrections(tenant, "Room Beta", "Fire Extinguisher");
    const betaCorrected = beta[0].correctedValue as Record<string, string>;
    expect(betaCorrected.roomNumber).toBe("update-me");

    const gamma = await getCorrections(tenant, "Room Gamma", "ADA Sign");
    expect(gamma).toHaveLength(1);
    const gammaCorrected = gamma[0].correctedValue as Record<string, string>;
    expect(gammaCorrected.roomNumber).toBe("new-insert");
  });

  it("returns 400 when diffs array is empty", async () => {
    const res = await confirmImport(tenant, { mode: "update", diffs: [] });
    expect(res.status).toBe(400);
  });

  it("returns 401 when no Authorization header is provided", async () => {
    const res = await request(app)
      .post("/api/training/import/confirm")
      .send({ mode: "update", diffs: [{ roomName: "X", humanSignType: "Y" }] });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /training/corrections
// ---------------------------------------------------------------------------

describe("GET /api/training/corrections", () => {
  it("returns only the authenticated tenant's corrections", async () => {
    const other = await seedRegularTenant();
    trackedTenantIds.push(other.tenantId);

    await db.insert(trainingCorrectionsTable).values([
      {
        id: uid("tc"),
        tenantId: tenant.tenantId,
        correctionType: "sign_type_override",
        roomNamePattern: "Lobby",
        signType: "Exit",
      },
      {
        id: uid("tc"),
        tenantId: other.tenantId,
        correctionType: "sign_type_override",
        roomNamePattern: "Server Room",
        signType: "IT Sign",
      },
    ]);

    const res = await request(app)
      .get("/api/training/corrections")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const patterns = res.body.map((r: { roomNamePattern: string }) => r.roomNamePattern);
    expect(patterns).toContain("Lobby");
    expect(patterns).not.toContain("Server Room");
  });

  it("returns an empty array when the tenant has no corrections", async () => {
    const res = await request(app)
      .get("/api/training/corrections")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("respects the limit query parameter", async () => {
    const inserts = Array.from({ length: 5 }, (_, i) => ({
      id: uid("tc"),
      tenantId: tenant.tenantId,
      correctionType: "sign_type_override",
      roomNamePattern: `Room ${i}`,
      signType: "Exit",
    }));
    await db.insert(trainingCorrectionsTable).values(inserts);

    const res = await request(app)
      .get("/api/training/corrections?limit=2")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  it("returns 401 when no Authorization header is provided", async () => {
    const res = await request(app).get("/api/training/corrections");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /training/overrides
// ---------------------------------------------------------------------------

describe("GET /api/training/overrides", () => {
  it("returns only the authenticated tenant's overrides", async () => {
    const other = await seedRegularTenant();
    trackedTenantIds.push(other.tenantId);

    await db.insert(ruleOverridesTable).values([
      {
        id: uid("ro"),
        tenantId: tenant.tenantId,
        ruleRef: "training.lobby.exit",
        overrideType: "sign_type",
        confidence: "0.850",
      },
      {
        id: uid("ro"),
        tenantId: other.tenantId,
        ruleRef: "training.server_room.it_sign",
        overrideType: "sign_type",
        confidence: "0.750",
      },
    ]);

    const res = await request(app)
      .get("/api/training/overrides")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const refs = res.body.map((r: { ruleRef: string }) => r.ruleRef);
    expect(refs).toContain("training.lobby.exit");
    expect(refs).not.toContain("training.server_room.it_sign");
  });

  it("returns confidence as a numeric value", async () => {
    await db.insert(ruleOverridesTable).values({
      id: uid("ro"),
      tenantId: tenant.tenantId,
      ruleRef: "training.hallway.exit",
      overrideType: "sign_type",
      confidence: "0.920",
    });

    const res = await request(app)
      .get("/api/training/overrides")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    const override = res.body.find((r: { ruleRef: string }) => r.ruleRef === "training.hallway.exit");
    expect(override).toBeDefined();
    expect(typeof override.confidence).toBe("number");
    expect(override.confidence).toBeCloseTo(0.92);
  });

  it("returns an empty array when the tenant has no overrides", async () => {
    const res = await request(app)
      .get("/api/training/overrides")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns 401 when no Authorization header is provided", async () => {
    const res = await request(app).get("/api/training/overrides");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// PATCH /training/overrides/:id
// ---------------------------------------------------------------------------

describe("PATCH /api/training/overrides/:id", () => {
  async function insertOverride(t: SeededRegularTenant, overrideId: string) {
    await db.insert(ruleOverridesTable).values({
      id: overrideId,
      tenantId: t.tenantId,
      ruleRef: "training.test.patch",
      overrideType: "sign_type",
      condition: { roomNamePattern: "Test Room" },
      action: { signType: "Exit" },
      confidence: "0.800",
      isActive: true,
    });
  }

  it("updates isActive to false", async () => {
    const id = uid("ro");
    await insertOverride(tenant, id);

    const res = await request(app)
      .patch(`/api/training/overrides/${id}`)
      .set("Authorization", auth(tenant))
      .send({ isActive: false });

    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(false);
    expect(typeof res.body.confidence).toBe("number");
  });

  it("updates action field", async () => {
    const id = uid("ro");
    await insertOverride(tenant, id);

    const res = await request(app)
      .patch(`/api/training/overrides/${id}`)
      .set("Authorization", auth(tenant))
      .send({ action: { signType: "Fire Exit" } });

    expect(res.status).toBe(200);
    expect(res.body.action).toEqual({ signType: "Fire Exit" });
  });

  it("updates condition field", async () => {
    const id = uid("ro");
    await insertOverride(tenant, id);

    const res = await request(app)
      .patch(`/api/training/overrides/${id}`)
      .set("Authorization", auth(tenant))
      .send({ condition: { roomNamePattern: "Stairwell" } });

    expect(res.status).toBe(200);
    expect(res.body.condition).toEqual({ roomNamePattern: "Stairwell" });
  });

  it("returns 404 for an override that does not exist", async () => {
    const res = await request(app)
      .patch("/api/training/overrides/nonexistent-id")
      .set("Authorization", auth(tenant))
      .send({ isActive: false });

    expect(res.status).toBe(404);
  });

  it("returns 404 when the override belongs to a different tenant", async () => {
    const other = await seedRegularTenant();
    trackedTenantIds.push(other.tenantId);

    const id = uid("ro");
    await insertOverride(other, id);

    const res = await request(app)
      .patch(`/api/training/overrides/${id}`)
      .set("Authorization", auth(tenant))
      .send({ isActive: false });

    expect(res.status).toBe(404);
  });

  it("returns 401 when no Authorization header is provided", async () => {
    const res = await request(app)
      .patch("/api/training/overrides/some-id")
      .send({ isActive: false });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /training/override-impact
// ---------------------------------------------------------------------------

describe("GET /api/training/override-impact", () => {
  async function insertSnapshot(
    t: SeededRegularTenant,
    overrides: Partial<{
      snapshotDate: Date;
      avgConfidence: string;
      activeOverrideCount: number;
      newRulesCount: number;
      updatedRulesCount: number;
      batchLabel: string;
    }> = {},
  ) {
    const id = uid("snap");
    await db.insert(importSnapshotsTable).values({
      id,
      tenantId: t.tenantId,
      snapshotDate: overrides.snapshotDate ?? new Date(),
      avgConfidence: overrides.avgConfidence ?? "0.800",
      activeOverrideCount: overrides.activeOverrideCount ?? 0,
      newRulesCount: overrides.newRulesCount ?? 0,
      updatedRulesCount: overrides.updatedRulesCount ?? 0,
      batchLabel: overrides.batchLabel ?? null,
    });
    return id;
  }

  it("returns 401 when no Authorization header is provided", async () => {
    const res = await request(app).get("/api/training/override-impact");
    expect(res.status).toBe(401);
  });

  it("returns only the authenticated tenant's data", async () => {
    const other = await seedRegularTenant();
    trackedTenantIds.push(other.tenantId);

    await db.insert(ruleOverridesTable).values([
      {
        id: uid("ro"),
        tenantId: tenant.tenantId,
        ruleRef: "training.impact.my",
        overrideType: "sign_type",
        confidence: "0.900",
        isActive: true,
      },
      {
        id: uid("ro"),
        tenantId: other.tenantId,
        ruleRef: "training.impact.other",
        overrideType: "sign_type",
        confidence: "0.800",
        isActive: true,
      },
    ]);

    await db.insert(trainingCorrectionsTable).values([
      {
        id: uid("tc"),
        tenantId: tenant.tenantId,
        correctionType: "sign_type_override",
        roomNamePattern: "My Room",
        signType: "Exit",
      },
      {
        id: uid("tc"),
        tenantId: other.tenantId,
        correctionType: "sign_type_override",
        roomNamePattern: "Other Room",
        signType: "Exit",
      },
    ]);

    await insertSnapshot(tenant);
    await insertSnapshot(other);

    const res = await request(app)
      .get("/api/training/override-impact")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body.totalOverrides).toBe(1);
    expect(res.body.activeOverrides).toBe(1);
    expect(res.body.totalCorrections).toBe(1);
    expect(res.body.confidenceTrend).toHaveLength(1);
  });

  it("returns zero counts and empty trend when tenant has no data", async () => {
    const res = await request(app)
      .get("/api/training/override-impact")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body.totalOverrides).toBe(0);
    expect(res.body.activeOverrides).toBe(0);
    expect(res.body.totalCorrections).toBe(0);
    expect(res.body.confidenceTrend).toEqual([]);
    expect(res.body.topPatterns).toEqual([]);
  });

  it("returns populated topPatterns grouped by correctionType, signType, roomNamePattern", async () => {
    const makeCorrection = (correctionType: string, signType: string, roomNamePattern: string) => ({
      id: uid("tc"),
      tenantId: tenant.tenantId,
      correctionType,
      originalValue: { signType: "Room ID" },
      correctedValue: { signType },
      signType,
      roomNamePattern,
      isActive: true,
      appliedCount: 0,
    });

    await db.insert(trainingCorrectionsTable).values([
      makeCorrection("sign_type_override", "Exit", "Stairwell A"),
      makeCorrection("sign_type_override", "Exit", "Stairwell A"),
      makeCorrection("sign_type_override", "Exit", "Stairwell A"),
      makeCorrection("sign_type_override", "Restroom", "Women's Room"),
      makeCorrection("sign_type_override", "Restroom", "Women's Room"),
      makeCorrection("sign_type_override", "Evac Map", "Lobby"),
    ]);

    const res = await request(app)
      .get("/api/training/override-impact")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body.topPatterns).toHaveLength(3);

    const first = res.body.topPatterns[0];
    expect(first.correctionType).toBe("sign_type_override");
    expect(first.signType).toBe("Exit");
    expect(first.roomNamePattern).toBe("Stairwell A");
    expect(first.count).toBe(3);

    const second = res.body.topPatterns[1];
    expect(second.count).toBe(2);

    const third = res.body.topPatterns[2];
    expect(third.count).toBe(1);
  });

  it("returns confidenceTrend entries with the correct shape", async () => {
    const snapshotDate = new Date("2025-03-10T00:00:00Z");
    await insertSnapshot(tenant, {
      snapshotDate,
      avgConfidence: "0.750",
      activeOverrideCount: 3,
      newRulesCount: 2,
      updatedRulesCount: 1,
      batchLabel: "Q1 batch",
    });

    const res = await request(app)
      .get("/api/training/override-impact")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body.confidenceTrend).toHaveLength(1);

    const entry = res.body.confidenceTrend[0];
    expect(entry).toHaveProperty("snapshotId");
    expect(entry.week).toBe("2025-03-10");
    expect(typeof entry.importDate).toBe("string");
    expect(typeof entry.avgConfidence).toBe("number");
    expect(entry.avgConfidence).toBeCloseTo(0.75);
    expect(entry.count).toBe(3);
    expect(entry.newRulesCount).toBe(2);
    expect(entry.updatedRulesCount).toBe(1);
    expect(entry.batchLabel).toBe("Q1 batch");
  });

  it("filters confidenceTrend by startDate", async () => {
    await insertSnapshot(tenant, {
      snapshotDate: new Date("2025-01-15T00:00:00Z"),
      avgConfidence: "0.600",
    });
    await insertSnapshot(tenant, {
      snapshotDate: new Date("2025-04-20T00:00:00Z"),
      avgConfidence: "0.800",
    });

    const res = await request(app)
      .get("/api/training/override-impact?startDate=2025-03-01")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    const weeks = res.body.confidenceTrend.map((e: { week: string }) => e.week);
    expect(weeks).not.toContain("2025-01-15");
    expect(weeks).toContain("2025-04-20");
  });

  it("filters confidenceTrend by endDate", async () => {
    await insertSnapshot(tenant, {
      snapshotDate: new Date("2025-01-15T00:00:00Z"),
      avgConfidence: "0.600",
    });
    await insertSnapshot(tenant, {
      snapshotDate: new Date("2025-06-01T00:00:00Z"),
      avgConfidence: "0.900",
    });

    const res = await request(app)
      .get("/api/training/override-impact?endDate=2025-03-01")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    const weeks = res.body.confidenceTrend.map((e: { week: string }) => e.week);
    expect(weeks).toContain("2025-01-15");
    expect(weeks).not.toContain("2025-06-01");
  });

  it("filters confidenceTrend by both startDate and endDate", async () => {
    await insertSnapshot(tenant, {
      snapshotDate: new Date("2025-01-01T00:00:00Z"),
      avgConfidence: "0.500",
    });
    await insertSnapshot(tenant, {
      snapshotDate: new Date("2025-05-15T00:00:00Z"),
      avgConfidence: "0.750",
    });
    await insertSnapshot(tenant, {
      snapshotDate: new Date("2025-09-01T00:00:00Z"),
      avgConfidence: "0.900",
    });

    const res = await request(app)
      .get("/api/training/override-impact?startDate=2025-03-01&endDate=2025-07-01")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    const weeks = res.body.confidenceTrend.map((e: { week: string }) => e.week);
    expect(weeks).not.toContain("2025-01-01");
    expect(weeks).toContain("2025-05-15");
    expect(weeks).not.toContain("2025-09-01");
  });

  it("returns 400 for a malformed startDate", async () => {
    const res = await request(app)
      .get("/api/training/override-impact?startDate=not-a-date")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
  });

  it("returns 400 for a malformed endDate", async () => {
    const res = await request(app)
      .get("/api/training/override-impact?endDate=99-99-9999")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
  });

  it("counts both active and inactive overrides in totalOverrides", async () => {
    await db.insert(ruleOverridesTable).values([
      {
        id: uid("ro"),
        tenantId: tenant.tenantId,
        ruleRef: "training.impact.active",
        overrideType: "sign_type",
        confidence: "0.900",
        isActive: true,
      },
      {
        id: uid("ro"),
        tenantId: tenant.tenantId,
        ruleRef: "training.impact.inactive",
        overrideType: "sign_type",
        confidence: "0.700",
        isActive: false,
      },
    ]);

    const res = await request(app)
      .get("/api/training/override-impact")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body.totalOverrides).toBe(2);
    expect(res.body.activeOverrides).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// GET /training/snapshots – pagination, ordering, and date filters
// ---------------------------------------------------------------------------

describe("GET /api/training/snapshots", () => {
  async function insertSnapshot(
    t: SeededRegularTenant,
    snapshotDate: Date,
    avgConfidence = "0.800",
    batchLabel: string | null = null,
  ) {
    const id = uid("snap");
    await db.insert(importSnapshotsTable).values({
      id,
      tenantId: t.tenantId,
      snapshotDate,
      avgConfidence,
      activeOverrideCount: 0,
      newRulesCount: 0,
      updatedRulesCount: 0,
      batchLabel,
    });
    return id;
  }

  it("returns 401 when no Authorization header is provided", async () => {
    const res = await request(app).get("/api/training/snapshots");
    expect(res.status).toBe(401);
  });

  it("returns an empty array when no snapshots exist for the tenant", async () => {
    const res = await request(app)
      .get("/api/training/snapshots")
      .set("Authorization", auth(tenant));
    expect(res.status).toBe(200);
    expect(res.body.snapshots).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  it("enforces a hard cap of 100 when no limit is provided and more than 100 snapshots exist", async () => {
    const rows = Array.from({ length: 110 }, (_, i) => ({
      id: uid("snap"),
      tenantId: tenant.tenantId,
      snapshotDate: new Date(2024, 0, i + 1),
      avgConfidence: "0.800",
      activeOverrideCount: 0,
      newRulesCount: 0,
      updatedRulesCount: 0,
      batchLabel: null,
    }));
    await db.insert(importSnapshotsTable).values(rows);

    const res = await request(app)
      .get("/api/training/snapshots")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body.snapshots).toHaveLength(100);
  });

  it("respects a custom limit parameter", async () => {
    for (let i = 1; i <= 5; i++) await insertSnapshot(tenant, new Date(2024, 0, i));

    const res = await request(app)
      .get("/api/training/snapshots?limit=2")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body.snapshots).toHaveLength(2);
  });

  it("respects the offset parameter by skipping the N most-recent records", async () => {
    const jan = (d: number) => new Date(`2024-01-${String(d).padStart(2, "0")}T00:00:00.000Z`);
    for (let i = 1; i <= 5; i++) await insertSnapshot(tenant, jan(i));

    const res = await request(app)
      .get("/api/training/snapshots?limit=3&offset=2")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body.snapshots).toHaveLength(3);

    const dates: string[] = res.body.snapshots.map((s: { snapshotDate: string }) => s.snapshotDate);
    expect(dates[0].startsWith("2024-01-01")).toBe(true);
    expect(dates[1].startsWith("2024-01-02")).toBe(true);
    expect(dates[2].startsWith("2024-01-03")).toBe(true);
  });

  it("returns snapshots in ascending chronological order", async () => {
    const dates = [
      new Date(2024, 2, 15),
      new Date(2024, 0, 1),
      new Date(2024, 5, 10),
    ];
    for (const d of dates) await insertSnapshot(tenant, d);

    const res = await request(app)
      .get("/api/training/snapshots")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    const returnedDates: string[] = res.body.snapshots.map((s: { snapshotDate: string }) => s.snapshotDate);
    const sorted = [...returnedDates].sort();
    expect(returnedDates).toEqual(sorted);
  });

  it("returns 400 when limit is 0", async () => {
    const res = await request(app)
      .get("/api/training/snapshots?limit=0")
      .set("Authorization", auth(tenant));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/limit/i);
  });

  it("returns 400 when limit exceeds 1000", async () => {
    const res = await request(app)
      .get("/api/training/snapshots?limit=1001")
      .set("Authorization", auth(tenant));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/limit/i);
  });

  it("returns 400 when limit is not a number", async () => {
    const res = await request(app)
      .get("/api/training/snapshots?limit=abc")
      .set("Authorization", auth(tenant));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/limit/i);
  });

  it("returns 400 when offset is negative", async () => {
    const res = await request(app)
      .get("/api/training/snapshots?offset=-1")
      .set("Authorization", auth(tenant));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/offset/i);
  });

  it("returns 400 for an invalid startDate", async () => {
    const res = await request(app)
      .get("/api/training/snapshots?startDate=not-a-date")
      .set("Authorization", auth(tenant));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/startDate|endDate/i);
  });

  it("filters by startDate", async () => {
    await insertSnapshot(tenant, new Date("2024-01-01"));
    await insertSnapshot(tenant, new Date("2024-06-01"));
    await insertSnapshot(tenant, new Date("2024-12-01"));

    const res = await request(app)
      .get("/api/training/snapshots?startDate=2024-06-01")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body.snapshots).toHaveLength(2);
    for (const s of res.body.snapshots) {
      expect(new Date(s.snapshotDate) >= new Date("2024-06-01")).toBe(true);
    }
  });

  it("filters by endDate", async () => {
    await insertSnapshot(tenant, new Date("2024-01-01"));
    await insertSnapshot(tenant, new Date("2024-06-01"));
    await insertSnapshot(tenant, new Date("2024-12-01"));

    const res = await request(app)
      .get("/api/training/snapshots?endDate=2024-06-01")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body.snapshots).toHaveLength(2);
    for (const s of res.body.snapshots) {
      expect(new Date(s.snapshotDate) <= new Date("2024-06-01")).toBe(true);
    }
  });

  it("filters by both startDate and endDate", async () => {
    await insertSnapshot(tenant, new Date("2024-01-01"));
    await insertSnapshot(tenant, new Date("2024-04-01"));
    await insertSnapshot(tenant, new Date("2024-08-01"));
    await insertSnapshot(tenant, new Date("2024-12-01"));

    const res = await request(app)
      .get("/api/training/snapshots?startDate=2024-03-01&endDate=2024-09-01")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body.snapshots).toHaveLength(2);
    for (const s of res.body.snapshots) {
      const d = new Date(s.snapshotDate);
      expect(d >= new Date("2024-03-01")).toBe(true);
      expect(d <= new Date("2024-09-01")).toBe(true);
    }
  });

  it("combines date filter with limit and offset, returning exact page contents", async () => {
    await insertSnapshot(tenant, new Date("2023-12-15"));
    await insertSnapshot(tenant, new Date("2024-03-01"));
    await insertSnapshot(tenant, new Date("2024-05-01"));
    await insertSnapshot(tenant, new Date("2024-07-01"));
    await insertSnapshot(tenant, new Date("2024-09-01"));
    await insertSnapshot(tenant, new Date("2025-01-10"));

    const res = await request(app)
      .get("/api/training/snapshots?startDate=2024-01-01&endDate=2024-12-31&limit=2&offset=1")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body.snapshots).toHaveLength(2);

    const dates: string[] = res.body.snapshots.map((s: { snapshotDate: string }) => s.snapshotDate);
    for (const d of dates) {
      expect(new Date(d) >= new Date("2024-01-01")).toBe(true);
      expect(new Date(d) <= new Date("2024-12-31")).toBe(true);
    }
    const sorted = [...dates].sort();
    expect(dates).toEqual(sorted);
  });

  it("excludes snapshots with zero avgConfidence", async () => {
    await insertSnapshot(tenant, new Date("2024-01-01"), "0.000");
    await insertSnapshot(tenant, new Date("2024-02-01"), "0.750");

    const res = await request(app)
      .get("/api/training/snapshots")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body.snapshots).toHaveLength(1);
    expect(res.body.snapshots[0].avgConfidence).toBeGreaterThan(0);
  });

  it("does not return snapshots belonging to another tenant", async () => {
    const other = await seedRegularTenant();
    trackedTenantIds.push(other.tenantId);

    await insertSnapshot(other, new Date("2024-01-01"));

    const res = await request(app)
      .get("/api/training/snapshots")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body.snapshots).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// PATCH /training/snapshots/:snapshotId – batch label edits
// ---------------------------------------------------------------------------

describe("PATCH /api/training/snapshots/:snapshotId", () => {
  async function insertSnapshot(t: SeededRegularTenant, batchLabel: string | null = null) {
    const id = uid("snap");
    await db.insert(importSnapshotsTable).values({
      id,
      tenantId: t.tenantId,
      snapshotDate: new Date(),
      avgConfidence: "0.800",
      activeOverrideCount: 0,
      newRulesCount: 0,
      updatedRulesCount: 0,
      batchLabel,
    });
    return id;
  }

  it("returns 401 when no Authorization header is provided", async () => {
    const snapshotId = await insertSnapshot(tenant);

    const res = await request(app)
      .patch(`/api/training/snapshots/${snapshotId}`)
      .send({ batchLabel: "New Label" });

    expect(res.status).toBe(401);
  });

  it("updates the batchLabel for an authenticated tenant's snapshot", async () => {
    const snapshotId = await insertSnapshot(tenant, "Old Label");

    const res = await request(app)
      .patch(`/api/training/snapshots/${snapshotId}`)
      .set("Authorization", auth(tenant))
      .send({ batchLabel: "Updated Label" });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(snapshotId);
    expect(res.body.batchLabel).toBe("Updated Label");
  });

  it("returns 404 when the snapshot belongs to a different tenant", async () => {
    const other = await seedRegularTenant();
    trackedTenantIds.push(other.tenantId);

    const otherSnapshotId = await insertSnapshot(other, "Other Label");

    const res = await request(app)
      .patch(`/api/training/snapshots/${otherSnapshotId}`)
      .set("Authorization", auth(tenant))
      .send({ batchLabel: "Hijacked Label" });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("clears the batchLabel to null when an empty string is sent", async () => {
    const snapshotId = await insertSnapshot(tenant, "Existing Label");

    const res = await request(app)
      .patch(`/api/training/snapshots/${snapshotId}`)
      .set("Authorization", auth(tenant))
      .send({ batchLabel: "" });

    expect(res.status).toBe(200);
    expect(res.body.batchLabel).toBeNull();
  });

  it("clears the batchLabel to null when a whitespace-only string is sent", async () => {
    const snapshotId = await insertSnapshot(tenant, "Existing Label");

    const res = await request(app)
      .patch(`/api/training/snapshots/${snapshotId}`)
      .set("Authorization", auth(tenant))
      .send({ batchLabel: "   " });

    expect(res.status).toBe(200);
    expect(res.body.batchLabel).toBeNull();
  });
});
