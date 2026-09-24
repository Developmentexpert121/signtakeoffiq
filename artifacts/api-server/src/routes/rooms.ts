import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { roomsTable, signsTable, jobsTable, ruleOverridesTable, tenantsTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { requireAuth } from "../lib/tenantAuth";
import { applyRules, type RoomRecord } from "../lib/rules-engine";
import { newId } from "../lib/ids";
import { computeLiveSignCounts, syncJobSignCounts } from "../lib/signCounts";

/**
 * Soft-delete all signs for the given room IDs, then recompute and persist
 * totalSigns / highConfidence / needsReview on the job row via the shared
 * syncJobSignCounts helper so the cached values always match /counts.
 */
async function softDeleteSignsAndRecalculate(
  jobId: string,
  tenantId: string,
  roomIds: string[],
) {
  if (roomIds.length > 0) {
    await db
      .update(signsTable)
      .set({ isDeleted: true })
      .where(
        and(
          eq(signsTable.jobId, jobId),
          eq(signsTable.tenantId, tenantId),
          inArray(signsTable.roomId, roomIds),
          eq(signsTable.isDeleted, false),
        ),
      );
  }

  return syncJobSignCounts(jobId, tenantId);
}

/**
 * Un-soft-delete all signs for the given room IDs (restoring dismissed rooms),
 * then recompute and persist job counts via syncJobSignCounts.
 */
async function restoreSignsAndRecalculate(
  jobId: string,
  tenantId: string,
  roomIds: string[],
) {
  if (roomIds.length > 0) {
    await db
      .update(signsTable)
      .set({ isDeleted: false })
      .where(
        and(
          eq(signsTable.jobId, jobId),
          eq(signsTable.tenantId, tenantId),
          inArray(signsTable.roomId, roomIds),
          eq(signsTable.isDeleted, true),
        ),
      );
  }

  return syncJobSignCounts(jobId, tenantId);
}

const router: IRouter = Router();

router.get("/jobs/:jobId/rooms", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const jobId = String(req.params.jobId);

  const rooms = await db.select().from(roomsTable)
    .where(and(eq(roomsTable.jobId, jobId), eq(roomsTable.tenantId, tenantId)));

  res.json(rooms);
});

router.post("/jobs/:jobId/rooms/bulk-review", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const jobId = String(req.params.jobId);
  const { reviewStatus, dismissalReason, fromStatus, level } = req.body as { reviewStatus: string; dismissalReason?: string; fromStatus?: string; level?: string };

  if (!["confirmed", "dismissed", "pending"].includes(reviewStatus)) {
    res.status(400).json({ error: "reviewStatus must be 'confirmed', 'dismissed', or 'pending'" });
    return;
  }

  if (reviewStatus === "pending" && fromStatus !== undefined && !["confirmed", "dismissed"].includes(fromStatus)) {
    res.status(400).json({ error: "fromStatus must be 'confirmed' or 'dismissed'" });
    return;
  }

  const updateData: { reviewStatus: string; dismissalReason?: string | null; warningDismissed?: boolean } = { reviewStatus };
  if (reviewStatus === "dismissed") {
    updateData.dismissalReason = dismissalReason ?? null;
  } else {
    updateData.dismissalReason = null;
  }
  if (reviewStatus === "pending") {
    updateData.warningDismissed = false;
  }

  const conditions = [
    eq(roomsTable.jobId, jobId),
    eq(roomsTable.tenantId, tenantId),
    eq(roomsTable.source, "ai_vision"),
  ];

  if (reviewStatus === "pending") {
    const sourceStatus = fromStatus === "confirmed" ? "confirmed" : "dismissed";
    conditions.push(eq(roomsTable.reviewStatus, sourceStatus));
  }

  if (level !== undefined) {
    conditions.push(eq(roomsTable.level, level));
  }

  const result = await db
    .update(roomsTable)
    .set(updateData)
    .where(and(...conditions))
    .returning({ id: roomsTable.id });

  const roomIds = result.map((r) => r.id);

  if (reviewStatus === "dismissed" && roomIds.length > 0) {
    // Soft-delete signs for dismissed rooms and sync cached counts
    await softDeleteSignsAndRecalculate(jobId, tenantId, roomIds);
  } else if (reviewStatus === "pending" && roomIds.length > 0) {
    // Restore signs for un-dismissed rooms and sync cached counts
    await restoreSignsAndRecalculate(jobId, tenantId, roomIds);
  }

  res.json({ updated: result.length });
});

router.post("/jobs/:jobId/rooms/dismiss-warnings", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const jobId = String(req.params.jobId);
  const { roomIds } = req.body as { roomIds?: unknown };

  if (!Array.isArray(roomIds) || roomIds.length === 0) {
    res.status(400).json({ error: "roomIds must be a non-empty array" });
    return;
  }

  const ids = roomIds.map(String);

  const result = await db
    .update(roomsTable)
    .set({ warningDismissed: true })
    .where(
      and(
        eq(roomsTable.jobId, jobId),
        eq(roomsTable.tenantId, tenantId),
        inArray(roomsTable.id, ids),
      ),
    )
    .returning({ id: roomsTable.id });

  res.json({ updated: result.length });
});

router.get("/jobs/:jobId/rooms/:roomId", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const jobId = String(req.params.jobId);
  const roomId = String(req.params.roomId);

  const [room] = await db.select().from(roomsTable)
    .where(and(
      eq(roomsTable.jobId, jobId),
      eq(roomsTable.tenantId, tenantId),
      eq(roomsTable.id, roomId),
    ));

  if (!room) {
    res.status(404).json({ error: "Room not found" });
    return;
  }

  const signs = await db.select().from(signsTable)
    .where(and(
      eq(signsTable.jobId, jobId),
      eq(signsTable.roomId, roomId),
      eq(signsTable.isDeleted, false),
    ));

  res.json({
    ...room,
    signs: signs.map(s => ({
      ...s,
      confidence: parseFloat(String(s.confidence || "0")),
    })),
  });
});

/** Allowed flag names that can be overridden by the UI. */
const ALLOWED_FLAG_NAMES = new Set([
  "isVariableUse",
  "isAssembly",
  "isMepUnoccupied",
  "isRestroom",
  "isCorridorOrHall",
  "isPublicFacing",
  "isResidentialUnit",
]);

router.patch("/jobs/:jobId/rooms/:roomId", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const jobId = String(req.params.jobId);
  const roomId = String(req.params.roomId);
  const { reviewStatus, dismissalReason, roomName, publicDoorCount, flagOverrides, qtyOverride } = req.body as {
    reviewStatus?: string;
    dismissalReason?: string;
    roomName?: string;
    publicDoorCount?: number | null;
    flagOverrides?: Partial<Record<string, boolean>>;
    qtyOverride?: number;
  };

  const hasUpdate =
    reviewStatus !== undefined ||
    roomName !== undefined ||
    publicDoorCount !== undefined ||
    flagOverrides !== undefined ||
    qtyOverride !== undefined;

  if (!hasUpdate) {
    res.status(400).json({ error: "reviewStatus, roomName, publicDoorCount, flagOverrides, or qtyOverride must be provided" });
    return;
  }

  if (qtyOverride !== undefined) {
    if (!Number.isInteger(qtyOverride) || qtyOverride < 0) {
      res.status(400).json({ error: "qtyOverride must be a non-negative integer" });
      return;
    }
  }

  const updateData: Record<string, unknown> = {};

  if (reviewStatus !== undefined) {
    if (!["confirmed", "dismissed", "pending"].includes(reviewStatus)) {
      res.status(400).json({ error: "reviewStatus must be 'confirmed', 'dismissed', or 'pending'" });
      return;
    }
    updateData.reviewStatus = reviewStatus;
    updateData.dismissalReason = reviewStatus === "dismissed" ? (dismissalReason ?? null) : null;
  }

  if (roomName !== undefined) {
    updateData.roomName = roomName.trim();
  }

  if (publicDoorCount !== undefined) {
    const count = publicDoorCount === null ? null : Math.max(0, Math.floor(Number(publicDoorCount)));
    updateData.publicDoorCount = count;
  }

  // Flag overrides: validate keys, load current overrides from DB, merge, then
  // write both the jsonb column (memory of what was manually set) and the
  // individual boolean columns (used by the rules engine).
  if (flagOverrides !== undefined) {
    // Validate incoming flag names
    const invalidKeys = Object.keys(flagOverrides).filter((k) => !ALLOWED_FLAG_NAMES.has(k));
    if (invalidKeys.length > 0) {
      res.status(400).json({ error: `Unknown flag name(s): ${invalidKeys.join(", ")}` });
      return;
    }

    // Load existing room to get current flagOverrides
    const [existing] = await db
      .select({ flagOverrides: roomsTable.flagOverrides })
      .from(roomsTable)
      .where(and(eq(roomsTable.jobId, jobId), eq(roomsTable.tenantId, tenantId), eq(roomsTable.id, roomId)));

    if (!existing) {
      res.status(404).json({ error: "Room not found" });
      return;
    }

    const existingOverrides = (existing.flagOverrides ?? {}) as Record<string, boolean>;
    const merged = { ...existingOverrides, ...flagOverrides };

    // Remove any keys explicitly set to undefined (clean up)
    for (const [k, v] of Object.entries(merged)) {
      if (v === undefined) delete merged[k];
    }

    updateData.flagOverrides = merged;

    // Apply each flag to its individual boolean column so the rules engine
    // picks it up immediately (without needing a full rescan).
    for (const [flag, value] of Object.entries(flagOverrides)) {
      if (typeof value === "boolean") {
        updateData[flag] = value;
      }
    }
  }

  let updated: typeof roomsTable.$inferSelect | undefined;

  if (Object.keys(updateData).length > 0) {
    const result = await db
      .update(roomsTable)
      .set(updateData)
      .where(
        and(
          eq(roomsTable.jobId, jobId),
          eq(roomsTable.tenantId, tenantId),
          eq(roomsTable.id, roomId),
        ),
      )
      .returning();
    updated = result[0];
  } else {
    // No room-level fields to update (e.g. only qtyOverride was sent).
    // Fetch the current row to validate existence and return it.
    const [room] = await db
      .select()
      .from(roomsTable)
      .where(
        and(
          eq(roomsTable.jobId, jobId),
          eq(roomsTable.tenantId, tenantId),
          eq(roomsTable.id, roomId),
        ),
      );
    updated = room;
  }

  if (!updated) {
    res.status(404).json({ error: "Room not found" });
    return;
  }

  // Sync sign soft-delete state and cached job counts whenever review status changes
  if (reviewStatus === "dismissed") {
    await softDeleteSignsAndRecalculate(jobId, tenantId, [roomId]);
  } else if (reviewStatus === "pending") {
    await restoreSignsAndRecalculate(jobId, tenantId, [roomId]);
  }

  // Re-run the rules engine for this room whenever flags or door count change
  // so signs update immediately without a full rescan.
  if (publicDoorCount !== undefined || flagOverrides !== undefined) {
    await regenSignsForRoom(jobId, tenantId, roomId);
  }

  // Manual qty override — set qty on all non-deleted signs for this room.
  // Does not trigger a rules re-run; this is a direct user override.
  if (qtyOverride !== undefined) {
    await db
      .update(signsTable)
      .set({ qty: qtyOverride })
      .where(
        and(
          eq(signsTable.jobId, jobId),
          eq(signsTable.tenantId, tenantId),
          eq(signsTable.roomId, roomId),
          eq(signsTable.isDeleted, false),
        ),
      );
  }

  res.json(updated);
});

/**
 * Re-apply the rules engine for a single room and replace its signs.
 * Loads all non-dismissed rooms for the job (needed for job-level context),
 * runs applyRules, then soft-deletes the room's existing signs and inserts
 * the new output.
 */
async function regenSignsForRoom(jobId: string, tenantId: string, roomId: string): Promise<void> {
  // Load job for building type
  const [job] = await db.select({ buildingType: jobsTable.buildingType })
    .from(jobsTable)
    .where(and(eq(jobsTable.id, jobId), eq(jobsTable.tenantId, tenantId)));
  if (!job) return;

  // Load tenant settings for custom multi-entry keywords
  const [tenant] = await db.select({ settings: tenantsTable.settings })
    .from(tenantsTable)
    .where(eq(tenantsTable.id, tenantId));
  const tenantSettings = (tenant?.settings ?? {}) as Record<string, unknown>;
  const rawCustomKeywords = tenantSettings.multiEntryRoomKeywords;
  const customMultiEntryKeywords: string[] = Array.isArray(rawCustomKeywords)
    ? rawCustomKeywords.filter((k): k is string => typeof k === "string" && k.trim().length > 0)
    : [];

  // Load all rooms for the job (rules engine needs full context)
  const dbRooms = await db.select().from(roomsTable)
    .where(and(eq(roomsTable.jobId, jobId), eq(roomsTable.tenantId, tenantId)));

  const roomRecords: RoomRecord[] = dbRooms.map((r) => ({
    id: r.id,
    roomNumber: r.roomNumber,
    roomName: r.roomName,
    level: r.level,
    occupantLoad: r.occupantLoad,
    occupancyGroup: r.occupancyGroup,
    sheetId: r.sheetId,
    coordX: r.coordX,
    coordY: r.coordY,
    isResidentialUnit: r.isResidentialUnit,
    isRestroom: r.isRestroom,
    isStair: r.isStair,
    isElevator: r.isElevator,
    isVestibule: r.isVestibule,
    isCorridorOrHall: r.isCorridorOrHall,
    isVehicleBay: r.isVehicleBay,
    isMepUnoccupied: r.isMepUnoccupied,
    isVariableUse: r.isVariableUse,
    isPublicFacing: r.isPublicFacing,
    isAssembly: r.isAssembly,
    publicDoorCount: r.publicDoorCount ?? null,
  }));

  const ruleOverrides = await db.select().from(ruleOverridesTable)
    .where(and(eq(ruleOverridesTable.tenantId, tenantId), eq(ruleOverridesTable.isActive, true)));

  const ruleOutput = applyRules({
    rooms: roomRecords,
    buildingType: job.buildingType ?? "commercial",
    ruleOverrides: ruleOverrides.map((o) => ({
      ruleRef: o.ruleRef,
      overrideType: o.overrideType,
      condition: o.condition as Record<string, unknown>,
      action: o.action as Record<string, unknown>,
    })),
    customMultiEntryKeywords,
  });

  // Find signs for the specific room in the rules output
  const roomResult = ruleOutput.results.find((r) => r.room.id === roomId);
  if (!roomResult) return;

  // Soft-delete existing signs for this room
  await db.update(signsTable)
    .set({ isDeleted: true })
    .where(and(
      eq(signsTable.jobId, jobId),
      eq(signsTable.tenantId, tenantId),
      eq(signsTable.roomId, roomId),
      eq(signsTable.isDeleted, false),
    ));

  // Insert new signs from rules output
  if (roomResult.signs.length > 0) {
    const floorPlanSheetIds: Record<string, string | null> = {};
    for (const r of dbRooms) {
      if (r.sheetId && !floorPlanSheetIds[r.level]) {
        floorPlanSheetIds[r.level] = r.sheetId;
      }
    }
    await db.insert(signsTable).values(
      roomResult.signs.map((sa) => ({
        id: newId("sign"),
        jobId,
        tenantId,
        roomId,
        sheetId: roomResult.room.sheetId ?? floorPlanSheetIds[roomResult.room.level] ?? null,
        signType: sa.signType,
        qty: sa.qty,
        ruleRef: sa.ruleRef,
        color: sa.color,
        confidence: String(sa.confidence),
        status: sa.status,
        source: "rules_engine" as const,
        markerX: roomResult.room.coordX,
        markerY: roomResult.room.coordY,
      })),
    );
  }

  // Recalculate job-level sign counts via shared helper so they always match /counts
  await syncJobSignCounts(jobId, tenantId);
}

/**
 * PATCH /jobs/:jobId/rooms/:roomId/marker
 * Save a human-corrected marker position.
 * Body: { x: number, y: number }  — 0-1000 normalised coordinates.
 */
router.patch("/jobs/:jobId/rooms/:roomId/marker", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const jobId = String(req.params.jobId);
  const roomId = String(req.params.roomId);
  const { x, y } = req.body as { x?: unknown; y?: unknown };

  const numX = typeof x === "number" ? x : (typeof x === "string" ? parseFloat(x) : NaN);
  const numY = typeof y === "number" ? y : (typeof y === "string" ? parseFloat(y) : NaN);

  if (isNaN(numX) || isNaN(numY) || numX < 0 || numX > 1000 || numY < 0 || numY > 1000) {
    res.status(400).json({ error: "x and y must be numbers in the range 0–1000" });
    return;
  }

  const [updated] = await db
    .update(roomsTable)
    .set({
      coordX: Math.round(numX),
      coordY: Math.round(numY),
      coordSource: "human_corrected",
    })
    .where(
      and(
        eq(roomsTable.jobId, jobId),
        eq(roomsTable.tenantId, tenantId),
        eq(roomsTable.id, roomId),
      ),
    )
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Room not found" });
    return;
  }

  res.json(updated);
});

/**
 * GET /jobs/:jobId/sign-count  (legacy path — kept for backwards compat)
 * GET /jobs/:jobId/counts       (preferred lightweight path)
 * Returns live sign counts computed fresh from the DB on every call — no cache.
 * { totalSigns, highConfidence, needsReview }
 */
router.get("/jobs/:jobId/sign-count", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const jobId = String(req.params.jobId);
  res.json(await computeLiveSignCounts(jobId, tenantId));
});

router.get("/jobs/:jobId/counts", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const jobId = String(req.params.jobId);
  res.json(await computeLiveSignCounts(jobId, tenantId));
});

export default router;
