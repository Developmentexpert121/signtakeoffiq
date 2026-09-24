import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { db, jobsTable, roomsTable, signsTable } from "@workspace/db";
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
// Helpers
// ---------------------------------------------------------------------------

async function insertRoom(
  tenantId: string,
  jId: string,
  overrides: Partial<typeof roomsTable.$inferInsert> = {},
) {
  const roomId = uid("room");
  await db.insert(roomsTable).values({
    id: roomId,
    jobId: jId,
    tenantId,
    roomNumber: "101",
    roomName: "Office",
    level: "1",
    source: "ai_vision",
    ...overrides,
  });
  return roomId;
}

// ---------------------------------------------------------------------------
// Authentication guard
// ---------------------------------------------------------------------------

describe("rooms routes – auth guard", () => {
  it("returns 401 when no Authorization header is provided", async () => {
    const res = await request(app).get(`/api/jobs/${jobId}/rooms`);
    expect(res.status).toBe(401);
  });

  it("returns 401 when an invalid token is provided", async () => {
    const res = await request(app)
      .get(`/api/jobs/${jobId}/rooms`)
      .set("Authorization", "Bearer not-a-real-token");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /jobs/:jobId/rooms – list
// ---------------------------------------------------------------------------

describe("GET /api/jobs/:jobId/rooms", () => {
  it("returns an empty array when the job has no rooms", async () => {
    const res = await request(app)
      .get(`/api/jobs/${jobId}/rooms`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  it("returns all rooms belonging to the job", async () => {
    await insertRoom(tenant.tenantId, jobId, { roomNumber: "101" });
    await insertRoom(tenant.tenantId, jobId, { roomNumber: "102" });

    const res = await request(app)
      .get(`/api/jobs/${jobId}/rooms`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body.length).toBe(2);
  });

  it("does not return rooms from a different job", async () => {
    const otherJobId = uid("job");
    await db.insert(jobsTable).values({
      id: otherJobId,
      tenantId: tenant.tenantId,
      name: "Other Job",
      status: "pending",
    });

    await insertRoom(tenant.tenantId, otherJobId, { roomNumber: "999" });
    await insertRoom(tenant.tenantId, jobId, { roomNumber: "101" });

    const res = await request(app)
      .get(`/api/jobs/${jobId}/rooms`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].roomNumber).toBe("101");
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

    await insertRoom(other.tenantId, otherJobId);

    const res = await request(app)
      .get(`/api/jobs/${otherJobId}/rooms`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// GET /jobs/:jobId/rooms/:roomId – read single
// ---------------------------------------------------------------------------

describe("GET /api/jobs/:jobId/rooms/:roomId", () => {
  it("returns the room when it exists and belongs to the tenant", async () => {
    const roomId = await insertRoom(tenant.tenantId, jobId, {
      roomNumber: "202",
      roomName: "Conference Room",
    });

    const res = await request(app)
      .get(`/api/jobs/${jobId}/rooms/${roomId}`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: roomId,
      roomNumber: "202",
      roomName: "Conference Room",
    });
  });

  it("includes a signs array in the response", async () => {
    const roomId = await insertRoom(tenant.tenantId, jobId);

    const res = await request(app)
      .get(`/api/jobs/${jobId}/rooms/${roomId}`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.signs)).toBe(true);
  });

  it("returns 404 for a non-existent room", async () => {
    const res = await request(app)
      .get(`/api/jobs/${jobId}/rooms/room_doesnotexist`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(404);
  });

  it("returns 404 when room belongs to another tenant", async () => {
    const other = await seedRegularTenant();
    trackedTenantIds.push(other.tenantId);

    const otherJobId = uid("job");
    await db.insert(jobsTable).values({
      id: otherJobId,
      tenantId: other.tenantId,
      name: "Other Job",
      status: "pending",
    });

    const roomId = await insertRoom(other.tenantId, otherJobId);

    const res = await request(app)
      .get(`/api/jobs/${jobId}/rooms/${roomId}`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PATCH /jobs/:jobId/rooms/:roomId – update review status
// ---------------------------------------------------------------------------

describe("PATCH /api/jobs/:jobId/rooms/:roomId", () => {
  it("updates reviewStatus to confirmed and returns the updated room", async () => {
    const roomId = await insertRoom(tenant.tenantId, jobId);

    const res = await request(app)
      .patch(`/api/jobs/${jobId}/rooms/${roomId}`)
      .set("Authorization", auth(tenant))
      .send({ reviewStatus: "confirmed" });

    expect(res.status).toBe(200);
    expect(res.body.reviewStatus).toBe("confirmed");
  });

  it("updates reviewStatus to dismissed", async () => {
    const roomId = await insertRoom(tenant.tenantId, jobId);

    const res = await request(app)
      .patch(`/api/jobs/${jobId}/rooms/${roomId}`)
      .set("Authorization", auth(tenant))
      .send({ reviewStatus: "dismissed" });

    expect(res.status).toBe(200);
    expect(res.body.reviewStatus).toBe("dismissed");

    const [row] = await db
      .select()
      .from(roomsTable)
      .where(eq(roomsTable.id, roomId));
    expect(row.reviewStatus).toBe("dismissed");
  });

  it("returns 400 for an invalid reviewStatus value", async () => {
    const roomId = await insertRoom(tenant.tenantId, jobId);

    const res = await request(app)
      .patch(`/api/jobs/${jobId}/rooms/${roomId}`)
      .set("Authorization", auth(tenant))
      .send({ reviewStatus: "invalid_status" });

    expect(res.status).toBe(400);
  });

  it("returns 404 when patching a non-existent room", async () => {
    const res = await request(app)
      .patch(`/api/jobs/${jobId}/rooms/room_doesnotexist`)
      .set("Authorization", auth(tenant))
      .send({ reviewStatus: "confirmed" });

    expect(res.status).toBe(404);
  });

  it("saves the dismissal reason when reviewStatus is dismissed", async () => {
    const roomId = await insertRoom(tenant.tenantId, jobId);

    const res = await request(app)
      .patch(`/api/jobs/${jobId}/rooms/${roomId}`)
      .set("Authorization", auth(tenant))
      .send({ reviewStatus: "dismissed", dismissalReason: "Not a sign room" });

    expect(res.status).toBe(200);
    expect(res.body.reviewStatus).toBe("dismissed");

    const [row] = await db
      .select()
      .from(roomsTable)
      .where(eq(roomsTable.id, roomId));
    expect(row.reviewStatus).toBe("dismissed");
    expect(row.dismissalReason).toBe("Not a sign room");
  });

  it("clears an existing dismissal reason when reviewStatus is confirmed", async () => {
    const roomId = await insertRoom(tenant.tenantId, jobId, {
      reviewStatus: "dismissed",
      dismissalReason: "Old reason",
    });

    const res = await request(app)
      .patch(`/api/jobs/${jobId}/rooms/${roomId}`)
      .set("Authorization", auth(tenant))
      .send({ reviewStatus: "confirmed" });

    expect(res.status).toBe(200);
    expect(res.body.reviewStatus).toBe("confirmed");

    const [row] = await db
      .select()
      .from(roomsTable)
      .where(eq(roomsTable.id, roomId));
    expect(row.reviewStatus).toBe("confirmed");
    expect(row.dismissalReason).toBeNull();
  });

  it("cannot patch a room belonging to another tenant", async () => {
    const other = await seedRegularTenant();
    trackedTenantIds.push(other.tenantId);

    const otherJobId = uid("job");
    await db.insert(jobsTable).values({
      id: otherJobId,
      tenantId: other.tenantId,
      name: "Other Job",
      status: "pending",
    });

    const roomId = await insertRoom(other.tenantId, otherJobId, {
      reviewStatus: "dismissed",
    });

    const res = await request(app)
      .patch(`/api/jobs/${jobId}/rooms/${roomId}`)
      .set("Authorization", auth(tenant))
      .send({ reviewStatus: "confirmed" });

    expect(res.status).toBe(404);

    const [row] = await db
      .select()
      .from(roomsTable)
      .where(eq(roomsTable.id, roomId));
    expect(row.reviewStatus).toBe("dismissed");
  });
});

// ---------------------------------------------------------------------------
// POST /jobs/:jobId/rooms/bulk-review – bulk update review status
// ---------------------------------------------------------------------------

describe("POST /api/jobs/:jobId/rooms/bulk-review", () => {
  it("bulk confirms all ai_vision rooms and returns the updated count", async () => {
    await insertRoom(tenant.tenantId, jobId, { source: "ai_vision" });
    await insertRoom(tenant.tenantId, jobId, { source: "ai_vision" });

    const res = await request(app)
      .post(`/api/jobs/${jobId}/rooms/bulk-review`)
      .set("Authorization", auth(tenant))
      .send({ reviewStatus: "confirmed" });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);
  });

  it("only updates ai_vision rooms, not manual ones", async () => {
    await insertRoom(tenant.tenantId, jobId, { source: "ai_vision" });
    await insertRoom(tenant.tenantId, jobId, { source: "manual" });

    const res = await request(app)
      .post(`/api/jobs/${jobId}/rooms/bulk-review`)
      .set("Authorization", auth(tenant))
      .send({ reviewStatus: "confirmed" });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);
  });

  it("returns 400 for an invalid reviewStatus value", async () => {
    const res = await request(app)
      .post(`/api/jobs/${jobId}/rooms/bulk-review`)
      .set("Authorization", auth(tenant))
      .send({ reviewStatus: "bogus" });

    expect(res.status).toBe(400);
  });

  it("saves the dismissal reason to all dismissed rooms", async () => {
    const roomId1 = await insertRoom(tenant.tenantId, jobId, {
      source: "ai_vision",
    });
    const roomId2 = await insertRoom(tenant.tenantId, jobId, {
      source: "ai_vision",
    });

    const res = await request(app)
      .post(`/api/jobs/${jobId}/rooms/bulk-review`)
      .set("Authorization", auth(tenant))
      .send({ reviewStatus: "dismissed", dismissalReason: "Duplicate entry" });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);

    const rows = await db
      .select()
      .from(roomsTable)
      .where(eq(roomsTable.jobId, jobId));

    for (const row of rows) {
      expect(row.reviewStatus).toBe("dismissed");
      expect(row.dismissalReason).toBe("Duplicate entry");
    }

    expect(rows.find((r) => r.id === roomId1)).toBeDefined();
    expect(rows.find((r) => r.id === roomId2)).toBeDefined();
  });

  it("clears existing dismissal reasons when bulk confirming", async () => {
    const roomId1 = await insertRoom(tenant.tenantId, jobId, {
      source: "ai_vision",
      reviewStatus: "dismissed",
      dismissalReason: "Old reason",
    });
    const roomId2 = await insertRoom(tenant.tenantId, jobId, {
      source: "ai_vision",
      reviewStatus: "dismissed",
      dismissalReason: "Another old reason",
    });

    const res = await request(app)
      .post(`/api/jobs/${jobId}/rooms/bulk-review`)
      .set("Authorization", auth(tenant))
      .send({ reviewStatus: "confirmed" });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);

    const [row1] = await db
      .select()
      .from(roomsTable)
      .where(eq(roomsTable.id, roomId1));
    const [row2] = await db
      .select()
      .from(roomsTable)
      .where(eq(roomsTable.id, roomId2));

    expect(row1.reviewStatus).toBe("confirmed");
    expect(row1.dismissalReason).toBeNull();
    expect(row2.reviewStatus).toBe("confirmed");
    expect(row2.dismissalReason).toBeNull();
  });

  it("resets only confirmed rooms when fromStatus is 'confirmed'", async () => {
    const confirmedRoomId = await insertRoom(tenant.tenantId, jobId, {
      source: "ai_vision",
      reviewStatus: "confirmed",
    });
    const dismissedRoomId = await insertRoom(tenant.tenantId, jobId, {
      source: "ai_vision",
      reviewStatus: "dismissed",
    });

    const res = await request(app)
      .post(`/api/jobs/${jobId}/rooms/bulk-review`)
      .set("Authorization", auth(tenant))
      .send({ reviewStatus: "pending", fromStatus: "confirmed" });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);

    const [confirmed] = await db
      .select()
      .from(roomsTable)
      .where(eq(roomsTable.id, confirmedRoomId));
    expect(confirmed.reviewStatus).toBe("pending");

    const [dismissed] = await db
      .select()
      .from(roomsTable)
      .where(eq(roomsTable.id, dismissedRoomId));
    expect(dismissed.reviewStatus).toBe("dismissed");
  });

  it("resets only dismissed rooms when fromStatus is absent (backward compat)", async () => {
    const confirmedRoomId = await insertRoom(tenant.tenantId, jobId, {
      source: "ai_vision",
      reviewStatus: "confirmed",
    });
    const dismissedRoomId = await insertRoom(tenant.tenantId, jobId, {
      source: "ai_vision",
      reviewStatus: "dismissed",
    });

    const res = await request(app)
      .post(`/api/jobs/${jobId}/rooms/bulk-review`)
      .set("Authorization", auth(tenant))
      .send({ reviewStatus: "pending" });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);

    const [confirmed] = await db
      .select()
      .from(roomsTable)
      .where(eq(roomsTable.id, confirmedRoomId));
    expect(confirmed.reviewStatus).toBe("confirmed");

    const [dismissed] = await db
      .select()
      .from(roomsTable)
      .where(eq(roomsTable.id, dismissedRoomId));
    expect(dismissed.reviewStatus).toBe("pending");
  });

  it("returns 400 for an invalid fromStatus value", async () => {
    const res = await request(app)
      .post(`/api/jobs/${jobId}/rooms/bulk-review`)
      .set("Authorization", auth(tenant))
      .send({ reviewStatus: "pending", fromStatus: "bogus" });

    expect(res.status).toBe(400);
  });

  it("only updates rooms for the authenticated tenant's job", async () => {
    const other = await seedRegularTenant();
    trackedTenantIds.push(other.tenantId);

    const otherJobId = uid("job");
    await db.insert(jobsTable).values({
      id: otherJobId,
      tenantId: other.tenantId,
      name: "Other Job",
      status: "pending",
    });

    const otherRoomId = await insertRoom(other.tenantId, otherJobId, {
      source: "ai_vision",
      reviewStatus: "dismissed",
    });

    const res = await request(app)
      .post(`/api/jobs/${otherJobId}/rooms/bulk-review`)
      .set("Authorization", auth(tenant))
      .send({ reviewStatus: "confirmed" });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(0);

    const [row] = await db
      .select()
      .from(roomsTable)
      .where(eq(roomsTable.id, otherRoomId));
    expect(row.reviewStatus).toBe("dismissed");
  });

  it("only confirms rooms on the specified level, leaves other levels unchanged", async () => {
    const roomLevel1 = await insertRoom(tenant.tenantId, jobId, {
      source: "ai_vision",
      level: "1",
      reviewStatus: "pending",
    });
    const roomLevel2 = await insertRoom(tenant.tenantId, jobId, {
      source: "ai_vision",
      level: "2",
      reviewStatus: "pending",
    });

    const res = await request(app)
      .post(`/api/jobs/${jobId}/rooms/bulk-review`)
      .set("Authorization", auth(tenant))
      .send({ reviewStatus: "confirmed", level: "1" });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);

    const [row1] = await db.select().from(roomsTable).where(eq(roomsTable.id, roomLevel1));
    const [row2] = await db.select().from(roomsTable).where(eq(roomsTable.id, roomLevel2));
    expect(row1.reviewStatus).toBe("confirmed");
    expect(row2.reviewStatus).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// POST /jobs/:jobId/rooms/dismiss-warnings – dismiss warning flags
// ---------------------------------------------------------------------------

describe("POST /api/jobs/:jobId/rooms/dismiss-warnings", () => {
  it("returns 401 when no Authorization header is provided", async () => {
    const roomId = await insertRoom(tenant.tenantId, jobId, {
      source: "ai_vision",
    });

    const res = await request(app)
      .post(`/api/jobs/${jobId}/rooms/dismiss-warnings`)
      .send({ roomIds: [roomId] });

    expect(res.status).toBe(401);
  });

  it("returns 400 when roomIds is missing", async () => {
    const res = await request(app)
      .post(`/api/jobs/${jobId}/rooms/dismiss-warnings`)
      .set("Authorization", auth(tenant))
      .send({});

    expect(res.status).toBe(400);
  });

  it("returns 400 when roomIds is an empty array", async () => {
    const res = await request(app)
      .post(`/api/jobs/${jobId}/rooms/dismiss-warnings`)
      .set("Authorization", auth(tenant))
      .send({ roomIds: [] });

    expect(res.status).toBe(400);
  });

  it("returns 400 when roomIds is not an array", async () => {
    const res = await request(app)
      .post(`/api/jobs/${jobId}/rooms/dismiss-warnings`)
      .set("Authorization", auth(tenant))
      .send({ roomIds: "not-an-array" });

    expect(res.status).toBe(400);
  });

  it("sets warningDismissed=true in the DB for the specified rooms", async () => {
    const roomId1 = await insertRoom(tenant.tenantId, jobId, {
      source: "ai_vision",
    });
    const roomId2 = await insertRoom(tenant.tenantId, jobId, {
      source: "ai_vision",
    });

    const res = await request(app)
      .post(`/api/jobs/${jobId}/rooms/dismiss-warnings`)
      .set("Authorization", auth(tenant))
      .send({ roomIds: [roomId1, roomId2] });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);

    const [row1] = await db
      .select()
      .from(roomsTable)
      .where(eq(roomsTable.id, roomId1));
    const [row2] = await db
      .select()
      .from(roomsTable)
      .where(eq(roomsTable.id, roomId2));

    expect(row1.warningDismissed).toBe(true);
    expect(row2.warningDismissed).toBe(true);
  });

  it("only updates the rooms listed in roomIds", async () => {
    const targetRoomId = await insertRoom(tenant.tenantId, jobId, {
      source: "ai_vision",
    });
    const untouchedRoomId = await insertRoom(tenant.tenantId, jobId, {
      source: "ai_vision",
    });

    const res = await request(app)
      .post(`/api/jobs/${jobId}/rooms/dismiss-warnings`)
      .set("Authorization", auth(tenant))
      .send({ roomIds: [targetRoomId] });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);

    const [touched] = await db
      .select()
      .from(roomsTable)
      .where(eq(roomsTable.id, targetRoomId));
    const [untouched] = await db
      .select()
      .from(roomsTable)
      .where(eq(roomsTable.id, untouchedRoomId));

    expect(touched.warningDismissed).toBe(true);
    expect(untouched.warningDismissed).toBe(false);
  });

  it("rooms list reflects warningDismissed=true after dismissal", async () => {
    const roomId = await insertRoom(tenant.tenantId, jobId, {
      source: "ai_vision",
    });

    await request(app)
      .post(`/api/jobs/${jobId}/rooms/dismiss-warnings`)
      .set("Authorization", auth(tenant))
      .send({ roomIds: [roomId] });

    const listRes = await request(app)
      .get(`/api/jobs/${jobId}/rooms`)
      .set("Authorization", auth(tenant));

    expect(listRes.status).toBe(200);
    const room = listRes.body.find((r: { id: string }) => r.id === roomId);
    expect(room).toBeDefined();
    expect(room.warningDismissed).toBe(true);
  });

  it("does not update rooms belonging to another tenant", async () => {
    const other = await seedRegularTenant();
    trackedTenantIds.push(other.tenantId);

    const otherJobId = uid("job");
    await db.insert(jobsTable).values({
      id: otherJobId,
      tenantId: other.tenantId,
      name: "Other Tenant Job",
      status: "pending",
    });

    const otherRoomId = await insertRoom(other.tenantId, otherJobId, {
      source: "ai_vision",
    });

    const res = await request(app)
      .post(`/api/jobs/${otherJobId}/rooms/dismiss-warnings`)
      .set("Authorization", auth(tenant))
      .send({ roomIds: [otherRoomId] });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(0);

    const [row] = await db
      .select()
      .from(roomsTable)
      .where(eq(roomsTable.id, otherRoomId));
    expect(row.warningDismissed).toBe(false);
  });

  it("does not update rooms belonging to a different job of the same tenant", async () => {
    const otherJobId = uid("job");
    await db.insert(jobsTable).values({
      id: otherJobId,
      tenantId: tenant.tenantId,
      name: "Other Job Same Tenant",
      status: "pending",
    });

    const otherJobRoomId = await insertRoom(tenant.tenantId, otherJobId, {
      source: "ai_vision",
    });

    const res = await request(app)
      .post(`/api/jobs/${jobId}/rooms/dismiss-warnings`)
      .set("Authorization", auth(tenant))
      .send({ roomIds: [otherJobRoomId] });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(0);

    const [row] = await db
      .select()
      .from(roomsTable)
      .where(eq(roomsTable.id, otherJobRoomId));
    expect(row.warningDismissed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// qtyOverride — PATCH /rooms/:roomId
// ---------------------------------------------------------------------------

describe("PATCH /rooms/:roomId — qtyOverride", () => {
  async function insertSign(
    tenantId: string,
    jId: string,
    rId: string,
    overrides: Partial<typeof signsTable.$inferInsert> = {},
  ) {
    const signId = uid("sign");
    await db.insert(signsTable).values({
      id: signId,
      jobId: jId,
      tenantId,
      roomId: rId,
      signType: "room_id",
      qty: 1,
      isDeleted: false,
      ...overrides,
    });
    return signId;
  }

  it("valid qtyOverride: 3 updates all non-deleted signs for the room to qty = 3", async () => {
    const roomId = await insertRoom(tenant.tenantId, jobId);
    await insertSign(tenant.tenantId, jobId, roomId);
    await insertSign(tenant.tenantId, jobId, roomId);

    const res = await request(app)
      .patch(`/api/jobs/${jobId}/rooms/${roomId}`)
      .set("Authorization", auth(tenant))
      .send({ qtyOverride: 3 });

    expect(res.status).toBe(200);

    const rows = await db
      .select()
      .from(signsTable)
      .where(eq(signsTable.roomId, roomId));
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.qty).toBe(3);
    }
  });

  it("qtyOverride: 0 is valid — sets qty to zero", async () => {
    const roomId = await insertRoom(tenant.tenantId, jobId);
    await insertSign(tenant.tenantId, jobId, roomId, { qty: 5 });

    const res = await request(app)
      .patch(`/api/jobs/${jobId}/rooms/${roomId}`)
      .set("Authorization", auth(tenant))
      .send({ qtyOverride: 0 });

    expect(res.status).toBe(200);

    const [sign] = await db
      .select()
      .from(signsTable)
      .where(eq(signsTable.roomId, roomId));
    expect(sign.qty).toBe(0);
  });

  it("qtyOverride: -1 returns 400", async () => {
    const roomId = await insertRoom(tenant.tenantId, jobId);

    const res = await request(app)
      .patch(`/api/jobs/${jobId}/rooms/${roomId}`)
      .set("Authorization", auth(tenant))
      .send({ qtyOverride: -1 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/non-negative integer/i);
  });

  it("qtyOverride: 1.5 (non-integer) returns 400", async () => {
    const roomId = await insertRoom(tenant.tenantId, jobId);

    const res = await request(app)
      .patch(`/api/jobs/${jobId}/rooms/${roomId}`)
      .set("Authorization", auth(tenant))
      .send({ qtyOverride: 1.5 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/non-negative integer/i);
  });

  it("qtyOverride without any other field satisfies the hasUpdate gate — does not return 400", async () => {
    const roomId = await insertRoom(tenant.tenantId, jobId);

    const res = await request(app)
      .patch(`/api/jobs/${jobId}/rooms/${roomId}`)
      .set("Authorization", auth(tenant))
      .send({ qtyOverride: 2 });

    expect(res.status).toBe(200);
  });

  it("deleted signs (isDeleted = true) are not affected by qtyOverride", async () => {
    const roomId = await insertRoom(tenant.tenantId, jobId);
    const liveId = await insertSign(tenant.tenantId, jobId, roomId, { qty: 1, isDeleted: false });
    const deadId = await insertSign(tenant.tenantId, jobId, roomId, { qty: 5, isDeleted: true });

    const res = await request(app)
      .patch(`/api/jobs/${jobId}/rooms/${roomId}`)
      .set("Authorization", auth(tenant))
      .send({ qtyOverride: 9 });

    expect(res.status).toBe(200);

    const [live] = await db.select().from(signsTable).where(eq(signsTable.id, liveId));
    const [dead] = await db.select().from(signsTable).where(eq(signsTable.id, deadId));

    expect(live.qty).toBe(9);
    expect(dead.qty).toBe(5);
  });

  it("does not trigger regenSignsForRoom — sign types unchanged after qty override", async () => {
    const roomId = await insertRoom(tenant.tenantId, jobId);
    const signId = await insertSign(tenant.tenantId, jobId, roomId, {
      signType: "exit",
      qty: 1,
    });

    const res = await request(app)
      .patch(`/api/jobs/${jobId}/rooms/${roomId}`)
      .set("Authorization", auth(tenant))
      .send({ qtyOverride: 4 });

    expect(res.status).toBe(200);

    const [sign] = await db.select().from(signsTable).where(eq(signsTable.id, signId));
    expect(sign.signType).toBe("exit");
    expect(sign.qty).toBe(4);
  });
});
