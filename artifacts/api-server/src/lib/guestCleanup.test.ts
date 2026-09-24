import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  aiScansTable,
  jobFilesTable,
  jobSheetsTable,
  jobsTable,
  plaqueScheduleTable,
  roomsTable,
  ruleOverridesTable,
  signsTable,
  tenantsTable,
  trainingCorrectionsTable,
  usersTable,
  validationResultsTable,
} from "@workspace/db";
import { deleteExpiredGuestTenants, countExpiredGuestTenants } from "./guestCleanup";
import { GUEST_SESSION_TTL_MS, GUEST_TENANT_PREFIX } from "./guestAuth";
import {
  cleanupTenants,
  insertGuest,
  seedExpiredGuestTenant,
  tenantExists,
} from "../__tests__/fixtures";

const trackedIds: string[] = [];

function guestId(suffix: string) {
  return `${GUEST_TENANT_PREFIX}test_${suffix}_${Date.now()}`;
}

afterEach(async () => {
  await cleanupTenants([...trackedIds]);
  trackedIds.length = 0;
});

describe("deleteExpiredGuestTenants – basic behaviour", () => {
  it("deletes an expired guest tenant (lastActiveAt past TTL)", async () => {
    const id = guestId("expired");
    const oldTime = new Date(Date.now() - GUEST_SESSION_TTL_MS - 60_000);
    await insertGuest(id, { lastActiveAt: oldTime });
    trackedIds.push(id);

    expect(await tenantExists(id)).toBe(true);

    const result = await deleteExpiredGuestTenants();

    expect(result.tenantsDeleted).toBeGreaterThanOrEqual(1);
    expect(await tenantExists(id)).toBe(false);
    trackedIds.splice(trackedIds.indexOf(id), 1);
  });

  it("does NOT delete a guest tenant still within the TTL window", async () => {
    const id = guestId("active");
    const recentTime = new Date(Date.now() - 60_000);
    await insertGuest(id, { lastActiveAt: recentTime });
    trackedIds.push(id);

    await deleteExpiredGuestTenants();

    expect(await tenantExists(id)).toBe(true);
  });

  it("falls back to createdAt when lastActiveAt is null and deletes if expired", async () => {
    const id = guestId("no_activity");
    const oldTime = new Date(Date.now() - GUEST_SESSION_TTL_MS - 60_000);
    await insertGuest(id, { lastActiveAt: null, createdAt: oldTime });
    trackedIds.push(id);

    expect(await tenantExists(id)).toBe(true);

    const result = await deleteExpiredGuestTenants();

    expect(result.tenantsDeleted).toBeGreaterThanOrEqual(1);
    expect(await tenantExists(id)).toBe(false);
    trackedIds.splice(trackedIds.indexOf(id), 1);
  });

  it("returns 0 when no guest tenants are expired", async () => {
    const id = guestId("fresh");
    await insertGuest(id, { lastActiveAt: new Date() });
    trackedIds.push(id);

    const result = await deleteExpiredGuestTenants();

    expect(result.tenantsDeleted).toBe(0);
  });

  it("does not delete regular (non-guest) tenants even if they appear old", async () => {
    const id = `regular_tenant_test_${Date.now()}`;
    trackedIds.push(id);
    await db.insert(tenantsTable).values({
      id,
      name: "Regular Tenant",
      slug: `regular-slug-${id}`,
      plan: "starter",
      settings: {},
      lastActiveAt: new Date(Date.now() - GUEST_SESSION_TTL_MS - 60_000),
    });

    await deleteExpiredGuestTenants();

    expect(await tenantExists(id)).toBe(true);
  });
});

describe("deleteExpiredGuestTenants – cascade coverage", () => {
  it("removes the expired guest tenant itself", async () => {
    const { tenantId } = await seedExpiredGuestTenant();
    trackedIds.push(tenantId);

    expect(await tenantExists(tenantId)).toBe(true);

    await deleteExpiredGuestTenants();

    expect(await tenantExists(tenantId)).toBe(false);
    trackedIds.splice(trackedIds.indexOf(tenantId), 1);
  });

  it("cascades to users table", async () => {
    const { tenantId, userId } = await seedExpiredGuestTenant();
    trackedIds.push(tenantId);

    const [before] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    expect(before).toBeDefined();

    await deleteExpiredGuestTenants();

    const [after] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    expect(after).toBeUndefined();
  });

  it("cascades to jobs table", async () => {
    const { tenantId, jobId } = await seedExpiredGuestTenant();
    trackedIds.push(tenantId);

    const [before] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId));
    expect(before).toBeDefined();

    await deleteExpiredGuestTenants();

    const [after] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId));
    expect(after).toBeUndefined();
  });

  it("cascades to job_files table", async () => {
    const { tenantId, jobFileId } = await seedExpiredGuestTenant();
    trackedIds.push(tenantId);

    const [before] = await db.select().from(jobFilesTable).where(eq(jobFilesTable.id, jobFileId));
    expect(before).toBeDefined();

    await deleteExpiredGuestTenants();

    const [after] = await db.select().from(jobFilesTable).where(eq(jobFilesTable.id, jobFileId));
    expect(after).toBeUndefined();
  });

  it("cascades to job_sheets table", async () => {
    const { tenantId, jobSheetId } = await seedExpiredGuestTenant();
    trackedIds.push(tenantId);

    const [before] = await db.select().from(jobSheetsTable).where(eq(jobSheetsTable.id, jobSheetId));
    expect(before).toBeDefined();

    await deleteExpiredGuestTenants();

    const [after] = await db.select().from(jobSheetsTable).where(eq(jobSheetsTable.id, jobSheetId));
    expect(after).toBeUndefined();
  });

  it("cascades to rooms table", async () => {
    const { tenantId, roomId } = await seedExpiredGuestTenant();
    trackedIds.push(tenantId);

    const [before] = await db.select().from(roomsTable).where(eq(roomsTable.id, roomId));
    expect(before).toBeDefined();

    await deleteExpiredGuestTenants();

    const [after] = await db.select().from(roomsTable).where(eq(roomsTable.id, roomId));
    expect(after).toBeUndefined();
  });

  it("cascades to signs table", async () => {
    const { tenantId, signId } = await seedExpiredGuestTenant();
    trackedIds.push(tenantId);

    const [before] = await db.select().from(signsTable).where(eq(signsTable.id, signId));
    expect(before).toBeDefined();

    await deleteExpiredGuestTenants();

    const [after] = await db.select().from(signsTable).where(eq(signsTable.id, signId));
    expect(after).toBeUndefined();
  });

  it("cascades to ai_scans table", async () => {
    const { tenantId, aiScanId } = await seedExpiredGuestTenant();
    trackedIds.push(tenantId);

    const [before] = await db.select().from(aiScansTable).where(eq(aiScansTable.id, aiScanId));
    expect(before).toBeDefined();

    await deleteExpiredGuestTenants();

    const [after] = await db.select().from(aiScansTable).where(eq(aiScansTable.id, aiScanId));
    expect(after).toBeUndefined();
  });

  it("cascades to plaque_schedule table", async () => {
    const { tenantId, plaqueId } = await seedExpiredGuestTenant();
    trackedIds.push(tenantId);

    const [before] = await db.select().from(plaqueScheduleTable).where(eq(plaqueScheduleTable.id, plaqueId));
    expect(before).toBeDefined();

    await deleteExpiredGuestTenants();

    const [after] = await db.select().from(plaqueScheduleTable).where(eq(plaqueScheduleTable.id, plaqueId));
    expect(after).toBeUndefined();
  });

  it("cascades to validation_results table", async () => {
    const { tenantId, validationId } = await seedExpiredGuestTenant();
    trackedIds.push(tenantId);

    const [before] = await db.select().from(validationResultsTable).where(eq(validationResultsTable.id, validationId));
    expect(before).toBeDefined();

    await deleteExpiredGuestTenants();

    const [after] = await db.select().from(validationResultsTable).where(eq(validationResultsTable.id, validationId));
    expect(after).toBeUndefined();
  });

  it("cascades to training_corrections table", async () => {
    const { tenantId, correctionId } = await seedExpiredGuestTenant();
    trackedIds.push(tenantId);

    const [before] = await db.select().from(trainingCorrectionsTable).where(eq(trainingCorrectionsTable.id, correctionId));
    expect(before).toBeDefined();

    await deleteExpiredGuestTenants();

    const [after] = await db.select().from(trainingCorrectionsTable).where(eq(trainingCorrectionsTable.id, correctionId));
    expect(after).toBeUndefined();
  });

  it("cascades to rule_overrides table", async () => {
    const { tenantId, ruleOverrideId } = await seedExpiredGuestTenant();
    trackedIds.push(tenantId);

    const [before] = await db.select().from(ruleOverridesTable).where(eq(ruleOverridesTable.id, ruleOverrideId));
    expect(before).toBeDefined();

    await deleteExpiredGuestTenants();

    const [after] = await db.select().from(ruleOverridesTable).where(eq(ruleOverridesTable.id, ruleOverrideId));
    expect(after).toBeUndefined();
  });
});

describe("countExpiredGuestTenants", () => {
  it("counts only expired guest tenants, ignoring active ones", async () => {
    const expiredId1 = guestId("cnt_exp1");
    const expiredId2 = guestId("cnt_exp2");
    const activeId = guestId("cnt_active");
    const oldTime = new Date(Date.now() - GUEST_SESSION_TTL_MS - 60_000);

    await insertGuest(expiredId1, { lastActiveAt: oldTime });
    await insertGuest(expiredId2, { lastActiveAt: oldTime });
    await insertGuest(activeId, { lastActiveAt: new Date() });
    trackedIds.push(expiredId1, expiredId2, activeId);

    const count = await countExpiredGuestTenants();
    expect(count).toBeGreaterThanOrEqual(2);

    await deleteExpiredGuestTenants();
    trackedIds.splice(trackedIds.indexOf(expiredId1), 1);
    trackedIds.splice(trackedIds.indexOf(expiredId2), 1);

    const countAfter = await countExpiredGuestTenants();
    expect(countAfter).toBe(0);
  });
});
