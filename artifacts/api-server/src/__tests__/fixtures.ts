import { eq, inArray } from "drizzle-orm";
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
import { GUEST_SESSION_TTL_MS, GUEST_TENANT_PREFIX, signGuestToken } from "../lib/guestAuth";

export { GUEST_TENANT_PREFIX, GUEST_SESSION_TTL_MS };

export interface SeededRegularTenant {
  tenantId: string;
  userId: string;
  bearerToken: string;
}

/**
 * Creates a fresh tenant with a guest-role user and returns a signed JWT
 * that integration tests can use in Authorization: Bearer headers.
 * Uses the guest token path in requireAuth so Clerk is not needed.
 */
export async function seedRegularTenant(): Promise<SeededRegularTenant> {
  const tenantId = `${GUEST_TENANT_PREFIX}${uid("regular")}`;
  const slug = uid("regular-test");

  await db.insert(tenantsTable).values({
    id: tenantId,
    name: "Regular Test Tenant",
    slug,
    lastActiveAt: new Date(),
  });

  const userId = uid("user");
  await db.insert(usersTable).values({
    id: userId,
    tenantId,
    email: `${userId}@guest.local`,
    role: "guest",
  });

  const bearerToken = signGuestToken(userId, tenantId);

  return { tenantId, userId, bearerToken };
}

export function uid(label: string): string {
  return `${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function insertGuest(
  id: string,
  opts: { lastActiveAt?: Date | null; createdAt?: Date } = {},
): Promise<void> {
  await db.insert(tenantsTable).values({
    id,
    name: `Test Guest ${id}`,
    slug: `slug-${id}`,
    plan: "starter",
    settings: {},
    lastActiveAt: opts.lastActiveAt ?? null,
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
  });
}

export async function tenantExists(id: string): Promise<boolean> {
  const rows = await db
    .select({ id: tenantsTable.id })
    .from(tenantsTable)
    .where(eq(tenantsTable.id, id));
  return rows.length > 0;
}

export async function cleanupTenants(ids: string[]): Promise<void> {
  if (ids.length > 0) {
    await db.delete(tenantsTable).where(inArray(tenantsTable.id, ids));
  }
}

export interface SeededGuestTenant {
  tenantId: string;
  userId: string;
  jobId: string;
  jobFileId: string;
  jobSheetId: string;
  roomId: string;
  signId: string;
  aiScanId: string;
  plaqueId: string;
  validationId: string;
  correctionId: string;
  ruleOverrideId: string;
}

export async function seedExpiredGuestTenant(): Promise<SeededGuestTenant> {
  const expiredAt = new Date(Date.now() - GUEST_SESSION_TTL_MS - 60_000);
  const tenantId = `${GUEST_TENANT_PREFIX}${uid("test")}`;
  const slug = uid("guest-test");

  await db.insert(tenantsTable).values({
    id: tenantId,
    name: "Test Guest Tenant",
    slug,
    lastActiveAt: expiredAt,
  });

  const userId = uid("user");
  await db.insert(usersTable).values({
    id: userId,
    tenantId,
    email: `${userId}@guest.local`,
    role: "guest",
  });

  const jobId = uid("job");
  await db.insert(jobsTable).values({
    id: jobId,
    tenantId,
    name: "Test Job",
    status: "pending",
  });

  const jobFileId = uid("file");
  await db.insert(jobFilesTable).values({
    id: jobFileId,
    jobId,
    tenantId,
    filename: "test.pdf",
    storagePath: `${tenantId}/test.pdf`,
  });

  const jobSheetId = uid("sheet");
  await db.insert(jobSheetsTable).values({
    id: jobSheetId,
    jobId,
    tenantId,
    sheetId: "sheet-1",
    pdfPage: 1,
  });

  const roomId = uid("room");
  await db.insert(roomsTable).values({
    id: roomId,
    jobId,
    tenantId,
    roomNumber: "101",
    roomName: "Office",
    level: "1",
  });

  const signId = uid("sign");
  await db.insert(signsTable).values({
    id: signId,
    jobId,
    tenantId,
    signType: "exit",
  });

  const aiScanId = uid("scan");
  await db.insert(aiScansTable).values({
    id: aiScanId,
    jobId,
    tenantId,
    callType: "room_extraction",
  });

  const plaqueId = uid("plaque");
  await db.insert(plaqueScheduleTable).values({
    id: plaqueId,
    jobId,
    tenantId,
    typeId: "type-a",
    name: "Exit Sign",
  });

  const validationId = uid("validation");
  await db.insert(validationResultsTable).values({
    id: validationId,
    jobId,
    tenantId,
    checkName: "sign_count",
    status: "pass",
  });

  const correctionId = uid("correction");
  await db.insert(trainingCorrectionsTable).values({
    id: correctionId,
    tenantId,
    correctionType: "add_sign",
  });

  const ruleOverrideId = uid("override");
  await db.insert(ruleOverridesTable).values({
    id: ruleOverrideId,
    tenantId,
    ruleRef: "exit-sign-rule",
  });

  return {
    tenantId,
    userId,
    jobId,
    jobFileId,
    jobSheetId,
    roomId,
    signId,
    aiScanId,
    plaqueId,
    validationId,
    correctionId,
    ruleOverrideId,
  };
}
