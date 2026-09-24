import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  jobsTable, signsTable, aiScansTable, roomsTable, ruleOverridesTable,
  validationResultsTable, tenantsTable
} from "@workspace/db";
import { eq, and, desc, sql, or, ilike, ne, inArray } from "drizzle-orm";
import { requireAuth, touchGuestLastActive, isSuperAdmin } from "../lib/tenantAuth";
import { newId } from "../lib/ids";
import {
  CreateJobBody, UpdateJobBody
} from "@workspace/api-zod";
import { processJob, ESTIMATED_SECONDS_PER_SHEET } from "../lib/pipeline";
import { getJobMaterialSpec } from "../lib/materialSpec";
import { applyRules, runValidationChecks, type RoomRecord } from "../lib/rules-engine";
import { logger } from "../lib/logger";
import { SIGN_COLORS, DEFAULT_SIGN_COLOR } from "../lib/signColors";
import { computeLiveSignCounts } from "../lib/signCounts";

export const CANONICAL_BUILDING_TYPE_VALUES = [
  "commercial",
  "residential",
  "education",
  "healthcare",
  "government",
  "hotel",
  "assembly",
  "unknown",
] as const;

type CanonicalBuildingType = typeof CANONICAL_BUILDING_TYPE_VALUES[number];

const BUILDING_TYPE_MIGRATIONS: Record<string, CanonicalBuildingType> = {
  "other":       "unknown",
  "office":      "commercial",
  "multifamily": "residential",
  "hospital":    "healthcare",
};

export async function migrateLegacyBuildingTypes(): Promise<void> {
  try {
    const legacyValues = Object.keys(BUILDING_TYPE_MIGRATIONS);
    const rows = await db
      .select({ id: jobsTable.id, buildingType: jobsTable.buildingType })
      .from(jobsTable)
      .where(inArray(jobsTable.buildingType, legacyValues));
    if (rows.length === 0) return;
    await Promise.all(
      rows.map((row) => {
        const newType = BUILDING_TYPE_MIGRATIONS[row.buildingType as string];
        return db
          .update(jobsTable)
          .set({ buildingType: newType })
          .where(eq(jobsTable.id, row.id));
      })
    );
    logger.info({ count: rows.length }, "Migrated legacy building type values");
  } catch (err) {
    logger.error({ err }, "Failed to migrate legacy building type values");
  }
}

function isValidBuildingType(value: string): value is CanonicalBuildingType {
  return (CANONICAL_BUILDING_TYPE_VALUES as readonly string[]).includes(value);
}

const router: IRouter = Router();

function serializeJob(j: typeof jobsTable.$inferSelect) {
  const meta = (j.metadata || {}) as Record<string, unknown>;
  return {
    ...j,
    aiTokenCost: parseFloat(String(j.aiTokenCost || "0")),
    metadata: meta,
    strategy: j.scopeFlag ?? meta.pipelineStrategy ?? null,
  };
}

router.get("/jobs", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const limit = req.query.limit ? parseInt(String(req.query.limit)) : 50;
  const offset = req.query.offset ? parseInt(String(req.query.offset)) : 0;
  const rawBuildingType = req.query.buildingType;
  const buildingTypeFilters: string[] = rawBuildingType
    ? (Array.isArray(rawBuildingType) ? rawBuildingType : [rawBuildingType]).map(String).filter(Boolean)
    : [];

  const conditions = [ne(jobsTable.status, "archived")];
  if (!isSuperAdmin(req.auth_ctx!.role)) {
    conditions.unshift(eq(jobsTable.tenantId, tenantId));
  }
  if (buildingTypeFilters.length === 1) {
    conditions.push(ilike(jobsTable.buildingType, buildingTypeFilters[0]));
  } else if (buildingTypeFilters.length > 1) {
    conditions.push(or(...buildingTypeFilters.map(bt => ilike(jobsTable.buildingType, bt)))!);
  }

  const query = db.select().from(jobsTable).where(and(...conditions)).$dynamic();

  const jobs = await query.orderBy(desc(jobsTable.updatedAt)).limit(limit).offset(offset);
  res.json(jobs.map(serializeJob));
});

router.post("/jobs", requireAuth, async (req, res): Promise<void> => {
  const { tenantId, role } = req.auth_ctx!;
  const rawVt = (req.body as { visionThreshold?: unknown } | undefined)?.visionThreshold;
  if (typeof rawVt === "number" && (rawVt < 0 || rawVt > 50)) {
    res.status(422).json({ error: "Maximum allowed value is 50" });
    return;
  }
  const parsed = CreateJobBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  if (!parsed.data.buildingType) {
    res.status(400).json({
      error: `buildingType is required. Must be one of: ${CANONICAL_BUILDING_TYPE_VALUES.join(", ")}`,
    });
    return;
  }

  if (!isValidBuildingType(parsed.data.buildingType)) {
    res.status(400).json({
      error: `Invalid building type. Must be one of: ${CANONICAL_BUILDING_TYPE_VALUES.join(", ")}`,
    });
    return;
  }

  const [job] = await db.insert(jobsTable).values({
    id: newId("job"),
    tenantId,
    name: parsed.data.name,
    location: parsed.data.location,
    jurisdiction: parsed.data.jurisdiction,
    buildingType: parsed.data.buildingType,
    visionThreshold: parsed.data.visionThreshold ?? null,
    status: "pending",
  }).returning();

  await touchGuestLastActive(tenantId, role);

  res.status(201).json(serializeJob(job));
});

router.get("/jobs/:jobId", requireAuth, async (req, res): Promise<void> => {
  const { tenantId, role } = req.auth_ctx!;
  const jobId = String(req.params.jobId);
  const whereClause = isSuperAdmin(role)
    ? eq(jobsTable.id, jobId)
    : and(eq(jobsTable.id, jobId), eq(jobsTable.tenantId, tenantId));

  const [job] = await db.select().from(jobsTable).where(whereClause);

  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  res.json(serializeJob(job));
});

router.patch("/jobs/:jobId", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const jobId = String(req.params.jobId);
  const rawVt = (req.body as { visionThreshold?: unknown } | undefined)?.visionThreshold;
  if (typeof rawVt === "number" && (rawVt < 0 || rawVt > 50)) {
    res.status(422).json({ error: "Maximum allowed value is 50" });
    return;
  }
  const parsed = UpdateJobBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  if (parsed.data.buildingType && !isValidBuildingType(parsed.data.buildingType)) {
    res.status(400).json({
      error: `Invalid building type. Must be one of: ${CANONICAL_BUILDING_TYPE_VALUES.join(", ")}`,
    });
    return;
  }

  const [job] = await db.update(jobsTable)
    .set({
      ...(parsed.data.name && { name: parsed.data.name }),
      ...(parsed.data.status && { status: parsed.data.status }),
      ...(parsed.data.location !== undefined && { location: parsed.data.location }),
      ...(parsed.data.jurisdiction !== undefined && { jurisdiction: parsed.data.jurisdiction }),
      ...(parsed.data.buildingType !== undefined && { buildingType: parsed.data.buildingType || null }),
      ...("visionThreshold" in parsed.data && { visionThreshold: parsed.data.visionThreshold ?? null }),
      ...(parsed.data.metadata && { metadata: parsed.data.metadata }),
    })
    .where(and(eq(jobsTable.id, jobId), eq(jobsTable.tenantId, tenantId)))
    .returning();

  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  res.json(serializeJob(job));
});

router.patch("/jobs/:jobId/pricing-overrides", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const jobId = String(req.params.jobId);
  const body = req.body as unknown;
  if (
    typeof body !== "object" ||
    body === null ||
    !("overrides" in body) ||
    typeof (body as { overrides: unknown }).overrides !== "object"
  ) {
    res.status(400).json({ error: "Request body must have an 'overrides' object" });
    return;
  }
  const overrides = (body as { overrides: Record<string, unknown> }).overrides;
  // Sanitize: all values must be numbers
  const sanitized: Record<string, number> = {};
  for (const [k, v] of Object.entries(overrides)) {
    if (typeof v === "number" && isFinite(v) && v >= 0) {
      sanitized[k] = v;
    }
  }
  const [job] = await db.update(jobsTable)
    .set({ pricingOverrides: sanitized })
    .where(and(eq(jobsTable.id, jobId), eq(jobsTable.tenantId, tenantId)))
    .returning();
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.json({ pricingOverrides: job.pricingOverrides });
});

router.delete("/jobs/:jobId", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const jobId = String(req.params.jobId);

  // Soft delete — set status to "archived" (excluded from list query by ne filter)
  await db.update(jobsTable)
    .set({ status: "archived" })
    .where(and(eq(jobsTable.id, jobId), eq(jobsTable.tenantId, tenantId)));

  res.sendStatus(204);
});

router.post("/jobs/:jobId/process", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const jobId = String(req.params.jobId);

  // Verify the job belongs to this tenant
  const [job] = await db.select({ id: jobsTable.id }).from(jobsTable)
    .where(and(eq(jobsTable.id, jobId), eq(jobsTable.tenantId, tenantId)));
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  // Atomic status claim: only succeeds if the job is NOT already processing.
  // This eliminates the read-check-update race condition.
  const [claimed] = await db.update(jobsTable)
    .set({ status: "processing", metadata: { processingStartedAt: new Date().toISOString(), estimatedSecondsPerSheet: ESTIMATED_SECONDS_PER_SHEET }, updatedAt: new Date() })
    .where(and(
      eq(jobsTable.id, jobId),
      eq(jobsTable.tenantId, tenantId),
      sql`${jobsTable.status} != 'processing'`
    ))
    .returning({ id: jobsTable.id });

  if (!claimed) {
    res.status(409).json({ error: "Job is already processing" });
    return;
  }

  // Extend the guest cleanup window when a guest triggers a pipeline action.
  touchGuestLastActive(tenantId, req.auth_ctx!.role).catch(() => {});

  // Status is already set to "processing" — pipeline will update it to completed/failed.
  res.status(202).json({ jobId, status: "processing", message: "Processing started" });

  processJob(jobId, tenantId).catch((err) => {
    logger.error({ jobId, err }, "[jobs] Background pipeline error");
    db.update(jobsTable)
      .set({ status: "error" })
      .where(eq(jobsTable.id, jobId))
      .catch(err2 => logger.error({ jobId, err: err2 }, "[jobs] Failed to set job error status"));
  });
});

router.post("/jobs/:jobId/rescan", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const jobId = String(req.params.jobId);

  // STEP 1 DIAGNOSTIC: log all possible force field names so we can confirm
  // exactly what the frontend is sending.
  logger.info(
    `[RESCAN] force flag received — body.forceAiRescan=${JSON.stringify(req.body?.forceAiRescan)} ` +
    `body.force=${JSON.stringify(req.body?.force)} ` +
    `body.forceReprocess=${JSON.stringify(req.body?.forceReprocess)} ` +
    `query.force=${JSON.stringify(req.query?.force)} ` +
    `full body=${JSON.stringify(req.body)}`,
  );

  // Read force flag — check ALL possible field names the frontend might send.
  const forceAiRescan =
    req.body?.forceAiRescan === true ||
    req.body?.forceAiRescan === "true" ||
    req.body?.force === true ||
    req.body?.force === "true" ||
    req.body?.forceReprocess === true ||
    req.body?.forceReprocess === "true" ||
    req.query?.force === "true";

  const forceRescanSheetIds: string[] = Array.isArray(req.body?.forceRescanSheetIds)
    ? req.body.forceRescanSheetIds.filter((id: unknown) => typeof id === "string")
    : [];

  // Verify the job belongs to this tenant
  const [job] = await db.select({ id: jobsTable.id }).from(jobsTable)
    .where(and(eq(jobsTable.id, jobId), eq(jobsTable.tenantId, tenantId)));
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  // Atomic status claim: only succeeds if the job is NOT already processing.
  const [claimed] = await db.update(jobsTable)
    .set({ status: "processing", metadata: { processingStartedAt: new Date().toISOString(), estimatedSecondsPerSheet: ESTIMATED_SECONDS_PER_SHEET }, updatedAt: new Date() })
    .where(and(
      eq(jobsTable.id, jobId),
      eq(jobsTable.tenantId, tenantId),
      sql`${jobsTable.status} != 'processing'`
    ))
    .returning({ id: jobsTable.id });

  if (!claimed) {
    res.status(409).json({ error: "Job is already processing" });
    return;
  }

  // Extend the guest cleanup window when a guest triggers a rescan.
  touchGuestLastActive(tenantId, req.auth_ctx!.role).catch(() => {});

  // Belt-and-suspenders cache clear: when force is requested, wipe all cached
  // state NOW — before firing off the pipeline — so a partial pipeline abort
  // cannot leave stale rooms/signs behind that corrupt the next run.
  // STEP 3: use exact table/column names confirmed from information_schema.
  //   rooms        — job_id column (ai_vision rows are the AI scan cache)
  //   signs        — job_id column
  //   ai_scans     — job_id + tenant_id columns
  //   job_sheets   — job_id column (sheet parse cache; pipeline Step 2 also clears this)
  if (forceAiRescan) {
    logger.info(`[FORCE] Clearing cache for job: ${jobId}`);

    // Run deletes sequentially to avoid FK-triggered lock conflicts and
    // Drizzle prepared-query cache collisions when running concurrent deletes
    // on related tables (signs.room_id → rooms.id SET NULL).
    const signsResult     = await db.execute(sql`DELETE FROM signs WHERE job_id = ${jobId}`);
    const specialtyResult = await db.execute(sql`DELETE FROM specialty_signs WHERE job_id = ${jobId}`);
    const roomsResult     = await db.execute(sql`DELETE FROM rooms WHERE job_id = ${jobId}`);
    const aiScansResult   = await db.execute(sql`DELETE FROM ai_scans WHERE job_id = ${jobId} AND tenant_id = ${tenantId}`);
    const sheetsResult    = await db.execute(sql`DELETE FROM job_sheets WHERE job_id = ${jobId}`);

    const roomsDeleted = (roomsResult as unknown as { rowCount?: number }).rowCount ?? 0;
    const signsDeleted = (signsResult as unknown as { rowCount?: number }).rowCount ?? 0;
    const aiScansDeleted = (aiScansResult as unknown as { rowCount?: number }).rowCount ?? 0;
    const sheetsDeleted = (sheetsResult as unknown as { rowCount?: number }).rowCount ?? 0;
    const specialtyDeleted = (specialtyResult as unknown as { rowCount?: number }).rowCount ?? 0;

    logger.info(
      `[FORCE] Cache rows deleted — rooms: ${roomsDeleted}, signs: ${signsDeleted}, ` +
      `ai_scans: ${aiScansDeleted}, job_sheets: ${sheetsDeleted}, specialty_signs: ${specialtyDeleted}`,
    );

    if (roomsDeleted === 0) {
      logger.warn(`[FORCE] WARNING: 0 room (AI scan cache) rows deleted — job may already be clean or wrong job_id`);
    }

    await db.update(jobsTable)
      .set({ totalSigns: 0, highConfidence: 0, needsReview: 0, aiTokenCost: "0.000000" })
      .where(eq(jobsTable.id, jobId));

    logger.info(`[jobs] Force rescan: cleared all cached rooms, signs, ai_scans, job_sheets, and specialty_signs for job ${jobId} before pipeline`);
  }

  res.status(202).json({ jobId, status: "processing", message: "Rescan started", forceAiRescan, forceRescanSheetIds });

  processJob(jobId, tenantId, { forceAiRescan, forceRescanSheetIds }).catch((err) => {
    logger.error({ jobId, err }, "[jobs] Background rescan error");
    db.update(jobsTable)
      .set({ status: "error" })
      .where(eq(jobsTable.id, jobId))
      .catch(err2 => logger.error({ jobId, err: err2 }, "[jobs] Failed to set job error status"));
  });
});

router.post("/jobs/:jobId/cancel", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const jobId = String(req.params.jobId);

  const [job] = await db.select({ id: jobsTable.id, status: jobsTable.status })
    .from(jobsTable)
    .where(and(eq(jobsTable.id, jobId), eq(jobsTable.tenantId, tenantId)));

  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  if (job.status !== "processing") {
    res.status(409).json({ error: "Job is not currently processing" });
    return;
  }

  const errorMetadata = { errorMessage: "Manually cancelled by user" };
  await db.update(jobsTable)
    .set({ status: "error", metadata: errorMetadata, updatedAt: new Date() })
    .where(and(eq(jobsTable.id, jobId), eq(jobsTable.tenantId, tenantId)));

  res.status(200).json({ jobId, status: "error", message: "Job cancelled" });
});

router.post("/jobs/:jobId/re-rule", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const jobId = String(req.params.jobId);

  const [job] = await db.select().from(jobsTable)
    .where(and(eq(jobsTable.id, jobId), eq(jobsTable.tenantId, tenantId)));
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  if (job.status === "processing") {
    res.status(409).json({ error: "Job is currently processing. Wait for it to finish before re-applying rules." });
    return;
  }

  if (job.status === "pending") {
    res.status(409).json({ error: "Job has not been processed yet. Run the pipeline first." });
    return;
  }

  logger.info(`[re-rule] Job ${jobId}: loading existing rooms and tenant settings`);

  const [tenant] = await db.select({ settings: tenantsTable.settings })
    .from(tenantsTable)
    .where(eq(tenantsTable.id, tenantId));
  const tenantSettings = (tenant?.settings ?? {}) as Record<string, unknown>;

  const rawCustomKeywords = tenantSettings.multiEntryRoomKeywords;
  const customMultiEntryKeywords: string[] =
    Array.isArray(rawCustomKeywords)
      ? rawCustomKeywords.filter((k): k is string => typeof k === "string" && k.trim().length > 0)
      : [];

  const dbRooms = await db.select().from(roomsTable)
    .where(and(eq(roomsTable.jobId, jobId), eq(roomsTable.tenantId, tenantId)));

  if (dbRooms.length === 0) {
    res.status(422).json({ error: "No rooms found for this job. Process the job first." });
    return;
  }

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

  const buildingType = job.buildingType || "commercial";

  const ruleInput = {
    rooms: roomRecords,
    buildingType,
    ruleOverrides: ruleOverrides.map((o) => ({
      ruleRef: o.ruleRef,
      overrideType: o.overrideType,
      condition: o.condition as Record<string, unknown>,
      action: o.action as Record<string, unknown>,
    })),
    customMultiEntryKeywords,
  };

  const ruleOutput = applyRules(ruleInput);

  const floorPlanSheetIds: Record<string, string | null> = {};
  for (const r of dbRooms) {
    if (r.sheetId && !floorPlanSheetIds[r.level]) {
      floorPlanSheetIds[r.level] = r.sheetId;
    }
  }
  const fallbackSheetId = Object.values(floorPlanSheetIds)[0] ?? null;

  const signRows: typeof signsTable.$inferInsert[] = [];

  for (const result of ruleOutput.results) {
    for (const sa of result.signs) {
      signRows.push({
        id: newId("sign"),
        jobId,
        tenantId,
        roomId: result.room.id,
        sheetId: result.room.sheetId ?? floorPlanSheetIds[result.room.level] ?? fallbackSheetId,
        signType: sa.signType,
        qty: sa.qty,
        ruleRef: sa.ruleRef,
        color: sa.color,
        confidence: String(sa.confidence),
        status: sa.status,
        source: "rules_engine",
        markerX: result.room.coordX,
        markerY: result.room.coordY,
      });
    }
  }

  for (const sa of ruleOutput.stairSigns) {
    signRows.push({
      id: newId("sign"),
      jobId,
      tenantId,
      roomId: null,
      sheetId: fallbackSheetId,
      signType: sa.signType,
      qty: sa.qty,
      ruleRef: sa.ruleRef,
      color: sa.color,
      confidence: String(sa.confidence),
      status: sa.status,
      source: "rules_engine",
    });
  }

  for (const sa of ruleOutput.elevatorSigns) {
    signRows.push({
      id: newId("sign"),
      jobId,
      tenantId,
      roomId: null,
      sheetId: fallbackSheetId,
      signType: sa.signType,
      qty: sa.qty,
      ruleRef: sa.ruleRef,
      color: sa.color,
      confidence: String(sa.confidence),
      status: sa.status,
      source: "rules_engine",
    });
  }

  for (const sa of ruleOutput.evacMapSigns) {
    signRows.push({
      id: newId("sign"),
      jobId,
      tenantId,
      roomId: null,
      sheetId: fallbackSheetId,
      signType: sa.signType,
      qty: sa.qty,
      ruleRef: sa.ruleRef,
      color: sa.color,
      confidence: String(sa.confidence),
      status: sa.status,
      source: "rules_engine",
    });
  }

  await db.delete(signsTable)
    .where(and(eq(signsTable.jobId, jobId), eq(signsTable.tenantId, tenantId), eq(signsTable.source, "rules_engine")));

  if (signRows.length > 0) {
    await db.insert(signsTable).values(signRows);
  }

  logger.info(`[re-rule] Job ${jobId}: replaced signs with ${signRows.length} new rule-based sign(s)`);

  const checks = runValidationChecks(ruleOutput);
  await db.delete(validationResultsTable).where(eq(validationResultsTable.jobId, jobId));
  if (checks.length > 0) {
    await db.insert(validationResultsTable).values(
      checks.map((c) => ({
        id: newId("val"),
        jobId,
        tenantId,
        checkName: c.checkName,
        status: c.status,
        details: c.details,
      })),
    );
  }

  await db.update(jobsTable)
    .set({ updatedAt: new Date() })
    .where(eq(jobsTable.id, jobId));

  const totalSigns = signRows.reduce((sum, s) => sum + (s.qty ?? 1), 0);
  res.json({ jobId, signsUpdated: signRows.length, totalSignQty: totalSigns });
});

router.get("/jobs/:jobId/sign-type-distribution", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const jobId = String(req.params.jobId);


  const signs = await db.select().from(signsTable)
    .where(and(
      eq(signsTable.jobId, jobId),
      eq(signsTable.tenantId, tenantId),
      eq(signsTable.isDeleted, false),
    ));

  const counts: Record<string, number> = {};
  for (const sign of signs) {
    counts[sign.signType] = (counts[sign.signType] || 0) + sign.qty;
  }

  const distribution = Object.entries(counts).map(([signType, count]) => ({
    signType,
    count,
    color: SIGN_COLORS[signType] || DEFAULT_SIGN_COLOR,
  }));

  res.json(distribution);
});

router.get("/jobs/:jobId/counts", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const jobId = String(req.params.jobId);
  const counts = await computeLiveSignCounts(jobId, tenantId);
  res.json(counts);
});

router.get("/jobs/:jobId/confidence-histogram", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const jobId = String(req.params.jobId);

  const aiRooms = await db.select({ confidence: roomsTable.confidence })
    .from(roomsTable)
    .where(and(
      eq(roomsTable.jobId, jobId),
      eq(roomsTable.tenantId, tenantId),
      eq(roomsTable.source, "ai_vision"),
    ));

  if (aiRooms.length === 0) {
    res.json([]);
    return;
  }

  const buckets = [
    { bucket: "< 50%",    minConfidence: 0.00, maxConfidence: 0.50, count: 0 },
    { bucket: "50–59%",   minConfidence: 0.50, maxConfidence: 0.60, count: 0 },
    { bucket: "60–79%",   minConfidence: 0.60, maxConfidence: 0.80, count: 0 },
    { bucket: "80–100%",  minConfidence: 0.80, maxConfidence: 1.00, count: 0 },
  ];

  for (const room of aiRooms) {
    const conf = parseFloat(String(room.confidence ?? "1"));
    if (conf < 0.50)      buckets[0].count++;
    else if (conf < 0.60) buckets[1].count++;
    else if (conf < 0.80) buckets[2].count++;
    else                  buckets[3].count++;
  }

  res.json(buckets);
});

router.get("/jobs/:jobId/ai-scans", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const jobId = String(req.params.jobId);

  const scans = await db.select().from(aiScansTable)
    .where(and(eq(aiScansTable.jobId, jobId), eq(aiScansTable.tenantId, tenantId)))
    .orderBy(desc(aiScansTable.createdAt));

  res.json(scans.map(s => ({
    ...s,
    cost: parseFloat(String(s.cost || "0")),
  })));
});

router.get("/jobs/:jobId/logs", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const jobId = String(req.params.jobId);

  const [job] = await db.select({ metadata: jobsTable.metadata }).from(jobsTable)
    .where(and(eq(jobsTable.id, jobId), eq(jobsTable.tenantId, tenantId)));
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  const meta = job.metadata as Record<string, unknown> | null;
  const lines: string[] = Array.isArray(meta?.pipelineLog) ? (meta.pipelineLog as string[]) : [];
  res.json({ lines });
});

router.get("/jobs/:jobId/material-spec", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const jobId = String(req.params.jobId);

  const [job] = await db.select({ id: jobsTable.id }).from(jobsTable)
    .where(and(eq(jobsTable.id, jobId), eq(jobsTable.tenantId, tenantId)));
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  const spec = await getJobMaterialSpec(jobId);
  res.json(spec ?? null);
});

export default router;
