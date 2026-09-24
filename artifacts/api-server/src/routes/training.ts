import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { trainingCorrectionsTable, ruleOverridesTable, importSnapshotsTable, importHistoryTable, jobsTable, roomsTable, signsTable, trainingPatternsTable, aiScansTable } from "@workspace/db";
import { eq, and, desc, count, avg, gte, lte, gt, lt, sql, isNotNull, sum, min } from "drizzle-orm";
import { requireAuth, requireAdmin } from "../lib/tenantAuth";
import { newId } from "../lib/ids";
import { ObjectStorageService } from "../lib/objectStorage";
import { cacheService } from "../lib/cache";
import { parseTakeoffSpreadsheet, type TakeoffRow } from "../lib/spreadsheet-parser";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

const SNAPSHOTS_CACHE_TTL_MS = 5 * 60 * 1000;
const SNAPSHOTS_CACHE_PREFIX = "snapshots:";

function snapshotsCacheKey(tenantId: string, startDate?: string, endDate?: string, limit?: number, offset?: number): string {
  return `${SNAPSHOTS_CACHE_PREFIX}${tenantId}:${startDate ?? ""}:${endDate ?? ""}:${limit ?? ""}:${offset ?? ""}`;
}

async function invalidateSnapshotsCache(tenantId: string): Promise<void> {
  await cacheService.deleteByPrefix(`${SNAPSHOTS_CACHE_PREFIX}${tenantId}:`);
}

router.get("/training/corrections", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const limit = req.query.limit ? parseInt(String(req.query.limit)) : 50;
  const offset = req.query.offset ? parseInt(String(req.query.offset)) : 0;

  const startDateStr = req.query.startDate ? String(req.query.startDate) : undefined;
  const endDateStr = req.query.endDate ? String(req.query.endDate) : undefined;
  const startDate = startDateStr ? new Date(startDateStr) : undefined;
  const endDate = endDateStr ? new Date(endDateStr) : undefined;

  if ((startDateStr && isNaN(startDate!.getTime())) || (endDateStr && isNaN(endDate!.getTime()))) {
    res.status(400).json({ error: "Invalid startDate or endDate. Use ISO 8601 format." });
    return;
  }

  const whereConditions = [
    eq(trainingCorrectionsTable.tenantId, tenantId),
    ...(startDate ? [gte(trainingCorrectionsTable.createdAt, startDate)] : []),
    ...(endDate ? [lte(trainingCorrectionsTable.createdAt, endDate)] : []),
  ];

  const corrections = await db.select().from(trainingCorrectionsTable)
    .where(and(...whereConditions))
    .orderBy(desc(trainingCorrectionsTable.createdAt))
    .limit(limit)
    .offset(offset);

  res.json(corrections);
});

router.get("/training/overrides", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;

  const overrides = await db.select().from(ruleOverridesTable)
    .where(eq(ruleOverridesTable.tenantId, tenantId))
    .orderBy(desc(ruleOverridesTable.createdAt));

  res.json(overrides.map(o => ({
    ...o,
    confidence: parseFloat(String(o.confidence || "0")),
  })));
});

router.patch("/training/overrides/:overrideId", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const overrideId = String(req.params.overrideId);

  const { isActive, action, condition } = req.body;

  const [override] = await db.update(ruleOverridesTable)
    .set({
      ...(isActive !== undefined && { isActive }),
      ...(action && { action }),
      ...(condition && { condition }),
    })
    .where(and(
      eq(ruleOverridesTable.id, overrideId),
      eq(ruleOverridesTable.tenantId, tenantId),
    ))
    .returning();

  if (!override) {
    res.status(404).json({ error: "Override not found" });
    return;
  }

  res.json({
    ...override,
    confidence: parseFloat(String(override.confidence || "0")),
  });
});

function isValidUploadPath(path: string): boolean {
  return (
    typeof path === "string" &&
    (
      path.startsWith("/objects/uploads/") ||
      /^\/objects\/tenants\/[^/]+\/uploads\//.test(path)
    ) &&
    path.length > "/objects/uploads/".length
  );
}

function predictSignType(roomName: string): string {
  const n = roomName.toLowerCase();
  if (n.includes("exit") || n.includes("egress")) return "Exit";
  if ((n.includes("stair") || n.includes("stairwell")) && (n.includes("corridor") || n.includes("hall"))) return "Stair(Corridor)";
  if ((n.includes("stair") || n.includes("stairwell")) && n.includes("landing")) return "Stair(Landing)";
  if (n.includes("stair") || n.includes("stairwell")) return "Stair(Corridor)";
  if (n.includes("restroom") || n.includes("bathroom") || n.includes("toilet") || n.includes(" wc") || n.includes("lavatory")) return "Restroom";
  if (n.includes("women") || n.includes("men's") || n.includes("female") || n.includes("male") || n.includes("gender neutral")) return "Restroom";
  if (n.includes("evac") || n.includes("evacuation map")) return "Evac Map";
  if (n.includes("in case of fire") || n.includes("fire instruction")) return "In case of fire";
  if (n.includes("directory") || n.includes("tenant directory")) return "Office Directory";
  if (n.includes("occupanc") || n.includes("capacity")) return "Max Occupancy";
  if (n.includes("insert") || n.includes("suite") || n.includes("office")) return "Room ID w/insert";
  return "Room ID";
}

function normalizeRoomKey(roomNumber: string, roomName: string): string {
  const num = (roomNumber ?? "").trim().toUpperCase().replace(/\s+/g, "");
  return num || (roomName ?? "").trim().toLowerCase();
}

router.post("/training/import", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const { pdfStoragePath, xlsxStoragePath, sourceJobId: bodySourceJobId } = req.body;
  const linkedJobId: string | null = typeof bodySourceJobId === "string" && bodySourceJobId.trim() ? bodySourceJobId.trim() : null;

  if (!xlsxStoragePath || typeof xlsxStoragePath !== "string") {
    res.status(400).json({ error: "xlsxStoragePath is required" });
    return;
  }

  if (!isValidUploadPath(xlsxStoragePath)) {
    res.status(400).json({ error: "Invalid xlsxStoragePath: must be a server-issued upload path" });
    return;
  }

  if (pdfStoragePath !== undefined && pdfStoragePath !== null && !isValidUploadPath(pdfStoragePath)) {
    res.status(400).json({ error: "Invalid pdfStoragePath: must be a server-issued upload path" });
    return;
  }

  let rows: TakeoffRow[];
  let fileSize = 0;
  try {
    const file = await objectStorageService.getObjectEntityFile(xlsxStoragePath);
    const response = await objectStorageService.downloadObject(file);
    const arrayBuffer = await response.arrayBuffer();
    fileSize = arrayBuffer.byteLength;
    const buffer = Buffer.from(arrayBuffer);

    const fileName = (req.body.xlsxFileName as string | undefined) || "takeoff";
    rows = parseTakeoffSpreadsheet(buffer, fileName);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[training/import] parseTakeoffSpreadsheet threw:", message);
    res.status(400).json({ error: `Failed to read spreadsheet: ${message}` });
    return;
  }

  console.log(`[training/import] Training import: parsed ${rows.length} rows from XLSX (fileSize=${fileSize})`);
  console.log(`[training/import] Training import: inserting analysis — ${rows.length} rows ready for review`);

  if (rows.length === 0) {
    console.error("[training/import] parseTakeoffSpreadsheet returned 0 rows — raw path:", xlsxStoragePath);
    res.status(400).json({
      error: "No valid rows found. The spreadsheet was parsed but contained no sign data. " +
        "Supported formats: tall (Sign Type | Room Name) or wide (Room / Room Name / Door # + one column per sign type).",
    });
    return;
  }

  // ── Delta analysis: compare human takeoff vs AI-extracted rooms ──────────
  type AiMissedItem = { id: string; roomNumber: string; roomName: string; level: string; qty: number; signType: string };
  type AiExtraItem = { id: string; roomId: string; roomNumber: string; roomName: string; level: string; signType: string; confidence: number };

  let matchedCount = 0;
  const aiMissed: AiMissedItem[] = [];
  const aiExtra: AiExtraItem[] = [];

  if (linkedJobId) {
    const [jobRooms, jobSigns] = await Promise.all([
      db.select().from(roomsTable)
        .where(and(eq(roomsTable.jobId, linkedJobId), eq(roomsTable.tenantId, tenantId))),
      db.select({ roomId: signsTable.roomId, signType: signsTable.signType, confidence: signsTable.confidence })
        .from(signsTable)
        .where(and(eq(signsTable.jobId, linkedJobId), eq(signsTable.tenantId, tenantId), eq(signsTable.isDeleted, false))),
    ]);

    const signTypeByRoomId = new Map<string, string>();
    for (const s of jobSigns) {
      if (s.roomId && !signTypeByRoomId.has(s.roomId)) signTypeByRoomId.set(s.roomId, s.signType);
    }

    const aiRoomMap = new Map<string, typeof roomsTable.$inferSelect>();
    for (const r of jobRooms) aiRoomMap.set(normalizeRoomKey(r.roomNumber, r.roomName), r);

    const humanKeySet = new Set<string>();
    for (const r of rows) {
      const key = normalizeRoomKey(r.roomNumber, r.roomName);
      humanKeySet.add(key);
      if (aiRoomMap.has(key)) {
        matchedCount++;
      } else {
        aiMissed.push({ id: newId("miss"), roomNumber: r.roomNumber, roomName: r.roomName, level: r.level, qty: r.qty, signType: r.signType });
      }
    }

    for (const r of jobRooms) {
      const conf = parseFloat(String(r.confidence ?? "0"));
      if (!humanKeySet.has(normalizeRoomKey(r.roomNumber, r.roomName)) && conf >= 0.80) {
        aiExtra.push({
          id: newId("xtra"),
          roomId: r.id,
          roomNumber: r.roomNumber,
          roomName: r.roomName,
          level: r.level,
          signType: signTypeByRoomId.get(r.id) ?? predictSignType(r.roomName),
          confidence: conf,
        });
      }
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  const existingCorrections = await db.select({
    roomNamePattern: trainingCorrectionsTable.roomNamePattern,
    signType: trainingCorrectionsTable.signType,
    originalValue: trainingCorrectionsTable.originalValue,
    correctedValue: trainingCorrectionsTable.correctedValue,
  })
    .from(trainingCorrectionsTable)
    .where(eq(trainingCorrectionsTable.tenantId, tenantId));

  const existingByPattern = new Map<string, string>();
  for (const c of existingCorrections) {
    if (c.roomNamePattern && c.signType) {
      existingByPattern.set(c.roomNamePattern, c.signType);
    }
  }

  const diffs: Array<{
    id: string;
    roomNumber: string;
    roomName: string;
    level: string;
    qty: number;
    pipelineSignType: string;
    humanSignType: string;
    ruleRef: string;
    existingCorrectedSignType: string | null;
    diffCategory: "new" | "conflict" | "duplicate";
  }> = [];

  for (const row of rows) {
    const pipelineSignType = predictSignType(row.roomName);
    if (pipelineSignType !== row.signType) {
      const existingCorrected = existingByPattern.get(row.roomName) ?? null;
      const diffCategory: "new" | "conflict" | "duplicate" =
        existingCorrected === null ? "new"
        : existingCorrected === row.signType ? "duplicate"
        : "conflict";
      diffs.push({
        id: newId("diff"),
        roomNumber: row.roomNumber,
        roomName: row.roomName,
        level: row.level,
        qty: row.qty,
        pipelineSignType,
        humanSignType: row.signType,
        ruleRef: row.ruleRef,
        existingCorrectedSignType: existingCorrected,
        diffCategory,
      });
    }
  }

  const existingMap = new Map(
    existingCorrections
      .filter(c => c.roomNamePattern && c.signType)
      .map(c => [`${c.roomNamePattern}::${c.signType}`, c])
  );

  const collisions: Array<{
    roomNamePattern: string;
    signType: string;
    oldCorrectedValue: string;
    newCorrectedValue: string;
  }> = [];

  const seenCollisionKeys = new Set<string>();
  for (const diff of diffs) {
    const key = `${diff.roomName}::${diff.humanSignType}`;
    if (existingMap.has(key) && !seenCollisionKeys.has(key)) {
      seenCollisionKeys.add(key);
      const existing = existingMap.get(key)!;
      const oldCorrectedVal = existing.correctedValue as { signType?: string } | null;
      collisions.push({
        roomNamePattern: diff.roomName,
        signType: diff.humanSignType,
        oldCorrectedValue: oldCorrectedVal?.signType ?? diff.humanSignType,
        newCorrectedValue: diff.humanSignType,
      });
    }
  }

  res.json({
    totalDiffs: diffs.length,
    totalRows: rows.length,
    collisionCount: collisions.length,
    diffs,
    collisions,
    matchedCount,
    aiMissedCount: aiMissed.length,
    aiExtraCount: aiExtra.length,
    aiMissed,
    aiExtra,
  });
});

router.post("/training/import/confirm", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;

  try {

  const { diffs, mode, batchLabel, sourceJobId, sourceType, matchedCount, aiMissedCount, aiExtraCount, buildingType, jurisdiction, totalHumanSigns, xlsxFilename } = req.body;
  const updateMode: "skip" | "update" = mode === "update" ? "update" : "skip";
  const label: string | null = typeof batchLabel === "string" && batchLabel.trim() ? batchLabel.trim() : null;
  const resolvedSourceJobId: string | null = typeof sourceJobId === "string" && sourceJobId.trim() ? sourceJobId.trim() : null;
  const VALID_SOURCE_TYPES = ["estimator_verified", "architect_schedule", "as_built"];
  const resolvedSourceType: string | null = typeof sourceType === "string" && VALID_SOURCE_TYPES.includes(sourceType) ? sourceType : null;
  const resolvedMatchedCount: number = typeof matchedCount === "number" && matchedCount >= 0 ? Math.round(matchedCount) : 0;
  const resolvedAiMissedCount: number = typeof aiMissedCount === "number" && aiMissedCount >= 0 ? Math.round(aiMissedCount) : 0;
  const resolvedAiExtraCount: number = typeof aiExtraCount === "number" && aiExtraCount >= 0 ? Math.round(aiExtraCount) : 0;
  const VALID_BUILDING_TYPES = ["Commercial", "Residential", "Education", "Healthcare", "Government", "Industrial", "Mixed Use", "Other"];
  const resolvedBuildingType: string | null = typeof buildingType === "string" && VALID_BUILDING_TYPES.includes(buildingType) ? buildingType : null;
  const resolvedJurisdiction: string | null = typeof jurisdiction === "string" && jurisdiction.trim() ? jurisdiction.trim().slice(0, 100) : null;
  const resolvedTotalHumanSigns: number | null = typeof totalHumanSigns === "number" && totalHumanSigns >= 0 ? Math.round(totalHumanSigns) : null;
  const accuracyTotal = resolvedMatchedCount + resolvedAiMissedCount + resolvedAiExtraCount;
  const accuracyScore: string | null = accuracyTotal > 0
    ? (resolvedMatchedCount / accuracyTotal).toFixed(4)
    : null;

  if (!Array.isArray(diffs) || diffs.length === 0) {
    res.status(400).json({ error: "diffs array is required and must be non-empty" });
    return;
  }

  const existingCorrections = await db.select({
    id: trainingCorrectionsTable.id,
    roomNamePattern: trainingCorrectionsTable.roomNamePattern,
    signType: trainingCorrectionsTable.signType,
  })
    .from(trainingCorrectionsTable)
    .where(eq(trainingCorrectionsTable.tenantId, tenantId));

  const existingMap = new Map(
    existingCorrections
      .filter(c => c.roomNamePattern && c.signType)
      .map(c => [`${c.roomNamePattern}::${c.signType}`, c.id])
  );

  // Map roomNamePattern → existing correction id (first one found, for conflict detection)
  const existingByRoomName = new Map<string, string>();
  for (const c of existingCorrections) {
    if (c.roomNamePattern && !existingByRoomName.has(c.roomNamePattern)) {
      existingByRoomName.set(c.roomNamePattern, c.id);
    }
  }

  const seenDiffKeys = new Set<string>();
  const deduplicatedDiffs = diffs.filter((diff: Record<string, unknown>) => {
    const roomNamePattern = String(diff.roomName || "").trim();
    const signType = String(diff.humanSignType || "").trim();
    if (!roomNamePattern || !signType) return true;
    const key = `${roomNamePattern}::${signType}`;
    if (seenDiffKeys.has(key)) return false;
    seenDiffKeys.add(key);
    return true;
  });

  // Pre-scan: determine which room patterns need deactivation.
  // Only deactivate when we will actually insert or update — not when we're
  // keeping the existing correction (skip mode + duplicate/conflict).
  const patternsToDeactivate = new Set<string>();
  for (const diff of deduplicatedDiffs) {
    const roomNamePattern = String(diff.roomName || "").trim();
    const signType = String(diff.humanSignType || "").trim();
    if (!roomNamePattern || !signType) continue;
    const key = `${roomNamePattern}::${signType}`;
    const isTrueDuplicate = existingMap.has(key);
    const isConflict = !isTrueDuplicate && existingByRoomName.has(roomNamePattern);
    if (isTrueDuplicate) {
      // Only deactivate if we're going to update (not skip)
      if (updateMode === "update" && diff.skipOverwrite !== true) {
        patternsToDeactivate.add(roomNamePattern);
      }
    } else if (isConflict) {
      // Only deactivate if update mode — skip mode keeps existing correction alive
      if (updateMode === "update") {
        patternsToDeactivate.add(roomNamePattern);
      }
    } else {
      // New room name — always deactivate any stale same-pattern rows before insert
      patternsToDeactivate.add(roomNamePattern);
    }
  }

  for (const roomNamePattern of patternsToDeactivate) {
    await db.update(trainingCorrectionsTable)
      .set({ isActive: false })
      .where(and(
        eq(trainingCorrectionsTable.tenantId, tenantId),
        eq(trainingCorrectionsTable.roomNamePattern, roomNamePattern),
      ));

    await db.update(ruleOverridesTable)
      .set({ isActive: false })
      .where(and(
        eq(ruleOverridesTable.tenantId, tenantId),
        sql`condition->>'roomNamePattern' = ${roomNamePattern}`,
      ));
  }

  const corrections: Array<typeof trainingCorrectionsTable.$inferInsert> = [];
  const ruleOverrideMap = new Map<string, { roomNamePattern: string; signType: string; pipelineSignType: string }>();
  let skipped = 0;        // true duplicates kept (skip mode)
  let updated = 0;        // true duplicates refreshed (update mode)
  let conflictsUpdated = 0; // conflicts overwritten (update mode)
  let conflictsSkipped = 0; // conflicts kept (skip mode)

  for (const diff of deduplicatedDiffs) {
    const roomNamePattern = String(diff.roomName || "").trim();
    const signType = String(diff.humanSignType || "").trim();
    const pipelineSignType = String(diff.pipelineSignType || "Unknown").trim();
    if (!roomNamePattern || !signType) continue;

    const key = `${roomNamePattern}::${signType}`;
    const skipOverwrite = diff.skipOverwrite === true;
    const isTrueDuplicate = existingMap.has(key);
    const isConflict = !isTrueDuplicate && existingByRoomName.has(roomNamePattern);

    if (isTrueDuplicate) {
      if (updateMode === "update" && !skipOverwrite) {
        // Refresh the existing record with the latest data
        const existingId = existingMap.get(key)!;
        await db.update(trainingCorrectionsTable)
          .set({
            originalValue: { signType: pipelineSignType },
            correctedValue: {
              signType,
              roomNumber: String(diff.roomNumber || ""),
              level: String(diff.level || ""),
            },
            ruleRef: diff.ruleRef ? String(diff.ruleRef) : null,
            isActive: true,
          })
          .where(and(
            eq(trainingCorrectionsTable.id, existingId),
            eq(trainingCorrectionsTable.tenantId, tenantId),
          ));
        updated++;
        if (!ruleOverrideMap.has(key)) {
          ruleOverrideMap.set(key, { roomNamePattern, signType, pipelineSignType });
        }
      } else {
        // Skip mode: existing correction was not deactivated, nothing to do.
        skipped++;
      }
      continue;
    }

    if (isConflict) {
      if (updateMode === "update") {
        // Existing correction for this room had a different sign type.
        // Deactivation already ran for this pattern; insert new sign type.
        corrections.push({
          id: newId("tc"),
          tenantId,
          correctionType: "sign_type_override",
          originalValue: { signType: pipelineSignType },
          correctedValue: {
            signType,
            roomNumber: String(diff.roomNumber || ""),
            level: String(diff.level || ""),
          },
          roomNamePattern,
          signType,
          ruleRef: diff.ruleRef ? String(diff.ruleRef) : null,
          reason: "bulk_import",
          isActive: true,
          appliedCount: 0,
        });
        if (!ruleOverrideMap.has(key)) {
          ruleOverrideMap.set(key, { roomNamePattern, signType, pipelineSignType });
        }
        conflictsUpdated++;
      } else {
        // Skip mode: keep the existing (differently-typed) correction as-is.
        // Deactivation was intentionally skipped for this pattern, so it stays active.
        conflictsSkipped++;
        console.log(`[training/import] Conflict kept (skip mode): ${roomNamePattern} existing="${existingByRoomName.has(roomNamePattern) ? "present" : "?"}" incoming="${signType}"`);
      }
      continue;
    }

    // New room name: insert regardless of mode
    corrections.push({
      id: newId("tc"),
      tenantId,
      correctionType: "sign_type_override",
      originalValue: { signType: pipelineSignType },
      correctedValue: {
        signType,
        roomNumber: String(diff.roomNumber || ""),
        level: String(diff.level || ""),
      },
      roomNamePattern,
      signType,
      ruleRef: diff.ruleRef ? String(diff.ruleRef) : null,
      reason: "bulk_import",
      isActive: true,
      appliedCount: 0,
    });

    if (!ruleOverrideMap.has(key)) {
      ruleOverrideMap.set(key, { roomNamePattern, signType, pipelineSignType });
    }
  }

  const totalInserted = corrections.length;

  if (totalInserted === 0 && skipped === 0 && updated === 0 && conflictsUpdated === 0 && conflictsSkipped === 0) {
    res.status(400).json({ error: "No valid diffs provided" });
    return;
  }

  const newCount = totalInserted - conflictsUpdated;
  console.log(
    `[training/import] Training import: inserting ${newCount} new` +
    (conflictsUpdated > 0 ? `, ${conflictsUpdated} conflicts updated` : "") +
    (conflictsSkipped > 0 ? `, ${conflictsSkipped} conflicts kept (skip mode)` : "") +
    (skipped > 0 ? `, ${skipped} true duplicates skipped` : "") +
    (updated > 0 ? `, ${updated} duplicates refreshed` : ""),
  );

  if (corrections.length > 0) {
    await db.insert(trainingCorrectionsTable).values(corrections);
    console.log(`[training/import] Training import: DB insert complete — ${corrections.length + updated} rows saved`);
  }

  const overrideChanges: Array<{
    ruleRef: string;
    roomNamePattern: string;
    signType: string;
    pipelineSignType: string;
    confidence: number;
    status: "new" | "updated";
  }> = [];

  for (const [, { roomNamePattern, signType, pipelineSignType }] of ruleOverrideMap) {
    const ruleRef = `training.${roomNamePattern.toLowerCase().replace(/[^a-z0-9]+/g, "_")}.${signType.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;

    const existing = await db.select()
      .from(ruleOverridesTable)
      .where(and(
        eq(ruleOverridesTable.tenantId, tenantId),
        eq(ruleOverridesTable.ruleRef, ruleRef),
      ))
      .limit(1);

    if (existing.length > 0) {
      const prev = existing[0];
      const prevConf = parseFloat(String(prev.confidence || "0.5"));
      const nextConf = Math.min(0.99, prevConf + 0.05).toFixed(3);
      await db.update(ruleOverridesTable)
        .set({
          sourceCorrections: (prev.sourceCorrections || 0) + 1,
          confidence: nextConf,
          isActive: true,
        })
        .where(eq(ruleOverridesTable.id, prev.id));
      overrideChanges.push({
        ruleRef,
        roomNamePattern,
        signType,
        pipelineSignType,
        confidence: parseFloat(nextConf),
        status: "updated",
      });
    } else {
      await db.insert(ruleOverridesTable).values({
        id: newId("ro"),
        tenantId,
        ruleRef,
        overrideType: "sign_type",
        condition: { roomNamePattern },
        action: { signType },
        confidence: "0.800",
        sourceCorrections: 1,
        isActive: true,
      });
      overrideChanges.push({
        ruleRef,
        roomNamePattern,
        signType,
        pipelineSignType,
        confidence: 0.800,
        status: "new",
      });
    }
  }

  const [totalOverrides] = await db
    .select({ count: count() })
    .from(ruleOverridesTable)
    .where(eq(ruleOverridesTable.tenantId, tenantId));

  const [activeOverrides] = await db
    .select({ count: count() })
    .from(ruleOverridesTable)
    .where(and(
      eq(ruleOverridesTable.tenantId, tenantId),
      eq(ruleOverridesTable.isActive, true),
    ));

  const [totalCorrections] = await db
    .select({ count: count() })
    .from(trainingCorrectionsTable)
    .where(eq(trainingCorrectionsTable.tenantId, tenantId));

  const [avgResult] = await db
    .select({ avgConf: avg(ruleOverridesTable.confidence) })
    .from(ruleOverridesTable)
    .where(and(
      eq(ruleOverridesTable.tenantId, tenantId),
      eq(ruleOverridesTable.isActive, true),
    ));

  const snapshotAvg = avgResult?.avgConf ? parseFloat(String(avgResult.avgConf)) : 0;
  const newRulesCount = overrideChanges.filter(c => c.status === "new").length;
  const updatedRulesCount = overrideChanges.filter(c => c.status === "updated").length;

  const [prevSnapshot] = await db
    .select({ avgConfidence: importSnapshotsTable.avgConfidence })
    .from(importSnapshotsTable)
    .where(eq(importSnapshotsTable.tenantId, tenantId))
    .orderBy(desc(importSnapshotsTable.snapshotDate))
    .limit(1);

  const prevAvgConfidence = prevSnapshot?.avgConfidence
    ? parseFloat(String(prevSnapshot.avgConfidence))
    : null;

  await db.insert(importSnapshotsTable).values({
    id: newId("snap"),
    tenantId,
    snapshotDate: new Date(),
    avgConfidence: snapshotAvg.toFixed(4),
    activeOverrideCount: activeOverrides?.count || 0,
    newRulesCount,
    updatedRulesCount,
    batchLabel: label,
    sourceJobId: resolvedSourceJobId,
    sourceType: resolvedSourceType,
    matchedCount: resolvedMatchedCount,
    aiMissedCount: resolvedAiMissedCount,
    aiExtraCount: resolvedAiExtraCount,
    buildingType: resolvedBuildingType,
    jurisdiction: resolvedJurisdiction,
    accuracyScore,
    totalHumanSigns: resolvedTotalHumanSigns,
  });

  await invalidateSnapshotsCache(tenantId);

  const historyFilename = (typeof xlsxFilename === "string" && xlsxFilename.trim())
    ? xlsxFilename.trim()
    : (label ?? "import");
  const historyRowsSaved = corrections.length + updated;
  const historyStatus = historyRowsSaved > 0 ? "success" : skipped > 0 ? "partial" : "no_changes";
  await db.insert(importHistoryTable).values({
    id: newId("ih"),
    tenantId,
    filename: historyFilename,
    rowsParsed: deduplicatedDiffs.length,
    rowsSaved: historyRowsSaved,
    rowsSkipped: skipped,
    status: historyStatus,
  });

  const newInserted = totalInserted - conflictsUpdated;
  console.log(
    `[training/import] Import complete: ${newInserted} new, ${conflictsUpdated} conflicts updated, ` +
    `${conflictsSkipped} conflicts kept, ${skipped} true duplicates skipped, ${updated} duplicates refreshed — ` +
    `overrides=${ruleOverrideMap.size} totalCorrections=${totalCorrections?.count ?? 0}`,
  );

  res.json({
    saved: corrections.length,
    updated,
    skipped,
    conflictsUpdated,
    conflictsSkipped,
    overridesCreatedOrUpdated: ruleOverrideMap.size,
    overrideChanges,
    prevAvgConfidence,
    newAvgConfidence: snapshotAvg,
    accuracyScore: accuracyScore !== null ? parseFloat(accuracyScore) : null,
    impact: {
      totalOverrides: totalOverrides?.count || 0,
      activeOverrides: activeOverrides?.count || 0,
      totalCorrections: totalCorrections?.count || 0,
    },
  });

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[training/import] Training import FAILED: ${message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: `Import failed: ${message}` });
    }
  }
});

router.get("/training/count", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;

  const [[totalCorrResult], [totalOverResult], [lastImport]] = await Promise.all([
    db.select({ count: count() })
      .from(trainingCorrectionsTable)
      .where(eq(trainingCorrectionsTable.tenantId, tenantId)),
    db.select({ count: count() })
      .from(ruleOverridesTable)
      .where(eq(ruleOverridesTable.tenantId, tenantId)),
    db.select({ importedAt: importHistoryTable.importedAt, rowsSaved: importHistoryTable.rowsSaved })
      .from(importHistoryTable)
      .where(eq(importHistoryTable.tenantId, tenantId))
      .orderBy(desc(importHistoryTable.importedAt))
      .limit(1),
  ]);

  res.json({
    totalCorrections: totalCorrResult?.count ?? 0,
    totalOverrides: totalOverResult?.count ?? 0,
    lastImportAt: lastImport?.importedAt ?? null,
    lastImportCount: lastImport?.rowsSaved ?? null,
  });
});

router.get("/training/import-history", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const limit = Math.min(parseInt(String(req.query.limit ?? "20"), 10) || 20, 100);

  const rows = await db
    .select()
    .from(importHistoryTable)
    .where(eq(importHistoryTable.tenantId, tenantId))
    .orderBy(desc(importHistoryTable.importedAt))
    .limit(limit);

  res.json(rows);
});

function getMondayOfWeek(d: Date): Date {
  const day = d.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(d);
  monday.setDate(d.getDate() + diffToMonday);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

function weekKey(d: Date): string {
  const monday = getMondayOfWeek(d);
  return monday.toISOString().slice(0, 10);
}

router.get("/training/snapshots", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;

  const startDateStr = req.query.startDate ? String(req.query.startDate) : undefined;
  const endDateStr = req.query.endDate ? String(req.query.endDate) : undefined;

  const startDate = startDateStr ? new Date(startDateStr) : undefined;
  const endDate = endDateStr ? new Date(endDateStr) : undefined;

  if ((startDateStr && isNaN(startDate!.getTime())) || (endDateStr && isNaN(endDate!.getTime()))) {
    res.status(400).json({ error: "Invalid startDate or endDate. Use ISO 8601 format." });
    return;
  }

  const limit = req.query.limit ? parseInt(String(req.query.limit)) : 100;
  const offset = req.query.offset ? parseInt(String(req.query.offset)) : 0;

  if (isNaN(limit) || limit < 1 || limit > 1000) {
    res.status(400).json({ error: "limit must be a number between 1 and 1000." });
    return;
  }
  if (isNaN(offset) || offset < 0) {
    res.status(400).json({ error: "offset must be a non-negative number." });
    return;
  }

  const cacheKey = snapshotsCacheKey(tenantId, startDateStr, endDateStr, limit, offset);
  const cached = await cacheService.get<{ snapshots: unknown[]; total: number }>(cacheKey);
  if (cached) {
    res.setHeader("X-Cache", "HIT");
    res.json(cached);
    return;
  }

  const whereConditions = [
    eq(importSnapshotsTable.tenantId, tenantId),
    gt(importSnapshotsTable.avgConfidence, "0"),
    ...(startDate ? [gte(importSnapshotsTable.snapshotDate, startDate)] : []),
    ...(endDate ? [lte(importSnapshotsTable.snapshotDate, endDate)] : []),
  ];

  const [totalResult] = await db
    .select({ count: count() })
    .from(importSnapshotsTable)
    .where(and(...whereConditions));

  const total = totalResult?.count ?? 0;

  const snapshotRows = await db
    .select()
    .from(importSnapshotsTable)
    .where(and(...whereConditions))
    .orderBy(desc(importSnapshotsTable.snapshotDate))
    .limit(limit)
    .offset(offset);

  const correctionWhereConditions = [
    eq(trainingCorrectionsTable.tenantId, tenantId),
    ...(startDate ? [gte(trainingCorrectionsTable.createdAt, startDate)] : []),
    ...(endDate ? [lte(trainingCorrectionsTable.createdAt, endDate)] : []),
  ];

  const correctionRows = await db
    .select({ createdAt: trainingCorrectionsTable.createdAt })
    .from(trainingCorrectionsTable)
    .where(and(...correctionWhereConditions));

  const correctionsByWeek = new Map<string, number>();
  for (const c of correctionRows) {
    const key = weekKey(c.createdAt);
    correctionsByWeek.set(key, (correctionsByWeek.get(key) ?? 0) + 1);
  }

  const snapshots = snapshotRows.reverse().map(r => ({
    id: r.id,
    snapshotDate: r.snapshotDate.toISOString(),
    avgConfidence: parseFloat(String(r.avgConfidence || "0")),
    activeOverrideCount: r.activeOverrideCount,
    newRulesCount: r.newRulesCount,
    updatedRulesCount: r.updatedRulesCount,
    correctionCount: correctionsByWeek.get(weekKey(r.snapshotDate)) ?? 0,
    batchLabel: r.batchLabel ?? null,
    buildingType: r.buildingType ?? null,
    jurisdiction: r.jurisdiction ?? null,
    accuracyScore: r.accuracyScore !== null && r.accuracyScore !== undefined ? parseFloat(String(r.accuracyScore)) : null,
    totalHumanSigns: r.totalHumanSigns ?? null,
  }));

  const responseBody = { snapshots, total };

  await cacheService.set(cacheKey, responseBody, SNAPSHOTS_CACHE_TTL_MS);
  res.setHeader("X-Cache", "MISS");
  res.json(responseBody);
});

router.get("/training/override-impact", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;

  const startDateStr = req.query.startDate ? String(req.query.startDate) : undefined;
  const endDateStr = req.query.endDate ? String(req.query.endDate) : undefined;

  const startDate = startDateStr ? new Date(startDateStr) : undefined;
  const endDate = endDateStr ? new Date(endDateStr) : undefined;

  if ((startDateStr && isNaN(startDate!.getTime())) || (endDateStr && isNaN(endDate!.getTime()))) {
    res.status(400).json({ error: "Invalid startDate or endDate. Use ISO 8601 format." });
    return;
  }

  const [totalOverrides] = await db
    .select({ count: count() })
    .from(ruleOverridesTable)
    .where(eq(ruleOverridesTable.tenantId, tenantId));

  const [activeOverrides] = await db
    .select({ count: count() })
    .from(ruleOverridesTable)
    .where(and(
      eq(ruleOverridesTable.tenantId, tenantId),
      eq(ruleOverridesTable.isActive, true),
    ));

  const [totalCorrections] = await db
    .select({ count: count() })
    .from(trainingCorrectionsTable)
    .where(eq(trainingCorrectionsTable.tenantId, tenantId));

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  const [correctionsThisMonthResult] = await db
    .select({ count: count() })
    .from(trainingCorrectionsTable)
    .where(and(
      eq(trainingCorrectionsTable.tenantId, tenantId),
      gte(trainingCorrectionsTable.createdAt, monthStart),
      lt(trainingCorrectionsTable.createdAt, monthEnd),
    ));

  const snapshotWhereConditions = [
    eq(importSnapshotsTable.tenantId, tenantId),
    gt(importSnapshotsTable.avgConfidence, "0"),
    ...(startDate ? [gte(importSnapshotsTable.snapshotDate, startDate)] : []),
    ...(endDate ? [lte(importSnapshotsTable.snapshotDate, endDate)] : []),
  ];

  const snapshotRows = await db
    .select({
      id: importSnapshotsTable.id,
      snapshotDate: importSnapshotsTable.snapshotDate,
      avgConfidence: importSnapshotsTable.avgConfidence,
      activeOverrideCount: importSnapshotsTable.activeOverrideCount,
      newRulesCount: importSnapshotsTable.newRulesCount,
      updatedRulesCount: importSnapshotsTable.updatedRulesCount,
      batchLabel: importSnapshotsTable.batchLabel,
      sourceJobId: importSnapshotsTable.sourceJobId,
      sourceJobName: jobsTable.name,
      buildingType: importSnapshotsTable.buildingType,
      jurisdiction: importSnapshotsTable.jurisdiction,
      accuracyScore: importSnapshotsTable.accuracyScore,
      totalHumanSigns: importSnapshotsTable.totalHumanSigns,
    })
    .from(importSnapshotsTable)
    .leftJoin(jobsTable, eq(importSnapshotsTable.sourceJobId, jobsTable.id))
    .where(and(...snapshotWhereConditions))
    .orderBy(importSnapshotsTable.snapshotDate);

  const confidenceTrend = snapshotRows.map(r => ({
    snapshotId: r.id,
    week: r.snapshotDate.toISOString().slice(0, 10),
    importDate: r.snapshotDate.toISOString(),
    avgConfidence: parseFloat(String(r.avgConfidence || "0")),
    count: r.activeOverrideCount,
    newRulesCount: r.newRulesCount,
    updatedRulesCount: r.updatedRulesCount,
    batchLabel: r.batchLabel ?? undefined,
    sourceJobId: r.sourceJobId ?? undefined,
    sourceJobName: r.sourceJobName ?? undefined,
    buildingType: r.buildingType ?? undefined,
    jurisdiction: r.jurisdiction ?? undefined,
    accuracyScore: r.accuracyScore !== null && r.accuracyScore !== undefined ? parseFloat(String(r.accuracyScore)) : undefined,
    totalHumanSigns: r.totalHumanSigns ?? undefined,
  }));

  const topPatternRows = await db
    .select({
      correctionType: trainingCorrectionsTable.correctionType,
      signType: trainingCorrectionsTable.signType,
      roomNamePattern: trainingCorrectionsTable.roomNamePattern,
      count: count(),
    })
    .from(trainingCorrectionsTable)
    .where(eq(trainingCorrectionsTable.tenantId, tenantId))
    .groupBy(
      trainingCorrectionsTable.correctionType,
      trainingCorrectionsTable.signType,
      trainingCorrectionsTable.roomNamePattern,
    )
    .orderBy(desc(sql`count(*)`))
    .limit(10);

  const topPatterns = topPatternRows.map(r => ({
    correctionType: r.correctionType,
    signType: r.signType ?? null,
    roomNamePattern: r.roomNamePattern ?? null,
    count: r.count,
  }));

  res.json({
    totalOverrides: totalOverrides?.count || 0,
    activeOverrides: activeOverrides?.count || 0,
    totalCorrections: totalCorrections?.count || 0,
    correctionsThisMonth: correctionsThisMonthResult?.count || 0,
    topPatterns,
    confidenceTrend,
  });
});

router.post("/training/snapshots/cache/invalidate", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  invalidateSnapshotsCache(tenantId);
  res.json({ invalidated: true });
});

router.delete("/training/snapshots/:snapshotId", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const snapshotId = String(req.params.snapshotId);

  const [existing] = await db
    .select({ id: importSnapshotsTable.id })
    .from(importSnapshotsTable)
    .where(and(
      eq(importSnapshotsTable.id, snapshotId),
      eq(importSnapshotsTable.tenantId, tenantId),
    ));

  if (!existing) {
    res.status(404).json({ error: "Snapshot not found" });
    return;
  }

  await db
    .delete(importSnapshotsTable)
    .where(and(
      eq(importSnapshotsTable.id, snapshotId),
      eq(importSnapshotsTable.tenantId, tenantId),
    ));

  await invalidateSnapshotsCache(tenantId);

  res.status(204).send();
});

router.patch("/training/snapshots/:snapshotId", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const snapshotId = String(req.params.snapshotId);
  const { batchLabel, sourceJobId } = req.body as { batchLabel?: string | null; sourceJobId?: string | null };

  const [existing] = await db
    .select({ id: importSnapshotsTable.id })
    .from(importSnapshotsTable)
    .where(and(
      eq(importSnapshotsTable.id, snapshotId),
      eq(importSnapshotsTable.tenantId, tenantId),
    ));

  if (!existing) {
    res.status(404).json({ error: "Snapshot not found" });
    return;
  }

  const newLabel = batchLabel !== undefined
    ? (batchLabel === null || batchLabel.trim() === "" ? null : batchLabel.trim())
    : undefined;

  const newSourceJobId = sourceJobId !== undefined
    ? (sourceJobId === null || sourceJobId.trim() === "" ? null : sourceJobId.trim())
    : undefined;

  const [updated] = await db
    .update(importSnapshotsTable)
    .set({
      ...(newLabel !== undefined ? { batchLabel: newLabel } : {}),
      ...(newSourceJobId !== undefined ? { sourceJobId: newSourceJobId } : {}),
    })
    .where(and(
      eq(importSnapshotsTable.id, snapshotId),
      eq(importSnapshotsTable.tenantId, tenantId),
    ))
    .returning();

  await invalidateSnapshotsCache(tenantId);

  res.json({ id: updated.id, batchLabel: updated.batchLabel ?? null, sourceJobId: updated.sourceJobId ?? null });
});

// ---------------------------------------------------------------------------
// Pattern detection
// ---------------------------------------------------------------------------

type PatternGroup = {
  correctionType: string;
  roomNamePattern: string | null;
  signType: string | null;
  jobIds: string[];
  humanSignType: string | null;
  pipelineSignType: string | null;
};

const JUNK_TERMS = ["unknown", "test", "xyz"];
/** Returns true if the value contains a junk word (but null/empty is NOT junk for optional fields) */
function containsJunk(val: string | null | undefined): boolean {
  if (!val || val.trim() === "") return false;
  const lower = val.toLowerCase();
  return JUNK_TERMS.some(t => lower.includes(t));
}
/** Returns true if the value is empty/null OR contains junk — for required fields like signType */
function isEmptyOrJunk(val: string | null | undefined): boolean {
  if (!val || val.trim() === "") return true;
  return containsJunk(val);
}

async function detectPatterns(tenantId: string): Promise<{ newPatterns: number; updatedPatterns: number; totalPatterns: number }> {
  // 1. Query all corrections for this tenant
  const corrections = await db.select().from(trainingCorrectionsTable)
    .where(eq(trainingCorrectionsTable.tenantId, tenantId));

  // 2. Group by (correctionType, roomNamePattern, signType) — accumulate all occurrences
  const groupCounts = new Map<string, number>();
  const groups = new Map<string, PatternGroup>();
  for (const c of corrections) {
    const key = `${c.correctionType}||${c.roomNamePattern ?? ""}||${c.signType ?? ""}`;
    groupCounts.set(key, (groupCounts.get(key) ?? 0) + 1);
    const existing = groups.get(key);
    const jobId = c.jobId ?? null;
    if (existing) {
      if (jobId && !existing.jobIds.includes(jobId)) existing.jobIds.push(jobId);
    } else {
      const correctedVal = c.correctedValue as Record<string, unknown>;
      const originalVal = c.originalValue as Record<string, unknown>;
      groups.set(key, {
        correctionType: c.correctionType,
        roomNamePattern: c.roomNamePattern ?? null,
        signType: c.signType ?? null,
        jobIds: jobId ? [jobId] : [],
        humanSignType: (correctedVal?.signType as string) ?? null,
        pipelineSignType: (originalVal?.signType as string) ?? null,
      });
    }
  }

  // 3. Only groups with 2+ occurrences, and no junk in signType (roomNamePattern may be null)
  const candidates = Array.from(groups.entries())
    .filter(([key, g]) => {
      const cnt = groupCounts.get(key) ?? 0;
      if (cnt < 2) return false;
      // signType must be non-empty and not junk
      if (isEmptyOrJunk(g.signType)) return false;
      // roomNamePattern may be null/empty (means "all rooms"), but not junk words
      if (containsJunk(g.roomNamePattern)) return false;
      return true;
    })
    .map(([key, g]) => ({ ...g, evidenceCount: groupCounts.get(key) ?? 0 }));

  // 4. Upsert each candidate into training_patterns
  let newPatterns = 0;
  let updatedPatterns = 0;

  for (const g of candidates) {
    const { evidenceCount } = g;

    const exampleJobIds = g.jobIds.slice(0, 5);

    // Fix 4: improved description — room-specific or global
    const signPart = g.signType!;
    const hasRoom = !!(g.roomNamePattern && g.roomNamePattern.trim() !== "");
    const roomPart = hasRoom ? g.roomNamePattern! : "all rooms";
    const description = hasRoom
      ? `'${g.roomNamePattern}' → ${signPart} (${evidenceCount} occurrence${evidenceCount !== 1 ? "s" : ""})`
      : `${signPart} — ${evidenceCount} occurrence${evidenceCount !== 1 ? "s" : ""} across all rooms`;

    // Fix 3: always generate suggestedFix
    let suggestedFix: string | null = null;
    if (g.correctionType === "sign_type_mismatch" || g.correctionType === "edit") {
      suggestedFix = hasRoom
        ? `When room name is '${roomPart}', assign '${signPart}' instead of pipeline default`
        : `'${signPart}' sign type is frequently corrected — review pipeline default assignment`;
    } else if (g.correctionType === "ai_missed" || g.correctionType === "add") {
      suggestedFix = hasRoom
        ? `Room pattern '${roomPart}' requires a '${signPart}' sign — add to extraction rules`
        : `'${signPart}' signs are frequently added manually — verify AI extraction covers this type`;
    } else if (g.correctionType === "ai_extra" || g.correctionType === "delete") {
      suggestedFix = hasRoom
        ? `Room pattern '${roomPart}' is being over-detected — exclude from '${signPart}' assignment`
        : `'${signPart}' signs are frequently removed — AI may be over-generating this type`;
    } else if (g.correctionType === "sign_type_override") {
      suggestedFix = hasRoom
        ? `When room name is '${roomPart}', assign '${signPart}' instead of pipeline default`
        : `'${signPart}' sign type is frequently overridden — review pipeline rules`;
    } else {
      suggestedFix = hasRoom
        ? `Review '${roomPart}' → '${signPart}' pattern (${g.correctionType})`
        : `'${signPart}' correction pattern (${g.correctionType}) — review pipeline rules`;
    }

    // Upsert: stable match on patternType + signType + roomNamePattern (null-safe)
    const [target] = await db.select({ id: trainingPatternsTable.id })
      .from(trainingPatternsTable)
      .where(and(
        eq(trainingPatternsTable.tenantId, tenantId),
        eq(trainingPatternsTable.patternType, g.correctionType),
        sql`coalesce(${trainingPatternsTable.suggestedFix}, '') like ${"%" + signPart.slice(0, 30) + "%"}`,
        g.roomNamePattern
          ? sql`${trainingPatternsTable.description} like ${`'${g.roomNamePattern}'%`}`
          : sql`${trainingPatternsTable.description} like ${signPart + " —%"}`
      ))
      .limit(1);

    let upsertedId: string;
    if (target) {
      await db.update(trainingPatternsTable)
        .set({
          description,
          evidenceCount,
          exampleJobIds: exampleJobIds as string[],
          suggestedFix,
          updatedAt: new Date(),
        })
        .where(eq(trainingPatternsTable.id, target.id));
      upsertedId = target.id;
      updatedPatterns++;
    } else {
      upsertedId = newId("pattern");
      await db.insert(trainingPatternsTable).values({
        id: upsertedId,
        tenantId,
        patternType: g.correctionType,
        description,
        evidenceCount,
        exampleJobIds: exampleJobIds as string[],
        suggestedFix,
        status: "detected",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      newPatterns++;
    }

    // Auto-approve patterns with strong evidence
    if (evidenceCount >= 3) {
      await db.update(trainingPatternsTable)
        .set({ status: "approved", approvedBy: "system", approvedAt: new Date() })
        .where(and(
          eq(trainingPatternsTable.id, upsertedId),
          eq(trainingPatternsTable.status, "detected"),
        ));
    }
  }

  const [{ total }] = await db.select({ total: count() })
    .from(trainingPatternsTable)
    .where(eq(trainingPatternsTable.tenantId, tenantId));

  return { newPatterns, updatedPatterns, totalPatterns: total };
}

// POST /training/patterns/analyze
router.post("/training/patterns/analyze", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  try {
    const result = await detectPatterns(tenantId);

    // Retroactively auto-approve any existing detected patterns with evidence >= 3
    await db.update(trainingPatternsTable)
      .set({ status: "approved", approvedBy: "system", approvedAt: new Date() })
      .where(and(
        eq(trainingPatternsTable.tenantId, tenantId),
        eq(trainingPatternsTable.status, "detected"),
        gte(trainingPatternsTable.evidenceCount, 3),
      ));

    res.json(result);
  } catch (err) {
    console.error("Pattern detection error:", err);
    res.status(500).json({ error: "Pattern detection failed" });
  }
});

// GET /training/patterns
router.get("/training/patterns", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const statusFilter = req.query.status ? String(req.query.status) : undefined;

  const rows = await db.select().from(trainingPatternsTable)
    .where(and(
      eq(trainingPatternsTable.tenantId, tenantId),
      ...(statusFilter ? [eq(trainingPatternsTable.status, statusFilter)] : [])
    ))
    .orderBy(desc(trainingPatternsTable.evidenceCount));

  res.json(rows.map(({ buildingTypesAffected: _omitted, ...rest }) => rest));
});

// PATCH /training/patterns/:patternId
router.patch("/training/patterns/:patternId", requireAuth, async (req, res): Promise<void> => {
  const { tenantId, userId } = req.auth_ctx!;
  const patternId = String(req.params.patternId);
  const { status } = req.body as { status: string };

  const validStatuses = ["detected", "reviewed", "approved", "deployed", "dismissed"];
  if (!status || !validStatuses.includes(status)) {
    res.status(400).json({ error: `status must be one of: ${validStatuses.join(", ")}` });
    return;
  }

  const [existing] = await db.select({ id: trainingPatternsTable.id })
    .from(trainingPatternsTable)
    .where(and(
      eq(trainingPatternsTable.id, patternId),
      eq(trainingPatternsTable.tenantId, tenantId),
    ))
    .limit(1);

  if (!existing) {
    res.status(404).json({ error: "Pattern not found" });
    return;
  }

  const [updated] = await db.update(trainingPatternsTable)
    .set({
      status,
      updatedAt: new Date(),
      ...(status === "approved" ? { approvedBy: userId, approvedAt: new Date() } : {}),
      ...(status === "deployed" ? { deployedAt: new Date() } : {}),
    })
    .where(and(
      eq(trainingPatternsTable.id, patternId),
      eq(trainingPatternsTable.tenantId, tenantId),
    ))
    .returning();

  res.json(updated);
});

// ---------------------------------------------------------------------------
// Training context retrieval (injected into Claude vision prompts)
// ---------------------------------------------------------------------------

import { getTrainingContext } from "../lib/trainingContext";
import { downloadFromGoogleDrive } from "../lib/googleDriveDownload";
export { getTrainingContext };

// GET /training/context/preview
router.get("/training/context/preview", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const buildingType = req.query.buildingType ? String(req.query.buildingType) : null;

  const patterns = await db.select()
    .from(trainingPatternsTable)
    .where(and(
      eq(trainingPatternsTable.tenantId, tenantId),
      eq(trainingPatternsTable.status, "approved"),
    ))
    .orderBy(desc(trainingPatternsTable.evidenceCount))
    .limit(15);

  const examples = await db.select()
    .from(importSnapshotsTable)
    .where(and(
      eq(importSnapshotsTable.tenantId, tenantId),
      isNotNull(importSnapshotsTable.accuracyScore),
      ...(buildingType ? [eq(importSnapshotsTable.buildingType, buildingType)] : []),
    ))
    .orderBy(desc(importSnapshotsTable.accuracyScore))
    .limit(3);

  const context = await getTrainingContext(tenantId, buildingType);

  res.json({
    context,
    patternCount: patterns.length,
    exampleCount: examples.length,
  });
});

router.get("/training/health", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;

  const [validatedJobsResult] = await db
    .select({ count: count() })
    .from(importSnapshotsTable)
    .where(and(
      eq(importSnapshotsTable.tenantId, tenantId),
      isNotNull(importSnapshotsTable.accuracyScore),
    ));

  const accuracyRows = await db
    .select({ accuracyScore: importSnapshotsTable.accuracyScore })
    .from(importSnapshotsTable)
    .where(and(
      eq(importSnapshotsTable.tenantId, tenantId),
      isNotNull(importSnapshotsTable.accuracyScore),
    ));

  const scores = accuracyRows
    .map(r => parseFloat(String(r.accuracyScore ?? "0")))
    .filter(n => !isNaN(n));
  const avgAccuracy = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

  const [patternsActiveResult] = await db
    .select({ count: count() })
    .from(trainingPatternsTable)
    .where(and(
      eq(trainingPatternsTable.tenantId, tenantId),
      eq(trainingPatternsTable.status, "approved"),
    ));

  res.json({
    validatedJobs: validatedJobsResult?.count ?? 0,
    avgAccuracy,
    patternsActive: patternsActiveResult?.count ?? 0,
  });
});

router.get("/training/ai-cost", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;

  const [firstSnapshotResult] = await db
    .select({ minDate: min(importSnapshotsTable.snapshotDate) })
    .from(importSnapshotsTable)
    .where(eq(importSnapshotsTable.tenantId, tenantId));

  const firstTrainingDate = firstSnapshotResult?.minDate ?? null;

  const whereConditions = [
    eq(aiScansTable.tenantId, tenantId),
    ...(firstTrainingDate ? [gte(aiScansTable.createdAt, firstTrainingDate)] : []),
  ];

  const [costResult] = await db
    .select({
      totalCost: sum(aiScansTable.cost),
      totalScans: sql<number>`count(distinct ${aiScansTable.jobId})`,
    })
    .from(aiScansTable)
    .where(and(...whereConditions));

  const totalCost = parseFloat(String(costResult?.totalCost ?? "0")) || 0;
  const totalScans = Number(costResult?.totalScans ?? 0);

  res.json({
    totalScans,
    totalCost,
    avgCostPerScan: totalScans > 0 ? totalCost / totalScans : 0,
    firstTrainingDate: firstTrainingDate ? firstTrainingDate.toISOString() : null,
  });
});

router.post("/training/import/drive", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const { driveUrl } = req.body;

  if (!driveUrl || typeof driveUrl !== "string") {
    res.status(400).json({ error: "driveUrl is required" });
    return;
  }

  try {
    const { buffer, filename, contentType, sizeBytes } = await downloadFromGoogleDrive(driveUrl);

    const uploadURL = await objectStorageService.getObjectEntityUploadURL(tenantId);
    const putResponse = await fetch(uploadURL, {
      method: "PUT",
      body: buffer,
      headers: { "Content-Type": contentType },
    });
    if (!putResponse.ok) {
      throw new Error(`Failed to upload to object storage: ${putResponse.status}`);
    }

    const storagePath = objectStorageService.normalizeObjectEntityPath(uploadURL);
    const sizeMB = parseFloat((sizeBytes / 1024 / 1024).toFixed(1));

    res.json({ storagePath, filename, sizeBytes, sizeMB });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to download from Google Drive";
    res.status(400).json({ error: message });
  }
});

export default router;
