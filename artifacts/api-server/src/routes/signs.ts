import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { signsTable, jobsTable, roomsTable, trainingCorrectionsTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { requireAuth } from "../lib/tenantAuth";
import { newId } from "../lib/ids";
import { CreateSignBody, UpdateSignBody } from "@workspace/api-zod";
import { SIGN_COLORS } from "../lib/signColors";
import { syncJobSignCounts } from "../lib/signCounts";

const router: IRouter = Router();

function serializeSign(s: typeof signsTable.$inferSelect, roomNumber?: string | null, roomName?: string | null, level?: string | null) {
  return {
    ...s,
    confidence: parseFloat(String(s.confidence || "0")),
    color: SIGN_COLORS[s.signType] || s.color || "#6b7280",
    // COALESCE: room join takes priority; fall back to sign's own roomNumber/roomName
    // (populated for egress signs that have no linked roomId)
    roomNumber: roomNumber || s.roomNumber || null,
    roomName: roomName || s.roomName || null,
    level: level || null,
  };
}

router.get("/jobs/:jobId/signs", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const jobId = String(req.params.jobId);

  const signs = await db.select({
    sign: signsTable,
    roomNumber: roomsTable.roomNumber,
    roomName: roomsTable.roomName,
    level: roomsTable.level,
  })
    .from(signsTable)
    .leftJoin(roomsTable, eq(signsTable.roomId, roomsTable.id))
    .where(and(
      eq(signsTable.jobId, jobId),
      eq(signsTable.tenantId, tenantId),
      eq(signsTable.isDeleted, false),
    ))
    .orderBy(desc(signsTable.updatedAt));

  res.json(signs.map(row => serializeSign(row.sign, row.roomNumber, row.roomName, row.level)));
});

router.post("/jobs/:jobId/signs", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const jobId = String(req.params.jobId);

  const parsed = CreateSignBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [sign] = await db.insert(signsTable).values({
    id: newId("sign"),
    jobId,
    tenantId,
    roomId: parsed.data.roomId,
    signType: parsed.data.signType,
    qty: parsed.data.qty ?? 1,
    markerX: parsed.data.markerX,
    markerY: parsed.data.markerY,
    sheetId: parsed.data.sheetId,
    color: SIGN_COLORS[parsed.data.signType] || parsed.data.color,
    dimensions: parsed.data.dimensions,
    mounting: parsed.data.mounting,
    finishColor: parsed.data.finishColor,
    message: parsed.data.message,
    confidence: "0.95",
    status: "confirmed",
    source: "manual",
  }).returning();

  await db.insert(trainingCorrectionsTable).values({
    id: newId("tc"),
    tenantId,
    jobId,
    signId: sign.id,
    roomId: sign.roomId,
    correctionType: "add",
    originalValue: {},
    correctedValue: { signType: sign.signType, qty: sign.qty },
    signType: sign.signType,
    reason: parsed.data.reason || "Manual addition",
  });

  await syncJobSignCounts(jobId, tenantId);
  res.status(201).json(serializeSign(sign));
});

router.get("/jobs/:jobId/signs/:signId", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const jobId = String(req.params.jobId);
  const signId = String(req.params.signId);

  const [row] = await db.select({
    sign: signsTable,
    roomNumber: roomsTable.roomNumber,
    roomName: roomsTable.roomName,
    level: roomsTable.level,
  })
    .from(signsTable)
    .leftJoin(roomsTable, eq(signsTable.roomId, roomsTable.id))
    .where(and(
      eq(signsTable.id, signId),
      eq(signsTable.jobId, jobId),
      eq(signsTable.tenantId, tenantId),
    ));

  if (!row) {
    res.status(404).json({ error: "Sign not found" });
    return;
  }

  res.json(serializeSign(row.sign, row.roomNumber, row.roomName, row.level));
});

router.patch("/jobs/:jobId/signs/:signId", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const jobId = String(req.params.jobId);
  const signId = String(req.params.signId);

  const parsed = UpdateSignBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [existing] = await db.select().from(signsTable)
    .where(and(eq(signsTable.id, signId), eq(signsTable.tenantId, tenantId)));

  if (!existing) {
    res.status(404).json({ error: "Sign not found" });
    return;
  }

  const markerFieldChanged =
    parsed.data.markerX !== undefined ||
    parsed.data.markerY !== undefined ||
    parsed.data.sheetId !== undefined ||
    parsed.data.roomName !== undefined ||
    parsed.data.markerColor !== undefined;

  const [sign] = await db.update(signsTable)
    .set({
      ...(parsed.data.signType && { signType: parsed.data.signType, color: SIGN_COLORS[parsed.data.signType] || undefined }),
      ...(parsed.data.qty !== undefined && { qty: parsed.data.qty }),
      ...(parsed.data.markerX !== undefined && { markerX: parsed.data.markerX }),
      ...(parsed.data.markerY !== undefined && { markerY: parsed.data.markerY }),
      ...("canvasX" in parsed.data && { canvasX: parsed.data.canvasX ?? null }),
      ...("canvasY" in parsed.data && { canvasY: parsed.data.canvasY ?? null }),
      ...(parsed.data.sheetId !== undefined && { sheetId: parsed.data.sheetId }),
      ...(parsed.data.status && { status: parsed.data.status }),
      ...(parsed.data.dimensions !== undefined && { dimensions: parsed.data.dimensions }),
      ...(parsed.data.dimSource !== undefined && { dimSource: parsed.data.dimSource }),
      ...(parsed.data.mounting !== undefined && { mounting: parsed.data.mounting }),
      ...(parsed.data.finishColor !== undefined && { finishColor: parsed.data.finishColor }),
      ...(parsed.data.message !== undefined && { message: parsed.data.message }),
      ...(parsed.data.markerColor !== undefined && { markerColor: parsed.data.markerColor }),
      ...(parsed.data.roomName !== undefined && { roomName: parsed.data.roomName }),
    })
    .where(eq(signsTable.id, signId))
    .returning();

  if (markerFieldChanged) {
    await db.update(jobsTable)
      .set({ xlsxDirty: true })
      .where(eq(jobsTable.id, jobId));
  }

  await db.insert(trainingCorrectionsTable).values({
    id: newId("tc"),
    tenantId,
    jobId,
    signId,
    correctionType: "edit",
    originalValue: { signType: existing.signType, qty: existing.qty },
    correctedValue: { signType: sign.signType, qty: sign.qty },
    signType: sign.signType,
    ruleRef: existing.ruleRef,
    reason: parsed.data.reason || "Manual edit",
  });

  await syncJobSignCounts(jobId, tenantId);
  res.json(serializeSign(sign));
});

router.delete("/jobs/:jobId/signs/:signId", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const jobId = String(req.params.jobId);
  const signId = String(req.params.signId);

  const [existing] = await db.select().from(signsTable)
    .where(and(eq(signsTable.id, signId), eq(signsTable.tenantId, tenantId)));

  if (!existing) {
    res.status(404).json({ error: "Sign not found" });
    return;
  }

  await db.update(signsTable)
    .set({ isDeleted: true, status: "deleted" })
    .where(eq(signsTable.id, signId));

  await db.insert(trainingCorrectionsTable).values({
    id: newId("tc"),
    tenantId,
    jobId,
    signId,
    correctionType: "delete",
    originalValue: { signType: existing.signType, qty: existing.qty },
    correctedValue: {},
    signType: existing.signType,
    ruleRef: existing.ruleRef,
    reason: "User deleted sign",
  });

  await syncJobSignCounts(jobId, tenantId);
  res.sendStatus(204);
});

router.get("/jobs/:jobId/plaque-schedule", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const jobId = String(req.params.jobId);

  const { plaqueScheduleTable } = await import("@workspace/db");
  const items = await db.select().from(plaqueScheduleTable)
    .where(and(eq(plaqueScheduleTable.jobId, jobId), eq(plaqueScheduleTable.tenantId, tenantId)));

  res.json(items);
});

router.get("/jobs/:jobId/occupant-loads", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const jobId = String(req.params.jobId);

  const rooms = await db.select().from(roomsTable)
    .where(and(
      eq(roomsTable.jobId, jobId),
      eq(roomsTable.tenantId, tenantId),
    ));

  res.json(rooms.filter(r => r.occupantLoad != null));
});

router.get("/jobs/:jobId/validation", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const jobId = String(req.params.jobId);

  const { validationResultsTable } = await import("@workspace/db");
  const results = await db.select().from(validationResultsTable)
    .where(and(eq(validationResultsTable.jobId, jobId), eq(validationResultsTable.tenantId, tenantId)));

  res.json(results);
});

router.get("/jobs/:jobId/specialty-signs", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const jobId = String(req.params.jobId);

  const { specialtySignsTable } = await import("@workspace/db");
  const results = await db.select().from(specialtySignsTable)
    .where(and(eq(specialtySignsTable.jobId, jobId), eq(specialtySignsTable.tenantId, tenantId)))
    .orderBy(specialtySignsTable.signCode);

  res.json(results);
});

router.patch("/jobs/:jobId/specialty-signs/:id", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const jobId = String(req.params.jobId);
  const id = String(req.params.id);
  const { qty } = req.body as { qty?: unknown };

  if (typeof qty !== "number" || !Number.isInteger(qty) || qty < 0) {
    res.status(400).json({ error: "qty must be a non-negative integer" });
    return;
  }

  const { specialtySignsTable } = await import("@workspace/db");
  await db.update(specialtySignsTable)
    .set({ qty })
    .where(and(
      eq(specialtySignsTable.id, id),
      eq(specialtySignsTable.jobId, jobId),
      eq(specialtySignsTable.tenantId, tenantId),
    ));

  res.json({ ok: true });
});

export default router;
